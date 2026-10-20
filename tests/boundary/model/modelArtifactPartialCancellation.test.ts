import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { ModelArtifactProvider } from "../../../src/model/ModelArtifactProvider.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { ggufFixture } from "../../fixtures/model/model.js";

const cancelledArrayFixture = () => {
  const seed = ggufFixture();
  const count = 200_000;
  const fixture = ggufFixture({
    tensors: [],
    metadata: [
      { key: "general.name", type: 8, value: seed.text("First row") },
      {
        key: "custom.bools",
        type: 9,
        value: Buffer.concat([
          seed.u32(7),
          seed.u64(BigInt(count)),
          Buffer.alloc(count),
        ]),
      },
    ],
  });
  return {
    fixture,
    count,
    arrayStart:
      24 +
      8 +
      Buffer.byteLength("general.name") +
      4 +
      8 +
      Buffer.byteLength("First row") +
      8 +
      Buffer.byteLength("custom.bools") +
      4 +
      4 +
      8,
  };
};

it("retains completed GGUF rows when cancellation interrupts a later value", async () => {
  const root = await mkdtemp(join(tmpdir(), "rea-model-partial-cancel-"));
  const path = join(root, "model.gguf");
  const { fixture, count, arrayStart } = cancelledArrayFixture();
  await writeFile(path, fixture.bytes);
  const sample = await open(path, "r");
  const handlePrototype = Object.getPrototypeOf(sample) as {
    read: (
      buffer: Buffer,
      offset: number,
      length: number,
      position: number,
    ) => Promise<{ bytesRead: number }>;
  };
  await sample.close();
  const originalRead = handlePrototype.read;
  const controller = new AbortController();
  const reason = { marker: "caller-selected-parser-cancel" };
  let arrayBytesObserved = 0;
  const readSpy = vi
    .spyOn(handlePrototype, "read")
    .mockImplementation(async function (
      this: unknown,
      buffer: Buffer,
      offset: number,
      length: number,
      position: number,
    ) {
      const result = await originalRead.call(
        this,
        buffer,
        offset,
        length,
        position,
      );
      if (position === arrayStart && result.bytesRead > 0) {
        arrayBytesObserved = result.bytesRead;
        controller.abort(reason);
      }
      return result;
    });
  const provider = new ModelArtifactProvider();
  try {
    const result = await provider.inspect(
      { path, hash: "header" },
      { signal: controller.signal },
    );
    if (result.ok) throw new Error("Expected parser cancellation");
    expect(arrayBytesObserved).toBeGreaterThan(0);
    expect(arrayBytesObserved).toBeLessThan(count);
    expect(result.error.cause).toBe(reason);
    const evidence = parseEvidence(result.error.partialObservation);
    expect(evidence.subject).toBeNull();
    expect(evidence.operation).toBe("inspect_model_artifact");
    expect(evidence.normalized_result).toMatchObject({
      kind: "model-artifact-partial",
      artifact: {
        path,
        header_sha256: null,
        sha256: null,
        file_identity: "unverified",
      },
      coverage: {
        header: "partial",
        metadata: "partial",
        tensors: "not-started",
      },
      metadata: [{ index: 0, key: "general.name", value: "First row" }],
      tensors: [],
    });
    const projected = projectAnalysisError(result.error);
    if (projected.details === undefined)
      throw new Error("Projected error omitted its partial observation");
    expect(parseEvidence(projected.details.partial_observation)).toEqual(
      evidence,
    );
  } finally {
    readSpy.mockRestore();
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("retains completed GGUF tensor declarations before later tensor bytes cancel", async () => {
  const root = await mkdtemp(join(tmpdir(), "rea-model-tensor-partial-"));
  const path = join(root, "model.gguf");
  const tensorCount = 4000;
  const fixture = ggufFixture({
    metadata: [],
    tensors: Array.from({ length: tensorCount }, (_, index) => ({
      name: `tensor-${String(index).padStart(4, "0")}`,
      type: 0,
      shape: [1n],
      offset: 0n,
      bytes: 4,
    })),
  });
  await writeFile(path, fixture.bytes);
  const sample = await open(path, "r");
  const handlePrototype = Object.getPrototypeOf(sample) as {
    read: (
      buffer: Buffer,
      offset: number,
      length: number,
      position: number,
    ) => Promise<{ bytesRead: number }>;
  };
  await sample.close();
  const originalRead = handlePrototype.read;
  const controller = new AbortController();
  const reason = { marker: "cancel-after-completed-tensor-declarations" };
  let laterHeaderChunkSeen = false;
  const readSpy = vi
    .spyOn(handlePrototype, "read")
    .mockImplementation(async function (
      this: unknown,
      buffer: Buffer,
      offset: number,
      length: number,
      position: number,
    ) {
      const result = await originalRead.call(
        this,
        buffer,
        offset,
        length,
        position,
      );
      if (position >= 24 + 65536 && result.bytesRead > 0) {
        laterHeaderChunkSeen = true;
        controller.abort(reason);
      }
      return result;
    });
  const provider = new ModelArtifactProvider();
  try {
    const result = await provider.inspect(
      { path, hash: "header" },
      { signal: controller.signal },
    );
    if (result.ok) throw new Error("Expected parser cancellation");
    expect(laterHeaderChunkSeen).toBe(true);
    expect(result.error.cause).toBe(reason);
    const evidence = parseEvidence(result.error.partialObservation);
    const partial = evidence.normalized_result as {
      tensor_declarations: Array<{
        index: number;
        file_offset: number | null;
        storage_validation: string;
      }>;
      tensors: unknown[];
      coverage: { tensors: string };
      artifact: {
        path: string;
        header_sha256: null;
        sha256: null;
        file_identity: string;
      };
    };
    expect(partial.tensor_declarations.length).toBeGreaterThan(0);
    expect(partial.tensor_declarations[0]).toMatchObject({
      index: 0,
      file_offset: null,
      storage_validation: "not-established",
    });
    expect(partial.tensors).toEqual([]);
    expect(partial.coverage.tensors).toBe("partial");
    expect(partial.artifact).toMatchObject({
      path,
      header_sha256: null,
      sha256: null,
      file_identity: "unverified",
    });
  } finally {
    readSpy.mockRestore();
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
});
