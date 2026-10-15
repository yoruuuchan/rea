import { access, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { describe, expect, it, onTestFinished, vi } from "vitest";
import { z } from "zod";

import { AnalysisCancelledError } from "../../../../src/domain/analysisErrorCore.js";
import { EvidenceIntegrityError } from "../../../../src/domain/evidenceErrors.js";
import { projectAnalysisError } from "../../../../src/domain/analysisErrorProjection.js";
import { nativeCallObservationInputSchema } from "../../../../src/domain/native/nativeCallObservation.js";
import { nativeCallPartialObservationSchema } from "../../../../src/domain/native/nativeCallPartialObservation.js";
import type { NativeCallTracer } from "../../../../src/native/LldbCallTracer.js";
import { LldbCallTracer } from "../../../../src/native/LldbCallTracer.js";
import { err, ok } from "../../../../src/domain/result.js";
import { NativeCommandFailure } from "../../../../src/native/CommandRunner.js";
import { NativeMacOSProvider } from "../../../../src/native/NativeMacOSProvider.js";
import { createDeferred } from "../../../fixtures/binarySession.js";
import { PrivateRuntimeRoot } from "../../../../src/process/PrivateRuntimeRoot.js";
import {
  NativeFixtureRunner,
  nativeMachoTarget,
} from "../../../fixtures/nativeCommands.js";

const EVENT = {
  sequence: 0,
  elapsed_ms: 1,
  thread_id: 2,
  breakpoint_index: 0,
  load_address: "0x1000",
  file_address: "0x1000",
  module: "fixture",
  module_path: "/tmp/fixture",
  symbol: "main",
  receiver_class: null,
  selector: null,
  registers: [],
  backtrace: [],
};

const request: Parameters<NativeCallTracer["trace"]>[0] = {
  executable: "/tmp/fixture",
  architecture: "arm64",
  expectedSha256: "a".repeat(64),
  input: nativeCallObservationInputSchema.parse({
    breakpoints: [{ kind: "function", name: "main" }],
    arguments: ["--fixture"],
    environment: { CASE: "retained" },
  }),
};

const fakeTool = { path: "/usr/bin/lldb", sha256: "b".repeat(64) };
const successfulTracerOutput = {
  status: "traced",
  version: "lldb-fixture",
  pid: 12345,
  outcome: "exited",
  resource_limit_reached: false,
  target_output: {
    stdout_bytes: 0,
    stderr_bytes: 0,
    stdout_truncated: false,
    stderr_truncated: false,
    stdout_complete: true,
    stderr_complete: true,
  },
  exit_status: 0,
  exit_description: null,
  killed: false,
  terminated: true,
  target_identity: {
    loaded_image_sha256: null,
    selected_file_sha256: request.expectedSha256,
    file_device: "1",
    file_inode: "2",
    module_path: request.executable,
    module_uuid: "fixture",
    stable: true,
  },
  elapsed_ms: 1,
  breakpoints: [{ index: 0, location_count: 1, locations: [] }],
  events: [EVENT],
  other_stops: [],
};
const configSchema = z.object({
  result_path: z.string(),
  observation_path: z.string(),
  stdout_capture_path: z.string(),
  stderr_capture_path: z.string(),
});

const configFromArguments = async (arguments_: readonly string[]) => {
  const command = arguments_.at(-1);
  const match =
    command === undefined ? null : /^rea_trace (.+)$/u.exec(command);
  if (match?.[1] === undefined)
    throw new Error("fake LLDB launcher did not receive a tracer config path");
  const raw: unknown = JSON.parse(await readFile(match[1], "utf8"));
  return { config: configSchema.parse(raw), configPath: match[1] };
};

const fixtureTracer = (
  outcome: "cancelled" | "integrity-error-cleanup-failure",
) => {
  let configPath: string | undefined;
  const tracer = new LldbCallTracer(
    {},
    async (_executable, arguments_) => {
      const resolved = await configFromArguments(arguments_);
      const { config } = resolved;
      configPath = resolved.configPath;
      await writeFile(
        config.observation_path,
        `${JSON.stringify({ kind: "event", event: EVENT })}\n`,
      );
      await writeFile(config.stdout_capture_path, "captured prefix");
      if (outcome === "integrity-error-cleanup-failure")
        await writeFile(
          config.result_path,
          JSON.stringify({
            status: "target-integrity-error",
            error: "launched target digest changed",
          }),
        );
      return outcome === "cancelled"
        ? {
            kind: "cancelled",
            targetLaunched: false,
            targetIdentity: undefined,
            cleanupFailure: undefined,
          }
        : {
            kind: "exited",
            targetLaunched: false,
            exitCode: 1,
            output: "bridge reported target integrity failure",
            targetIdentity: undefined,
            cleanupFailure: "LLDB process-group cleanup could not be verified",
          };
    },
    async () => ok(fakeTool),
  );
  return {
    tracer,
    runtimeRoot: async () => {
      if (configPath === undefined)
        throw new Error("fake LLDB launcher was not called");
      const root = dirname(configPath);
      await expect(access(root)).rejects.toThrow();
    },
  };
};

describe("LLDB completed trace retention through finalization", () => {
  it.each([
    "after launch",
    "during runtime cleanup",
    "runtime cleanup failure",
  ])("retains completed trace facts after %s", async (phase) => {
    const controller = new AbortController();
    const close = PrivateRuntimeRoot.prototype.close;
    let runtime: string | undefined;
    const closeSpy =
      phase !== "after launch"
        ? vi
            .spyOn(PrivateRuntimeRoot.prototype, "close")
            .mockImplementation(async function (this: PrivateRuntimeRoot) {
              if (phase === "runtime cleanup failure")
                throw new Error("fixture runtime removal denied");
              await close.call(this);
              controller.abort();
            })
        : undefined;
    const tracer = new LldbCallTracer(
      {},
      async (_executable, arguments_) => {
        const { config } = await configFromArguments(arguments_);
        runtime = dirname(config.result_path);
        await writeFile(config.observation_path, "");
        await writeFile(config.stdout_capture_path, "");
        await writeFile(config.stderr_capture_path, "");
        await writeFile(
          config.result_path,
          JSON.stringify(successfulTracerOutput),
        );
        if (phase === "after launch") controller.abort();
        return {
          kind: "exited",
          targetLaunched: false,
          exitCode: 0,
          output: "",
          targetIdentity: undefined,
          cleanupFailure: undefined,
        };
      },
      async () => ok(fakeTool),
    );
    onTestFinished(async () => {
      closeSpy?.mockRestore();
      await tracer.close();
    });

    const result = await tracer
      .trace(request, controller.signal)
      .finally(() => closeSpy?.mockRestore());
    if (result.ok)
      throw new Error("expected finalization failure after LLDB exit");
    if (runtime === undefined) throw new Error("LLDB fixture did not launch");
    if (phase === "runtime cleanup failure") {
      expect(result.error.cleanupResources).toEqual([runtime]);
      await access(runtime);
      expect((await tracer.close()).ok).toBe(true);
    } else expect(result.error).toBeInstanceOf(AnalysisCancelledError);
    await expect(access(runtime)).rejects.toMatchObject({ code: "ENOENT" });
    expect(result.error.partialObservation).toMatchObject({
      coverage: {
        status: "partial",
        reason:
          phase === "runtime cleanup failure" ? "cleanup-failure" : "cancelled",
      },
      target: { launch_identity: successfulTracerOutput.target_identity },
      debugger: { ...fakeTool, version: successfulTracerOutput.version },
      process: {
        outcome: "exited",
        exit_status: 0,
        exit_description: null,
        terminated: true,
        elapsed_ms: 1,
        stdout: { complete: true },
      },
      breakpoints: [
        {
          index: 0,
          request: { kind: "function", name: "main" },
          location_count: 1,
        },
      ],
      events: [EVENT],
    });
    const partial = nativeCallPartialObservationSchema.parse(
      result.error.partialObservation,
    );
    expect(partial).toEqual(result.error.partialObservation);
    expect(partial.limitations).not.toContain(
      "Captured output byte counts are observed lower bounds because LLDB did not report final stream counters.",
    );
  });
});

describe("LLDB failure retention through the production tracer", () => {
  it("waits for an active trace before client close removes its runtime root", async () => {
    const launchGate = createDeferred<void>();
    const launchStarted = createDeferred<void>();
    const tracer = new LldbCallTracer(
      {},
      async (_executable, arguments_) => {
        const { config } = await configFromArguments(arguments_);
        await writeFile(
          config.observation_path,
          `${JSON.stringify({ kind: "event", event: EVENT })}\n`,
        );
        await writeFile(config.stdout_capture_path, "captured prefix");
        launchStarted.resolve();
        await launchGate.promise;
        return {
          kind: "exited",
          targetLaunched: false,
          exitCode: 0,
          output: "",
          targetIdentity: undefined,
          cleanupFailure: undefined,
        };
      },
      async () => ok(fakeTool),
    );
    const client = new NativeMacOSProvider(
      {},
      new NativeFixtureRunner(),
      "darwin",
      () => tracer,
    ).createClient(nativeMachoTarget(request.executable));
    const tracePromise = tracer.trace(request);
    await launchStarted.promise;
    let closeFinished = false;
    const closePromise = client.close().then((result) => {
      closeFinished = true;
      return result;
    });
    await Promise.resolve();
    expect(closeFinished).toBe(false);
    launchGate.resolve();
    const [trace, close] = await Promise.all([tracePromise, closePromise]);
    expect(close.ok).toBe(true);
    if (trace.ok) throw new Error("expected missing LLDB result");
    expect(trace.error.partialObservation).toMatchObject({
      events: [EVENT],
      process: { stdout: { text: "captured prefix", complete: false } },
    });
  });

  it("names the missing LLDB requirement instead of asking for another target", async () => {
    const tracer = new LldbCallTracer(
      {},
      () => Promise.reject(new Error("LLDB must not launch")),
      async (tool) => err(new NativeCommandFailure(tool, "unavailable")),
    );
    const result = await tracer.trace(request);
    if (result.ok) throw new Error("expected an unavailable LLDB");
    expect(projectAnalysisError(result.error)).toMatchObject({
      code: "capability_unavailable",
      message: "LLDB from Xcode or the Command Line Tools is not available",
    });
  });

  it("preserves cancellation and journal/output evidence after runtime cleanup", async () => {
    const fixture = fixtureTracer("cancelled");
    const result = await fixture.tracer.trace(request);
    await fixture.runtimeRoot();
    if (result.ok) throw new Error("expected cancellation");
    expect(result.error).toBeInstanceOf(AnalysisCancelledError);
    expect(result.error.partialObservation).toMatchObject({
      coverage: { status: "partial", reason: "cancelled" },
      events: [EVENT],
      process: { stdout: { text: "captured prefix", complete: false } },
      target: {
        arguments: ["--fixture"],
        environment: { CASE: "retained" },
        working_directory: null,
      },
    });
  });

  it("preserves bridge integrity failure type when process-group cleanup also fails", async () => {
    const fixture = fixtureTracer("integrity-error-cleanup-failure");
    const result = await fixture.tracer.trace(request);
    await fixture.runtimeRoot();
    if (result.ok) throw new Error("expected integrity failure");
    expect(result.error).toBeInstanceOf(EvidenceIntegrityError);
    expect(result.error.partialObservation).toMatchObject({
      coverage: { status: "partial", reason: "cleanup-failure" },
      events: [EVENT],
      process: { stdout: { text: "captured prefix", complete: false } },
    });
    expect(projectAnalysisError(result.error)).toMatchObject({
      code: "cleanup_incomplete",
      details: { execution_failure: "evidence_integrity_mismatch" },
    });
  });
});

describe("LLDB pre-target phase proof", () => {
  it("releases a proven pre-target integrity rejection and allows tracer reuse", async () => {
    let launches = 0;
    let firstRuntime: string | undefined;
    const tracer = new LldbCallTracer(
      {},
      async (_executable, arguments_) => {
        const { config } = await configFromArguments(arguments_);
        launches += 1;
        if (firstRuntime === undefined)
          firstRuntime = dirname(config.result_path);
        await writeFile(config.observation_path, "");
        await writeFile(config.stdout_capture_path, "");
        await writeFile(
          config.result_path,
          JSON.stringify(
            launches === 1
              ? {
                  status: "target-integrity-error",
                  error:
                    "selected executable digest changed before LLDB target creation",
                  target_process_created: false,
                }
              : {
                  status: "target-error",
                  error: "second launch reached the bridge",
                },
          ),
        );
        return {
          kind: "exited",
          targetLaunched: launches === 1,
          exitCode: 1,
          output: "",
          targetIdentity: undefined,
          cleanupFailure: undefined,
        };
      },
      async () => ok(fakeTool),
    );

    const rejected = await tracer.trace(request);
    if (rejected.ok) throw new Error("expected pre-target integrity failure");
    expect(rejected.error).toBeInstanceOf(EvidenceIntegrityError);
    expect(projectAnalysisError(rejected.error).code).toBe(
      "evidence_integrity_mismatch",
    );
    if (firstRuntime === undefined) throw new Error("LLDB was not launched");
    await expect(access(firstRuntime)).rejects.toThrow();

    const retried = await tracer.trace(request);
    expect(launches).toBe(2);
    if (retried.ok) throw new Error("expected the second bridge result");
    expect(retried.error).toMatchObject({
      _tag: "AnalysisCapabilityUnavailableError",
      reason: expect.stringContaining("second launch reached the bridge"),
    });
  });
});

describe("LLDB retains ambiguous target ownership", () => {
  it("releases a launch failure after the bridge proves the process exited", async () => {
    let configPath: string | undefined;
    const tracer = new LldbCallTracer(
      {},
      async (_executable, arguments_) => {
        const resolved = await configFromArguments(arguments_);
        configPath = resolved.configPath;
        await writeFile(
          resolved.config.result_path,
          JSON.stringify({
            status: "launch-error",
            error: "attach failed after the launched process exited",
            target_process_created: true,
            target_process_exit_observed: true,
          }),
        );
        return {
          kind: "exited",
          targetLaunched: true,
          exitCode: 1,
          output: "",
          targetIdentity: undefined,
          cleanupFailure: undefined,
        };
      },
      async () => ok(fakeTool),
    );

    const result = await tracer.trace(request);
    if (result.ok) throw new Error("expected LLDB launch failure");
    expect(projectAnalysisError(result.error).code).toBe(
      "capability_unavailable",
    );
    expect(result.error.cleanup).toBeUndefined();
    expect(configPath).toBeDefined();
    if (configPath !== undefined)
      await expect(access(dirname(configPath))).rejects.toThrow();
  });

  it("keeps a post-target integrity rejection unresolved when its PID is missing", async () => {
    let runtime: string | undefined;
    const tracer = new LldbCallTracer(
      {},
      async (_executable, arguments_) => {
        const { config } = await configFromArguments(arguments_);
        runtime = dirname(config.result_path);
        await writeFile(config.observation_path, "");
        await writeFile(config.stdout_capture_path, "");
        await writeFile(
          config.result_path,
          JSON.stringify({
            status: "target-integrity-error",
            error: "selected executable changed during LLDB launch",
            target_process_created: true,
          }),
        );
        return {
          kind: "exited",
          targetLaunched: true,
          exitCode: 1,
          output: "",
          targetIdentity: undefined,
          cleanupFailure: undefined,
        };
      },
      async () => ok(fakeTool),
    );

    try {
      const result = await tracer.trace(request);
      if (result.ok) throw new Error("expected unresolved target identity");
      expect(projectAnalysisError(result.error)).toMatchObject({
        code: "cleanup_incomplete",
        details: {
          resources: expect.arrayContaining(["native-target:unknown"]),
        },
      });
      expect(runtime).toBeDefined();
      if (runtime !== undefined) await access(runtime);
      const retry = await tracer.trace(request);
      if (retry.ok) throw new Error("expected retained target cleanup");
      expect(projectAnalysisError(retry.error).code).toBe("cleanup_incomplete");
    } finally {
      if (runtime !== undefined)
        await rm(runtime, { recursive: true, force: true });
    }
  });

  it("keeps an invalid process after Launch unresolved without producer proof", async () => {
    let launches = 0;
    let runtime: string | undefined;
    const tracer = new LldbCallTracer(
      {},
      async (_executable, arguments_) => {
        launches += 1;
        const { config } = await configFromArguments(arguments_);
        runtime = dirname(config.result_path);
        await writeFile(config.observation_path, "");
        await writeFile(config.stdout_capture_path, "");
        await writeFile(
          config.result_path,
          JSON.stringify({
            status: "launch-error",
            error: "LLDB returned an invalid process after Launch",
          }),
        );
        return {
          kind: "exited",
          targetLaunched: true,
          exitCode: 1,
          output: "",
          targetIdentity: undefined,
          cleanupFailure: undefined,
        };
      },
      async () => ok(fakeTool),
    );

    try {
      const result = await tracer.trace(request);
      if (result.ok) throw new Error("expected unresolved launch cleanup");
      expect(projectAnalysisError(result.error)).toMatchObject({
        code: "cleanup_incomplete",
        details: {
          resources: expect.arrayContaining(["native-target:unknown"]),
        },
      });
      expect(runtime).toBeDefined();
      if (runtime !== undefined) await access(runtime);
      const retry = await tracer.trace(request);
      if (retry.ok) throw new Error("expected retained target cleanup");
      expect(projectAnalysisError(retry.error).code).toBe("cleanup_incomplete");
      expect(launches).toBe(1);
    } finally {
      if (runtime !== undefined)
        await rm(runtime, { recursive: true, force: true });
    }
  });
});
