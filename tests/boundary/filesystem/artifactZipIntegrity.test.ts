import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { TextReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { expect, it } from "vitest";

import { writeOrderedZip } from "../../fixtures/artifactEntryOrder.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

import { parseBinaryTarget } from "../../../src/application/BinaryTargetResolver.js";
import { ArtifactProvider } from "../../../src/artifacts/ArtifactProvider.js";
import { ZipArtifactReader } from "../../../src/artifacts/ZipArtifactReader.js";
import { artifactInventoryResultSchema } from "../../../src/domain/artifactGraph.js";

it("bounds a requested metadata read without rejecting the underlying valid ZIP", async () => {
  const root = await createTestTempDirectory("rea-zip-metadata-budget-");
  const path = join(root, "large-directory.zip");
  const name = `${"a".repeat(8192)}.class`;
  await writeOrderedZip(path, [name]);
  const bounded = new ZipArtifactReader(path, "zip", 4096);
  const control = new ZipArtifactReader(path, "zip");
  const collect = async (reader: ZipArtifactReader): Promise<string[]> => {
    const names: string[] = [];
    for await (const entry of reader.entries()) names.push(entry.path);
    return names;
  };
  try {
    await expect(collect(bounded)).rejects.toMatchObject({
      reason: "limit",
      message: expect.stringContaining("4096-byte read budget"),
    });
    await expect(collect(control)).resolves.toEqual([name]);
  } finally {
    await Promise.all([bounded.close(), control.close()]);
  }
});

it("binds ZIP opens to the emitted entry metadata", async () => {
  const root = await createTestTempDirectory("rea-zip-entry-identity-");
  const path = join(root, "entries.zip");
  const writer = new ZipWriter(new Uint8ArrayWriter());
  await writer.add("first.txt", new TextReader("first bytes"));
  await writer.add("second.txt", new TextReader("second bytes"));
  await writeFile(path, await writer.close());

  const reader = new ZipArtifactReader(path, "zip");
  try {
    const entries = [];
    for await (const entry of reader.entries()) entries.push(entry);
    const first = entries[0];
    const second = entries[1];
    if (first === undefined || second === undefined)
      throw new Error("Expected both ZIP entries");

    await expect(
      reader.open({ ...second, adapterKey: first.adapterKey }),
    ).rejects.toMatchObject({ reason: "integrity" });
    await expect(
      reader.open({ ...second, path: first.path }),
    ).rejects.toMatchObject({ reason: "integrity" });
    await expect(
      reader.open({ ...second, declaredSize: first.declaredSize }),
    ).rejects.toMatchObject({ reason: "integrity" });
    const originalKey = second.adapterKey;
    Reflect.set(second, "adapterKey", first.adapterKey);
    await expect(reader.open(second)).rejects.toMatchObject({
      reason: "integrity",
    });
    Reflect.set(second, "adapterKey", originalKey);

    const stream = await reader.open({ ...second });
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString()).toBe("second bytes");
  } finally {
    await reader.close();
  }
});

it("rejects duplicate ZIP names before replacing an emitted entry", async () => {
  const root = await createTestTempDirectory("rea-zip-duplicate-identity-");
  const path = join(root, "duplicates.zip");
  const writer = new ZipWriter(new Uint8ArrayWriter());
  await writer.add("x.txt", new TextReader("first bytes\n"), { level: 0 });
  await writer.add("y.txt", new TextReader("later bytes\n"), { level: 0 });
  const bytes = Buffer.from(await writer.close());
  // zip.js refuses to produce duplicate names. Rename the second local and
  // central-directory records without changing their data, sizes, or CRCs.
  for (const [signature, headerSize] of [
    [Buffer.from([0x50, 0x4b, 0x03, 0x04]), 30],
    [Buffer.from([0x50, 0x4b, 0x01, 0x02]), 46],
  ] as const) {
    const first = bytes.indexOf(signature);
    const second = bytes.indexOf(signature, first + 4);
    if (first < 0 || second <= first)
      throw new Error("Expected both ZIP member headers");
    expect(
      bytes.subarray(second + headerSize, second + headerSize + 5).toString(),
    ).toBe("y.txt");
    bytes.write("x.txt", second + headerSize);
  }
  await writeFile(path, bytes);

  const reader = new ZipArtifactReader(path, "zip");
  try {
    const iterator = reader.entries()[Symbol.asyncIterator]();
    const first = await iterator.next();
    if (first.done) throw new Error("Expected the first ZIP member");
    await expect(iterator.next()).rejects.toMatchObject({ reason: "path" });
    const stream = await reader.open({ ...first.value });
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString()).toBe("first bytes\n");
  } finally {
    await reader.close();
  }

  const target = await parseBinaryTarget(path);
  if (!target.ok) throw target.error;
  const client = new ArtifactProvider(process.env).createClient(target.value);
  try {
    expect(await client.execute("inventory_artifact", {})).toMatchObject({
      ok: false,
      error: { _tag: "ArtifactOperationError", reason: "path" },
    });
  } finally {
    await client.close();
  }
});

it("can enumerate case-distinct ZIP members again without losing entry identity", async () => {
  const root = await createTestTempDirectory("rea-zip-entry-replay-");
  const path = join(root, "case-distinct.zip");
  const writer = new ZipWriter(new Uint8ArrayWriter());
  await writer.add("x.txt", new TextReader("first bytes\n"), { level: 0 });
  await writer.add("X.txt", new TextReader("later bytes\n"), { level: 0 });
  await writeFile(path, await writer.close());

  const reader = new ZipArtifactReader(path, "zip");
  try {
    for (let pass = 0; pass < 2; pass++) {
      const entries = [];
      for await (const entry of reader.entries()) entries.push(entry);
      expect(entries.map(({ path: entryPath }) => entryPath)).toEqual([
        "x.txt",
        "X.txt",
      ]);
      const contents = [];
      for (const entry of entries) {
        const chunks: Buffer[] = [];
        for await (const chunk of await reader.open({ ...entry }))
          chunks.push(Buffer.from(chunk));
        contents.push(Buffer.concat(chunks).toString());
      }
      expect(contents).toEqual(["first bytes\n", "later bytes\n"]);
    }
  } finally {
    await reader.close();
  }
});

it("rejects overlapping ZIP member data ranges through artifact inventory", async () => {
  const root = await createTestTempDirectory("rea-zip-overlap-");
  const path = join(root, "overlap.zip");
  await writeOrderedZip(path, ["a.txt", "b.txt"]);
  const bytes = await readFile(path);
  const centralDirectorySignature = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
  const first = bytes.indexOf(centralDirectorySignature);
  const second = bytes.indexOf(centralDirectorySignature, first + 4);
  if (first < 0 || second <= first)
    throw new Error("Expected two ZIP central-directory entries");

  const firstLocalOffset = bytes.readUInt32LE(first + 42);
  const secondLocalOffset = bytes.readUInt32LE(second + 42);
  expect(secondLocalOffset).not.toBe(firstLocalOffset);
  bytes.writeUInt32LE(firstLocalOffset, second + 42);
  await writeFile(path, bytes);

  const target = await parseBinaryTarget(path);
  if (!target.ok) throw target.error;
  const result = await new ArtifactProvider(process.env)
    .createClient(target.value)
    .execute("inventory_artifact", {});

  expect(result).toMatchObject({
    ok: false,
    error: { _tag: "ArtifactOperationError", reason: "io" },
  });
});

it("preserves encrypted-member and corrupt-CRC observations", async () => {
  const root = await createTestTempDirectory("rea-zip-integrity-");
  const encryptedPath = join(root, "encrypted.zip");
  const encryptedWriter = new ZipWriter(new Uint8ArrayWriter());
  await encryptedWriter.add("secret.txt", new TextReader("secret bytes"), {
    password: "fixture-password",
  });
  await writeFile(encryptedPath, await encryptedWriter.close());

  const encryptedTarget = await parseBinaryTarget(encryptedPath);
  if (!encryptedTarget.ok) throw encryptedTarget.error;
  const encryptedResult = await new ArtifactProvider(process.env)
    .createClient(encryptedTarget.value)
    .execute("inventory_artifact", {});
  if (!encryptedResult.ok) throw encryptedResult.error;
  const encryptedInventory = artifactInventoryResultSchema.parse(
    encryptedResult.value.result,
  );
  expect(encryptedInventory.occurrences).toContainEqual(
    expect.objectContaining({
      logical_path: "secret.txt",
      encrypted: true,
      hash_status: "unavailable",
    }),
  );
  // REA does not decrypt entries, so complete extraction is unsupported.
  const extractionRoot = join(root, "encrypted-output");
  expect(
    await new ArtifactProvider(process.env)
      .createClient(encryptedTarget.value)
      .execute("extract_artifact", { output_root: extractionRoot }),
  ).toMatchObject({
    ok: false,
    error: {
      _tag: "AnalysisUnsupportedTargetError",
      reason: expect.stringContaining("Archive entry secret.txt is encrypted"),
    },
  });
  await expect(readFile(extractionRoot)).rejects.toMatchObject({
    code: "ENOENT",
  });

  const corruptPath = join(root, "corrupt-crc.zip");
  const corruptWriter = new ZipWriter(new Uint8ArrayWriter());
  await corruptWriter.add("data.txt", new TextReader("evidence\n"));
  await writeFile(corruptPath, await corruptWriter.close());
  const bytes = await readFile(corruptPath);
  const localFileHeaderSignature = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
  const localHeader = bytes.indexOf(localFileHeaderSignature);
  if (localHeader < 0) throw new Error("Expected a ZIP local-file header");
  const dataOffset =
    localHeader +
    30 +
    bytes.readUInt16LE(localHeader + 26) +
    bytes.readUInt16LE(localHeader + 28);
  const firstByte = bytes[dataOffset];
  if (firstByte === undefined) throw new Error("Expected ZIP member bytes");
  bytes[dataOffset] = firstByte ^ 1;
  await writeFile(corruptPath, bytes);

  const corruptTarget = await parseBinaryTarget(corruptPath);
  if (!corruptTarget.ok) throw corruptTarget.error;
  const corruptResult = await new ArtifactProvider(process.env)
    .createClient(corruptTarget.value)
    .execute("inventory_artifact", {});
  expect(corruptResult).toMatchObject({
    ok: false,
    error: { _tag: "ArtifactOperationError", reason: "io" },
  });
});

it("rejects a truncated ZIP through artifact inventory", async () => {
  const root = await createTestTempDirectory("rea-zip-malformed-");
  const path = join(root, "truncated.zip");
  await writeFile(path, Buffer.from([0x50, 0x4b, 0x03, 0x04]));

  const target = await parseBinaryTarget(path);
  if (!target.ok) throw target.error;
  const result = await new ArtifactProvider(process.env)
    .createClient(target.value)
    .execute("inventory_artifact", {});

  expect(result).toMatchObject({
    ok: false,
    error: { _tag: "ArtifactOperationError", reason: "io" },
  });
});
