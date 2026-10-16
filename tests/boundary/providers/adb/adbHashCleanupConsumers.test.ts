import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, onTestFinished, test, vi } from "vitest";

import { AdbProvider } from "../../../../src/adb/AdbProvider.js";
import { OwnedFileHandle } from "../../../../src/filesystem/OwnedFileHandle.js";
import {
  execFileBytes,
  execFileOutput,
} from "../../../../src/process/ExecFileOutput.js";
import { projectAnalysisError } from "../../../../src/domain/analysisErrorProjection.js";
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

afterEach(() => vi.restoreAllMocks());

const fixture = async () => {
  const root = await createTestTempDirectory("rea-adb-hash-consumer-");
  const binary = join(root, "adb");
  vi.mocked(execFileOutput).mockImplementation(async () => {
    const stdout = `Android Debug Bridge version 1.0.41\nVersion 34.0.5-stub\nInstalled as ${binary}\n`;
    return {
      stdout,
      stderr: "",
      stdoutBytes: Buffer.byteLength(stdout),
      stderrBytes: 0,
    };
  });
  vi.mocked(execFileBytes).mockImplementation(async (_binary, args) => {
    const last = args.at(-1)!;
    if (args.includes("pull")) {
      await writeFile(last, "pulled bytes");
      return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    }
    if (args.includes("path") && args.includes("pm"))
      return {
        stdout: Buffer.from("package:/data/app/example/base.apk\n"),
        stderr: Buffer.alloc(0),
      };
    if (args.includes("bugreport")) {
      const staging = last;
      const archive = join(staging, "report.zip");
      await writeFile(archive, "pulled bytes");
      return {
        stdout: Buffer.from(`Bug report copied to ${archive}\n`),
        stderr: Buffer.alloc(0),
      };
    }
    return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  });
  const provider = new AdbProvider({ environment: { REA_ADB_PATH: binary } });
  onTestFinished(() => provider.close());
  const failFirstClose = () => {
    const originalClose = OwnedFileHandle.prototype.close;
    let failed = false;
    vi.spyOn(OwnedFileHandle.prototype, "close").mockImplementation(
      async function (this: OwnedFileHandle) {
        if (!failed) {
          failed = true;
          throw new Error("hash descriptor close denied");
        }
        return originalClose.call(this);
      },
    );
  };
  return { root, provider, failFirstClose };
};

test.each([
  {
    label: "single-file pull",
    retainedPath: (root: string) => join(root, "payload.bin"),
    request: (root: string) => ({
      operation: "pull_adb_file" as const,
      input: {
        serial: "device",
        device_path: "/sdcard/payload.bin",
        output_directory: root,
      },
    }),
    expected: {
      bytes: 12,
      device_path: "/sdcard/payload.bin",
      sha256: expect.any(String),
    },
  },
  {
    label: "package pull",
    retainedPath: (root: string) => join(root, "example", "base.apk"),
    request: (root: string) => ({
      operation: "pull_adb_package" as const,
      input: {
        serial: "device",
        package: "example",
        output_directory: root,
      },
    }),
    expected: {
      package_name: "example",
      coverage: "partial",
      failures: [
        { device_path: "/data/app/example/base.apk", stage: "digest" },
      ],
    },
  },
  {
    label: "bugreport collection",
    retainedPath: (root: string) => join(root, "report.zip"),
    request: (root: string) => ({
      operation: "collect_adb_bugreport" as const,
      input: { serial: "device", output_directory: root },
    }),
    expected: { bytes: 12, serial: "device", sha256: expect.any(String) },
  },
])(
  "preserves the linked hash cleanup error through $label",
  async ({ request, expected, retainedPath }) => {
    const f = await fixture();
    f.failFirstClose();
    const result = await f.provider.execute(request(f.root));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected hash descriptor cleanup failure");
    const returnedError = result.error;
    const originalCause = returnedError.cause;
    expect(returnedError.cleanupIncomplete).toBe(true);
    expect(returnedError.diagnostics).toMatchObject({
      primary_error: {
        details: { partial_observation: { result: expect.any(Object) } },
      },
    });
    expect(
      projectAnalysisError(returnedError).details?.partial_observation,
    ).toMatchObject({ result: expected });

    await f.provider.close();
    expect(returnedError.cleanupIncomplete).toBe(false);
    expect(returnedError.cause).toBe(originalCause);
    await expect(readFile(retainedPath(f.root))).resolves.toEqual(
      Buffer.from("pulled bytes"),
    );
  },
);
