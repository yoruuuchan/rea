import { scheduler } from "node:timers/promises";
import type { GpuObject } from "../domain/gpu/gpuCodeObjects.js";
import {
  BinaryFormatFailure,
  BinaryResourceFailure,
} from "../native/metadata/BinaryContainer.js";
import { assertArtifactReadActive } from "../artifacts/ArtifactFileOperation.js";
import {
  gpuCount,
  GPU_REPORT_BYTES,
  rejectGpu,
  type GpuSource,
} from "./GpuSource.js";
import { gpuObject } from "./GpuObject.js";
export const CLANG_BUNDLE_MAGIC = Buffer.from("__CLANG_OFFLOAD_BUNDLE__");
export const readClangBundleDirectory = async (
  source: GpuSource,
  base: number,
  signal?: AbortSignal,
): Promise<{ objects: GpuObject[]; end: number }> => {
  const header = await source.read(base, 32),
    count = gpuCount(header.readBigUInt64LE(24));
  if (!header.subarray(0, 24).equals(CLANG_BUNDLE_MAGIC))
    rejectGpu("Invalid Clang offload bundle magic");
  if (count > 65536)
    throw new BinaryResourceFailure(
      "structure",
      65536,
      "HIP bundle entry count exceeds the inventory budget",
    );
  const objects: GpuObject[] = [];
  let position = base + 32;
  for (let index = 0; index < count; index++) {
    if (index % 256 === 0) {
      await scheduler.yield();
      assertArtifactReadActive(signal);
    }
    const h = await source.read(position, 24),
      offset = gpuCount(BigInt(base) + h.readBigUInt64LE(0)),
      size = gpuCount(h.readBigUInt64LE(8)),
      nameSize = gpuCount(h.readBigUInt64LE(16));
    if (nameSize > 65536 || position - base + 24 + nameSize > GPU_REPORT_BYTES)
      throw new BinaryResourceFailure(
        "structure",
        GPU_REPORT_BYTES,
        "HIP directory exceeds 16 MiB or its bundle ID exceeds 65536 bytes",
      );
    let name: string;
    try {
      name = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        await source.read(position + 24, nameSize),
      );
    } catch (cause) {
      if (cause instanceof TypeError)
        return rejectGpu("HIP bundle ID is not valid UTF-8");
      throw cause;
    }
    if (offset > source.size || size > source.size - offset)
      rejectGpu("HIP entry range is outside its bundle");
    const row = gpuObject(source, {
      offset,
      size,
      kind: name.startsWith("host-")
        ? "host"
        : /^(?:hip|hipv4)-amdgcn-/u.test(name)
          ? "amdgpu"
          : "unknown",
      metadata: { offset: position, size: 24 + nameSize },
    });
    row.bundle_id = name;
    row.target =
      /-(?:-)?(gfx[a-zA-Z0-9]+(?::[^\s]+)?)$/u.exec(name)?.[1] ?? null;
    objects.push(row);
    position += 24 + nameSize;
  }
  let end = position;
  for (const row of objects) {
    if (row.encoded_size === 0) continue;
    if (row.location.offset < position)
      rejectGpu("HIP entry overlaps its bundle directory");
    end = Math.max(end, row.location.offset + row.encoded_size);
  }
  return { objects, end };
};
export const readCcobHeader = (bytes: Buffer, remaining: number) => {
  if (bytes.length < 20) rejectGpu("CCOB header is truncated");
  const version = bytes.readUInt16LE(4),
    method = bytes.readUInt16LE(6);
  let width: number, total: number, decoded: number, hash: bigint;
  if (version === 1) {
    width = 20;
    total = remaining;
    decoded = bytes.readUInt32LE(8);
    hash = bytes.readBigUInt64LE(12);
  } else if (version === 2) {
    width = 24;
    if (bytes.length < width) rejectGpu("CCOB v2 header is truncated");
    total = bytes.readUInt32LE(8);
    decoded = bytes.readUInt32LE(12);
    hash = bytes.readBigUInt64LE(16);
  } else if (version === 3) {
    width = 32;
    if (bytes.length < width) rejectGpu("CCOB v3 header is truncated");
    total = gpuCount(bytes.readBigUInt64LE(8));
    decoded = gpuCount(bytes.readBigUInt64LE(16));
    hash = bytes.readBigUInt64LE(24);
  } else
    throw new BinaryFormatFailure(
      "unsupported",
      `Unsupported CCOB version ${version}`,
    );
  if (total < width || total > remaining)
    rejectGpu("CCOB declared extent is invalid");
  return { version, method, width, total, decoded, hash };
};
