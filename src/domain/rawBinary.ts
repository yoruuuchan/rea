import { z } from "zod";

import type { BinaryArchitecture } from "./binaryTargetTypes.js";
import type { ExecutableFormatHint } from "./dosCom.js";
import { err, ok, type Result } from "./result.js";

/** Caller-visible CPU families admitted for headerless raw binaries. */
export const BINARY_ARCHITECTURES = [
  "x86",
  "x86_64",
  "arm",
  "arm64",
] as const satisfies readonly BinaryArchitecture[];

/** Provider-neutral CPU family for a caller-supplied raw-binary load. */
export const binaryArchitectureSchema = z.enum(BINARY_ARCHITECTURES);

const RAW_BINARY_ENTRY_POINT = /^0x[0-9A-Fa-f]{1,16}$/u;

/** Hexadecimal load and entry address; file offset 0 is mapped here. */
export const rawBinaryEntryPointSchema = z
  .string()
  .regex(RAW_BINARY_ENTRY_POINT, {
    message: "entry_point must be a hexadecimal address of the form 0x…",
  });

/** Canonicalized caller-supplied raw-binary entry with the original spelling. */
export interface CanonicalRawBinaryEntry {
  readonly source: string;
  readonly canonical: string;
  readonly value: bigint;
}

/** Parse a caller-supplied hex entry while preserving the source spelling. */
export const parseRawBinaryEntryPoint = (
  value: string,
): Result<CanonicalRawBinaryEntry, string> => {
  if (!RAW_BINARY_ENTRY_POINT.test(value))
    return err("entry_point must be a hexadecimal address of the form 0x…");
  const parsed = BigInt(value);
  return ok({
    source: value,
    canonical: `0x${parsed.toString(16)}`,
    value: parsed,
  });
};

/** Reject empty or non-integral file extents for a headerless image. */
export const validateRawBinaryLength = (
  length: number,
): Result<null, string> =>
  Number.isSafeInteger(length) && length >= 1
    ? ok(null)
    : err("raw-binary requires at least one file byte");

/** Admitted headerless load identity used by target resolution and profiles. */
export interface RawBinaryAdmission {
  readonly architecture: Exclude<BinaryArchitecture, "mips">;
  readonly entryPoint: string;
  readonly entryPointSource: string;
}

const addressWidth = (architecture: BinaryArchitecture): bigint =>
  architecture === "x86" || architecture === "arm"
    ? 0xffffffffn
    : 0xffffffffffffffffn;

/** Validate architecture, entry, and that the mapped image fits the CPU width. */
export const admitRawBinary = (input: {
  readonly architecture: unknown;
  readonly entryPoint: unknown;
  readonly fileBytes: number;
}): Result<RawBinaryAdmission, string> => {
  const architecture = binaryArchitectureSchema.safeParse(input.architecture);
  if (!architecture.success)
    return err(
      "raw-binary format requires architecture (x86, x86_64, arm, or arm64)",
    );
  if (typeof input.entryPoint !== "string")
    return err(
      "raw-binary format requires entry_point as a hexadecimal address of the form 0x…",
    );
  const entry = parseRawBinaryEntryPoint(input.entryPoint);
  if (!entry.ok) return entry;
  if (
    (architecture.data === "arm" || architecture.data === "arm64") &&
    entry.value.value % 4n !== 0n
  )
    return err(
      `raw-binary ${architecture.data} entry_point ${entry.value.canonical} must be 4-byte aligned`,
    );
  const length = validateRawBinaryLength(input.fileBytes);
  if (!length.ok) return length;
  const last = entry.value.value + BigInt(input.fileBytes) - 1n;
  const max = addressWidth(architecture.data);
  if (entry.value.value > max || last > max)
    return err(
      `raw-binary mapping from ${entry.value.canonical} must fit in the ${architecture.data} address width`,
    );
  return ok({
    architecture: architecture.data,
    entryPoint: entry.value.canonical,
    entryPointSource: entry.value.source,
  });
};

/** Describe the format/architecture/entry pairing without performing I/O. */
export const rawBinarySelectionError = (input: {
  readonly format?: ExecutableFormatHint;
  readonly architecture?: unknown;
  readonly entryPoint?: unknown;
}): string | undefined => {
  const hasArchitecture = input.architecture !== undefined;
  const hasEntry = input.entryPoint !== undefined;
  if (input.format === "raw-binary") {
    if (!hasArchitecture || !hasEntry)
      return "format=raw-binary requires architecture and entry_point";
    return undefined;
  }
  if (hasArchitecture || hasEntry)
    return "architecture and entry_point apply only with format=raw-binary";
  return undefined;
};
