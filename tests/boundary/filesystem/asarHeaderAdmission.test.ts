import { mkdir, open, readFile, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createPackage } from "@electron/asar";
import { expect, it, vi } from "vitest";

import { translateArtifactFailure } from "../../../src/artifacts/ArtifactOperationFailure.js";
import { ArtifactReaderFailure } from "../../../src/artifacts/ArtifactReader.js";
import {
  admitAsarHeader,
  asarHeaderAdmissionRecovery,
  MAX_ASAR_HEADER_BYTES,
} from "../../../src/artifacts/AsarHeader.js";
import { ArtifactOperationError } from "../../../src/domain/artifactOperationError.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { inventoryArtifact } from "../../fixtures/artifactInventory.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { analyzeJavaScriptApplication } from "../../support/javascriptApplicationScope.js";

const createFixture = async () => {
  const root = await createTestTempDirectory("rea-asar-header-admission-");
  const source = join(root, "source");
  const archive = join(root, "fixture.asar");
  await mkdir(source);
  await writeFile(join(source, "main.js"), "export const answer = 42;\n");
  await createPackage(source, archive);
  return { archive, original: await readFile(archive) };
};

const admit = async (path: string) => {
  const handle = await open(path, "r");
  const read = vi.spyOn(handle, "read");
  try {
    return await admitAsarHeader(handle);
  } finally {
    // Admission must inspect only the fixed prefix, even for forged extents.
    const calls = [...read.mock.calls];
    const results = await Promise.all(
      read.mock.results.map(
        ({ value }) => value as Promise<{ readonly bytesRead: number }>,
      ),
    );
    read.mockRestore();
    await handle.close();
    expect(handle.fd).toBe(-1);
    expect(calls.length).toBeGreaterThan(0);
    let filled = 0;
    for (const [index, call] of calls.entries()) {
      const [buffer, offset, length, position]: readonly unknown[] =
        call as unknown as readonly unknown[];
      expect(buffer).toBeInstanceOf(Buffer);
      expect(offset).toBe(filled);
      expect(position).toBe(filled);
      expect(length).toBe(16 - filled);
      filled += results[index]!.bytesRead;
    }
    expect(filled).toBeLessThanOrEqual(16);
  }
};

it("admits a header produced by the upstream ASAR serializer", async () => {
  const { archive, original } = await createFixture();
  await expect(admit(archive)).resolves.toEqual({
    archiveBytes: original.length,
    headerBytes: original.readUInt32LE(4),
    jsonBytes: original.readUInt32LE(12),
  });
  expect(await readFile(archive)).toEqual(original);
});

it("rejects every truncated prefix of a real serialized header", async () => {
  const { archive, original } = await createFixture();
  const headerEnd = 8 + original.readUInt32LE(4);
  for (let length = 0; length < headerEnd; length++) {
    await writeFile(archive, original.subarray(0, length));
    await expect(
      admit(archive),
      `truncated at byte ${length}`,
    ).rejects.toMatchObject({
      reason: "format",
    });
  }
  // Member data is outside header admission; an intact header still passes.
  await writeFile(archive, original.subarray(0, headerEnd));
  await expect(admit(archive)).resolves.toMatchObject({
    archiveBytes: headerEnd,
  });
});

it("rejects contradictory and unsigned-boundary extents before decoding", async () => {
  const { archive, original } = await createFixture();
  const mutations = [
    { offset: 0, values: [0, 1, 3, 5, 0xffffffff] },
    { offset: 4, values: [0, 4, 7, original.length, 0x80000000, 0xffffffff] },
    { offset: 8, values: [0, 1, original.readUInt32LE(8) + 4, 0xffffffff] },
    { offset: 12, values: [original.readUInt32LE(8), 0x80000000, 0xffffffff] },
  ];
  for (const { offset, values } of mutations) {
    for (const value of values) {
      const bytes = Buffer.from(original);
      bytes.writeUInt32LE(value, offset);
      await writeFile(archive, bytes);
      await expect(
        admit(archive),
        `uint32 at ${offset} = ${value}`,
      ).rejects.toMatchObject({
        reason: "format",
      });
    }
  }
});

it("separates the header decode budget from container validity at its exact boundary", async () => {
  const root = await createTestTempDirectory("rea-asar-header-budget-");
  const archive = join(root, "budget.asar");
  expect(MAX_ASAR_HEADER_BYTES).toBe(16 * 1024 * 1024);
  for (const headerBytes of [
    MAX_ASAR_HEADER_BYTES,
    MAX_ASAR_HEADER_BYTES + 4,
  ]) {
    const prefix = Buffer.alloc(16);
    prefix.writeUInt32LE(4, 0);
    prefix.writeUInt32LE(headerBytes, 4);
    prefix.writeUInt32LE(headerBytes - 4, 8);
    prefix.writeUInt32LE(2, 12);
    await writeFile(archive, prefix);
    // Supply the declared extent without allocating a header-sized JS buffer.
    // This tests extent admission only; the padding is not valid archive JSON.
    await truncate(archive, headerBytes + 8);
    if (headerBytes === MAX_ASAR_HEADER_BYTES)
      await expect(admit(archive)).resolves.toEqual({
        archiveBytes: headerBytes + 8,
        headerBytes,
        jsonBytes: 2,
      });
    else
      await expect(admit(archive)).rejects.toMatchObject({
        reason: "limit",
        message: asarHeaderAdmissionRecovery(),
        admission: {
          kind: "asar-header",
          maximumBytes: MAX_ASAR_HEADER_BYTES,
        },
      });
  }
});

const writeOversizedHeaderArchive = async (): Promise<string> => {
  const root = await createTestTempDirectory("rea-asar-header-recovery-");
  const archive = join(root, "app.asar");
  const headerBytes = MAX_ASAR_HEADER_BYTES + 4;
  const json = Buffer.from("{}");
  const prefix = Buffer.alloc(16);
  prefix.writeUInt32LE(4, 0);
  prefix.writeUInt32LE(headerBytes, 4);
  prefix.writeUInt32LE(headerBytes - 4, 8);
  prefix.writeUInt32LE(json.length, 12);
  await writeFile(archive, Buffer.concat([prefix, json]));
  await truncate(archive, headerBytes + 8);
  return archive;
};

it("names the fixed header admission budget when source selection cannot bypass it", async () => {
  const recovery = asarHeaderAdmissionRecovery();
  expect(MAX_ASAR_HEADER_BYTES).toBe(16 * 1024 * 1024);
  expect(recovery).toContain("ASAR header/index admission");
  expect(recovery).toContain(
    `${String(MAX_ASAR_HEADER_BYTES / (1024 * 1024))} MiB / ${String(MAX_ASAR_HEADER_BYTES)} bytes`,
  );
  expect(recovery).toContain("no runtime override");
  expect(recovery).toContain("Selecting fewer sources");
  expect(recovery).toContain("does not bypass header admission");
  expect(recovery).toContain("extracted application directory");
  expect(recovery).not.toContain("Narrow the requested path");

  const archive = await writeOversizedHeaderArchive();
  let inventoryFailure: unknown;
  try {
    await inventoryArtifact(archive);
  } catch (cause: unknown) {
    inventoryFailure = cause;
  }
  expect(inventoryFailure).toBeInstanceOf(ArtifactReaderFailure);
  if (!(inventoryFailure instanceof ArtifactReaderFailure))
    throw new Error("inventory failure was not an artifact reader failure");
  expect(inventoryFailure.cleanup).toBeUndefined();
  const wrapped = ArtifactReaderFailure.withCleanup(inventoryFailure, {
    reason: "close failed",
    resources: ["header"],
  });
  expect(wrapped.message).toBe(recovery);
  expect(wrapped.admission).toEqual(inventoryFailure.admission);
  const inventory = projectAnalysisError(
    translateArtifactFailure("inventory_artifact", inventoryFailure),
  );
  expect(inventory).toMatchObject({
    code: "truncated",
    message: recovery,
    remediation: { action: recovery },
    details: {
      reason: "limit",
      truncated: true,
      detail: recovery,
      admission: "asar-header",
      maximum_header_bytes: MAX_ASAR_HEADER_BYTES,
    },
  });
  expect(
    projectAnalysisError(translateArtifactFailure("inspect_artifact", wrapped))
      .message,
  ).toBe(recovery);

  const selected = await analyzeJavaScriptApplication({
    input_path: archive,
    source_paths: ["package.json"],
    max_heap_mb: 2048,
  });
  const unselected = await analyzeJavaScriptApplication({
    input_path: archive,
  });
  if (selected.ok || unselected.ok)
    throw new Error("ASAR header admission succeeded");
  expect(projectAnalysisError(selected.error).message).toBe(recovery);
  expect(projectAnalysisError(unselected.error).message).toBe(recovery);
  expect(projectAnalysisError(selected.error).remediation.action).toBe(
    recovery,
  );
});

it("keeps unrelated artifact limit recovery distinct from header admission", () => {
  expect(
    projectAnalysisError(
      new ArtifactOperationError(
        "inventory_artifact",
        "limit",
        undefined,
        "Directory traversal reached its examined-entry budget",
      ),
    ).message,
  ).toBe(
    "Artifact is too large to process safely. Narrow the requested path or use a smaller artifact.",
  );
});
