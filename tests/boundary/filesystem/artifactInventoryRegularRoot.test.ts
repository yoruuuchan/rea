import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  lstat,
  open as openFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { expect, it } from "vitest";

import {
  classifyAndHashRoot,
  inventoryArtifact,
} from "../../fixtures/artifactInventory.js";
import { asarHeaderBytes } from "../../fixtures/asarHeader.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { readWithoutFifoWriter } from "../../fixtures/fifoInput.js";
import { MAX_ASAR_HEADER_BYTES } from "../../../src/artifacts/AsarHeader.js";

it.skipIf(process.platform === "win32")(
  "rejects a FIFO artifact root without waiting for a writer",
  async () => {
    const root = await createTestTempDirectory("rea-artifact-root-fifo-");
    const fifoPath = join(root, "input.asar");
    await promisify(execFile)("mkfifo", [fifoPath]);

    const outcome = await readWithoutFifoWriter(fifoPath, () =>
      inventoryArtifact(fifoPath).then(
        () => undefined,
        (cause: unknown) => cause,
      ),
    );
    expect(outcome.state).toBe("completed");
    if (outcome.state !== "completed")
      throw new Error("Artifact inventory waited for a FIFO writer");
    expect(outcome.result).toMatchObject({
      reason: "format",
      message: `Artifact root is not a regular file: ${fifoPath}`,
    });
  },
);

it("rejects a root path replaced between its initial stat and open", async () => {
  const root = await createTestTempDirectory("rea-artifact-root-replaced-");
  const path = join(root, "input.bin");
  const replacement = join(root, "replacement.bin");
  await writeFile(path, "first bytes\n");
  const expectedMetadata = await lstat(path);
  await writeFile(replacement, "different bytes\n");
  await rm(path);
  await rename(replacement, path);

  await expect(
    classifyAndHashRoot(path, false, expectedMetadata),
  ).rejects.toMatchObject({
    reason: "integrity",
    message: `Root artifact changed before inventory: ${path}`,
  });
});

it("keeps unavailable container traversal distinct from observed root bytes", async () => {
  const root = await createTestTempDirectory("rea-artifact-root-scope-");
  const path = join(root, "fixture.pkg");
  // The recognized XAR prefix selects PKG inventory; no child decoder is installed.
  await writeFile(path, Buffer.from("xar!fixture"));
  const inventory = await inventoryArtifact(path);
  expect(inventory.manifest).toMatchObject({
    root_format: "pkg",
    node_count: 1,
    occurrence_count: 1,
    edge_count: 0,
  });
  expect(inventory.occurrences[0]?.hash_status).toBe("verified");
  expect(inventory.coverage).toEqual({
    scope: "container-entries",
    status: "unknown",
  });
});

it("recognizes a root ASAR when its exact JSON extent has legal surrounding whitespace", async () => {
  const root = await createTestTempDirectory("rea-asar-root-whitespace-");
  const path = join(root, "app.asar");
  const json = ` \t\r\n${JSON.stringify({
    files: { "main.js": { size: 0, offset: "0" } },
  })}\r\n `;
  const bytes = asarHeaderBytes(json);
  await writeFile(path, bytes);

  const inventory = await inventoryArtifact(path);
  expect(inventory.manifest.root_format).toBe("asar");
  const rootNode = inventory.nodes.find(
    ({ artifact_id }) => artifact_id === inventory.manifest.root_artifact_id,
  );
  expect(rootNode?.sha256).toBe(
    createHash("sha256").update(bytes).digest("hex"),
  );
  expect(
    inventory.occurrences.map(({ logical_path }) => logical_path),
  ).toContain("main.js");
});

it("reports the bounded probe limit for an oversized ASAR candidate without penalizing opaque files", async () => {
  const root = await createTestTempDirectory("rea-asar-probe-limit-");
  const candidatePath = join(root, "large.asar");
  const opaquePath = join(root, "opaque.bin");
  const jsonObject = Buffer.from('{"files":{}}');
  const signatureOffset = MAX_ASAR_HEADER_BYTES + 9;
  const whitespaceBytes = signatureOffset - 16;
  const jsonBytes = whitespaceBytes + jsonObject.length;
  const headerBytes = 8 + Math.ceil(jsonBytes / 4) * 4;
  const archiveBytes = 8 + headerBytes;
  const fixed = Buffer.alloc(16);
  fixed.writeUInt32LE(4, 0);
  fixed.writeUInt32LE(headerBytes, 4);
  fixed.writeUInt32LE(headerBytes - 4, 8);
  fixed.writeUInt32LE(jsonBytes, 12);

  const handle = await openFile(candidatePath, "w");
  try {
    const writeAt = async (bytes: Buffer, start: number): Promise<void> => {
      let written = 0;
      while (written < bytes.length) {
        const result = await handle.write(
          bytes,
          written,
          bytes.length - written,
          start + written,
        );
        if (result.bytesWritten === 0)
          throw new Error("Could not write ASAR signature fixture");
        written += result.bytesWritten;
      }
    };
    await writeAt(fixed, 0);
    const spaces = Buffer.alloc(64 * 1024, 0x20);
    let position = 16;
    while (position < signatureOffset) {
      const count = Math.min(spaces.length, signatureOffset - position);
      await writeAt(spaces.subarray(0, count), position);
      position += count;
    }
    await writeAt(jsonObject, signatureOffset);
    await handle.truncate(archiveBytes);
  } finally {
    await handle.close();
  }

  await writeFile(opaquePath, "ordinary opaque bytes");
  await expect(inventoryArtifact(candidatePath)).rejects.toMatchObject({
    reason: "limit",
  });
  expect((await inventoryArtifact(opaquePath)).manifest.root_format).toBe(
    "file",
  );
});
