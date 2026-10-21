import { expect, it, onTestFinished } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { gpuCodeObjectsPartialSchema } from "../../../src/domain/gpu/gpuCodeObjects.js";
import { GpuCodeObjectsProvider } from "../../../src/gpu/GpuCodeObjectsProvider.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import {
  cudaFixture,
  cubinFixture,
  ccobFixture,
  hipFixture,
  peGpuFixture,
  elfFixture,
  ptxFixture,
  amdFixture,
} from "../../fixtures/gpu/codeObjects.js";
const inspect = async (
  bytes: Buffer,
  options: {
    analysis?: "inventory" | "kernels";
    targets?: string[];
    object_ids?: string[];
    expected_sha256?: string;
  } = {},
) => {
  const root = await createTestTempDirectory("rea-gpu-"),
    path = join(root, "no-format-extension");
  await writeFile(path, bytes);
  const provider = new GpuCodeObjectsProvider();
  onTestFinished(() => provider.close());
  return provider.inspect({ path, analysis: "kernels", ...options });
};
it.each(["none", "zstd"] as const)(
  "reads selected CUDA metadata and PTX with %s compression",
  async (compression) => {
    const result = await inspect(cudaFixture(compression));
    if (!result.ok) throw result.error;
    expect(result.value.coverage).toMatchObject({
      discovery: "complete",
      payloads: "complete",
    });
    expect(
      result.value.kernels.map((row) => [
        row.name,
        row.parameter_count,
        row.parameter_bytes,
        row.shared_bytes,
        row.registers.physical,
      ]),
    ).toEqual([
      ["add_one", 2, 12, 32, null],
      ["add_one", 2, 12, 1056, 10],
    ]);
    expect(result.value.ptx_artifacts[0]!.text).toBe(ptxFixture);
    expect(
      result.value.kernels[1]!.parameters.map((row) => [
        row.ordinal,
        row.offset,
        row.size,
      ]),
    ).toEqual([
      [0, 0, 8],
      [1, 8, 4],
    ]);
  },
);
it.each([1, 2, 3] as const)(
  "reads CCOB v%d zlib/Zstd and retains exact decoded provenance",
  async (version) => {
    for (const method of ["zlib", "zstd"] as const) {
      const result = await inspect(ccobFixture(version, method));
      if (!result.ok) throw result.error;
      expect(result.value.kernels[0]).toMatchObject({
        name: "add_one",
        parameter_count: 2,
        parameter_bytes: 12,
        registers: { sgpr: 6, vgpr: 2 },
        shared_bytes: 0,
      });
      expect(result.value.objects[2]!.location.container_id).toBe(
        result.value.objects[0]!.id,
      );
    }
  },
);
it("does not decode unselected payloads and keeps stable positional identities", async () => {
  const bytes = cudaFixture("zstd");
  const inventory = await inspect(bytes, { analysis: "inventory" }),
    selected = await inspect(bytes, { targets: ["sm_90"] });
  if (!inventory.ok) throw inventory.error;
  if (!selected.ok) throw selected.error;
  expect(inventory.value.kernels).toEqual([]);
  expect(selected.value.objects.map((row) => row.id)).toEqual(
    inventory.value.objects.map((row) => row.id),
  );
  expect(selected.value.ptx_artifacts).toEqual([]);
  expect(selected.value.kernels).toHaveLength(1);
  expect(selected.value.coverage.payloads).toBe("partial");
});
it.each(["cubin", "ptx"] as const)(
  "retains conflicting container and %s target declarations as partial facts",
  async (kind) => {
    const bytes = cudaFixture("none", [
      {
        kind: kind === "cubin" ? 2 : 1,
        target: 80,
        bytes:
          kind === "cubin"
            ? cubinFixture({ architecture: 90 })
            : Buffer.from(ptxFixture.replace("sm_80", "sm_90")),
      },
    ]);
    const result = await inspect(bytes, { targets: ["sm_80"] });
    if (!result.ok) throw result.error;
    expect(result.value.objects[0]).toMatchObject({
      target: "sm_80",
      payload_target: "sm_90",
      target_consistency: "conflict",
      inspection: "partial",
    });
    expect(result.value.coverage.payloads).toBe("partial");
    expect(result.value.kernels).toHaveLength(1);
    expect(result.value.kernels[0]!.limitations.join(" ")).toContain(
      "inventory sm_80; payload sm_90",
    );
    const unexamined = await inspect(bytes, { targets: ["sm_90"] });
    if (!unexamined.ok) throw unexamined.error;
    expect(unexamined.value.objects[0]).toMatchObject({
      target: "sm_80",
      payload_target: null,
      target_consistency: "unexamined",
      inspection: "not-selected",
    });
    expect(unexamined.value.coverage.payloads).toBe("partial");
  },
);
it("keeps CUBIN base-only agreement distinct from verified feature-profile agreement", async () => {
  const bytes = cudaFixture("none", [
    { kind: 2, target: 90, bytes: cubinFixture({ architecture: 90 }) },
  ]);
  bytes.writeBigUInt64LE(bytes.readBigUInt64LE(16 + 40) | 0x100000n, 16 + 40);
  const result = await inspect(bytes, { targets: ["sm_90a"] });
  if (!result.ok) throw result.error;
  expect(result.value.objects[0]).toMatchObject({
    target: "sm_90a",
    payload_target: "sm_90",
    target_consistency: "base-only",
    inspection: "complete",
  });
});
it.each([
  [100, 0x06006402],
  [101, 0x06006502],
  [103, 0x05006702],
  [120, 0x06007802],
  [121, 0x06007902],
])(
  "reads ABI-qualified CUDA target sm_%d from released NVIDIA header flags",
  async (architecture, flags) => {
    const result = await inspect(cubinFixture({ osAbi: 0x41, flags }));
    if (!result.ok) throw result.error;
    expect(result.value.objects[0]).toMatchObject({
      target: `sm_${architecture}`,
      payload_target: `sm_${architecture}`,
      target_consistency: "single-source",
      inspection: "complete",
      cuda_target_header: {
        os_abi: 0x41,
        flags: `0x${flags.toString(16).padStart(8, "0")}`,
      },
    });
  },
);
it("keeps unsupported CUDA flag layouts unknown while retaining raw header evidence", async () => {
  const result = await inspect(
    cubinFixture({ osAbi: 0x41, flags: 0x06016402 }),
  );
  if (!result.ok) throw result.error;
  expect(result.value.objects[0]).toMatchObject({
    target: null,
    payload_target: null,
    target_consistency: "unknown",
    inspection: "partial",
    cuda_target_header: { os_abi: 0x41, flags: "0x06016402" },
  });
  expect(result.value.kernels).toHaveLength(1);
  expect(result.value.kernels[0]!.limitations.join(" ")).toContain(
    "target encoding is unknown",
  );
  const inventory = await inspect(
    cubinFixture({ osAbi: 0x41, flags: 0x06016402 }),
    { analysis: "inventory" },
  );
  if (!inventory.ok) throw inventory.error;
  expect(inventory.value.coverage.discovery).toBe("partial");
});
it("discovers standalone AMD targets before exact selection", async () => {
  const bytes = amdFixture(),
    target = "amdgcn-amd-amdhsa--gfx900";
  const inventory = await inspect(bytes, { analysis: "inventory" });
  const selected = await inspect(bytes, { targets: [target] });
  const skipped = await inspect(bytes, {
    targets: ["amdgcn-amd-amdhsa--gfx1100"],
  });
  if (!inventory.ok) throw inventory.error;
  if (!selected.ok) throw selected.error;
  if (!skipped.ok) throw skipped.error;
  expect(inventory.value.objects[0]).toMatchObject({
    target,
    inspection: "inventory",
    sha256: null,
  });
  expect(inventory.value.kernels).toEqual([]);
  expect(selected.value.objects[0]).toMatchObject({
    target,
    inspection: "complete",
    id: inventory.value.objects[0]!.id,
  });
  expect(selected.value.kernels).toHaveLength(1);
  expect(selected.value.kernels[0]).toMatchObject({
    representation: "amdgpu-metadata",
    parameter_bytes: 12,
  });
  expect(skipped.value.objects[0]).toMatchObject({
    target,
    inspection: "not-selected",
    sha256: null,
  });
  expect(skipped.value.kernels).toEqual([]);
  expect(skipped.value.coverage.payloads).toBe("partial");
});
it.each([
  "hipv4-amdgcn-amd-amdhsa--gfx900",
  "hipv4-amdgcn-amd-amdhsa-gfx900",
  "hipv4-amdgcn-amd-amdhsa-opaque",
])("keeps discovered HIP targets selectable for %s", async (targetId) => {
  const bytes = hipFixture(amdFixture(), targetId);
  const inventory = await inspect(bytes, { analysis: "inventory" });
  if (!inventory.ok) throw inventory.error;
  const row = inventory.value.objects.find((value) => value.kind === "amdgpu")!;
  expect(row.target).not.toBeNull();
  const selected = await inspect(bytes, { targets: [row.target!] });
  if (!selected.ok) throw selected.error;
  expect(selected.value.kernels).toHaveLength(1);
  expect(
    selected.value.objects.find((value) => value.kind === "amdgpu"),
  ).toMatchObject({
    target: row.target,
    payload_target: "amdgcn-amd-amdhsa--gfx900",
    target_consistency: targetId.endsWith("opaque")
      ? "single-source"
      : "consistent",
    inspection: "complete",
  });
});
it("bounds standalone AMD note discovery before retaining metadata", async () => {
  const result = await inspect(
    elfFixture(224, [
      { name: ".note", type: 7, bytes: Buffer.alloc(8 * 1024 * 1024 + 1) },
    ]),
    { analysis: "inventory" },
  );
  if (!result.ok) throw result.error;
  expect(result.value.objects[0]).toMatchObject({
    target: null,
    inspection: "capacity",
  });
  expect(result.value.objects[0]!.limitations).toContain(
    "AMDGPU ELF note discovery exceeds the 8 MiB retained metadata budget",
  );
  expect(result.value.kernels).toEqual([]);
});
it("reads PE raw-size fallback and ELF-host section locations", async () => {
  for (const bytes of [
    peGpuFixture(),
    elfFixture(62, [{ name: ".nv_fatbin", bytes: cudaFixture() }]),
  ]) {
    const result = await inspect(bytes);
    if (!result.ok) throw result.error;
    expect(result.value.kernels).toHaveLength(2);
    expect(result.value.objects[0]!.location.section_index).not.toBeNull();
    expect(result.value.objects[1]!.location.container_id).toBe(
      result.value.objects[0]!.id,
    );
  }
});
it("coalesces aliased CUDA metadata before expanding the temporary index", async () => {
  const bytes = cubinFixture({ globalRecords: 65536, globalAliases: 1024 });
  expect(bytes.length).toBeLessThan(1024 * 1024);
  const result = await inspect(bytes);
  if (!result.ok) throw result.error;
  expect(result.value.objects[0]!.inspection).toBe("complete");
  expect(result.value.kernels).toHaveLength(1);
  expect(result.value.kernels[0]!.registers.physical).toBe(10);
});
it("retains unknown PTX virtual counts and partial payload coverage", async () => {
  const result = await inspect(
    Buffer.from(ptxFixture.replace("%r<9>", "r0, r1, %r<4>, %s<8>")),
  );
  if (!result.ok) throw result.error;
  expect(result.value.kernels[0]!.registers.virtual[0]).toEqual({
    type: ".b32",
    count: 14,
  });
  const unsupported = await inspect(
    Buffer.from(ptxFixture.replace("%r<9>", "%r[4]")),
  );
  if (!unsupported.ok) throw unsupported.error;
  expect(unsupported.value.objects[0]!.inspection).toBe("partial");
  expect(unsupported.value.coverage.payloads).toBe("partial");
  expect(unsupported.value.kernels[0]!.registers.virtual[0]).toEqual({
    type: ".b32",
    count: null,
  });
});
it.each([
  ["parameter", ".u64 output", ".u64 .ptr .global output"],
  ["shared", "scratch[32]", "scratch[]"],
] as const)(
  "marks unknown PTX %s declarations partial while retaining known facts",
  async (kind, from, to) => {
    const bytes = Buffer.from(ptxFixture.replace(from, to));
    const result = await inspect(bytes);
    if (!result.ok) throw result.error;
    expect(result.value.objects[0]!.inspection).toBe("partial");
    expect(result.value.coverage.payloads).toBe("partial");
    expect(result.value.ptx_artifacts[0]!.text).toBe(bytes.toString());
    const kernel = result.value.kernels[0]!;
    expect(kernel.registers.virtual[0]).toEqual({ type: ".b32", count: 9 });
    expect(kernel.limitations.join(" ")).toContain(`PTX ${kind} declarations`);
    if (kind === "parameter") {
      expect(kernel.parameter_count).toBe(2);
      expect(kernel.parameter_bytes).toBeNull();
      expect(
        kernel.parameters.map(({ size, offset }) => [size, offset]),
      ).toEqual([
        [null, null],
        [4, null],
      ]);
      expect(kernel.shared_bytes).toBe(32);
    } else {
      expect(kernel.parameter_bytes).toBe(12);
      expect(kernel.shared_bytes).toBeNull();
    }
  },
);
it.each(["whitespace", "comment"] as const)(
  "recognizes standalone PTX after more than 64 KiB of leading %s",
  async (kind) => {
    const prefix =
      kind === "whitespace"
        ? " ".repeat(70 * 1024)
        : `/*${"x".repeat(70 * 1024)}*/\n`;
    const bytes = Buffer.from(prefix + ptxFixture);
    const inventory = await inspect(bytes, { analysis: "inventory" });
    const selected = await inspect(bytes, { targets: ["sm_80"] });
    if (!inventory.ok) throw inventory.error;
    if (!selected.ok) throw selected.error;
    expect(inventory.value.objects[0]!.target).toBe("sm_80");
    expect(selected.value.kernels).toHaveLength(1);
    expect(selected.value.kernels[0]!.location.offset).toBeGreaterThan(
      64 * 1024,
    );
  },
);
it.each(["truncated", "invalid", "extension"] as const)(
  "retains earlier AMD kernel declarations after a later %s note",
  async (kind) => {
    const tail = Buffer.alloc(kind === "truncated" ? 3 : 24);
    if (kind !== "truncated") {
      tail.writeUInt32LE(7, 0);
      tail.writeUInt32LE(kind === "invalid" ? 1 : 3, 4);
      tail.writeUInt32LE(32, 8);
      tail.write("AMDGPU\0", 12);
      tail[20] = kind === "invalid" ? 0xc1 : 0xd4;
    }
    for (const bytes of [
      amdFixture(false, tail),
      hipFixture(amdFixture(false, tail)),
    ]) {
      const result = await inspect(bytes);
      if (!result.ok) throw result.error;
      expect(result.value.kernels).toHaveLength(1);
      expect(result.value.kernels[0]).toMatchObject({
        name: "add_one",
        parameter_bytes: 12,
        registers: { sgpr: 6, vgpr: 2 },
      });
      expect(
        result.value.objects.find((row) => row.kind === "amdgpu")!.inspection,
      ).toBe(kind === "extension" ? "unsupported" : "malformed");
      expect(result.value.coverage.payloads).toBe("partial");
    }
  },
);
it("bounds cumulative CUDA records across separate in-range metadata sections", async () => {
  const record = Buffer.from("042f0800010000000a000000", "hex"),
    records = Buffer.alloc(record.length * 131073);
  for (let offset = 0; offset < records.length; offset += record.length)
    record.copy(records, offset);
  const result = await inspect(
    elfFixture(190, [
      { name: ".nv.info", type: 0x70000000, bytes: records },
      { name: ".nv.info", type: 0x70000000, bytes: records },
    ]),
  );
  if (!result.ok) throw result.error;
  expect(result.value.objects[0]!.inspection).toBe("capacity");
  expect(result.value.objects[0]!.limitations.join(" ")).toContain(
    "aggregate record/symbol visits",
  );
});
it.each(["section-names", "symbols"] as const)(
  "retains partial CUBIN coverage when %s are unavailable",
  async (missing) => {
    const bytes = cubinFixture();
    if (missing === "section-names") bytes.writeUInt16LE(0, 62);
    else bytes.writeUInt32LE(1, Number(bytes.readBigUInt64LE(40)) + 3 * 64 + 4);
    const result = await inspect(bytes);
    if (!result.ok) throw result.error;
    expect(result.value.objects[0]!.inspection).toBe("partial");
    expect(result.value.coverage.payloads).toBe("partial");
    expect(result.value.kernels).toHaveLength(missing === "symbols" ? 0 : 1);
    expect(result.value.objects[0]!.limitations.join(" ")).toContain(
      missing === "symbols"
        ? "kernel declaration coverage is unknown"
        : "named metadata coverage is partial",
    );
  },
);
it("preserves parameters for long mangled names and rejects conflicting register counts", async () => {
  const name = "kernel_" + "argument".repeat(64);
  const result = await inspect(
    cubinFixture({ name, textRegisters: 9, globalRegisters: 10 }),
  );
  if (!result.ok) throw result.error;
  expect(result.value.kernels[0]).toMatchObject({
    name,
    parameter_count: 2,
    registers: { physical: null },
  });
  expect(result.value.kernels[0]!.limitations.join(" ")).toContain(
    "Conflicting",
  );
});
it("iterates flat concatenated fatbins beyond the genuine container nesting limit", async () => {
  const result = await inspect(
    Buffer.concat(Array.from({ length: 20 }, () => cudaFixture())),
  );
  if (!result.ok) throw result.error;
  expect(result.value.objects).toHaveLength(40);
  expect(result.value.kernels).toHaveLength(40);
  expect(result.value.coverage.discovery).toBe("complete");
});
it("reports checksum corruption and unknown compression as partial, retaining known entries", async () => {
  const corrupt = ccobFixture();
  corrupt[16] = corrupt[16]! ^ 1;
  const result = await inspect(corrupt);
  if (!result.ok) throw result.error;
  expect(result.value.coverage.discovery).toBe("partial");
  expect(result.value.objects[0]!.inspection).toBe("malformed");
  const unknown = ccobFixture();
  unknown.writeUInt16LE(99, 6);
  const unsupported = await inspect(unknown);
  if (!unsupported.ok) throw unsupported.error;
  expect(unsupported.value.objects[0]!.inspection).toBe("unsupported");
});
it("rejects out-of-range bundle entries without guessing a payload", async () => {
  const bytes = hipFixture();
  bytes.writeBigUInt64LE(BigInt(bytes.length + 1), 32);
  const result = await inspect(bytes);
  expect(result).toMatchObject({
    ok: false,
    error: { _tag: "BinaryTargetError" },
  });
});

it("preserves standalone PTX BOM and trailing NUL bytes in the retained text artifact", async () => {
  const bytes = Buffer.from("\uFEFF" + ptxFixture + "\0");
  const result = await inspect(bytes);
  if (!result.ok) throw result.error;
  expect(Buffer.from(result.value.ptx_artifacts[0]!.text)).toEqual(bytes);
  expect(result.value.ptx_artifacts[0]!.byte_length).toBe(bytes.length);
});
it("rejects a changed full-file identity before applying positional object selection", async () => {
  const bytes = cudaFixture();
  const result = await inspect(bytes, {
    expected_sha256: "0".repeat(64),
    object_ids: ["file@10"],
  });
  expect(result).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisArtifactChangedError" },
  });
});
it("iterates mixed plain/CCOB bundles without counting flat records as nesting", async () => {
  const records = Array.from({ length: 20 }, (_, index) =>
    index % 2 === 0 ? hipFixture() : ccobFixture(),
  );
  const result = await inspect(Buffer.concat(records));
  if (!result.ok) throw result.error;
  expect(result.value.kernels).toHaveLength(20);
  expect(result.value.coverage.discovery).toBe("complete");
});
it("continues at the declared CCOB boundary after an unsupported codec", async () => {
  const unknown = ccobFixture();
  unknown.writeUInt16LE(99, 6);
  const result = await inspect(Buffer.concat([unknown, ccobFixture()]));
  if (!result.ok) throw result.error;
  expect(result.value.kernels).toHaveLength(1);
  expect(result.value.coverage.discovery).toBe("partial");
});

it("refuses escaped PTX report expansion while preserving bounded interrupted facts", async () => {
  const text = ptxFixture + "\n//" + "\u0001".repeat(3 * 1024 * 1024);
  const result = await inspect(Buffer.from(text));
  expect(result).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisResourceConstraintError" },
  });
  if (result.ok) throw new Error("expected representation capacity refusal");
  const partial = gpuCodeObjectsPartialSchema.parse(
    parseEvidence(result.error.partialObservation).normalized_result,
  );
  expect(partial.ptx_artifacts).toEqual([]);
  expect(partial.objects).toHaveLength(1);
  expect(partial.artifact.sha256).toBeNull();
});
