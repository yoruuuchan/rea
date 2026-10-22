import { z } from "zod";
import { digestSchema } from "../digests.js";
import { localPathStringSchema } from "../localPath.js";

export const PYTHON_PYC_HEADER_BYTES = 16;
export const PYTHON_PYC_HASH_BASED = 0x1;
export const PYTHON_PYC_CHECK_SOURCE = 0x2;

const uint = z.number().int().min(0).max(0xffffffff);
const index = z.number().int().nonnegative();
/** Non-negative CPython `int` counts. `0xffffffff` is -1 and is not evidence. */
const signedCount = z.number().int().min(0).max(0x7fffffff);

/** Marshal TYPE_CODE field order for CPython 3.7, 3.8–3.10, and 3.11+. */
export const PYTHON_PYC_CODE_LAYOUTS = ["py37", "py38", "py311"] as const;
export type PythonPycCodeLayout = (typeof PYTHON_PYC_CODE_LAYOUTS)[number];

type MagicEntry = {
  readonly python_version: string;
  readonly code_layout: PythonPycCodeLayout;
};

const magics = (
  values: readonly number[],
  python_version: string,
  code_layout: PythonPycCodeLayout,
): ReadonlyArray<readonly [number, MagicEntry]> =>
  values.map((magic) => [magic, { python_version, code_layout }]);

const consecutive = (
  start: number,
  end: number,
  python_version: string,
  code_layout: PythonPycCodeLayout,
): ReadonlyArray<readonly [number, MagicEntry]> =>
  magics(
    Array.from({ length: end - start + 1 }, (_, offset) => start + offset),
    python_version,
    code_layout,
  );

/**
 * Pinned CPython pyc magics for 3.7–3.13. Identity is the 16-bit little-endian
 * field; `\r\n` is required separately. Layout follows marshal TYPE_CODE, not
 * bytecode opcode tables.
 */
export const PYTHON_PYC_MAGIC_TABLE: ReadonlyMap<number, MagicEntry> = new Map([
  ...magics([3390, 3391, 3392, 3393, 3394], "3.7", "py37"),
  ...magics([3400, 3401], "3.8", "py37"),
  ...magics([3410, 3411, 3412, 3413], "3.8", "py38"),
  ...magics([3420, 3421, 3422, 3423, 3424, 3425], "3.9", "py38"),
  ...magics(
    [3430, 3431, 3432, 3433, 3434, 3435, 3436, 3437, 3438, 3439],
    "3.10",
    "py38",
  ),
  // 3.11 alphas before 3494 marshal other code layouts: no co_qualname
  // before 3460, and PEP 657 end-line and column tables until 3494.
  ...consecutive(3494, 3495, "3.11", "py311"),
  ...consecutive(3500, 3531, "3.12", "py311"),
  ...consecutive(3550, 3571, "3.13", "py311"),
]);

/** Map a pyc magic integer to its pinned CPython family, or null when unknown. */
export const pythonPycMagicEntry = (magic: number): MagicEntry | null =>
  PYTHON_PYC_MAGIC_TABLE.get(magic) ?? null;

export const inspectPythonPycInputSchema = z.strictObject({
  path: localPathStringSchema.describe(
    "Absolute filesystem path to the selected CPython .pyc file",
  ),
  max_file_bytes: z
    .number()
    .int()
    .min(16)
    .max(64 * 1024 * 1024)
    .default(16 * 1024 * 1024)
    .describe(
      "Maximum selected file size in bytes; exceeding the budget fails without partial success",
    ),
  max_objects: z
    .number()
    .int()
    .min(1)
    .max(65536)
    .default(16384)
    .describe(
      "Maximum marshal objects to examine; exceeding the budget fails without partial success",
    ),
  max_depth: z
    .number()
    .int()
    .min(1)
    .max(256)
    .default(64)
    .describe(
      "Maximum marshal nesting depth; exceeding the budget fails without partial success",
    ),
  max_string_bytes: z
    .number()
    .int()
    .min(1)
    .max(8 * 1024 * 1024)
    .default(1024 * 1024)
    .describe(
      "Maximum bytes retained for one marshal string or byte string; exceeding the budget fails without partial success",
    ),
});

export const PYTHON_PYC_CONST_PREVIEW_LIMIT = 80;
/** Integers up to 256 bits fit the 80-character preview in decimal. */
export const PYTHON_PYC_INT_PREVIEW_BITS = 256;

/** CPython float repr for values JSON numbers cannot carry. */
const pythonFloatSchema = z.union([z.number(), z.enum(["inf", "-inf", "nan"])]);

const pythonConstSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("none") }),
  z.strictObject({ kind: z.literal("bool"), value: z.boolean() }),
  z.strictObject({
    kind: z.literal("int"),
    bits: uint,
    value: z.string().min(1).max(PYTHON_PYC_CONST_PREVIEW_LIMIT).nullable(),
  }),
  z.strictObject({ kind: z.literal("float"), value: pythonFloatSchema }),
  z.strictObject({
    kind: z.literal("str"),
    bytes: uint,
    truncated: z.boolean(),
    value: z.string().max(PYTHON_PYC_CONST_PREVIEW_LIMIT),
  }),
  z.strictObject({
    kind: z.literal("bytes"),
    bytes: uint,
    sha256: digestSchema,
  }),
  z.strictObject({
    kind: z.literal("code"),
    name: z.string(),
    firstlineno: uint,
  }),
  z.strictObject({ kind: z.literal("tuple"), length: uint }),
  z.strictObject({ kind: z.literal("list"), length: uint }),
  z.strictObject({ kind: z.literal("set"), length: uint }),
  z.strictObject({ kind: z.literal("frozenset"), length: uint }),
  z.strictObject({ kind: z.literal("dict"), length: uint }),
  z.strictObject({ kind: z.literal("ellipsis") }),
  z.strictObject({
    kind: z.literal("complex"),
    real: pythonFloatSchema,
    imag: pythonFloatSchema,
  }),
  z.strictObject({ kind: z.literal("other"), type: z.string().min(1) }),
]);

const pythonCodeFields = {
  name: z.string(),
  qualname: z.string().nullable(),
  filename: z.string(),
  firstlineno: uint,
  argcount: signedCount,
  posonlyargcount: signedCount.nullable(),
  kwonlyargcount: signedCount,
  nlocals: signedCount.nullable(),
  stacksize: signedCount,
  flags: uint,
  names: z.array(z.string()),
  varnames: z.array(z.string()).nullable(),
  freevars: z.array(z.string()).nullable(),
  cellvars: z.array(z.string()).nullable(),
  localsplusnames: z.array(z.string()).nullable(),
  localspluskinds_hex: z.string().nullable(),
  bytecode: z.strictObject({
    bytes: uint,
    sha256: digestSchema,
  }),
  consts: z.array(pythonConstSchema),
};

export type PythonPycConst = z.infer<typeof pythonConstSchema>;

/**
 * One distinct marshal code object. `nested_code` holds indexes into the
 * report's `code_objects`, so a child shared through TYPE_REF is listed once.
 * The owner's own index is included when its constants reach that object.
 */
const pythonCodeObjectSchema = z.strictObject({
  ...pythonCodeFields,
  nested_code: z.array(index),
});
export type PythonPycCodeObject = z.infer<typeof pythonCodeObjectSchema>;

export const pythonPycHeaderSchema = z.strictObject({
  magic: z.number().int().min(0).max(0xffff),
  python_version: z.string().min(1),
  code_layout: z.enum(PYTHON_PYC_CODE_LAYOUTS),
  flags: uint,
  hash_based: z.boolean(),
  check_source: z.boolean(),
  source_hash_hex: z.string().nullable(),
  source_mtime: uint.nullable(),
  source_size: uint.nullable(),
});

/** Bounded CPython 3.7–3.13 pyc observation; marshal is walked, bytecode is not decompiled. */
export const pythonPycSchema = z
  .strictObject({
    artifact: z.strictObject({
      path: localPathStringSchema,
      sha256: digestSchema,
      bytes: index,
    }),
    header: pythonPycHeaderSchema,
    /** The top-level module code object is first. */
    code_objects: z.array(pythonCodeObjectSchema).min(1),
    coverage: z.strictObject({
      status: z.literal("complete"),
      objects: uint,
      code_objects: uint,
      marshal_bytes: uint,
      marshal_depth: uint,
    }),
    limitations: z.array(z.string().min(1)).min(1),
  })
  .superRefine((report, context) => {
    if (report.artifact.bytes < PYTHON_PYC_HEADER_BYTES) {
      context.addIssue({
        code: "custom",
        path: ["artifact", "bytes"],
        message: "A pyc header does not fit in the selected artifact.",
      });
    }
    const marshalBytes = report.artifact.bytes - PYTHON_PYC_HEADER_BYTES;
    if (report.coverage.marshal_bytes !== marshalBytes) {
      context.addIssue({
        code: "custom",
        path: ["coverage", "marshal_bytes"],
        message: "Marshal byte count disagrees with the header-stripped file.",
      });
    }
    if (report.header.hash_based === (report.header.source_hash_hex === null)) {
      context.addIssue({
        code: "custom",
        path: ["header", "source_hash_hex"],
        message:
          "Hash-based pycs require an 8-byte source hash; others must omit it.",
      });
    }
    if (report.header.hash_based === (report.header.source_mtime !== null)) {
      context.addIssue({
        code: "custom",
        path: ["header", "source_mtime"],
        message: "Timestamp pycs require mtime; hash-based pycs must omit it.",
      });
    }
    if (report.header.hash_based === (report.header.source_size !== null)) {
      context.addIssue({
        code: "custom",
        path: ["header", "source_size"],
        message:
          "Timestamp pycs require source_size; hash-based pycs must omit it.",
      });
    }
    if (report.coverage.code_objects !== report.code_objects.length) {
      context.addIssue({
        code: "custom",
        path: ["coverage", "code_objects"],
        message: "Code-object coverage disagrees with the listed code objects.",
      });
    }
    report.code_objects.forEach((code, owner) => {
      if (
        code.localspluskinds_hex !== null &&
        code.localspluskinds_hex.length !==
          (code.localsplusnames?.length ?? 0) * 2
      )
        context.addIssue({
          code: "custom",
          path: ["code_objects", owner, "localspluskinds_hex"],
          message:
            "co_localspluskinds length does not match co_localsplusnames.",
        });
      code.nested_code.forEach((nested, position) => {
        if (nested >= report.code_objects.length)
          context.addIssue({
            code: "custom",
            path: ["code_objects", owner, "nested_code", position],
            message: "Nested code index does not name a listed code object.",
          });
      });
    });
  });

export type PythonPyc = z.infer<typeof pythonPycSchema>;
export type InspectPythonPycInput = z.infer<typeof inspectPythonPycInputSchema>;
