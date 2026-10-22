import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Cli } from "incur";
import { afterEach, expect, it, vi } from "vitest";

import * as analysisViewService from "../../src/application/analysisView/AnalysisViewService.js";
import { WasmArtifactService } from "../../src/application/wasm/WasmArtifactService.js";
import { registerAnalysisViewCommands } from "../../src/cli/analysisViewCommands.js";
import { registerWasmCommands } from "../../src/cli/wasmCommands.js";
import { wasmArtifactModule } from "../../src/composition/wasm.js";
import { AnalysisOutputError } from "../../src/domain/analysisErrorCore.js";
import { createEvidenceBundle } from "../../src/domain/evidenceBundle.js";
import { ProviderCleanupError } from "../../src/domain/providerCleanupError.js";
import { err, ok } from "../../src/domain/result.js";
import { OwnedFileHandle } from "../../src/filesystem/OwnedFileHandle.js";
import { silentLogger } from "../../src/logger.js";
import { analysisViewLayoutEvidence } from "../fixtures/analysisView.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import {
  wasmArtifactExecution,
  wasmArtifactFixture,
} from "../fixtures/wasm/artifact.js";

const host = vi.hoisted(() => ({
  listeners: new Map<string, () => void>(),
  get exitCode() {
    return process.exitCode;
  },
  set exitCode(value: typeof process.exitCode) {
    process.exitCode = value;
  },
  on(signal: string, listener: () => void) {
    this.listeners.set(signal, listener);
  },
  off(signal: string, listener: () => void) {
    if (this.listeners.get(signal) === listener) this.listeners.delete(signal);
  },
}));

vi.mock("../../src/cli/commandCancellation.js", async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import("../../src/cli/commandCancellation.js")
    >();
  return {
    ...original,
    withCommandCancellation: <Value>(
      operation: (signal: AbortSignal) => Promise<Value>,
    ) => original.withCommandCancellation(operation, host),
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  host.listeners.clear();
});

it.each([
  "control",
  "interrupt",
  "primary-failure",
  "cleanup-failure",
  "interrupt-cleanup-failure",
] as const)(
  "finishes the registered WASM command through final close: %s",
  async (scenario) => {
    const value = wasmArtifactFixture();
    const primary = new AnalysisOutputError(
      "inspect_wasm_artifact",
      "primary reply failure",
    );
    const cleanup = new ProviderCleanupError(
      "wabt-artifact",
      ["exact-owned-root"],
      { reason: "close refused" },
      { operation: "inspect_wasm_artifact" },
    );
    let closed = false;
    const service = new WasmArtifactService({
      inspect: async () =>
        scenario === "primary-failure"
          ? err(primary)
          : ok(wasmArtifactExecution(value)),
      close: async () => {
        await Promise.resolve();
        if (scenario !== "control" && scenario !== "cleanup-failure")
          host.listeners.get("SIGINT")?.();
        closed = true;
        if (
          scenario === "cleanup-failure" ||
          scenario === "interrupt-cleanup-failure"
        )
          throw cleanup;
      },
    });
    vi.spyOn(wasmArtifactModule, "create").mockReturnValue(service);
    const cli = Cli.create("finalization-test", { sync: false });
    registerWasmCommands(cli, silentLogger, {});
    let output = "";
    const previousExitCode = process.exitCode;
    let exitCode;
    try {
      process.exitCode = undefined;
      await cli.serve(
        ["inspect-wasm-artifact", value.artifact.path, "--json"],
        {
          stdout: (part) => {
            output += part;
          },
          exit: () => {},
        },
      );
      exitCode = process.exitCode;
    } finally {
      process.exitCode = previousExitCode;
    }
    const result = JSON.parse(output);
    expect(closed).toBe(true);
    expect(host.listeners.size).toBe(0);
    if (scenario === "control") {
      expect(result.normalized_result).toEqual(value);
      expect(exitCode).toBeUndefined();
    } else if (scenario === "primary-failure") {
      expect(result).toMatchObject({
        code: "unreadable_output",
        details: { reason: "primary reply failure" },
      });
      expect(exitCode).toBe(130);
    } else {
      expect(result).toMatchObject({
        code: scenario === "interrupt" ? "cancelled" : "cleanup_incomplete",
        details: {
          partial_observation: {
            operation: "inspect_wasm_artifact",
            normalized_result: value,
          },
          ...(scenario === "interrupt"
            ? {}
            : { resources: ["exact-owned-root"] }),
        },
      });
      if (scenario !== "cleanup-failure") expect(exitCode).toBe(130);
    }
  },
);

it.each([
  ["bundle", "control", "close"],
  ["bundle", "SIGINT", "close"],
  ["bundle", "SIGTERM", "close"],
  ["evidence-file", "control", "close"],
  ["evidence-file", "SIGINT", "close"],
  ["evidence-file", "SIGTERM", "close"],
  ["request-file", "control", "close"],
  ["request-file", "SIGINT", "close"],
  ["request-file", "SIGTERM", "close"],
  ["bundle", "SIGINT", "authentication"],
  ["bundle", "SIGTERM", "authentication"],
  ["bundle", "SIGINT", "projection"],
  ["bundle", "SIGTERM", "projection"],
  ["bundle", "SIGINT", "authentication-failure"],
  ["bundle", "SIGTERM", "projection-failure"],
] as const)(
  "preserves the analysis-view result and exit status for %s: %s during %s",
  async (source, signal, phase) => {
    const root = await createTestTempDirectory("rea-analysis-view-signal-");
    const parent = analysisViewLayoutEvidence();
    const filename = `${source}.json`;
    const path = join(root, filename);
    const request = {
      source:
        source === "bundle"
          ? {
              kind: "retained-evidence",
              evidence_id:
                phase === "projection-failure"
                  ? `ev_${"f".repeat(64)}`
                  : parent.evidence_id,
            }
          : source === "evidence-file"
            ? { kind: "evidence-file", path }
            : { kind: "inline", evidence: parent },
      view: { kind: "summary" },
    };
    await writeFile(
      path,
      JSON.stringify(
        source === "bundle"
          ? {
              ...createEvidenceBundle([parent]),
              ...(phase === "authentication-failure"
                ? { records: [{ ...parent, normalized_result: "altered" }] }
                : {}),
            }
          : source === "evidence-file"
            ? parent
            : request,
      ),
    );
    let interruptHandled = false;
    let pendingInterrupt: Promise<void> | undefined;
    const interrupt = () => {
      const listener = host.listeners.get(signal);
      interruptHandled = listener !== undefined;
      listener?.();
    };
    const queueInterrupt = () => {
      pendingInterrupt = new Promise((resolve) => {
        setImmediate(() => {
          interrupt();
          resolve();
        });
      });
    };
    const originalProject = analysisViewService.inspectAnalysisViewValidated;
    let projected: ReturnType<typeof originalProject> | undefined;
    const project = vi
      .spyOn(analysisViewService, "inspectAnalysisViewValidated")
      .mockImplementation((...args) => {
        projected = originalProject(...args);
        if (phase.startsWith("projection")) queueInterrupt();
        return projected;
      });
    const originalClose = OwnedFileHandle.prototype.close;
    const close = vi
      .spyOn(OwnedFileHandle.prototype, "close")
      .mockImplementation(async function (this: OwnedFileHandle) {
        await originalClose.call(this);
        expect(this.handle.fd).toBe(-1);
        if (signal !== "control" && phase === "close") interrupt();
        if (phase.startsWith("authentication")) queueInterrupt();
      });
    const cli = Cli.create("analysis-view-finalization-test", { sync: false });
    registerAnalysisViewCommands(cli, silentLogger);
    let output = "";
    const previousExitCode = process.exitCode;
    try {
      process.exitCode = undefined;
      await cli.serve(
        [
          "inspect-analysis-view",
          source === "request-file" ? path : JSON.stringify(request),
          ...(source === "bundle" ? ["--evidence-bundle", path] : []),
          "--json",
        ],
        {
          stdout: (part) => {
            output += part;
          },
          exit: () => {},
        },
      );
      expect(close).toHaveBeenCalledOnce();
      expect(host.listeners.size).toBe(0);
      expect(await readdir(root)).toEqual([filename]);
      const result = JSON.parse(output);
      expect(result).toMatchObject(
        signal === "control"
          ? { operation: "inspect_analysis_view" }
          : {
              code: phase.endsWith("failure")
                ? "evidence_integrity_mismatch"
                : "cancelled",
            },
      );
      expect(process.exitCode ?? 0).toBe(
        signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 0,
      );
      if (signal !== "control") expect(interruptHandled).toBe(true);
      if (phase.startsWith("authentication"))
        expect(project).not.toHaveBeenCalled();
      if (phase === "projection") {
        if (!projected?.ok) throw new Error("Expected a completed page");
        expect(result.details.partial_observation).toEqual(projected.value);
      }
    } finally {
      await pendingInterrupt;
      process.exitCode = previousExitCode;
    }
  },
);
