import { createHash } from "node:crypto";
import { access, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fault = vi.hoisted(() => ({
  roots: new Set<string>(),
  blocked: true,
  failure: new Error("controlled helper-root removal failure"),
  abort: undefined as AbortController | undefined,
  attempts: 0,
  gate: undefined as (() => Promise<void>) | undefined,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    mkdtemp: async (...args: Parameters<typeof actual.mkdtemp>) => {
      const root = await actual.mkdtemp(...args);
      if (
        typeof root === "string" &&
        String(args[0]).includes("rea-process-token-")
      )
        fault.roots.add(root);
      return root;
    },
    rm: async (...args: Parameters<typeof actual.rm>) => {
      if (typeof args[0] === "string" && fault.roots.has(args[0])) {
        fault.attempts += 1;
        await fault.gate?.();
        if (!fault.blocked) return actual.rm(...args);
        fault.abort?.abort(null);
        throw fault.failure;
      }
      return actual.rm(...args);
    },
  };
});

import {
  createDarwinProcessRunTokenReader,
  DarwinProcessOwnershipInspectionError,
} from "../../src/process/DarwinProcessRunTokenReader.js";
import { GhidraClient } from "../../src/ghidra/GhidraClient.js";
import { GhidraHeadlessLauncher } from "../../src/ghidra/GhidraLauncher.js";
import { captureProcessScenario } from "../../src/process/capture/ProcessHarness.js";
import { processScenarioSchema } from "../../src/domain/process/processScenario.js";
import { systemProcessOwnershipHost } from "../../src/process/ProcessOwnershipObservation.js";
import { ghidraFixturePath } from "../boundary/providers/ghidra/ghidraClient.fixture.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
let releaseCleanup: (() => void) | undefined;
const clients: GhidraClient[] = [];
const readers: ReturnType<typeof createDarwinProcessRunTokenReader>[] = [];
beforeEach(() => {
  fault.blocked = true;
  fault.abort = undefined;
  fault.roots.clear();
  fault.attempts = 0;
  fault.gate = undefined;
});
afterEach(async () => {
  releaseCleanup?.();
  releaseCleanup = undefined;
  fault.blocked = false;
  fault.abort = undefined;
  fault.gate = undefined;
  vi.restoreAllMocks();
  for (const client of clients.splice(0)) await client.close();
  for (const reader of readers.splice(0)) await reader.close();
});

const fixture = async (mode: "fail" | "active" = "fail") => {
  const directory = await createTestTempDirectory(
    "rea-compiler-cleanup-fixture-",
  );
  const compiler = join(directory, "compiler");
  await writeFile(
    compiler,
    mode === "fail"
      ? "#!/usr/bin/env node\nprocess.stdout.write('owned compiler stdout'); process.stderr.write('controlled compiler failure\\n'); process.exitCode=7;\n"
      : `#!/usr/bin/env node
const fs = require('node:fs');
process.on('SIGINT', () => process.exit(0));
fs.writeFileSync(${JSON.stringify(join(directory, "ready"))}, 'ready');
setInterval(() => {}, 1000);
`,
    { mode: 0o755 },
  );
  const reader = createDarwinProcessRunTokenReader({
    compiler: { kind: "xcrun", executable: compiler },
  });
  readers.push(reader);
  return { reader, readyPath: join(directory, "ready") };
};

it
  .skipIf(process.platform === "win32")
  .each(["ordinary", "cancel during cleanup"] as const)(
  "preserves the compiler failure through %s and resolves retained cleanup on retry",
  async (mode) => {
    const { reader } = await fixture();
    const controller = new AbortController();
    if (mode === "cancel during cleanup") fault.abort = controller;
    const failure: unknown = await reader
      .prepare(controller.signal)
      .catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(DarwinProcessOwnershipInspectionError);
    expect(failure).toMatchObject({
      compilerOutcome: {
        outcome: "exited",
        code: 7,
        stderr: "controlled compiler failure\n",
      },
      cleanupFailure: { cleanupIncomplete: true, cause: fault.failure },
    });
    if (!(failure instanceof DarwinProcessOwnershipInspectionError))
      throw new Error("Expected primary compiler failure");
    const root = [...fault.roots][0];
    if (root === undefined) throw new Error("Expected owned compiler root");
    await expect(access(root)).resolves.toBeUndefined();
    fault.blocked = false;
    await reader.close();
    await expect(access(root)).rejects.toMatchObject({ code: "ENOENT" });
    expect(failure).toMatchObject({
      cleanupFailure: { cleanupIncomplete: false },
      compilerOutcome: { code: 7 },
    });
  },
);

it
  .skipIf(process.platform === "win32")
  .each(["two retries", "retry and close"] as const)(
  "shares retained root cleanup during %s",
  async (mode) => {
    const { reader } = await fixture();
    const original: unknown = await reader
      .prepare()
      .catch((cause: unknown) => cause);
    expect(original).toMatchObject({
      cleanupFailure: { cleanupIncomplete: true },
    });
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
      releaseCleanup = resolve;
    });
    fault.gate = () => gate;
    fault.blocked = false;
    const before = fault.attempts;
    const first = reader.prepare().catch((cause: unknown) => cause);
    const second =
      mode === "two retries"
        ? reader.prepare().catch((cause: unknown) => cause)
        : reader.close();
    await vi.waitFor(() => expect(fault.attempts).toBe(before + 1));
    await new Promise((resolve) => setImmediate(resolve));
    expect(fault.attempts).toBe(before + 1);
    release?.();
    await Promise.all([first, second]);
    expect(original).toMatchObject({
      cleanupFailure: { cleanupIncomplete: false },
    });
  },
);

it
  .skipIf(process.platform === "win32")
  .each([null, "stop preparation", new Error("stop preparation")] as const)(
  "joins final cleanup after the last waiter cancels with exact %s reason",
  async (reason) => {
    const { reader, readyPath } = await fixture("active");
    const controller = new AbortController();
    const preparation = reader
      .prepare(controller.signal)
      .catch((cause: unknown) => cause);
    await vi.waitFor(async () =>
      expect(await readFile(readyPath, "utf8")).toBe("ready"),
    );
    const root = [...fault.roots][0];
    if (root === undefined) throw new Error("Expected helper root");
    controller.abort(reason);
    const failure: unknown = await preparation;
    expect(failure).toBeInstanceOf(DarwinProcessOwnershipInspectionError);
    if (!(failure instanceof DarwinProcessOwnershipInspectionError))
      throw new Error("Expected retained cleanup failure");
    expect(failure.cause).toBe(reason);
    expect(failure.cancellation?.reason).toBe(reason);
    expect(failure.cleanupFailure?.cleanupIncomplete).toBe(true);
    fault.blocked = false;
    await reader.close();
    expect(failure.cleanupFailure?.cleanupIncomplete).toBe(false);
    await expect(access(root)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

it.skipIf(process.platform === "win32")(
  "Ghidra startup retains the compiler root until that owner confirms cleanup",
  async () => {
    const { reader, readyPath } = await fixture();
    const fixtureRoot = dirname(readyPath);
    const launcher = new GhidraHeadlessLauncher({
      configurationDirectoryName: "ghidra_12.1.4_PUBLIC",
      environment: {},
      analyzeHeadlessPath: join(fixtureRoot, "support", "analyzeHeadless"),
      javaHome: join(fixtureRoot, "jdk"),
      bridgeScriptPath: join(fixtureRoot, "ReaGhidraBridge.java"),
      javaLaunch: async () => ({
        command: process.execPath,
        arguments: [],
        environment: {},
      }),
      spawnProcess: async () => {
        await reader.prepare();
        throw new Error("unexpected compilation success");
      },
    });
    const client = new GhidraClient({
      launcher,
      targetPath: ghidraFixturePath,
      targetSha256: createHash("sha256")
        .update(await readFile(ghidraFixturePath))
        .digest("hex"),
      providerVersion: "test",
      profileDigest: "b".repeat(64),
      startupTimeoutMs: 10000,
    });
    clients.push(client);
    const result = await client.start();
    expect(result).toMatchObject({
      ok: false,
      error: { kind: "start", cleanupFailure: { cleanupIncomplete: true } },
    });
    if (result.ok) throw new Error("Expected startup compiler failure");
    expect(result.error.diagnostics).toMatchObject({
      failure_cause: {
        launch_outcome: {
          stdout: "owned compiler stdout",
          stdout_bytes: 21,
          stderr_bytes: 28,
          exit_code: 7,
        },
        cause: { compiler_outcome: { code: 7 } },
      },
    });
    await client.close();
    expect(result.error.cleanupFailure?.cleanupIncomplete).toBe(true);
    fault.blocked = false;
    await reader.close();
    expect(result.error.cleanupFailure?.cleanupIncomplete).toBe(false);
  },
);

it.skipIf(process.platform === "win32")(
  "capture boundary retains compiler output and follows the actual helper cleanup retry",
  async () => {
    const { reader } = await fixture();
    vi.spyOn(systemProcessOwnershipHost, "prepare").mockImplementation(
      async (signal) => {
        await reader.prepare(signal);
      },
    );
    const result = await captureProcessScenario(
      processScenarioSchema.parse({ executable: process.execPath }),
      undefined,
      "linux",
      {},
    );
    expect(result).toMatchObject({
      ok: false,
      error: {
        cleanupIncomplete: true,
        capturedOutput: {
          exit_code: 7,
          stdout: "owned compiler stdout",
          stdout_bytes: 21,
          stderr_bytes: 28,
          stderr: "controlled compiler failure\n",
        },
      },
    });
    if (result.ok) throw new Error("Expected capture preparation failure");
    fault.blocked = false;
    await reader.close();
    expect(result.error.cleanupIncomplete).toBe(false);
    expect(result.error.capturedOutput?.exit_code).toBe(7);
  },
);
