import { readElfFixedHeader } from "../../domain/elfFixedHeader.js";
import {
  BinaryFormatFailure,
  BinaryReader,
  BinaryResourceFailure,
  declaredFileRange,
} from "./BinaryContainer.js";

/** A borrowed positional source. Drivers own admission, cancellation and file identity. */
export interface NativeReadRequest {
  readonly offset: number;
  readonly size: number;
}
export interface NativeSection {
  readonly index: number;
  readonly name: string | null;
  readonly name_state: "known" | "unavailable" | "truncated";
  readonly header_offset: number;
  readonly offset: bigint;
  readonly size: bigint;
  readonly address: bigint;
  readonly type: number;
  readonly flags: bigint;
  readonly link: number;
  readonly info: number;
  readonly entry_size: bigint;
  readonly file_backed: boolean;
}
export interface NativeSectionDirectory {
  readonly format: "elf" | "pe";
  readonly bits: 32 | 64;
  readonly little: boolean;
  readonly machine: number;
  readonly elf_os_abi: number | null;
  readonly flags: number;
  readonly program_offset: bigint;
  readonly program_count: number;
  readonly program_width: number;
  readonly sections: readonly NativeSection[];
}
const STRUCTURE_BYTES = 16 * 1024 * 1024;
const reject = (message: string): never => {
  throw new BinaryFormatFailure("malformed", message);
};
const exact = (value: bigint): number => {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER))
    reject("Native offset exceeds exact host precision");
  return Number(value);
};
const request = (
  fileSize: number,
  offset: bigint,
  size: bigint,
): NativeReadRequest => {
  if (
    offset < 0n ||
    size < 0n ||
    offset > BigInt(fileSize) ||
    size > BigInt(fileSize) - offset
  )
    reject("Native directory range is truncated or outside the file");
  if (size > BigInt(STRUCTURE_BYTES))
    throw new BinaryResourceFailure(
      "structure",
      STRUCTURE_BYTES,
      "Native directory exceeds the 16 MiB structural decoding budget",
    );
  return { offset: exact(offset), size: exact(size) };
};

/** One ELF interpretation for in-memory images and bounded descriptor-backed inspections. */
export function* readElfSectionDirectory(
  fileSize: number,
): Generator<NativeReadRequest, NativeSectionDirectory, Buffer> {
  const prefix = yield request(fileSize, 0n, 16n);
  const headerSize = prefix[4] === 1 ? 52 : 64;
  const bytes = yield request(fileSize, 0n, BigInt(headerSize));
  const parsed = readElfFixedHeader(bytes, fileSize);
  if (!parsed.ok) return reject(parsed.error);
  const { elfClass: bits, byteOrder, machine } = parsed.value;
  const little = byteOrder === "little";
  const wide = bits === 64;
  const r = new BinaryReader(bytes, little);
  const program_offset = r.word(wide ? 32 : 28, bits);
  const sectionOffset = r.word(wide ? 40 : 32, bits);
  const program_width = r.u16(wide ? 54 : 42);
  const sectionWidth = r.u16(wide ? 58 : 46);
  let program_count = r.u16(wide ? 56 : 44);
  let count = r.u16(wide ? 60 : 48);
  let namesIndex = r.u16(wide ? 62 : 50);
  if (
    (program_count !== 0 && program_offset < BigInt(headerSize)) ||
    (sectionOffset !== 0n && sectionOffset < BigInt(headerSize))
  )
    reject("ELF header table overlaps the native header");
  if (
    sectionOffset === 0n &&
    (count !== 0 || namesIndex !== 0 || program_count === 0xffff)
  )
    reject("ELF section table is missing");
  if (
    sectionOffset !== 0n &&
    (count === 0 || namesIndex === 0xffff || program_count === 0xffff)
  ) {
    if (sectionWidth < (wide ? 64 : 40))
      reject("ELF extended section header width is invalid");
    const first = new BinaryReader(
      yield request(fileSize, sectionOffset, BigInt(sectionWidth)),
      little,
    );
    if (first.u32(4) !== 0)
      reject(
        "ELF initial section for extended numbering must have SHT_NULL type",
      );
    if (count === 0) {
      const declared = first.word(wide ? 32 : 20, bits);
      if (declared < 0xff00n) reject("ELF extended section count is invalid");
      count = exact(declared);
    }
    if (namesIndex === 0xffff) {
      namesIndex = first.u32(wide ? 40 : 24);
      if (namesIndex < 0xff00)
        reject("ELF extended section name index is below its reserved range");
    }
    if (program_count === 0xffff) {
      program_count = first.u32(wide ? 44 : 28);
      if (program_count < 0xffff)
        reject("ELF extended program count is below its reserved range");
    }
  }
  if (program_count !== 0) {
    if (program_width < (wide ? 56 : 32))
      reject("ELF program header width is invalid");
    request(
      fileSize,
      program_offset,
      BigInt(program_count) * BigInt(program_width),
    );
  }
  const sections: NativeSection[] = [];
  if (count !== 0) {
    if (sectionWidth < (wide ? 64 : 40) || namesIndex >= count)
      reject("ELF section width or name-table index is invalid");
    const table = new BinaryReader(
      yield request(
        fileSize,
        sectionOffset,
        BigInt(count) * BigInt(sectionWidth),
      ),
      little,
    );
    let names: Buffer | null = null;
    if (namesIndex !== 0) {
      const h = namesIndex * sectionWidth;
      if (table.u32(h + 4) !== 3)
        reject("ELF section name table is not a string table");
      names = yield request(
        fileSize,
        table.word(h + (wide ? 24 : 16), bits),
        table.word(h + (wide ? 32 : 20), bits),
      );
    }
    const decodedNames = new Map<
      number,
      { name: string | null; state: NativeSection["name_state"] }
    >();
    let nameBytes = 0;
    for (let index = 0; index < count; index++) {
      const h = index * sectionWidth;
      const nameOffset = table.u32(h);
      let name: string | null = null;
      let name_state: NativeSection["name_state"] = "unavailable";
      if (names !== null) {
        if (nameOffset >= names.length)
          reject("ELF section name offset is outside its string table");
        let decoded = decodedNames.get(nameOffset);
        if (decoded === undefined) {
          const window = names.subarray(
            nameOffset,
            Math.min(nameOffset + 65536, names.length),
          );
          const end = window.indexOf(0);
          nameBytes += end < 0 ? window.length : end + 1;
          if (nameBytes > STRUCTURE_BYTES)
            throw new BinaryResourceFailure(
              "structure",
              STRUCTURE_BYTES,
              "Decoded ELF section names exceed the 16 MiB structural budget",
            );
          decoded = {
            name: end < 0 ? null : window.toString("latin1", 0, end),
            state: end < 0 ? "truncated" : "known",
          };
          decodedNames.set(nameOffset, decoded);
        }
        name_state = decoded.state;
        name = decoded.name;
      }
      const type = table.u32(h + 4);
      const offset = table.word(h + (wide ? 24 : 16), bits);
      const size = table.word(h + (wide ? 32 : 20), bits);
      sections.push({
        index,
        name,
        name_state,
        header_offset: exact(sectionOffset) + h,
        offset,
        size,
        address: table.word(h + (wide ? 16 : 12), bits),
        type,
        flags: table.word(h + 8, bits),
        link: table.u32(h + (wide ? 40 : 24)),
        info: table.u32(h + (wide ? 44 : 28)),
        entry_size: table.word(h + (wide ? 56 : 36), bits),
        file_backed:
          type !== 8 && declaredFileRange(fileSize, offset, size).file_backed,
      });
    }
  }
  return {
    format: "elf",
    elf_os_abi: parsed.value.osAbi,
    bits,
    little,
    machine,
    flags: r.u32(wide ? 48 : 36),
    program_offset,
    program_count,
    program_width,
    sections,
  };
}

/** Shared COFF section fields; content extent excludes file-alignment padding. */
export const readPeSectionHeader = (bytes: Buffer) => {
  const r = new BinaryReader(bytes, true);
  const name = r.range(0, 8, "PE section name");
  const nul = name.indexOf(0);
  const virtual_size = r.u32(8);
  const raw_size = r.u32(16);
  return {
    name: name.toString("latin1", 0, nul < 0 ? name.length : nul),
    virtual_size,
    virtual_address: r.u32(12),
    raw_size,
    offset: r.u32(20),
    characteristics: r.u32(36),
    size: virtual_size === 0 ? raw_size : Math.min(virtual_size, raw_size),
  };
};

export function* readPeSectionDirectory(
  fileSize: number,
): Generator<NativeReadRequest, NativeSectionDirectory, Buffer> {
  const dos = new BinaryReader(yield request(fileSize, 0n, 64n), true);
  if (dos.u16(0) !== 0x5a4d) reject("Missing DOS MZ header");
  const pe = dos.u32(60);
  if (pe < 64) reject("PE signature overlaps the DOS header");
  const coff = new BinaryReader(yield request(fileSize, BigInt(pe), 24n), true);
  if (coff.u32(0) !== 0x4550) reject("PE signature is invalid");
  const optionalSize = coff.u16(20);
  const optional = new BinaryReader(
    yield request(fileSize, BigInt(pe + 24), BigInt(optionalSize)),
    true,
  );
  const magic = optional.u16(0);
  const bits = magic === 0x10b ? 32 : magic === 0x20b ? 64 : null;
  if (bits === null)
    throw new BinaryFormatFailure(
      "unsupported",
      "Only PE32/PE32+ images are supported",
    );
  const minimum = bits === 64 ? 112 : 96;
  if (
    optionalSize < minimum ||
    optional.u32(minimum - 4) * 8 > optionalSize - minimum
  )
    reject("PE optional header or data directories are truncated");
  const count = coff.u16(6);
  const start = pe + 24 + optionalSize;
  const table = yield request(fileSize, BigInt(start), BigInt(count) * 40n);
  const sections: NativeSection[] = [];
  for (let index = 0; index < count; index++) {
    const row = readPeSectionHeader(
      table.subarray(index * 40, (index + 1) * 40),
    );
    sections.push({
      index,
      name: row.name,
      name_state: "known",
      header_offset: start + index * 40,
      offset: BigInt(row.offset),
      size: BigInt(row.size),
      address: BigInt(row.virtual_address),
      type: 0,
      flags: BigInt(row.characteristics),
      link: 0,
      info: 0,
      entry_size: 0n,
      file_backed: declaredFileRange(
        fileSize,
        BigInt(row.offset),
        BigInt(row.size),
      ).file_backed,
    });
  }
  return {
    format: "pe",
    elf_os_abi: null,
    bits,
    little: true,
    machine: coff.u16(4),
    flags: coff.u16(22),
    program_offset: 0n,
    program_count: 0,
    program_width: 0,
    sections,
  };
}

/** Synchronous driver borrows bytes; file drivers satisfy the identical requests without loading payloads. */
export const readNativeDirectoryFromBuffer = (
  bytes: Buffer,
  format: "elf" | "pe",
): NativeSectionDirectory => {
  const steps =
    format === "elf"
      ? readElfSectionDirectory(bytes.length)
      : readPeSectionDirectory(bytes.length);
  let next = steps.next();
  while (!next.done) {
    const { offset, size } = next.value;
    next = steps.next(bytes.subarray(offset, offset + size));
  }
  return next.value;
};
