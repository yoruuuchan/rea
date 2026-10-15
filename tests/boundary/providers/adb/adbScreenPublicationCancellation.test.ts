import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, onTestFinished, test, vi } from "vitest";

import { AdbProvider } from "../../../../src/adb/AdbProvider.js";
import { parseEvidence } from "../../../../src/domain/evidence.js";
import {
  execFileBytes,
  execFileOutput,
} from "../../../../src/process/ExecFileOutput.js";
import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";

vi.mock(
  "../../../../src/process/ExecFileOutput.js",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../../../src/process/ExecFileOutput.js")
    >()),
    execFileBytes: vi.fn(),
    execFileOutput: vi.fn(),
  }),
);
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, writeFile: vi.fn(actual.writeFile) };
});

afterEach(() => vi.restoreAllMocks());

const fixture = async () => {
  const root = await createTestTempDirectory("rea-adb-screen-cancel-");
  const binary = join(root, "adb");
  const stdout = `Android Debug Bridge version 1.0.41\nVersion 34.0.5-stub\nInstalled as ${binary}\n`;
  vi.mocked(execFileOutput).mockResolvedValue({
    stdout,
    stderr: "",
    stdoutBytes: Buffer.byteLength(stdout),
    stderrBytes: 0,
  });
  const provider = new AdbProvider({ environment: { REA_ADB_PATH: binary } });
  onTestFinished(() => provider.close());
  return {
    root,
    provider,
    png: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jv4sAAAAASUVORK5CYII=",
      "base64",
    ),
  };
};

test("does not publish a screen capture cancelled before the commit point", async () => {
  const f = await fixture();
  const controller = new AbortController();
  vi.mocked(execFileBytes).mockImplementationOnce(async () => {
    controller.abort();
    return { stdout: f.png, stderr: Buffer.alloc(0) };
  });
  const output = join(f.root, "captures");
  const result = await f.provider.execute(
    {
      operation: "capture_adb_screen",
      input: { serial: "device", output_directory: output },
    },
    { signal: controller.signal },
  );
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected cancellation");
  expect(result.error._tag).toBe("AnalysisCancelledError");
  await expect(readFile(join(output, "screen.png"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  await f.provider.close();
});

test("retains a committed screen capture receipt when cancellation arrives after commit", async () => {
  const f = await fixture();
  const controller = new AbortController();
  vi.mocked(execFileBytes).mockResolvedValueOnce({
    stdout: f.png,
    stderr: Buffer.alloc(0),
  });
  const actualFs =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  vi.mocked(writeFile).mockImplementationOnce(async (...args) => {
    await actualFs.writeFile(...args);
    controller.abort();
  });
  const output = join(f.root, "captures");
  const result = await f.provider.execute(
    {
      operation: "capture_adb_screen",
      input: { serial: "device", output_directory: output },
    },
    { signal: controller.signal },
  );
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected cancellation");
  expect(result.error._tag).toBe("AnalysisCancelledError");
  const evidence = parseEvidence(result.error.partialObservation);
  expect(evidence).toMatchObject({
    provider: { id: "adb" },
    operation: "capture_adb_screen",
    confidence: "observed",
    parameters: { serial: "device", output_directory: output },
    normalized_result: {
      local_path: join(output, "screen.png"),
      bytes: f.png.byteLength,
      sha256: createHash("sha256").update(f.png).digest("hex"),
      width: 1,
      height: 1,
    },
  });
  expect(await readFile(join(output, "screen.png"))).toEqual(f.png);
  await f.provider.close();
});
