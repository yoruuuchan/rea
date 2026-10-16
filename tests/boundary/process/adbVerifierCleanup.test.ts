import { spawn } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { expect, it } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const providerModule = `
import { writeFile } from "node:fs/promises";

export function createAdbDeviceAnalysisProvider() {
  return {
    async close() {
      await writeFile(process.env.REA_ADB_TEST_CLOSE_MARKER, "closed");
      if (process.env.REA_ADB_TEST_CLOSE_FAILURE === "1")
        throw new Error("fake provider close failed");
    },
  };
}
`;

const serviceModule = `
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const transferBytes = Buffer.from("rea adb transfer verification\\n");
const transferDigest = createHash("sha256").update(transferBytes).digest("hex");
const packageBytes = Buffer.from("fake package artifact");
const packageDigest = createHash("sha256").update(packageBytes).digest("hex");
const packages = [{
  package_name: "com.example",
  base_apk_device_path: "/data/app/example/base.apk",
}];

export class AdbDeviceAnalysisService {
  async execute(operation, input) {
    if (process.env.REA_ADB_TEST_THROW === operation)
      throw new Error("fake operation threw");

    if (operation === "pull_adb_package") {
      await mkdir(input.output_directory, { recursive: true });
      const local_path = join(input.output_directory, "base.apk");
      await writeFile(local_path, packageBytes);
      return {
        ok: true,
        value: {
          normalized_result: {
            artifacts: [{
              local_path,
              file_name: "base.apk",
              bytes: packageBytes.length,
              sha256: packageDigest,
              role: "base",
            }],
            coverage: "complete",
          },
        },
      };
    }

    const results = {
      inspect_adb_client: {
        client: { version: "test", binary_path: "/fake/adb" },
      },
      list_adb_devices: {
        devices: [{ serial: "test-device", state: "device", kind: "emulator" }],
      },
      inspect_adb_device: {
        properties: [{ name: "ro.build.version.sdk", value: "35" }],
        emulator_observed: true,
      },
      list_adb_processes: { processes: [{ name: "system" }], columns: "PID NAME" },
      inspect_adb_window: { focused_window: null },
      inspect_adb_display: {
        physical_size: { width: 1, height: 1 },
        physical_density: 1,
      },
      read_adb_setting: { value: "1" },
      read_adb_logcat: { lines: [], coverage: "complete" },
      list_adb_features: { features: ["test-feature"], coverage: "complete" },
      list_adb_services: { services: ["test-service"], coverage: "complete" },
      list_adb_directory: { entries: [], coverage: "complete" },
      list_adb_packages: { packages, coverage: "complete" },
      push_adb_file: {
        bytes: transferBytes.length,
        sha256: transferDigest,
        device_digest_source: "device_sha256sum",
        device_sha256: transferDigest,
      },
      pull_adb_file: { bytes: transferBytes.length, sha256: transferDigest },
      capture_adb_screen: { width: 1, height: 1, bytes: 1 },
    };
    const normalized_result = results[operation];
    if (normalized_result === undefined)
      throw new Error("unexpected fake operation: " + operation);
    return { ok: true, value: { normalized_result } };
  }
}
`;

async function createVerifierFixture() {
  const root = await createTestTempDirectory("rea-adb-verifier-cleanup-");
  const scriptDirectory = join(root, "scripts");
  const scriptLibDirectory = join(scriptDirectory, "lib");
  const applicationDirectory = join(root, "dist/application/adb");
  const compositionDirectory = join(root, "dist/composition");
  await Promise.all([
    mkdir(scriptDirectory, { recursive: true }),
    mkdir(scriptLibDirectory, { recursive: true }),
    mkdir(applicationDirectory, { recursive: true }),
    mkdir(compositionDirectory, { recursive: true }),
  ]);
  const scriptPath = join(scriptDirectory, "verify-adb.mjs");
  const closeMarker = join(root, "provider-closed");
  await Promise.all([
    copyFile(resolve("scripts/verify-adb.mjs"), scriptPath),
    copyFile(
      resolve("scripts/lib/verifier-cleanup.mjs"),
      join(scriptLibDirectory, "verifier-cleanup.mjs"),
    ),
    writeFile(join(root, "package.json"), '{"type":"module"}\n'),
    writeFile(
      join(applicationDirectory, "AdbDeviceAnalysisService.js"),
      serviceModule,
    ),
    writeFile(join(compositionDirectory, "adb.js"), providerModule),
  ]);
  return { root, scriptPath, closeMarker };
}

function runVerifier(
  root: string,
  scriptPath: string,
  closeMarker: string,
  extraEnvironment: Record<string, string> = {},
) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolveResult, reject) => {
      const child = spawn(process.execPath, [scriptPath], {
        cwd: root,
        env: {
          ...process.env,
          REA_ADB_TEST_CLOSE_MARKER: closeMarker,
          ...extraEnvironment,
        },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
      child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
      child.once("error", reject);
      child.once("close", (code) => resolveResult({ code, stdout, stderr }));
    },
  );
}

it("fails verification when provider cleanup fails after successful checks", async () => {
  const fixture = await createVerifierFixture();
  const result = await runVerifier(
    fixture.root,
    fixture.scriptPath,
    fixture.closeMarker,
    { REA_ADB_TEST_CLOSE_FAILURE: "1" },
  );

  expect(result.code).not.toBe(0);
  expect(await readFile(fixture.closeMarker, "utf8")).toBe("closed");
  expect(result.stdout + result.stderr).toContain("fake provider close failed");
  expect(result.stdout).not.toContain("all adb device checks passed");
});

it("runs cleanup and retains operation and cleanup failures", async () => {
  const fixture = await createVerifierFixture();
  const result = await runVerifier(
    fixture.root,
    fixture.scriptPath,
    fixture.closeMarker,
    {
      REA_ADB_TEST_THROW: "inspect_adb_client",
      REA_ADB_TEST_CLOSE_FAILURE: "1",
    },
  );

  expect(result.code).not.toBe(0);
  expect(await readFile(fixture.closeMarker, "utf8")).toBe("closed");
  expect(result.stdout + result.stderr).toContain("fake operation threw");
  expect(result.stdout + result.stderr).toContain("fake provider close failed");
  expect(result.stdout).not.toContain("all adb device checks passed");
});

it("reports success after successful verification and provider cleanup", async () => {
  const fixture = await createVerifierFixture();
  const result = await runVerifier(
    fixture.root,
    fixture.scriptPath,
    fixture.closeMarker,
  );

  expect(result.code).toBe(0);
  expect(await readFile(fixture.closeMarker, "utf8")).toBe("closed");
  expect(result.stdout).toContain("all adb device checks passed");
});
