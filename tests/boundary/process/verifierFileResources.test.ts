import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

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
