import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";
import ts from "typescript6";
import type { inspectVerifierGhidraInstallation } from "../../../scripts/lib/ghidra-installation-inspection.mjs";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it("retains and retries the exact descriptor after a verifier hash close failure", async () => {
  const directory = await createTestTempDirectory("rea-verifier-file-");
  const path = join(directory, "input.bin");
  const bytes = Buffer.from("owned verifier fixture");
  await writeFile(path, bytes);
  const script = `
    import { ArtifactResourceScope } from ${JSON.stringify(new URL("../../../dist/artifacts/ArtifactResourceScope.js", import.meta.url).href)};
    import { OwnedFileHandle } from ${JSON.stringify(new URL("../../../dist/filesystem/OwnedFileHandle.js", import.meta.url).href)};
    import { hashVerifierFile } from ${JSON.stringify(new URL("../../../scripts/lib/verifier-file-resources.mjs", import.meta.url).href)};
    const path = process.argv[1];
    const resources = new ArtifactResourceScope();
    const originalClose = OwnedFileHandle.prototype.close;
    let attempts = 0;
    OwnedFileHandle.prototype.close = async function () {
      attempts += 1;
      if (attempts === 1) throw new Error("fixture close failure");
      return originalClose.call(this);
    };
    let failure;
    try { await hashVerifierFile(path, resources); } catch (cause) { failure = cause; }
    try {
      if (failure?.outcome?.kind !== "completed" || failure.retention?.kind !== "callback_returned") throw new Error("Completed hash was not retained");
      if (failure.outcome.value.sha256 !== process.env.EXPECTED_SHA256) throw new Error("Completed digest was lost");
      if (!resources.hasPending) throw new Error("Failed descriptor was not retained");
    } finally {
      await resources.close();
    }
    if (attempts !== 2 || resources.hasPending) throw new Error("Exact descriptor did not close on retry");
    console.log(JSON.stringify({ attempts, retained: true, retried: true }));
  `;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", script, path],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        EXPECTED_SHA256: createHash("sha256").update(bytes).digest("hex"),
      },
    },
  );
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  expect(JSON.parse(result.stdout.trim())).toEqual({
    attempts: 2,
    retained: true,
    retried: true,
  });
});

it("hashes and closes a clean verifier input", async () => {
  const directory = await createTestTempDirectory("rea-verifier-file-");
  const path = join(directory, "input.bin");
  const bytes = Buffer.from("clean verifier fixture");
  await writeFile(path, bytes);
  const script = `
    import { ArtifactResourceScope } from ${JSON.stringify(new URL("../../../dist/artifacts/ArtifactResourceScope.js", import.meta.url).href)};
    import { hashVerifierFile } from ${JSON.stringify(new URL("../../../scripts/lib/verifier-file-resources.mjs", import.meta.url).href)};
    const resources = new ArtifactResourceScope();
    const identity = await hashVerifierFile(process.argv[1], resources);
    await resources.close();
    console.log(JSON.stringify(identity));
  `;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", script, path],
    {
      encoding: "utf8",
    },
  );
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  expect(JSON.parse(result.stdout.trim())).toEqual({
    bytes: bytes.length,
    sha256: createHash("sha256")
      .update(await readFile(path))
      .digest("hex"),
  });
});

it("Ghidra verifier probes await the shared owned inspection contract", async () => {
  const names = (await readdir("scripts")).filter(
    (name) => name.startsWith("verify-real-ghidra") && name.endsWith(".mjs"),
  );
  const paths = [
    ...names.map((name) => `scripts/${name}`),
    "scripts/lib/real-ghidra-namespace-annotations.mjs",
  ];
  const probes: string[] = [];
  const violations: { path: string; reason: string }[] = [];
  for (const path of paths) {
    const source = ts.createSourceFile(
      path,
      await readFile(path, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        [
          "inspectGhidraInstallation",
          "inspectVerifierGhidraInstallation",
        ].includes(node.expression.text)
      ) {
        probes.push(path);
        if (!ts.isAwaitExpression(node.parent))
          violations.push({
            path,
            reason: "installation result was not awaited",
          });
        if (node.expression.text !== "inspectVerifierGhidraInstallation")
          violations.push({
            path,
            reason: "inspection has no shared cleanup owner",
          });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  expect(probes.length).toBeGreaterThan(0);
  expect(violations).toEqual([]);
});

it("firmware verifier loads its current hash API before reporting unavailable prerequisites", () => {
  const result = spawnSync(
    process.execPath,
    ["scripts/verify/firmware/analysis.mjs"],
    {
      encoding: "utf8",
      timeout: 10_000,
      env: { PATH: process.env.PATH ?? "" },
    },
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(
    process.platform === "linux"
      ? "requires REA_BINWALK_COMMAND"
      : "requires Linux",
  );
  expect(result.stderr).not.toContain("does not provide an export");
});

it.each(["late-close", "retry-close", "retained-close", "opaque-cancellation"])(
  "owns Ghidra verifier prerequisite finalization: %s",
  async (mode) => {
    const root = await createTestTempDirectory("rea-verifier-ghidra-owner-");
    const options = {
      environment: {},
      installDir: root,
      platform: process.platform,
      architecture: "x64",
    } satisfies Parameters<typeof inspectVerifierGhidraInstallation>[0];
    const script = String.raw`
      import assert from 'node:assert/strict';
      import { mkdir, open, writeFile } from 'node:fs/promises';
      import { join } from 'node:path';
      import { inspectVerifierGhidraInstallation } from ${JSON.stringify(new URL("../../../scripts/lib/ghidra-installation-inspection.mjs", import.meta.url).href)};
      import { systemGhidraInstallationHost } from ${JSON.stringify(new URL("../../../dist/ghidra/GhidraInstallation.js", import.meta.url).href)};
      import { SUPPORTED_GHIDRA_VERSION, SUPPORTED_GHIDRA_JAVA_MAJOR } from ${JSON.stringify(new URL("../../../dist/ghidra/GhidraReleasePolicy.js", import.meta.url).href)};
      import { OwnedFileHandle } from ${JSON.stringify(new URL("../../../dist/filesystem/OwnedFileHandle.js", import.meta.url).href)};
      import { RegularFileCleanupFailure } from ${JSON.stringify(new URL("../../../dist/filesystem/OwnedRegularFile.js", import.meta.url).href)};
      import { ArtifactResourceRetryFailure } from ${JSON.stringify(new URL("../../../dist/artifacts/ArtifactResourceScope.js", import.meta.url).href)};
      const root = process.argv[1], mode = process.argv[2], options = JSON.parse(process.argv[3]);
      await mkdir(join(root, 'Ghidra'));
      await writeFile(join(root, 'Ghidra', 'application.properties'), 'application.version=' + SUPPORTED_GHIDRA_VERSION + '\napplication.java.min=' + SUPPORTED_GHIDRA_JAVA_MAJOR + '\n');
      const controller = new AbortController();
      let foreign;
      if (mode === 'opaque-cancellation') {
        const path = join(root, 'foreign'); await writeFile(path, 'foreign');
        foreign = new OwnedFileHandle(await open(path, 'r'));
        controller.abort(new RegularFileCleanupFailure(path, foreign, { kind: 'completed', value: 'opaque' }, new Error('not this inspection owner')));
      }
      let entered, release;
      const entering = new Promise(resolve => { entered = resolve; });
      const finishing = new Promise(resolve => { release = resolve; });
      const handles = new Set();
      let attempts = 0, denied = true;
      const originalClose = OwnedFileHandle.prototype.close;
      OwnedFileHandle.prototype.close = async function () {
        handles.add(this.handle); attempts++;
        if (mode === 'late-close' && attempts === 1) { entered(); await finishing; }
        if ((mode === 'retry-close' && attempts === 1) || (mode === 'retained-close' && denied)) throw new Error('controlled inspection close refusal');
        return originalClose.call(this);
      };
      const host = {
        ...systemGhidraInstallationHost(),
        executable: () => true,
        executableHeader: () => ({ ok: true, value: undefined }),
        probeJava: async () => ({ ok: true, value: { major: SUPPORTED_GHIDRA_JAVA_MAJOR, version: '21.0.11', home: '/fixture/jdk', bits: 64, runtime: 'jdk', osArch: 'amd64', osName: options.platform === 'win32' ? 'Windows' : options.platform === 'darwin' ? 'Mac OS X' : 'Linux' } }),
      };
      let settled = false;
      const pending = inspectVerifierGhidraInstallation({ ...options, signal: controller.signal }, host).then(
        value => { settled = true; return { value }; },
        error => { settled = true; return { error }; },
      );
      try {
        if (mode === 'late-close') { await entering; assert.equal(settled, false); release(); }
        const outcome = await pending;
        if (mode === 'late-close') { assert.equal(outcome.value?.status, 'available'); assert.equal(handles.size, 1); }
        else if (mode === 'retry-close') {
          assert.ok(outcome.error); assert.equal(outcome.error.cleanupIncomplete, false);
          assert.ok(attempts >= 2); assert.equal(handles.size, 1);
        } else if (mode === 'retained-close') {
          assert.ok(outcome.error instanceof AggregateError);
          const primary = outcome.error.errors.find(error => error.cleanupIncomplete === true);
          const cleanup = outcome.error.errors.find(error => error instanceof ArtifactResourceRetryFailure);
          assert.ok(primary); assert.ok(cleanup); assert.ok(cleanup.cleanupLeases.length > 0);
          denied = false;
          for (const lease of cleanup.cleanupLeases) await lease.release();
          assert.equal(primary.cleanupIncomplete, false);
          assert.equal(handles.size, 1);
        } else {
          assert.equal(outcome.error?._tag, 'AnalysisCancelledError');
          assert.equal(outcome.error.cause, controller.signal.reason);
          assert.equal(handles.size, 0); assert.ok(foreign.handle.fd >= 0);
        }
        for (const handle of handles) assert.equal(handle.fd, -1);
        console.log(JSON.stringify({ mode, verified: true }));
      } finally {
        denied = false; release();
        await pending;
        OwnedFileHandle.prototype.close = originalClose;
        for (const handle of handles) await handle.close();
        await foreign?.close();
      }
    `;
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        script,
        root,
        mode,
        JSON.stringify(options),
      ],
      { encoding: "utf8", timeout: 10_000 },
    );
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({ mode, verified: true });
  },
);

it("Ghidra verifier awaits native prerequisite rejection before creating target fixtures", async () => {
  const root = await createTestTempDirectory(
    "rea-verifier-ghidra-prerequisite-",
  );
  const result = spawnSync(
    process.execPath,
    ["scripts/verify-real-ghidra.mjs"],
    {
      encoding: "utf8",
      timeout: 10_000,
      env: {
        // Keep native process inspectors available; the selected JDK and Ghidra are absent.
        PATH: process.env.PATH ?? "",
        HOME: root,
        USERPROFILE: root,
        GHIDRA_INSTALL_DIR: join(root, "absent-installation"),
        JAVA_HOME: join(root, "absent-jdk"),
      },
    },
  );
  expect(result.status, result.stderr).toBe(1);
  expect(result.stderr).toContain(
    'Ghidra installation is unavailable: {"status":"unavailable"',
  );
  expect(result.stderr).not.toContain("TypeError");
  expect(result.stderr).not.toContain("Ghidra installation is unavailable: {}");
});
