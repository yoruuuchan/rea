import {
  BinaryFormatFailure,
  BinaryReader,
  BinaryResourceFailure,
  mappedFileOffset,
} from "../metadata/BinaryContainer.js";
import { architectureForElfMachine } from "../metadata/ElfImage.js";
import { readElfString, readElfSymbol } from "../metadata/ElfSymbol.js";
import {
  readNativeDirectoryFromBuffer,
  type NativeSection,
} from "../metadata/NativeSectionDirectory.js";
import { readPeImage } from "../metadata/PeImage.js";
import {
  MAX_NATIVE_EXPORT_ROWS,
  type ElfExport,
  type NativeExportIssue,
  type NativeExports,
  type PeExport,
} from "../../domain/native/nativeExports.js";

type Artifact = NativeExports["artifact"];

const SHT_STRTAB = 3;
const SHT_DYNSYM = 11;
const SHT_GNU_VERDEF = 0x6ffffffd;
const SHT_GNU_VERSYM = 0x6fffffff;
const PE_EXPORT_DIRECTORY = 0;
const PE_EXPORT_DIRECTORY_BYTES = 40;
const MAXIMUM_NAME_BYTES = 4096;
/** Text retained across all rows; names can repeat one long string table entry. */
const MAXIMUM_RETAINED_TEXT_BYTES = 16 * 1024 * 1024;

/** Charge every retained row and its text before it is stored. */
const createRetention = () => {
  let rows = 0;
  let text = 0;
  return (...strings: readonly (string | null)[]): void => {
    rows++;
    rowBudget(rows, "Export inventory");
    for (const value of strings) text += value?.length ?? 0;
    if (text > MAXIMUM_RETAINED_TEXT_BYTES)
      throw new BinaryResourceFailure(
        "structure",
        MAXIMUM_RETAINED_TEXT_BYTES,
        `Export names exceed the ${String(MAXIMUM_RETAINED_TEXT_BYTES)}-byte retained-text allowance`,
      );
  };
};

const hex = (value: bigint | number) => `0x${value.toString(16)}`;

const rowBudget = (count: number, label: string): void => {
  if (count > MAX_NATIVE_EXPORT_ROWS)
    throw new BinaryResourceFailure(
      "structure",
      MAX_NATIVE_EXPORT_ROWS,
      `${label} declares ${String(count)} entries, above the ${String(MAX_NATIVE_EXPORT_ROWS)}-entry export inventory allowance`,
    );
};

const coverage = (
  issues: readonly NativeExportIssue[],
  examined: number,
  exports: number,
): NativeExports["coverage"] =>
  issues.length === 0
    ? { status: "complete", reason: null, examined_entries: examined, exports }
    : {
        status: "partial",
        reason: `${String(issues.length)} export table issue(s) left entries unreported; see issues`,
        examined_entries: examined,
        exports,
      };

const failureMessage = (cause: unknown): string => {
  if (cause instanceof BinaryFormatFailure) return cause.message;
  throw cause;
};

const PE_LIMITATIONS = [
  "Rows reproduce the PE export directory; they do not establish that an export is reachable, safe to call or loaded at runtime.",
  "Forwarded exports resolve in another DLL, which is not opened; ordinal-only exports have no name in this image.",
];

/** Read the PE export directory: every used address-table slot and its names. */
const parsePeExports = (bytes: Buffer, artifact: Artifact): NativeExports => {
  const image = readPeImage(bytes);
  const base = image.image_base ?? 0n;
  const directory = image.pe_data_directories?.[PE_EXPORT_DIRECTORY];
  const result = {
    artifact,
    format: "pe" as const,
    architecture: image.architecture,
    bits: image.bits,
  };
  if (directory === undefined || directory.virtual_address === 0)
    return {
      ...result,
      export_directory: null,
      exports: [],
      coverage: coverage([], 0, 0),
      issues: [],
      limitations: [
        "The image declares no export directory, so it exports nothing by name or ordinal.",
        ...PE_LIMITATIONS,
      ],
    };
  const reader = new BinaryReader(bytes, true);
  const mappings =
    image.pe_header_mapping === undefined
      ? image.mappings
      : [image.pe_header_mapping, ...image.mappings];
  const map = (rva: number, size: number): number =>
    mappedFileOffset(mappings, base + BigInt(rva), size, image.zero_fills);
  const cString = (rva: number): string => {
    const start = map(rva, 1);
    const end = bytes
      .subarray(start, start + MAXIMUM_NAME_BYTES + 1)
      .indexOf(0);
    if (end <= 0)
      throw new BinaryFormatFailure(
        "malformed",
        `Export name at RVA ${hex(rva)} is empty, unterminated or longer than ${String(MAXIMUM_NAME_BYTES)} bytes`,
      );
    // The whole string must stay inside one file-backed mapping.
    map(rva, end + 1);
    return bytes.toString("latin1", start, start + end);
  };

  const header = map(directory.virtual_address, PE_EXPORT_DIRECTORY_BYTES);
  const ordinalBase = reader.u32(header + 16);
  const functionCount = reader.u32(header + 20);
  const nameCount = reader.u32(header + 24);
  rowBudget(functionCount, "PE export address table");
  if (ordinalBase + functionCount > 0x10000)
    throw new BinaryFormatFailure(
      "malformed",
      "PE export ordinal base and address-table size exceed 16-bit ordinals",
    );
  rowBudget(nameCount, "PE export name table");
  const functions =
    functionCount === 0 ? 0 : map(reader.u32(header + 28), functionCount * 4);
  const names =
    nameCount === 0 ? 0 : map(reader.u32(header + 32), nameCount * 4);
  const ordinals =
    nameCount === 0 ? 0 : map(reader.u32(header + 36), nameCount * 2);
  const issues: NativeExportIssue[] = [];
  let dllName: string | null = null;
  try {
    dllName = cString(reader.u32(header + 12));
  } catch (cause) {
    issues.push({
      code: "name_unreadable",
      location: hex(reader.u32(header + 12)),
      message: `Export directory DLL name: ${failureMessage(cause)}`,
    });
  }

  const namesByFunction = new Map<number, string[]>();
  const namedFunctions = new Set<number>();
  for (let index = 0; index < nameCount; index++) {
    const functionIndex = reader.u16(ordinals + index * 2);
    const nameRva = reader.u32(names + index * 4);
    if (functionIndex >= functionCount) {
      issues.push({
        code: "malformed_entry",
        location: hex(nameRva),
        message: `Export name ${String(index)} selects address-table slot ${String(functionIndex)}, outside its ${String(functionCount)} slots`,
      });
      continue;
    }
    namedFunctions.add(functionIndex);
    try {
      const list = namesByFunction.get(functionIndex) ?? [];
      list.push(cString(nameRva));
      namesByFunction.set(functionIndex, list);
    } catch (cause) {
      issues.push({
        code: "name_unreadable",
        location: hex(nameRva),
        message: failureMessage(cause),
      });
    }
  }

  const forwarderEnd = directory.virtual_address + directory.size;
  const retain = createRetention();
  const exports: PeExport[] = [];
  for (let index = 0; index < functionCount; index++) {
    const rva = reader.u32(functions + index * 4);
    // A zero slot is an unused ordinal, not an export.
    if (rva === 0) continue;
    const ordinal = ordinalBase + index;
    let target: Pick<PeExport, "address" | "forwarder">;
    if (rva >= directory.virtual_address && rva < forwarderEnd) {
      try {
        target = { address: null, forwarder: cString(rva) };
      } catch (cause) {
        issues.push({
          code: "malformed_entry",
          location: hex(rva),
          message: `Forwarder of ordinal ${String(ordinal)}: ${failureMessage(cause)}`,
        });
        continue;
      }
    } else target = { address: hex(base + BigInt(rva)), forwarder: null };
    const exportNames = namesByFunction.get(index);
    if (exportNames !== undefined)
      for (const name of exportNames) {
        retain(name, target.forwarder);
        exports.push({ name, ordinal, ...target });
      }
    // A slot whose only name was unreadable is reported through its issue.
    else if (!namedFunctions.has(index)) {
      retain(target.forwarder);
      exports.push({ name: null, ordinal, ...target });
    }
  }
  return {
    ...result,
    export_directory: {
      rva: directory.virtual_address,
      size: directory.size,
      dll_name: dllName,
      ordinal_base: ordinalBase,
      timestamp: reader.u32(header + 4),
    },
    exports,
    coverage: coverage(issues, functionCount, exports.length),
    issues,
    limitations: PE_LIMITATIONS,
  };
};

const ELF_LIMITATIONS = [
  "Rows list defined default- or protected-visibility global, weak and unique dynamic symbols; local, hidden, internal and undefined symbols are not exports.",
  "A hidden symbol version is not the default version that a by-name dlsym lookup selects.",
  "Rows reproduce the dynamic symbol table; they do not establish that a symbol is reachable, safe to call or loaded at runtime.",
];

const ELF_TYPES: Readonly<Record<number, ElfExport["type"]>> = {
  1: "object",
  2: "function",
  6: "tls",
  10: "ifunc",
};
const ELF_BINDINGS: Readonly<Record<number, ElfExport["binding"]>> = {
  1: "global",
  2: "weak",
  10: "unique",
};

/** Version definitions by index, read from `.gnu.version_d`. */
const readVersionDefinitions = (
  reader: BinaryReader,
  sections: readonly NativeSection[],
  issues: NativeExportIssue[],
): Map<number, string> => {
  const definitions = new Map<number, string>();
  const verdef = sections.find(({ type }) => type === SHT_GNU_VERDEF);
  if (verdef === undefined) return definitions;
  try {
    const strings = sections[verdef.link];
    if (strings?.type !== SHT_STRTAB)
      throw new BinaryFormatFailure(
        "malformed",
        "Version definitions do not link to a string table",
      );
    const names = reader.fileRange(
      strings.offset,
      strings.size,
      "Version strings",
    );
    const nameBytes = reader.bytes.subarray(
      names.offset,
      names.offset + names.size,
    );
    const table = reader.fileRange(
      verdef.offset,
      verdef.size,
      "Version definitions",
    );
    let offset = 0;
    for (let index = 0; index < verdef.info; index++) {
      if (offset + 20 > table.size)
        throw new BinaryFormatFailure(
          "malformed",
          "Version definition chain leaves its section",
        );
      const at = table.offset + offset;
      const versionIndex = reader.u16(at + 4) & 0x7fff;
      const aux = reader.u32(at + 12);
      const next = reader.u32(at + 16);
      if (aux < 20 || offset + aux + 8 > table.size)
        throw new BinaryFormatFailure(
          "malformed",
          "Version definition name entry leaves its section",
        );
      definitions.set(
        versionIndex,
        readElfString(nameBytes, reader.u32(at + aux)),
      );
      if (next === 0) break;
      offset += next;
    }
  } catch (cause) {
    issues.push({
      code: "version_unresolved",
      location: hex(verdef.offset),
      message: `Version definitions: ${failureMessage(cause)}`,
    });
  }
  return definitions;
};

/** Read defined exported entries of `.dynsym` with their symbol versions. */
const parseElfExports = (bytes: Buffer, artifact: Artifact): NativeExports => {
  const directory = readNativeDirectoryFromBuffer(bytes, "elf");
  const reader = new BinaryReader(bytes, directory.little);
  const result = {
    artifact,
    format: "elf" as const,
    architecture: architectureForElfMachine(directory.machine),
    bits: directory.bits,
    byte_order: directory.little ? ("little" as const) : ("big" as const),
  };
  const { sections } = directory;
  if (sections.length === 0)
    return {
      ...result,
      exports: [],
      coverage: {
        status: "unsupported",
        reason:
          "The ELF has no section headers; enumerating dynamic symbols from the dynamic segment is not implemented",
        examined_entries: 0,
        exports: 0,
      },
      issues: [],
      limitations: ELF_LIMITATIONS,
    };
  const dynsym = sections.find(({ type }) => type === SHT_DYNSYM);
  if (dynsym === undefined)
    return {
      ...result,
      exports: [],
      coverage: coverage([], 0, 0),
      issues: [],
      limitations: [
        "The ELF has no dynamic symbol table, so it exports no dynamic symbols.",
        ...ELF_LIMITATIONS,
      ],
    };
  const width = directory.bits === 64 ? 24 : 16;
  const strings = sections[dynsym.link];
  if (
    dynsym.entry_size !== BigInt(width) ||
    dynsym.size % BigInt(width) !== 0n ||
    // The table must hold at least its mandatory null symbol.
    dynsym.size < BigInt(width) ||
    strings?.type !== SHT_STRTAB
  )
    throw new BinaryFormatFailure(
      "malformed",
      "ELF dynamic symbol table entry size, length, null entry or string-table link is invalid",
    );
  const count = Number(dynsym.size / BigInt(width));
  rowBudget(count, "ELF dynamic symbol table");
  const table = reader.table(
    dynsym.offset,
    count,
    width,
    "ELF dynamic symbols",
  );
  const nameRange = reader.fileRange(
    strings.offset,
    strings.size,
    "ELF dynamic strings",
  );
  const names = bytes.subarray(
    nameRange.offset,
    nameRange.offset + nameRange.size,
  );
  const issues: NativeExportIssue[] = [];
  const versym = sections.find(
    ({ type, link }) => type === SHT_GNU_VERSYM && link === dynsym.index,
  );
  let versions: number | null = null;
  if (versym !== undefined) {
    try {
      if (versym.size !== BigInt(count * 2))
        throw new BinaryFormatFailure(
          "malformed",
          `Symbol version table has ${String(versym.size)} bytes for ${String(count)} symbols`,
        );
      versions = reader.table(versym.offset, count, 2, "ELF symbol versions");
    } catch (cause) {
      // Keep every export; their versions become unknown.
      issues.push({
        code: "version_unresolved",
        location: hex(versym.offset),
        message: failureMessage(cause),
      });
    }
  }
  const definitions = readVersionDefinitions(reader, sections, issues);
  const unresolvedVersions = new Set<number>();
  const retain = createRetention();
  const exports: ElfExport[] = [];
  for (let index = 1; index < count; index++) {
    const at = table + index * width;
    const symbol = readElfSymbol(
      bytes.subarray(at, at + width),
      directory.bits,
      directory.little,
    );
    const binding = ELF_BINDINGS[symbol.binding];
    const visibility = symbol.other & 3;
    // Undefined, local and hidden/internal symbols are not exports.
    if (
      binding === undefined ||
      symbol.section_index === 0 ||
      (visibility !== 0 && visibility !== 3)
    )
      continue;
    let version: ElfExport["version"] = null;
    if (versym !== undefined && versions === null) version = "unknown";
    else if (versions !== null) {
      const raw = reader.u16(versions + index * 2);
      const versionIndex = raw & 0x7fff;
      if (versionIndex === 0) continue;
      if (versionIndex >= 2) {
        const defined = definitions.get(versionIndex);
        const name = defined === undefined || defined === "" ? null : defined;
        if (name === null && !unresolvedVersions.has(versionIndex)) {
          unresolvedVersions.add(versionIndex);
          issues.push({
            code: "version_unresolved",
            location: hex(symbol.value),
            message: `Version index ${String(versionIndex)}, first used by symbol ${String(index)}, has no named version definition`,
          });
        }
        version = {
          index: versionIndex,
          name,
          hidden: (raw & 0x8000) !== 0,
        };
      }
    }
    let name: string;
    try {
      name = readElfString(names, symbol.name_offset);
    } catch (cause) {
      issues.push({
        code: "name_unreadable",
        location: hex(symbol.value),
        message: `Dynamic symbol ${String(index)}: ${failureMessage(cause)}`,
      });
      continue;
    }
    if (name === "") {
      issues.push({
        code: "name_unreadable",
        location: hex(symbol.value),
        message: `Defined global dynamic symbol ${String(index)} has an empty name`,
      });
      continue;
    }
    retain(name, typeof version === "object" ? (version?.name ?? null) : null);
    exports.push({
      name,
      value: hex(symbol.value),
      size: symbol.size.toString(),
      type: ELF_TYPES[symbol.type] ?? "other",
      binding,
      version,
    });
  }
  return {
    ...result,
    exports,
    coverage: coverage(issues, count - 1, exports.length),
    issues,
    limitations: ELF_LIMITATIONS,
  };
};

/** Static export inventory of one PE or ELF image; other formats are unsupported. */
export const parseNativeExports = (
  bytes: Buffer,
  artifact: Artifact,
): NativeExports => {
  if (bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])))
    return parseElfExports(bytes, artifact);
  if (bytes.subarray(0, 2).equals(Buffer.from("MZ")))
    return parsePeExports(bytes, artifact);
  throw new BinaryFormatFailure(
    "unsupported",
    "Only PE and ELF images are supported; inspect Mach-O exports with inspect_macho",
  );
};
