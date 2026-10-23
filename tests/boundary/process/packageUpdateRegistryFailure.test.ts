import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

import { expect, it } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const execFileAsync = promisify(execFile);
const injectedFailure = "injected upstream body failure";

it("reports the upstream body failure instead of a second header write", async () => {
  const testRoot = await createTestTempDirectory("rea-update-registry-");
  const packageRoot = join(testRoot, "package");
  const workspace = join(testRoot, "workspace");
  const prefix = join(testRoot, "prefix");
  const tarball = join(testRoot, "release.tgz");
  const application = join(packageRoot, "dist", "application");
  await Promise.all([
    mkdir(application, { recursive: true }),
    mkdir(join(packageRoot, "scripts"), { recursive: true }),
    mkdir(workspace, { recursive: true }),
    mkdir(prefix, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(tarball, "archive"),
    writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify({ name: "rea-agents", version: "6.0.0" }),
    ),
    writeFile(
      join(packageRoot, "dist", "generatedPackageMetadata.js"),
      'export const generated = { version: "6.0.0" };\n',
    ),
    writeFile(
      join(packageRoot, "scripts", "rea.mjs"),
      [
        'import { readFileSync } from "node:fs";',
        'const metadata = new URL("../package.json", import.meta.url);',
        "console.log(JSON.parse(readFileSync(metadata, 'utf8')).version);",
        "",
      ].join("\n"),
    ),
    writeFile(
      join(application, "Update.js"),
      [
        "export async function runUpdate() {",
        "  const registry = process.env.npm_config_registry;",
        "  const response = await fetch(`${registry}/unlisted`, {",
        "    signal: AbortSignal.timeout(5000),",
        "  });",
        "  const body = await response.text();",
        "  throw new Error(`registry fixture answered ${response.status}: ${body}`);",
        "}",
        "",
      ].join("\n"),
    ),
    writeFile(
      join(application, "UpdateRuntime.js"),
      "export const systemUpdateHost = () => ({});\n",
    ),
  ]);
  const verifierUrl = pathToFileURL(
    resolve("scripts/verify-package-update.mjs"),
  ).href;
  const harness = `
globalThis.fetch = async () => ({
  status: 200,
  headers: new Headers({ "content-type": "application/json" }),
  arrayBuffer: async () => {
    throw new Error(${JSON.stringify(injectedFailure)});
  },
});
const { verifyPackageUpdate } = await import(${JSON.stringify(verifierUrl)});
let failure;
try {
  await verifyPackageUpdate({
    prefix: ${JSON.stringify(prefix)},
    packageRoot: ${JSON.stringify(packageRoot)},
    tarball: ${JSON.stringify(tarball)},
    workspace: ${JSON.stringify(workspace)},
    environment: { PATH: process.env.PATH },
  });
} catch (cause) {
  failure = cause instanceof Error ? cause.message : String(cause);
}
process.stdout.write(JSON.stringify({ failure }));
`;
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--input-type=module", "--eval", harness],
    { env: { ...process.env }, maxBuffer: 1_024 * 1_024, timeout: 30_000 },
  );

  expect(JSON.parse(stdout)).toEqual({ failure: injectedFailure });
}, 45_000);
