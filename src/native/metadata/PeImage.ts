import { readPeSectionHeader } from "./NativeSectionDirectory.js";
import {
  observeMzWindowsHeader,
  parseDosMzHeader,
} from "../../domain/dosMz.js";
import {
  declaredFileRange,
  BinaryFormatFailure,
  BinaryReader,
  type BinaryContainer,
  type FileMapping,
  type ImageSection,
  type ZeroFillMapping,
} from "./BinaryContainer.js";

const peHeaderOffset = (reader: BinaryReader): number => {
  const windowsHeader = observeMzWindowsHeader(reader.bytes);
  if (windowsHeader.state !== "declared") {
    const dos = parseDosMzHeader(reader.bytes);
    if (!dos.ok) throw new BinaryFormatFailure("malformed", dos.error);
    throw new BinaryFormatFailure(
      "unsupported",
      "DOS MZ images are outside the supported ELF, PE and thin Mach-O formats",
    );
  }
  const { offset: pe } = windowsHeader;
  if (pe < 64)
    throw new BinaryFormatFailure(
      "malformed",
      "PE signature overlaps the DOS header",
    );
  reader.range(pe, 24, "PE signature and COFF header");
  if (["NE", "LE", "LX"].includes(windowsHeader.signature))
    throw new BinaryFormatFailure(
      "unsupported",
      `${windowsHeader.signature} images are outside the supported ELF, PE and thin Mach-O formats`,
    );
  if (windowsHeader.signature !== "PE")
    throw new BinaryFormatFailure(
      "malformed",
      "PE signature is invalid or overlaps the DOS header",
    );
  return pe;
};

const optionalHeaderMagic = (
  reader: BinaryReader,
  offset: number,
  size: number,
): number => {
  reader.range(offset, size, "PE optional header");
  if (size < 2)
    throw new BinaryFormatFailure(
      "malformed",
      "PE optional header is missing its complete magic field",
    );
  return reader.u16(offset);
};

/** Read PE32/PE32+ native image mappings and section facts. */
export const readPeImage = (bytes: Buffer): BinaryContainer => {
  const reader = new BinaryReader(bytes, true);
  const pe = peHeaderOffset(reader);
  const optional = pe + 24;
  const optionalSize = reader.u16(pe + 20);
  const magic = optionalHeaderMagic(reader, optional, optionalSize);
  const bits = magic === 0x10b ? 32 : magic === 0x20b ? 64 : null;
  if (bits === null)
    throw new BinaryFormatFailure(
      "unsupported",
      "Only PE32 and PE32+ image optional headers are supported",
    );
  if (optionalSize < (bits === 64 ? 112 : 96))
    throw new BinaryFormatFailure(
      "malformed",
      "PE optional header is truncated",
    );
  const directoriesOffset = bits === 64 ? 112 : 96;
  const directories = reader.u32(optional + directoriesOffset - 4);
  if (directories * 8 > optionalSize - directoriesOffset)
    throw new BinaryFormatFailure(
      "malformed",
      "PE data directories extend beyond the optional header",
    );
  const dataDirectories = Array.from({ length: directories }, (_, index) => {
    const entry = optional + directoriesOffset + index * 8;
    return { virtual_address: reader.u32(entry), size: reader.u32(entry + 4) };
  });
  const imageBase = reader.word(optional + (bits === 64 ? 24 : 28), bits);
  const headerMapping: FileMapping = {
    address: imageBase,
    offset: 0,
    size: Math.min(reader.u32(optional + 60), bytes.length),
  };
  const count = reader.u16(pe + 6);
  const start = reader.table(
    BigInt(optional + optionalSize),
    count,
    40,
    "PE sections",
  );
  const mappings: FileMapping[] = [];
  const executableMappings: FileMapping[] = [];
  const zeroFills: ZeroFillMapping[] = [];
  const sections: ImageSection[] = [];
  for (let index = 0; index < count; index++) {
    const entry = start + index * 40;
    const {
      name: sectionName,
      virtual_size: virtualSize,
      virtual_address: virtualAddress,
      raw_size: size,
      offset,
      characteristics,
      size: contentSize,
    } = readPeSectionHeader(reader.range(entry, 40, "PE section header"));
    sections.push(
      peImageSection({
        reader,
        name: sectionName,
        size: contentSize,
        offset,
        characteristics,
        virtualAddress,
        virtualSize,
        rawSize: size,
      }),
    );
    const address = imageBase + BigInt(virtualAddress);
    if (address + BigInt(Math.max(size, virtualSize)) > 1n << BigInt(bits))
      throw new BinaryFormatFailure(
        "malformed",
        "PE section virtual address overflows its address width",
      );
    const mapping = {
      ...(size === 0
        ? { offset: 0, size: 0 }
        : reader.fileRange(BigInt(offset), BigInt(size), "PE section")),
      address,
    };
    if (size !== 0) {
      mappings.push(mapping);
      if ((characteristics & 0x20000000) !== 0)
        executableMappings.push({ ...mapping, size: contentSize });
    }
    if (virtualSize > size)
      zeroFills.push({
        address: address + BigInt(size),
        size: BigInt(virtualSize - size),
      });
  }
  const machine = reader.u16(pe + 4);
  const names = new Map([
    [0x014c, "386"],
    [0x8664, "amd64"],
    [0x01c0, "arm"],
    [0x01c2, "arm"],
    [0x01c4, "arm"],
    [0xaa64, "arm64"],
  ]);
  return {
    format: "pe",
    image_base: imageBase,
    pe_data_directories: dataDirectories,
    pe_header_mapping: headerMapping,
    architecture: names.get(machine) ?? `pe-machine-${machine}`,
    bits,
    byte_order: "little",
    mappings,
    executable_mappings: executableMappings,
    zero_fills: zeroFills,
    sections,
  };
};

const peImageSection = ({
  reader,
  name,
  size,
  offset,
  characteristics,
  virtualAddress,
  virtualSize,
  rawSize,
}: {
  readonly reader: BinaryReader;
  readonly name: string;
  readonly size: number;
  readonly offset: number;
  readonly characteristics: number;
  readonly virtualAddress: number;
  readonly virtualSize: number;
  readonly rawSize: number;
}): ImageSection => {
  const range = declaredFileRange(
    reader.bytes.length,
    BigInt(offset),
    BigInt(size),
  );
  const readOnly =
    range.file_backed &&
    (characteristics & 0x40000000) !== 0 &&
    (characteristics & 0x80000000) === 0 &&
    (characteristics & 0x20000000) === 0 &&
    (characteristics & 0x40) !== 0;
  return {
    format: "pe",
    name,
    virtual_address: virtualAddress,
    virtual_size: virtualSize,
    raw_size: rawSize,
    characteristics,
    ...range,
    read_only: readOnly,
    compressed: false,
  };
};
