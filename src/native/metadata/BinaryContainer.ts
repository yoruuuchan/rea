/** Distinguish corrupt recognized binaries from containers outside parser coverage. */
export class BinaryFormatFailure extends Error {
  constructor(
    readonly kind: "malformed" | "unsupported",
    message: string,
  ) {
    super(message);
    this.name = "BinaryFormatFailure";
  }
}

/** Resource boundary exceeded while decoding metadata or native container structure. */
export class BinaryResourceFailure extends Error {
  constructor(
    readonly boundary: "build-info" | "structure" | "search",
    readonly maximum_bytes: number,
    message: string,
  ) {
    super(message);
    this.name = "BinaryResourceFailure";
  }
}

/** One file-backed virtual range; addresses stay exact until mapped to file offsets. */
export interface FileMapping {
  readonly address: bigint;
  readonly offset: number;
  readonly size: number;
}

/** Declared zero-initialized virtual memory with no corresponding file bytes. */
export interface ZeroFillMapping {
  readonly address: bigint;
  readonly size: bigint;
}

/** Native loader region facts; language-specific fallback selection belongs to consumers. */
export interface LoadRegion {
  readonly mapping: FileMapping;
  readonly memory_size: bigint;
  readonly read: boolean;
  readonly write: boolean;
  readonly execute: boolean;
  /** Raw Mach-O VM_PROT masks preserve bits not represented by booleans. */
  readonly protection_masks?: {
    readonly current: number;
    readonly maximum: number;
  };
}

/** Parsed section facts; consumer metadata validity is separate from native structure. */
export type ImageSection = {
  readonly name: string;
  readonly offset: number;
  readonly size: number;
  readonly file_backed: boolean;
  readonly read_only: boolean;
  readonly compressed: boolean;
} & (
  | {
      readonly format: "elf";
      readonly type: number;
      readonly address: bigint;
      readonly declared_range: {
        readonly offset: bigint;
        readonly size: bigint;
      };
    }
  | {
      readonly format: "pe";
      readonly virtual_address: number;
      readonly virtual_size: number;
      readonly raw_size: number;
      readonly characteristics: number;
    }
  | {
      readonly format: "macho";
      readonly section_name: string;
      readonly type: number;
      readonly address: bigint;
      readonly declared_range: {
        readonly offset: bigint;
        readonly size: bigint;
      };
      readonly segment_mapping: FileMapping | null;
      readonly segment_unmapped: boolean;
    }
);

/** Native container facts, without language metadata search policy. */
export interface BinaryContainer {
  readonly format: "elf" | "pe" | "macho";
  readonly architecture: string;
  readonly bits: 32 | 64;
  readonly byte_order: "little" | "big";
  /** Declared PE preferred base, when available. */
  readonly image_base?: bigint;
  /** Mach-O load-command observation, when available. */
  readonly macho_chained_fixups?: boolean;
  readonly mappings: readonly FileMapping[];
  readonly load_regions?: readonly LoadRegion[];
  /** File-backed ranges the native loader marks executable. */
  readonly executable_mappings?: readonly FileMapping[];
  readonly zero_fills: readonly ZeroFillMapping[];
  readonly sections: readonly ImageSection[];
}

/** Reader that checks every structural range before decoding numeric fields. */
export class BinaryReader {
  constructor(
    readonly bytes: Buffer,
    readonly little: boolean,
  ) {}

  range(offset: number, size: number, label: string): Buffer {
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(size) ||
      offset < 0 ||
      size < 0 ||
      offset > this.bytes.length ||
      size > this.bytes.length - offset
    )
      throw new BinaryFormatFailure(
        "malformed",
        `${label} range is truncated or outside the file`,
      );
    return this.bytes.subarray(offset, offset + size);
  }

  u16(offset: number): number {
    const value = this.range(offset, 2, "16-bit field");
    return this.little ? value.readUInt16LE() : value.readUInt16BE();
  }

  u32(offset: number): number {
    const value = this.range(offset, 4, "32-bit field");
    return this.little ? value.readUInt32LE() : value.readUInt32BE();
  }

  word(offset: number, bits: 32 | 64): bigint {
    if (bits === 32) return BigInt(this.u32(offset));
    const value = this.range(offset, 8, "64-bit field");
    return this.little ? value.readBigUInt64LE() : value.readBigUInt64BE();
  }

  fileRange(offset: bigint, size: bigint, label: string): FileMapping {
    if (
      offset > BigInt(this.bytes.length) ||
      size > BigInt(this.bytes.length) - offset
    )
      throw new BinaryFormatFailure(
        "malformed",
        `${label} range is outside the file`,
      );
    const result = { address: 0n, offset: Number(offset), size: Number(size) };
    this.range(result.offset, result.size, label);
    return result;
  }

  table(offset: bigint, count: number, width: number, label: string): number {
    const size = BigInt(count) * BigInt(width);
    if (size > 16n * 1024n * 1024n)
      throw new BinaryResourceFailure(
        "structure",
        16 * 1024 * 1024,
        `${label} exceeds the 16 MiB structural decoding budget`,
      );
    return this.fileRange(offset, size, label).offset;
  }
}

/** Admit a declared file span, or mark it unbacked when it leaves the file. */
export const declaredFileRange = (
  fileBytes: number,
  offset: bigint,
  size: bigint,
): {
  readonly offset: number;
  readonly size: number;
  readonly file_backed: boolean;
} => {
  if (
    offset < 0n ||
    size < 0n ||
    offset > BigInt(Number.MAX_SAFE_INTEGER) ||
    size > BigInt(Number.MAX_SAFE_INTEGER) ||
    offset > BigInt(fileBytes) ||
    size > BigInt(fileBytes) - offset
  )
    return { offset: 0, size: 0, file_backed: false };
  return {
    offset: Number(offset),
    size: Number(size),
    file_backed: size > 0n,
  };
};

/** Map a virtual span without losing precision or selecting an ambiguous alias. */
export const mappedFileOffset = (
  mappings: readonly FileMapping[],
  address: bigint,
  size: number,
  zeroFills: readonly ZeroFillMapping[] = [],
): number => {
  let found: number | undefined;
  for (const mapping of mappings) {
    const delta = address - mapping.address;
    if (
      delta < 0n ||
      delta > BigInt(mapping.size) ||
      BigInt(size) > BigInt(mapping.size) - delta
    )
      continue;
    const offset = mapping.offset + Number(delta);
    if (found !== undefined && found !== offset)
      throw new BinaryFormatFailure(
        "malformed",
        "Virtual address has ambiguous file mappings",
      );
    found = offset;
  }
  if (found === undefined)
    throw new BinaryFormatFailure(
      "malformed",
      "Virtual address or string range is not file mapped",
    );
  for (const zeroFill of zeroFills) {
    if (spansOverlap(address, BigInt(size), zeroFill.address, zeroFill.size))
      throw new BinaryFormatFailure(
        "malformed",
        "Virtual address has ambiguous file and zero-fill mappings",
      );
  }
  const end = address + BigInt(size);
  for (const mapping of mappings) {
    const start = address > mapping.address ? address : mapping.address;
    const mappingEnd = mapping.address + BigInt(mapping.size);
    const overlapEnd = end < mappingEnd ? end : mappingEnd;
    if (start >= overlapEnd) continue;
    if (
      BigInt(found) + start - address !==
      BigInt(mapping.offset) + start - mapping.address
    )
      throw new BinaryFormatFailure(
        "malformed",
        "Virtual address has ambiguous file mappings",
      );
  }
  return found;
};

/** Recognize a wholly zero-filled span while refusing even partial file aliases. */
export const isZeroFilledSpan = (
  mappings: readonly FileMapping[],
  zeroFills: readonly ZeroFillMapping[],
  address: bigint,
  size: number,
): boolean => {
  const bytes = BigInt(size);
  if (
    !zeroFills.some(
      (mapping) =>
        address >= mapping.address &&
        address + bytes <= mapping.address + mapping.size,
    )
  )
    return false;
  for (const mapping of mappings) {
    if (spansOverlap(address, bytes, mapping.address, BigInt(mapping.size)))
      throw new BinaryFormatFailure(
        "malformed",
        "Virtual address has ambiguous file and zero-fill mappings",
      );
  }
  return true;
};

const spansOverlap = (
  address: bigint,
  size: bigint,
  otherAddress: bigint,
  otherSize: bigint,
): boolean =>
  size > 0n &&
  otherSize > 0n &&
  address < otherAddress + otherSize &&
  otherAddress < address + size;
