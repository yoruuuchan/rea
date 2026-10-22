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
import { readNativeDirectoryFromBuffer } from "./NativeSectionDirectory.js";

/** Read ELF sections and file-backed program mappings without interpreting language metadata. */
export const readElfImage = (bytes: Buffer): BinaryContainer => {
  const directory = readNativeDirectoryFromBuffer(bytes, "elf");
  const {
    bits,
    program_offset: phOffset,
    program_count: phCount,
    program_width: phWidth,
  } = directory;
  const reader = new BinaryReader(bytes, directory.little);
  const wide = bits === 64;
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
  for (const section of directory.sections) {
    if (section.name === "" || section.name_state === "unavailable") continue;
    const range = declaredFileRange(bytes.length, section.offset, section.size);
    const file_backed = section.type !== 8 && range.file_backed;
    const compressed = (section.flags & 0x800n) !== 0n;
    const read_only =
      section.type === 1 &&
      file_backed &&
      !compressed &&
      (section.flags & 1n) === 0n &&
      (section.flags & 4n) === 0n &&
      (section.flags & 2n) !== 0n;
    if (section.name === null && !read_only) continue;
    sections.push({
      format: "elf",
      name: section.name ?? "",
      type: section.type,
      address: section.address,
      declared_range: { offset: section.offset, size: section.size },
      ...range,
      file_backed,
      compressed,
      read_only,
    });
  }
  return {
    format: "elf",
    architecture: architectureForElfMachine(directory.machine),
    bits,
    byte_order: reader.little ? "little" : "big",
    mappings,
    load_regions: loadRegions,
    executable_mappings: executableMappings,
    zero_fills: zeroFills,
    sections,
  };
};

/** Map ELF machine identifiers to stable architecture names. */
export const architectureForElfMachine = (machine: number): string => {
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
