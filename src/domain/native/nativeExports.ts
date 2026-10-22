import { z } from "zod";

import { absoluteLocalPathStringSchema } from "../localPath.js";

const uint = z.number().int().min(0).max(0xffffffff);
const address = z.string().regex(/^0x[0-9a-f]+$/u);

/** Hard ceiling on the caller-selected input read budget. */
export const MAX_INSPECT_NATIVE_EXPORTS_FILE_BYTES = 536870912;
/** Fixed bound on reported export rows, so one library cannot flood a reply. */
export const MAX_NATIVE_EXPORT_ROWS = 262144;

/** One explicitly selected PE or ELF library or executable. */
export const inspectNativeExportsInputSchema = z.strictObject({
  path: absoluteLocalPathStringSchema.describe(
    "Absolute filesystem path to a PE or ELF image",
  ),
  max_file_bytes: z
    .number()
    .int()
    .min(64)
    .max(MAX_INSPECT_NATIVE_EXPORTS_FILE_BYTES)
    .default(268435456)
    .describe("Maximum stable artifact bytes to read (default 256 MiB)"),
});
export type InspectNativeExportsInput = z.infer<
  typeof inspectNativeExportsInputSchema
>;

/**
 * One PE export-address-table slot as the export directory states it. A
 * forwarder has no address in this image; an ordinal-only export has no name.
 */
const peExportSchema = z.strictObject({
  name: z.string().min(1).nullable(),
  ordinal: z.number().int().min(0).max(0xffff),
  address: address.nullable(),
  forwarder: z.string().min(1).nullable(),
});

/**
 * One defined, default- or protected-visibility global, weak or unique
 * dynamic symbol. `version` is null when the symbol carries no version and
 * "unknown" when the version table could not be read; a hidden version is not
 * the default one a by-name lookup selects.
 */
const elfExportSchema = z.strictObject({
  name: z.string().min(1),
  /** `st_value` as stored; on 32-bit ARM, bit 0 of a function marks Thumb code. */
  value: address,
  size: z.string().regex(/^[0-9]+$/u),
  type: z.enum(["function", "ifunc", "object", "tls", "other"]),
  binding: z.enum(["global", "weak", "unique"]),
  version: z.union([
    z.null(),
    z.literal("unknown"),
    z.strictObject({
      index: z.number().int().min(2).max(0x7fff),
      name: z.string().min(1).nullable(),
      hidden: z.boolean(),
    }),
  ]),
});

/** Parsed table issue; rows it affects are counted, not silently dropped. */
const nativeExportIssueSchema = z.strictObject({
  code: z.enum([
    "malformed_entry",
    "name_unreadable",
    "version_unresolved",
    "table_unavailable",
  ]),
  location: z.string().min(1).nullable(),
  message: z.string().min(1),
});

const artifactSchema = z.strictObject({
  path: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  bytes: uint,
});

const coverageSchema = z.strictObject({
  /** complete: every table entry was read; partial: issues name the gaps. */
  status: z.enum(["complete", "partial", "unsupported"]),
  reason: z.string().min(1).nullable(),
  examined_entries: uint,
  exports: uint,
});

/** Static export inventory of one PE or ELF image, read without execution. */
export const nativeExportsSchema = z.discriminatedUnion("format", [
  z.strictObject({
    artifact: artifactSchema,
    format: z.literal("pe"),
    architecture: z.string().min(1),
    bits: z.union([z.literal(32), z.literal(64)]),
    /** Null when the image declares no export directory. */
    export_directory: z
      .strictObject({
        rva: uint,
        size: uint,
        dll_name: z.string().nullable(),
        ordinal_base: uint,
        timestamp: uint,
      })
      .nullable(),
    exports: z.array(peExportSchema).max(MAX_NATIVE_EXPORT_ROWS),
    coverage: coverageSchema,
    issues: z.array(nativeExportIssueSchema),
    limitations: z.array(z.string().min(1)),
  }),
  z.strictObject({
    artifact: artifactSchema,
    format: z.literal("elf"),
    architecture: z.string().min(1),
    bits: z.union([z.literal(32), z.literal(64)]),
    byte_order: z.enum(["little", "big"]),
    exports: z.array(elfExportSchema).max(MAX_NATIVE_EXPORT_ROWS),
    coverage: coverageSchema,
    issues: z.array(nativeExportIssueSchema),
    limitations: z.array(z.string().min(1)),
  }),
]);
export type NativeExports = z.infer<typeof nativeExportsSchema>;
export type PeExport = z.infer<typeof peExportSchema>;
export type ElfExport = z.infer<typeof elfExportSchema>;
export type NativeExportIssue = z.infer<typeof nativeExportIssueSchema>;
