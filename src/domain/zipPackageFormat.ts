/** ZIP-backed application package families that share the hardened archive reader. */
export const ZIP_PACKAGE_FORMATS = [
  "zip",
  "ipa",
  "apk",
  "msix",
  "appx",
  "hap",
  "hsp",
  "app-pack",
] as const;
export type ZipPackageFormat = (typeof ZIP_PACKAGE_FORMATS)[number];

/** All ZIP package families share archive ownership and inventory coverage. */
export const isZipPackageFormat = (
  format: string,
): format is ZipPackageFormat =>
  ZIP_PACKAGE_FORMATS.some((candidate) => candidate === format);

/** Recognize local-header, empty-archive, or split-archive ZIP signatures, not archive validity. */
export const hasZipSignature = (bytes: Uint8Array): boolean =>
  bytes.length >= 4 &&
  bytes[0] === 0x50 &&
  bytes[1] === 0x4b &&
  ((bytes[2] === 0x03 && bytes[3] === 0x04) ||
    (bytes[2] === 0x05 && bytes[3] === 0x06) ||
    (bytes[2] === 0x07 && bytes[3] === 0x08));

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;
const END_RECORD_BYTES = 22;
const MAXIMUM_COMMENT_BYTES = 0xffff;
const CENTRAL_HEADER_BYTES = 46;

/** Positional read of at most `length` bytes; a short result means end of file. */
export type PositionalRead = (
  position: number,
  length: number,
) => Promise<Uint8Array>;

/**
 * Locate a single-disk ZIP whose end-of-central-directory record ends the
 * file after leading non-ZIP bytes, such as a self-extractor or script stub.
 * Its central directory and first local header must resolve, whether member
 * offsets include the leading bytes or were written before them. Zip64,
 * split and empty archives are not located. Returns the leading byte count.
 */
export const locateTrailingZipArchive = async (
  size: number,
  read: PositionalRead,
): Promise<{ readonly leadingBytes: number } | undefined> => {
  if (!Number.isSafeInteger(size) || size < END_RECORD_BYTES) return undefined;
  const tailStart = Math.max(
    0,
    size - END_RECORD_BYTES - MAXIMUM_COMMENT_BYTES,
  );
  const tail = Buffer.from(await read(tailStart, size - tailStart));
  if (tail.length !== size - tailStart) return undefined;
  // The record's comment must end exactly at end of file.
  let record = -1;
  for (let at = tail.length - END_RECORD_BYTES; at >= 0; at -= 1)
    if (
      tail.readUInt32LE(at) === END_OF_CENTRAL_DIRECTORY &&
      at + END_RECORD_BYTES + tail.readUInt16LE(at + 20) === tail.length
    ) {
      record = at;
      break;
    }
  if (record < 0) return undefined;
  const entriesOnDisk = tail.readUInt16LE(record + 8);
  const directoryBytes = tail.readUInt32LE(record + 12);
  const declaredDirectory = tail.readUInt32LE(record + 16);
  if (
    tail.readUInt16LE(record + 4) !== 0 ||
    tail.readUInt16LE(record + 6) !== 0 ||
    entriesOnDisk === 0 ||
    entriesOnDisk === 0xffff ||
    entriesOnDisk !== tail.readUInt16LE(record + 10) ||
    directoryBytes === 0xffffffff ||
    declaredDirectory === 0xffffffff
  )
    return undefined;
  const directory = tailStart + record - directoryBytes;
  // Offsets written before leading bytes were prepended are shifted by them.
  const shift = directory - declaredDirectory;
  if (directory < 0 || shift < 0) return undefined;
  const header = Buffer.from(await read(directory, CENTRAL_HEADER_BYTES));
  if (
    header.length !== CENTRAL_HEADER_BYTES ||
    header.readUInt32LE(0) !== CENTRAL_DIRECTORY_HEADER
  )
    return undefined;
  const firstLocal = header.readUInt32LE(42) + shift;
  if (firstLocal === 0 || firstLocal >= directory) return undefined;
  const local = Buffer.from(await read(firstLocal, 4));
  return local.length === 4 && local.readUInt32LE(0) === LOCAL_FILE_HEADER
    ? { leadingBytes: firstLocal }
    : undefined;
};

/**
 * Classify a ZIP-backed package by its complete lower-cased path suffix.
 *
 * This is deliberately extension-only. Callers must separately verify ZIP
 * magic before trusting the classification for a root input. HarmonyOS `.har`
 * is intentionally absent: the suffix also names HTTP Archive JSON, so a
 * Harmony shared archive is only established from verified ZIP bytes. The
 * HarmonyOS App Pack suffix `.app` is also absent here: it applies only to
 * root inputs (see `classifyAndHashRoot`), because a nested ZIP entry ending
 * in `.app` inside another package, such as an IPA, is not an App Pack.
 */
export const zipPackageFormatForPath = (
  path: string,
): ZipPackageFormat | undefined => {
  const lower = path.toLowerCase();
  if (lower.endsWith(".zip")) return "zip";
  if (lower.endsWith(".ipa")) return "ipa";
  // An Android App Bundle is a ZIP archive, not a standalone APK.
  if (lower.endsWith(".apk")) return "apk";
  if (lower.endsWith(".msix") || lower.endsWith(".msixbundle")) return "msix";
  if (lower.endsWith(".appx") || lower.endsWith(".appxbundle")) return "appx";
  if (lower.endsWith(".hap")) return "hap";
  if (lower.endsWith(".hsp")) return "hsp";
  return undefined;
};

/**
 * Classify a verified ZIP root input by its path. The HarmonyOS App Pack
 * suffix `.app` applies only to root inputs; a nested ZIP member ending in
 * `.app` keeps its observed format.
 */
export const zipRootPackageFormat = (path: string): ZipPackageFormat => {
  const lower = path.toLowerCase();
  return lower.endsWith(".app")
    ? "app-pack"
    : (zipPackageFormatForPath(lower) ?? "zip");
};

/** Inventory lists entries, not all bytes surrounding the central directory. */
export const ZIP_NON_ENTRY_LIMITATION =
  "ZIP inventory lists central-directory entries only. Non-entry bytes, including leading bytes before the first entry such as a self-extractor stub, an APK Signing Block before the central directory or a ZIP comment after it, are not occurrences.";
