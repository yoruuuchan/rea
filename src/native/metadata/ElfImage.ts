import {
  declaredFileRange,
  BinaryFormatFailure,
  BinaryReader,
  type BinaryContainer,
  type FileMapping,
  type ImageSection,
  type LoadRegion,
  type ZeroFillMapping,
} from "./BinaryContainer.js";
import { readElfFixedHeader } from "../../domain/elfFixedHeader.js";

/** Read ELF sections and file-backed program mappings without interpreting language metadata. */
export const readElfImage = (bytes: Buffer): BinaryContainer => {
  const fixedHeader = readElfFixedHeader(bytes);
  if (!fixedHeader.ok)
    throw new BinaryFormatFailure("malformed", fixedHeader.error);
  const { elfClass: bits, headerSize } = fixedHeader.value;
  const reader = new BinaryReader(
    bytes,
    fixedHeader.value.byteOrder === "little",
  );
  const wide = bits === 64;
  const phOffset = reader.word(wide ? 32 : 28, bits);
  const shOffset = reader.word(wide ? 40 : 32, bits);
  const phWidth = reader.u16(wide ? 54 : 42);
  const shWidth = reader.u16(wide ? 58 : 46);
  let phCount = reader.u16(wide ? 56 : 44);
  let shCount = reader.u16(wide ? 60 : 48);
  let namesIndex = reader.u16(wide ? 62 : 50);
  if (
    (phCount !== 0 && phOffset < BigInt(headerSize)) ||
    (shOffset !== 0n && shOffset < BigInt(headerSize))
  )
    throw new BinaryFormatFailure(
      "malformed",
      "ELF header table overlaps the native header",
    );
  if (
    shOffset !== 0n &&
    (shCount === 0 || phCount === 0xffff || namesIndex === 0xffff)
  ) {
    if (shWidth < (wide ? 64 : 40))
      throw new BinaryFormatFailure(
        "malformed",
        "ELF extended section header width is invalid",
      );
    const first = reader.fileRange(
      shOffset,
      BigInt(shWidth),
      "ELF section zero",
    ).offset;
    if (reader.u32(first + 4) !== 0)
      throw new BinaryFormatFailure(
        "malformed",
        "ELF initial section for extended numbering must have SHT_NULL type",
      );
    if (shCount === 0) {
      const count = reader.word(first + (wide ? 32 : 20), bits);
      if (count < 0xff00n || count > BigInt(Number.MAX_SAFE_INTEGER))
        throw new BinaryFormatFailure(
          "malformed",
          "ELF extended section count is invalid",
        );
      shCount = Number(count);
    }
    if (phCount === 0xffff) {
      phCount = reader.u32(first + (wide ? 44 : 28));
      if (phCount < 0xffff)
        throw new BinaryFormatFailure(
          "malformed",
          "ELF extended program count is below its reserved range",
        );
    }
    if (namesIndex === 0xffff) {
      namesIndex = reader.u32(first + (wide ? 40 : 24));
      if (namesIndex < 0xff00)
        throw new BinaryFormatFailure(
          "malformed",
          "ELF extended section name index is below its reserved range",
        );
    }
  } else if (
    shOffset === 0n &&
    (shCount !== 0 || namesIndex !== 0 || phCount === 0xffff)
  ) {
    throw new BinaryFormatFailure("malformed", "ELF section table is missing");
  }
  if (phCount !== 0 && phWidth < (wide ? 56 : 32))
    throw new BinaryFormatFailure(
      "malformed",
      "ELF program header width is invalid",
    );
  const phStart = reader.table(
    phOffset,
    phCount,
    phWidth,
    "ELF program headers",
  );
  const mappings: FileMapping[] = [];
  const loadRegions: LoadRegion[] = [];
  const executableMappings: FileMapping[] = [];
  const zeroFills: ZeroFillMapping[] = [];
  const sections: ImageSection[] = [];
  for (let index = 0; index < phCount; index++) {
    const offset = phStart + index * phWidth;
    if (reader.u32(offset) !== 1) continue;
    const flags = reader.u32(offset + (wide ? 4 : 24));
    const fileOffset = reader.word(offset + (wide ? 8 : 4), bits);
    const address = reader.word(offset + (wide ? 16 : 8), bits);
    const size = reader.word(offset + (wide ? 32 : 16), bits);
    const memorySize = reader.word(offset + (wide ? 40 : 20), bits);
    if (size > memorySize || address + memorySize > 1n << BigInt(bits))
      throw new BinaryFormatFailure(
        "malformed",
        "ELF load segment sizes or addresses are invalid",
      );
    const mapping = {
      ...(size === 0n
        ? { offset: 0, size: 0 }
        : reader.fileRange(fileOffset, size, "ELF load segment")),
      address,
    };
    if (mapping.size !== 0) {
      mappings.push(mapping);
      loadRegions.push({
        mapping,
        memory_size: memorySize,
        read: (flags & 4) !== 0,
        write: (flags & 2) !== 0,
        execute: (flags & 1) !== 0,
      });
      if ((flags & 1) !== 0) executableMappings.push(mapping);
    }
    if (memorySize > size)
      zeroFills.push({ address: address + size, size: memorySize - size });
  }
  if (shCount !== 0) {
    if (shWidth < (wide ? 64 : 40) || namesIndex >= shCount)
      throw new BinaryFormatFailure(
        "malformed",
        "ELF section width or name-table index is invalid",
      );
    const shStart = reader.table(
      shOffset,
      shCount,
      shWidth,
      "ELF section headers",
    );
    if (namesIndex !== 0) {
      const namesHeader = shStart + namesIndex * shWidth;
      if (reader.u32(namesHeader + 4) !== 3)
        throw new BinaryFormatFailure(
          "malformed",
          "ELF section name table is not a string table",
        );
      const names = reader.fileRange(
        reader.word(namesHeader + (wide ? 24 : 16), bits),
        reader.word(namesHeader + (wide ? 32 : 20), bits),
        "ELF section names",
      );
      for (let index = 0; index < shCount; index++) {
        const offset = shStart + index * shWidth;
        const nameOffset = reader.u32(offset);
        if (nameOffset >= names.size)
          throw new BinaryFormatFailure(
            "malformed",
            "ELF section name offset is outside its string table",
          );
        recordElfSection(sections, {
          bytes,
          names,
          nameOffset,
          reader,
          bits,
          wide,
          header: offset,
        });
      }
    }
  }
  return {
    format: "elf",
    architecture: architectureForElfMachine(fixedHeader.value.machine),
    bits,
    byte_order: reader.little ? "little" : "big",
    mappings,
    load_regions: loadRegions,
    executable_mappings: executableMappings,
    zero_fills: zeroFills,
    sections,
  };
};

const recordElfSection = (
  sections: ImageSection[],
  input: {
    readonly bytes: Buffer;
    readonly names: { readonly offset: number; readonly size: number };
    readonly nameOffset: number;
    readonly reader: BinaryReader;
    readonly bits: 32 | 64;
    readonly wide: boolean;
    readonly header: number;
  },
): void => {
  const decoded = elfSectionName(input.bytes, input.names, input.nameOffset);
  const header = {
    reader: input.reader,
    bits: input.bits,
    wide: input.wide,
    header: input.header,
  };
  switch (decoded.status) {
    case "named":
      sections.push(elfImageSection({ ...header, name: decoded.name }));
      return;
    case "truncated": {
      // Names past this window stay out of .dep-v0 matching. Read-only
      // bytes can still hold the only compiler path.
      const section = elfImageSection({ ...header, name: "" });
      if (section.read_only) sections.push(section);
      return;
    }
    case "unnamed":
      return;
    default: {
      const unreachable: never = decoded;
      return unreachable;
    }
  }
};

const elfSectionName = (
  bytes: Buffer,
  names: { readonly offset: number; readonly size: number },
  nameOffset: number,
):
  | { readonly status: "named"; readonly name: string }
  | { readonly status: "unnamed" }
  | { readonly status: "truncated" } => {
  const start = names.offset + nameOffset;
  const limit = Math.min(start + 64, names.offset + names.size);
  const nul = bytes.subarray(start, limit).indexOf(0);
  if (nul === 0) return { status: "unnamed" };
  if (nul < 0) return { status: "truncated" };
  return {
    status: "named",
    name: bytes.toString("latin1", start, start + nul),
  };
};

const elfImageSection = ({
  reader,
  bits,
  wide,
  header,
  name,
}: {
  readonly reader: BinaryReader;
  readonly bits: 32 | 64;
  readonly wide: boolean;
  readonly header: number;
  readonly name: string;
}): ImageSection => {
  const type = reader.u32(header + 4);
  const flags = reader.word(header + 8, bits);
  const declared_range = {
    offset: reader.word(header + (wide ? 24 : 16), bits),
    size: reader.word(header + (wide ? 32 : 20), bits),
  };
  const declared = declaredFileRange(
    reader.bytes.length,
    declared_range.offset,
    declared_range.size,
  );
  // SHT_NOBITS offsets and sizes do not describe stored bytes.
  const range =
    type === SHT_NOBITS ? { ...declared, file_backed: false } : declared;
  const compressed = (flags & 0x800n) !== 0n;
  const readOnly =
    type === 1 &&
    range.file_backed &&
    !compressed &&
    (flags & 1n) === 0n &&
    (flags & 4n) === 0n &&
    (flags & 2n) !== 0n;
  return {
    format: "elf",
    name,
    type,
    address: reader.word(header + (wide ? 16 : 12), bits),
    declared_range,
    ...range,
    read_only: readOnly,
    compressed,
  };
};

const SHT_NOBITS = 8;

/** Map ELF machine identifiers to stable architecture names. */
const architectureForElfMachine = (machine: number): string => {
  const names = new Map([
    [3, "386"],
    [8, "mips"],
    [20, "ppc"],
    [21, "ppc64"],
    [22, "s390"],
    [40, "arm"],
    [62, "amd64"],
    [183, "arm64"],
    [243, "riscv"],
    [258, "loongarch"],
  ]);
  return names.get(machine) ?? `elf-machine-${machine}`;
};
