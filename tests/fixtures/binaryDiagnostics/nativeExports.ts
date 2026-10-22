/** One PE export-address-table slot: code RVA, forwarder text, or unused. */
export type PeFixtureFunction =
  | { readonly rva: number }
  | { readonly forwarder: string }
  | null;

const SECTION_RVA = 0x1000;
const SECTION_OFFSET = 0x400;
const SECTION_BYTES = 0x400;
/** SizeOfHeaders; header RVAs map to the same file offsets. */
const HEADER_BYTES = 0x400;

/**
 * Minimal PE32/PE32+ image whose only section holds an export directory at
 * RVA 0x1000. Name entries point at `functions` by index.
 */
export const peExportImage = (options: {
  readonly bits?: 32 | 64;
  readonly ordinalBase?: number;
  readonly functions?: readonly PeFixtureFunction[];
  readonly names?: readonly { readonly name: string; readonly index: number }[];
  /** Replace one name's RVA, e.g. with an unmapped one. */
  readonly nameRvaOverride?: {
    readonly position: number;
    readonly rva: number;
  };
  readonly exportDirectory?: boolean;
  readonly declaredFunctions?: number;
  /** Store the export directory and its tables in the PE headers. */
  readonly inHeaders?: boolean;
}): Buffer => {
  const bits = options.bits ?? 64;
  const bytes = Buffer.alloc(SECTION_OFFSET + SECTION_BYTES);
  const wide = bits === 64;
  bytes.write("MZ", 0, "ascii");
  bytes.writeUInt32LE(128, 60);
  bytes.write("PE\0\0", 128, "ascii");
  bytes.writeUInt16LE(wide ? 0x8664 : 0x14c, 132);
  bytes.writeUInt16LE(1, 134);
  const directoriesAt = wide ? 112 : 96;
  const optionalSize = directoriesAt + 16 * 8;
  bytes.writeUInt16LE(optionalSize, 148);
  const optional = 152;
  bytes.writeUInt16LE(wide ? 0x20b : 0x10b, optional);
  if (wide) bytes.writeBigUInt64LE(0x180000000n, optional + 24);
  else bytes.writeUInt32LE(0x10000000, optional + 28);
  bytes.writeUInt32LE(16, optional + directoriesAt - 4);
  bytes.writeUInt32LE(HEADER_BYTES, optional + 60);
  const section = optional + optionalSize;
  bytes.write(".edata", section, "ascii");
  bytes.writeUInt32LE(SECTION_BYTES, section + 8);
  bytes.writeUInt32LE(SECTION_RVA, section + 12);
  bytes.writeUInt32LE(SECTION_BYTES, section + 16);
  bytes.writeUInt32LE(SECTION_OFFSET, section + 20);
  bytes.writeUInt32LE(0x40000040, section + 36);
  if (options.exportDirectory === false) return bytes;

  const at = (rva: number) =>
    rva < HEADER_BYTES ? rva : rva - SECTION_RVA + SECTION_OFFSET;
  const base = options.inHeaders === true ? 0x200 : SECTION_RVA;
  const functions = options.functions ?? [];
  const names = options.names ?? [];
  // Directory, address table, name table, ordinals, then strings; forwarders
  // stay inside the 0x200-byte declared directory range.
  const eat = base + 0x40;
  const nameTable = base + 0x80;
  const ordinalTable = base + 0xc0;
  let forwarderText = base + 0x100;
  let text = base + (options.inHeaders === true ? 0x180 : 0x200);
  const string = (value: string, inside: boolean): number => {
    const rva = inside ? forwarderText : text;
    bytes.write(`${value}\0`, at(rva), "latin1");
    if (inside) forwarderText += value.length + 1;
    else text += value.length + 1;
    return rva;
  };
  bytes.writeUInt32LE(base, optional + directoriesAt);
  bytes.writeUInt32LE(0x200, optional + directoriesAt + 4);
  const directory = at(base);
  bytes.writeUInt32LE(0x5f5e0ff, directory + 4);
  bytes.writeUInt32LE(string("fixture.dll", false), directory + 12);
  bytes.writeUInt32LE(options.ordinalBase ?? 1, directory + 16);
  bytes.writeUInt32LE(
    options.declaredFunctions ?? functions.length,
    directory + 20,
  );
  bytes.writeUInt32LE(names.length, directory + 24);
  bytes.writeUInt32LE(eat, directory + 28);
  bytes.writeUInt32LE(nameTable, directory + 32);
  bytes.writeUInt32LE(ordinalTable, directory + 36);
  functions.forEach((entry, index) => {
    const value =
      entry === null
        ? 0
        : "rva" in entry
          ? entry.rva
          : string(entry.forwarder, true);
    bytes.writeUInt32LE(value, at(eat) + index * 4);
  });
  names.forEach(({ name, index }, position) => {
    const rva =
      options.nameRvaOverride?.position === position
        ? options.nameRvaOverride.rva
        : string(name, false);
    bytes.writeUInt32LE(rva, at(nameTable) + position * 4);
    bytes.writeUInt16LE(index, at(ordinalTable) + position * 2);
  });
  return bytes;
};

/** One `.dynsym` entry; `version` is its raw `.gnu.version` half-word. */
export interface ElfFixtureSymbol {
  readonly name: string;
  readonly binding?: number;
  readonly type?: number;
  readonly visibility?: number;
  readonly section?: number;
  readonly value?: bigint;
  readonly size?: bigint;
  readonly version?: number;
  /** Replace the symbol's string-table offset. */
  readonly nameOffset?: number;
}

/**
 * Minimal ELF shared object with `.dynsym`, `.dynstr`, `.gnu.version` and
 * `.gnu.version_d`, laid out in order. Version definitions are indexed from 1.
 */
export const elfExportImage = (options: {
  readonly bits?: 32 | 64;
  readonly little?: boolean;
  readonly machine?: number;
  readonly symbols: readonly ElfFixtureSymbol[];
  readonly versionDefinitions?: readonly string[];
  /** Declare a `.gnu.version` table that is one entry short. */
  readonly truncatedVersions?: boolean;
  /** Point `.gnu.version` past the end of the file. */
  readonly versionsOutsideFile?: boolean;
  /** Declare a zero-byte `.dynsym`, without its null entry. */
  readonly emptyDynamicSymbols?: boolean;
  readonly sectionHeaders?: boolean;
  readonly dynamicSymbols?: boolean;
}): Buffer => {
  const bits = options.bits ?? 64;
  const little = options.little ?? true;
  const wide = bits === 64;
  const symbolWidth = wide ? 24 : 16;
  const sectionWidth = wide ? 64 : 40;
  const symbols = [null, ...options.symbols];
  const definitions = options.versionDefinitions ?? [];

  const dynstr: string[] = ["\0"];
  let dynstrBytes = 1;
  const strings = new Map<string, number>();
  const intern = (value: string): number => {
    const known = strings.get(value);
    if (known !== undefined) return known;
    const offset = dynstrBytes;
    strings.set(value, offset);
    dynstr.push(`${value}\0`);
    dynstrBytes += value.length + 1;
    return offset;
  };
  const definitionNames = definitions.map(intern);
  const symbolNames = symbols.map((symbol) =>
    symbol === null ? 0 : (symbol.nameOffset ?? intern(symbol.name)),
  );
  const shstrtab =
    "\0.dynsym\0.dynstr\0.gnu.version\0.gnu.version_d\0.shstrtab\0";
  let cursor = 0x100;
  const place = (size: number): number => {
    const offset = cursor;
    cursor = Math.ceil((cursor + size) / 16) * 16;
    return offset;
  };
  const dynsymAt = place(symbols.length * symbolWidth);
  const dynstrAt = place(dynstrBytes);
  const versymAt = place(symbols.length * 2);
  const verdefAt = place(definitions.length * 28);
  const shstrtabAt = place(shstrtab.length);
  const sectionAt = place(6 * sectionWidth);
  const bytes = Buffer.alloc(cursor);

  const u16 = (offset: number, value: number) =>
    little
      ? bytes.writeUInt16LE(value, offset)
      : bytes.writeUInt16BE(value, offset);
  const u32 = (offset: number, value: number) =>
    little
      ? bytes.writeUInt32LE(value, offset)
      : bytes.writeUInt32BE(value, offset);
  const word = (offset: number, value: bigint) => {
    if (!wide) u32(offset, Number(value));
    else if (little) bytes.writeBigUInt64LE(value, offset);
    else bytes.writeBigUInt64BE(value, offset);
  };
  bytes.set([0x7f, 0x45, 0x4c, 0x46, wide ? 2 : 1, little ? 1 : 2, 1]);
  u16(16, 3);
  u16(18, options.machine ?? (wide ? 62 : 40));
  u32(20, 1);
  u16(wide ? 52 : 40, wide ? 64 : 52);
  u16(wide ? 54 : 42, wide ? 56 : 32);
  u16(wide ? 58 : 46, sectionWidth);
  if (options.sectionHeaders === false) return bytes;

  symbols.forEach((symbol, index) => {
    if (symbol === null) return;
    const at = dynsymAt + index * symbolWidth;
    const info = ((symbol.binding ?? 1) << 4) | (symbol.type ?? 2);
    const other = symbol.visibility ?? 0;
    const value = symbol.value ?? BigInt(0x1000 + index * 16);
    u32(at, symbolNames[index]!);
    if (wide) {
      bytes[at + 4] = info;
      bytes[at + 5] = other;
      u16(at + 6, symbol.section ?? 1);
      word(at + 8, value);
      word(at + 16, symbol.size ?? 16n);
    } else {
      word(at + 4, value);
      word(at + 8, symbol.size ?? 16n);
      bytes[at + 12] = info;
      bytes[at + 13] = other;
      u16(at + 14, symbol.section ?? 1);
    }
  });
  Buffer.from(dynstr.join(""), "latin1").copy(bytes, dynstrAt);
  symbols.forEach((symbol, index) =>
    u16(versymAt + index * 2, symbol?.version ?? (index === 0 ? 0 : 1)),
  );
  definitions.forEach((_, index) => {
    const at = verdefAt + index * 28;
    u16(at, 1);
    u16(at + 2, index === 0 ? 1 : 0);
    u16(at + 4, index + 1);
    u16(at + 6, 1);
    u32(at + 12, 20);
    u32(at + 16, index === definitions.length - 1 ? 0 : 28);
    u32(at + 20, definitionNames[index]!);
  });
  bytes.write(shstrtab, shstrtabAt, "latin1");
  const sections = elfSectionRows(options, {
    dynsymAt,
    dynsym: symbols.length * symbolWidth,
    symbolWidth,
    dynstrAt,
    dynstrBytes,
    versymAt,
    versym: symbols.length * 2,
    verdefAt,
    definitions: definitions.length,
    shstrtabAt,
    shstrtab: shstrtab.length,
    end: cursor,
  });
  sections.forEach(([name, type, offset, size, link, info, entsize], index) => {
    const at = sectionAt + index * sectionWidth;
    u32(at, name);
    u32(at + 4, type);
    word(at + (wide ? 24 : 16), BigInt(offset));
    word(at + (wide ? 32 : 20), BigInt(size));
    u32(at + (wide ? 40 : 24), link);
    u32(at + (wide ? 44 : 28), info);
    word(at + (wide ? 56 : 36), BigInt(entsize));
  });
  word(wide ? 40 : 32, BigInt(sectionAt));
  u16(wide ? 60 : 48, sections.length);
  u16(wide ? 62 : 50, sections.length - 1);
  return bytes;
};

type ElfSectionRow = readonly [
  name: number,
  type: number,
  offset: number,
  size: number,
  link: number,
  info: number,
  entsize: number,
];

/** Section header rows for the fixture layout, with the requested defects. */
const elfSectionRows = (
  options: Parameters<typeof elfExportImage>[0],
  layout: {
    readonly dynsymAt: number;
    readonly dynsym: number;
    readonly symbolWidth: number;
    readonly dynstrAt: number;
    readonly dynstrBytes: number;
    readonly versymAt: number;
    readonly versym: number;
    readonly verdefAt: number;
    readonly definitions: number;
    readonly shstrtabAt: number;
    readonly shstrtab: number;
    readonly end: number;
  },
): readonly ElfSectionRow[] => [
  [0, 0, 0, 0, 0, 0, 0],
  ...(options.dynamicSymbols === false
    ? []
    : ([
        [
          1,
          11,
          layout.dynsymAt,
          options.emptyDynamicSymbols === true ? 0 : layout.dynsym,
          2,
          1,
          layout.symbolWidth,
        ],
        [9, 3, layout.dynstrAt, layout.dynstrBytes, 0, 0, 0],
        [
          17,
          0x6fffffff,
          options.versionsOutsideFile === true
            ? layout.end + 64
            : layout.versymAt,
          layout.versym - (options.truncatedVersions === true ? 2 : 0),
          1,
          0,
          2,
        ],
        [
          30,
          0x6ffffffd,
          layout.verdefAt,
          layout.definitions * 28,
          2,
          layout.definitions,
          0,
        ],
      ] satisfies ElfSectionRow[])),
  [45, 3, layout.shstrtabAt, layout.shstrtab, 0, 0, 0],
];
