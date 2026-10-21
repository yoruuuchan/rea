import type { FileHandle } from "node:fs/promises";
import { copyArtifactEntry, type ArtifactEntry } from "../ArtifactReader.js";
import { isCArchiveDeclaration, type CArchiveEntry } from "./CArchiveLayout.js";
import type { PyzArchive, PyzEntry } from "./PyzArchive.js";
import {
  RECONSTRUCTED_PYTHON_HEADER_LIMITATION,
  reconstructedPycHeader,
} from "./PythonBytecode.js";
import {
  cArchiveEntryMetadata,
  pyzEntryMetadata,
  pyzEntryEncrypted,
} from "./PyInstallerMetadata.js";
import type { PyInstallerEntryMetadata } from "../../domain/artifactFormatMetadata.js";

const CRYPTO_KEY_NAME = "pyimod00_crypto_key";

/** Parsed facts and the descriptor identity used to locate a retained image. */
export interface PyzImage {
  readonly archive: PyzArchive;
  readonly handle: FileHandle;
  readonly start: number;
}

/** Stable entry descriptions and bounded read plans; expanded member bytes are never retained. */
export interface PyInstallerMember {
  readonly entry: ArtifactEntry;
  readonly read:
    | {
        readonly kind: "carchive";
        readonly archiveStart: number;
        readonly source: CArchiveEntry;
        readonly header: Buffer | undefined;
      }
    | {
        readonly kind: "pyz";
        readonly handle: FileHandle;
        readonly offset: number;
        readonly length: number;
        readonly compressed: boolean;
        readonly uncompressedSize: number | undefined;
        readonly header: Buffer | undefined;
      }
    | undefined;
}

/** The producer's key is an importable, nonempty Python module, not a data filename. */
export const hasEncryptionMarker = (
  entries: readonly CArchiveEntry[],
): boolean =>
  entries.some(
    (entry) =>
      entry.name === CRYPTO_KEY_NAME &&
      (entry.typeCode === "m" || entry.typeCode === "M") &&
      entry.uncompressedSize > 0,
  );

export const projectStoredMember = (
  entry: CArchiveEntry,
  archiveStart: number,
  pythonMagic: Buffer | undefined,
): PyInstallerMember => {
  if (isCArchiveDeclaration(entry))
    return {
      entry: fileEntry({
        path: `__pyinstaller__/${entry.typeCode === "o" ? "runtime-options" : "dependencies"}/${String(entry.index)}`,
        kind: "metadata",
        declaredSize: entry.uncompressedSize,
        compressedSize: entry.compressedSize,
        byteOffset: null,
        limitations:
          entry.typeCode === "d"
            ? [
                "Multipackage dependency bytes belong to another executable and remain unresolved.",
              ]
            : [],
        adapterKey: `carchive:${String(entry.index)}:${entry.name}`,
        formatMetadata: cArchiveEntryMetadata(entry),
      }),
      read: undefined,
    };
  const header =
    pythonMagic !== undefined && isBytecodeType(entry.typeCode)
      ? reconstructedPycHeader(pythonMagic)
      : undefined;
  const path = canonicalMemberPath(entry.name);
  const symlink = entry.typeCode === "n";
  const limitations: string[] = [];
  if (symlink) limitations.push("PyInstaller symlink target was not read.");
  if (header !== undefined)
    limitations.push(RECONSTRUCTED_PYTHON_HEADER_LIMITATION);
  const declaredSize = entry.uncompressedSize;
  return {
    entry: fileEntry({
      path,
      kind: symlink ? "symlink" : "file",
      declaredSize,
      compressedSize: entry.compressedSize,
      byteOffset: sourceByteOffset(entry, archiveStart),
      limitations,
      adapterKey: `carchive:${String(entry.index)}:${entry.name}`,
      formatMetadata: cArchiveEntryMetadata(entry, header),
    }),
    read: {
      kind: "carchive",
      archiveStart,
      source: entry,
      header,
    },
  };
};

export const projectPyzContainer = (
  entry: CArchiveEntry,
  archiveStart: number,
  image: PyzImage,
  encrypted: boolean,
): PyInstallerMember => {
  const { archive } = image;
  const path = canonicalMemberPath(entry.name);
  const byteOffset = sourceByteOffset(entry, archiveStart);
  const limitations: string[] = [];
  if (archive.kind === "opaque")
    return {
      entry: fileEntry({
        path,
        declaredSize: entry.uncompressedSize,
        compressedSize: entry.compressedSize,
        byteOffset,
        // Legacy encryption applies to inner payloads, never the PYZ image.
        encrypted: false,
        limitations: [
          ...limitations,
          archive.limitation,
          ...(encrypted
            ? ["PYZ entries are encrypted and were not decoded."]
            : []),
        ],
        adapterKey: `carchive:${String(entry.index)}:${entry.name}`,
        formatMetadata: cArchiveEntryMetadata(
          entry,
          undefined,
          archive,
          encrypted,
        ),
      }),
      read:
        entry.compressionFlag === 1
          ? {
              kind: "pyz",
              handle: image.handle,
              offset: image.start,
              length: entry.uncompressedSize,
              compressed: false,
              uncompressedSize: entry.uncompressedSize,
              header: undefined,
            }
          : {
              kind: "carchive",
              archiveStart,
              source: entry,
              header: undefined,
            },
    };
  return {
    entry: {
      path,
      kind: "directory",
      declaredSize: entry.uncompressedSize,
      compressedSize: entry.compressedSize,
      executable: false,
      encrypted: false,
      byteOffset,
      declaredIntegrity: null,
      unpacked: false,
      limitations: [
        ...limitations,
        `PyInstaller PYZ sha256 ${archive.sha256}.`,
        ...(encrypted
          ? ["PYZ entries are encrypted and were not decoded."]
          : []),
      ],
      adapterKey: `carchive:${String(entry.index)}:${entry.name}`,
      formatMetadata: cArchiveEntryMetadata(
        entry,
        undefined,
        archive,
        encrypted,
      ),
    },
    read: undefined,
  };
};

export const projectPyzMember = (
  container: CArchiveEntry,
  item: PyzEntry,
  encryptionMarker: boolean,
  pythonMagic: Buffer | undefined,
  range:
    | {
        readonly handle: FileHandle;
        readonly offset: number;
        readonly length: number;
      }
    | undefined,
): PyInstallerMember => {
  const path = pyzMemberPath(canonicalMemberPath(container.name), item);
  const encrypted = pyzEntryEncrypted(item, encryptionMarker);
  if (item.namespace)
    return {
      entry: {
        path: path,
        kind: "directory",
        declaredSize: 0,
        compressedSize: item.length,
        executable: false,
        encrypted,
        byteOffset: null,
        declaredIntegrity: null,
        unpacked: false,
        limitations: [
          "Namespace package has no importable bytecode; its declared payload is not materialized.",
          ...(encrypted
            ? [
                "PYZ namespace payload is declared encrypted and is not materialized.",
              ]
            : []),
        ],
        adapterKey: `pyz:${String(container.index)}:${String(item.index)}:${path}`,
        formatMetadata: pyzEntryMetadata(
          container,
          item,
          undefined,
          encryptionMarker,
        ),
      },
      read: undefined,
    };
  const header =
    !encrypted &&
    pythonMagic !== undefined &&
    (item.typeCode === 0 || item.typeCode === 1)
      ? reconstructedPycHeader(pythonMagic)
      : undefined;
  const limitations: string[] = [];
  if (encrypted)
    limitations.push("PYZ entry is encrypted and was not decoded.");
  if (header !== undefined)
    limitations.push(RECONSTRUCTED_PYTHON_HEADER_LIMITATION);
  limitations.push(
    "PYZ tables declare compressed lengths; the uncompressed size is unknown until decoding.",
  );
  return {
    entry: fileEntry({
      path: path,
      declaredSize: null,
      compressedSize: item.length,
      byteOffset: null,
      encrypted,
      limitations,
      adapterKey: `pyz:${String(container.index)}:${String(item.index)}:${path}`,
      formatMetadata: pyzEntryMetadata(
        container,
        item,
        header,
        encryptionMarker,
      ),
    }),
    read:
      range === undefined
        ? undefined
        : {
            kind: "pyz",
            ...range,
            compressed: true,
            uncompressedSize: undefined,
            header,
          },
  };
};

/**
 * CArchive and PYZ data names treat `\` as a separator. The logical path is
 * canonical; the stored spelling is kept when that conversion changes it.
 * `source_location` is an offset plus declared size, so a compressed member
 * publishes a file span only when that size is the physical extent. Otherwise
 * the span stays unknown, as ZIP does for compressed entries.
 */
const canonicalMemberPath = (storedName: string): string =>
  storedName.replaceAll("\\", "/");

const sourceByteOffset = (
  entry: CArchiveEntry,
  archiveStart: number,
): number | null =>
  entry.compressionFlag === 0 ? archiveStart + entry.offset : null;

const pyzMemberPath = (container: string, item: PyzEntry): string => {
  if (item.typeCode === 2)
    return `${container}/${canonicalMemberPath(item.name)}`;
  const dotted = item.name.replaceAll(".", "/");
  if (item.namespace) return `${container}/${dotted}`;
  if (item.package) return `${container}/${dotted}/__init__.pyc`;
  return `${container}/${dotted}.pyc`;
};

const isBytecodeType = (typeCode: string): boolean =>
  typeCode === "s" || typeCode === "m" || typeCode === "M";

const fileEntry = (input: {
  readonly path: string;
  readonly declaredSize: number | null;
  readonly compressedSize: number;
  readonly byteOffset: number | null;
  readonly limitations: readonly string[];
  readonly adapterKey: string;
  readonly formatMetadata: PyInstallerEntryMetadata;
  readonly encrypted?: boolean;
  readonly kind?: "file" | "symlink" | "metadata";
}): ArtifactEntry => ({
  path: input.path,
  kind: input.kind ?? "file",
  declaredSize: input.declaredSize,
  compressedSize: input.compressedSize,
  executable: false,
  encrypted: input.encrypted === true,
  byteOffset: input.byteOffset,
  declaredIntegrity: null,
  unpacked: false,
  limitations: input.limitations,
  adapterKey: input.adapterKey,
  formatMetadata: input.formatMetadata,
});

/** Stable entry stored for a later open(). */
export const sealMember = (member: PyInstallerMember): PyInstallerMember => ({
  ...member,
  entry: copyArtifactEntry(member.entry),
});
