import { expect, it } from "vitest";
import { GpuInventory } from "./GpuInventory.js";
import { GpuBufferSource } from "./GpuSource.js";
import {
  ccobFixture,
  cubinFixture,
  cudaFixture,
} from "../../tests/fixtures/gpu/codeObjects.js";

it.each(["cuda", "ccob"] as const)(
  "refuses oversized %s output before reading compressed input",
  async (kind) => {
    const bytes =
      kind === "cuda"
        ? cudaFixture("zstd", [{ kind: 2, target: 80, bytes: cubinFixture() }])
        : ccobFixture(3);
    const payloadOffset = kind === "cuda" ? 80 : 32;
    bytes.writeBigUInt64LE(
      BigInt(128 * 1024 * 1024 + 1),
      kind === "cuda" ? 72 : 16,
    );
    const source = new GpuBufferSource(bytes, "fixture"),
      reads: number[] = [],
      inventory = new GpuInventory({ path: "/fixture", analysis: "kernels" });
    await inventory.inspect({
      size: source.size,
      containerId: source.containerId,
      read: async (offset, size) => {
        reads.push(offset);
        return source.read(offset, size);
      },
    });
    expect(reads).not.toContain(payloadOffset);
    expect(inventory.objects[0]).toMatchObject({
      inspection: "capacity",
      sha256: null,
    });
    expect(inventory.kernels).toEqual([]);
  },
);
it("observes cancellation while walking flat empty bundles in a decoded buffer", async () => {
  const empty = Buffer.alloc(32);
  empty.write("__CLANG_OFFLOAD_BUNDLE__");
  const bytes = Buffer.concat(Array.from({ length: 4096 }, () => empty));
  const controller = new AbortController(),
    reason = { selected: "cancel-buffer-walk" };
  const inventory = new GpuInventory(
    { path: "/fixture", analysis: "inventory" },
    controller.signal,
  );
  const result = inventory.inspect(new GpuBufferSource(bytes, "fixture"));
  setImmediate(() => controller.abort(reason));
  await expect(result).rejects.toMatchObject({
    reason: "cancelled",
    cause: reason,
  });
});
