import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir, realpath } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
const sha = (value) => createHash("sha256").update(value).digest("hex");

/** Bind a trial to its source checkout and the compiled CLI actually launched. */
export const captureRuntimeBinding = async (runtime) => {
  const root = await realpath(runtime);
  const git = (args) =>
    execFileSync("git", args, { cwd: root, maxBuffer: 16 * 1024 * 1024 });
  const gitRevision = git(["rev-parse", "HEAD"]).toString().trim();
  const sourcePaths = ["src", "scripts", "package.json", "package-lock.json"];
  const sourceDiff = git([
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--binary",
    "HEAD",
    "--",
    ...sourcePaths,
  ]);
  const untracked = git([
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
    "--",
    ...sourcePaths,
  ])
    .toString()
    .split("\0")
    .filter(Boolean)
    .sort();
  const untrackedEntries = [];
  for (const name of untracked)
    untrackedEntries.push([name, sha(await readFile(join(root, name)))]);
  const files = ["scripts/rea.mjs", "package.json", "package-lock.json"];
  const visit = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )) {
      const path = join(directory, entry.name);
      assert.ok(!entry.isSymbolicLink(), `Unbound compiled CLI link: ${path}`);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && /\.(?:[cm]?js|json)$/.test(entry.name))
        files.push(relative(root, path));
    }
  };
  await visit(join(root, "dist/cli-runtime"));
  assert.ok(
    files.includes(join("dist", "cli-runtime", "cli.js")),
    "Missing compiled CLI entry",
  );
  const hash = createHash("sha256");
  let bytes = 0;
  for (const name of files.sort()) {
    const value = await readFile(join(root, name));
    bytes += value.length;
    hash.update(JSON.stringify([name, value.length, sha(value)]) + "\n");
  }
  return {
    binding_version: 1,
    root,
    node: process.version,
    git_revision: gitRevision,
    source_diff_sha256: sha(sourceDiff),
    untracked_source_sha256: sha(JSON.stringify(untrackedEntries)),
    compiled_cli_sha256: hash.digest("hex"),
    compiled_cli_files: files.length,
    compiled_cli_bytes: bytes,
  };
};

export const assertRuntimeBinding = (actual, expected, mode) => {
  assert.ok(expected, `Missing expected runtime binding for ${mode}`);
  assert.deepEqual(actual, expected, `Runtime binding differs for ${mode}`);
};

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  console.log(
    JSON.stringify(await captureRuntimeBinding(process.argv[2]), null, 2),
  );
}
