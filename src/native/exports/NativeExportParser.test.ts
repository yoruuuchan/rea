import { describe, expect, it } from "vitest";

import {
  elfExportImage,
  peExportImage,
} from "../../../tests/fixtures/binaryDiagnostics/nativeExports.js";
import { nativeExportsSchema } from "../../domain/native/nativeExports.js";
import {
  BinaryFormatFailure,
  BinaryResourceFailure,
} from "../metadata/BinaryContainer.js";
import { parseNativeExports } from "./NativeExportParser.js";

const artifact = { path: "/fixture/lib", sha256: "a".repeat(64), bytes: 1 };
const parse = (bytes: Buffer) =>
  nativeExportsSchema.parse(parseNativeExports(bytes, artifact));

describe("PE export directories", () => {
  it.each([32, 64] as const)(
    "reports named, aliased, ordinal-only and forwarded PE%d exports",
    (bits) => {
      const result = parse(
        peExportImage({
          bits,
          ordinalBase: 5,
          functions: [
            { rva: 0x2000 },
            { rva: 0x2010 },
            null,
            { forwarder: "OTHER.Target" },
          ],
          names: [
            { name: "Alias", index: 0 },
            { name: "Forwarded", index: 3 },
            { name: "Primary", index: 0 },
          ],
        }),
      );
      const base = bits === 64 ? 0x180000000 : 0x10000000;

      expect(result).toMatchObject({
        format: "pe",
        bits,
        export_directory: {
          rva: 0x1000,
          size: 0x200,
          dll_name: "fixture.dll",
          ordinal_base: 5,
        },
        coverage: {
          status: "complete",
          examined_entries: 4,
          exports: 4,
        },
        issues: [],
      });
      expect(result.exports).toEqual([
        {
          name: "Alias",
          ordinal: 5,
          address: `0x${(base + 0x2000).toString(16)}`,
          forwarder: null,
        },
        {
          name: "Primary",
          ordinal: 5,
          address: `0x${(base + 0x2000).toString(16)}`,
          forwarder: null,
        },
        {
          name: null,
          ordinal: 6,
          address: `0x${(base + 0x2010).toString(16)}`,
          forwarder: null,
        },
        {
          name: "Forwarded",
          ordinal: 8,
          address: null,
          forwarder: "OTHER.Target",
        },
      ]);
    },
  );

  it("counts unreadable and out-of-range names without inventing exports", () => {
    const result = parse(
      peExportImage({
        functions: [{ rva: 0x2000 }, { rva: 0x2010 }],
        names: [
          { name: "Unmapped", index: 0 },
          { name: "Stray", index: 9 },
          { name: "Kept", index: 1 },
        ],
        nameRvaOverride: { position: 0, rva: 0x9000 },
      }),
    );

    expect(result.exports.map(({ name }) => name)).toEqual(["Kept"]);
    expect(result.coverage).toMatchObject({ status: "partial", exports: 1 });
    expect(result.issues.map(({ code }) => code)).toEqual([
      "name_unreadable",
      "malformed_entry",
    ]);
  });

  it("reports an image without an export directory as exporting nothing", () => {
    const result = parse(peExportImage({ exportDirectory: false }));

    expect(result).toMatchObject({
      export_directory: null,
      exports: [],
      coverage: { status: "complete", examined_entries: 0 },
    });
    expect(result.limitations[0]).toContain("declares no export directory");
  });

  it("refuses ordinals beyond the 16-bit ordinal space", () => {
    expect(() =>
      parseNativeExports(
        peExportImage({
          functions: [{ rva: 0x2000 }],
          ordinalBase: 0xffff + 1,
        }),
        artifact,
      ),
    ).toThrow("16-bit ordinals");
  });

  it("refuses an export table above the inventory allowance", () => {
    expect(() =>
      parseNativeExports(
        peExportImage({ functions: [], declaredFunctions: 0x40001 }),
        artifact,
      ),
    ).toThrow(BinaryResourceFailure);
  });
});

describe("ELF dynamic symbol exports", () => {
  const symbols = [
    { name: "plain_fn" },
    { name: "versioned_fn", version: 2 },
    { name: "old_fn", version: 0x8003 },
    { name: "weak_obj", binding: 2, type: 1 },
    { name: "ifunc_sym", type: 10 },
    { name: "protected_fn", visibility: 3 },
    { name: "hidden_fn", visibility: 2 },
    { name: "undefined_fn", section: 0 },
    { name: "local_fn", binding: 0 },
    { name: "local_version_fn", version: 0 },
  ];

  it("lists defined default and protected globals with their versions", () => {
    const result = parse(
      elfExportImage({
        symbols,
        versionDefinitions: ["libfixture.so", "VER_1", "VER_0"],
      }),
    );

    expect(result).toMatchObject({
      format: "elf",
      bits: 64,
      byte_order: "little",
      architecture: "amd64",
      coverage: { status: "complete", examined_entries: 10, exports: 6 },
      issues: [],
    });
    expect(
      result.format === "elf" &&
        result.exports.map(({ name, type, binding, version }) => ({
          name,
          type,
          binding,
          version,
        })),
    ).toEqual([
      { name: "plain_fn", type: "function", binding: "global", version: null },
      {
        name: "versioned_fn",
        type: "function",
        binding: "global",
        version: { index: 2, name: "VER_1", hidden: false },
      },
      {
        name: "old_fn",
        type: "function",
        binding: "global",
        version: { index: 3, name: "VER_0", hidden: true },
      },
      { name: "weak_obj", type: "object", binding: "weak", version: null },
      { name: "ifunc_sym", type: "ifunc", binding: "global", version: null },
      {
        name: "protected_fn",
        type: "function",
        binding: "global",
        version: null,
      },
    ]);
  });

  it("reads a big-endian ELF32 table", () => {
    const result = parse(
      elfExportImage({
        bits: 32,
        little: false,
        machine: 20,
        symbols: [{ name: "be_fn", value: 0x10000n, size: 8n }],
      }),
    );

    expect(result).toMatchObject({
      bits: 32,
      byte_order: "big",
      architecture: "ppc",
      exports: [{ name: "be_fn", value: "0x10000", size: "8" }],
    });
  });

  it("marks versions unknown when the version table does not fit", () => {
    const result = parse(
      elfExportImage({
        symbols: [{ name: "a" }, { name: "b", version: 2 }],
        versionDefinitions: ["lib.so", "V1"],
        truncatedVersions: true,
      }),
    );

    expect(
      result.format === "elf" && result.exports.map(({ version }) => version),
    ).toEqual(["unknown", "unknown"]);
    expect(result.coverage.status).toBe("partial");
    expect(result.issues).toMatchObject([{ code: "version_unresolved" }]);
  });

  it("reports one issue per undefined version index", () => {
    const result = parse(
      elfExportImage({
        symbols: [
          { name: "a", version: 7 },
          { name: "b", version: 7 },
        ],
        versionDefinitions: ["lib.so"],
      }),
    );

    expect(
      result.format === "elf" && result.exports.map(({ version }) => version),
    ).toEqual([
      { index: 7, name: null, hidden: false },
      { index: 7, name: null, hidden: false },
    ]);
    expect(result.issues).toHaveLength(1);
  });

  it("counts a symbol whose name is outside the string table", () => {
    const result = parse(
      elfExportImage({
        symbols: [{ name: "kept" }, { name: "lost", nameOffset: 0x7000 }],
      }),
    );

    expect(result.exports.map(({ name }) => name)).toEqual(["kept"]);
    expect(result.issues).toMatchObject([{ code: "name_unreadable" }]);
    expect(result.coverage.status).toBe("partial");
  });

  it("separates no dynamic symbols from unread section headers", () => {
    expect(
      parse(elfExportImage({ symbols: [], dynamicSymbols: false })),
    ).toMatchObject({ exports: [], coverage: { status: "complete" } });
    expect(
      parse(elfExportImage({ symbols: [], sectionHeaders: false })),
    ).toMatchObject({
      exports: [],
      coverage: {
        status: "unsupported",
        reason: expect.stringContaining("no section headers"),
      },
    });
  });
});

describe("export inventory review regressions", () => {
  it("reads an export directory stored in the PE headers", () => {
    const result = parse(
      peExportImage({
        inHeaders: true,
        functions: [{ rva: 0x2000 }, { forwarder: "OTHER.Target" }],
        names: [
          { name: "HeaderExport", index: 0 },
          { name: "HeaderForward", index: 1 },
        ],
      }),
    );

    expect(result).toMatchObject({
      export_directory: { rva: 0x200, dll_name: "fixture.dll" },
      coverage: { status: "complete", exports: 2 },
    });
    expect(result.exports.map(({ name }) => name)).toEqual([
      "HeaderExport",
      "HeaderForward",
    ]);
  });

  it("bounds retained name text before storing rows", () => {
    // 300 rows naming one 60000-byte string retain about 18 MB of text.
    const long = "n".repeat(60000);
    const bytes = elfExportImage({
      symbols: Array.from({ length: 300 }, () => ({ name: long })),
    });

    expect(bytes.length).toBeLessThan(100_000);
    expect(() => parseNativeExports(bytes, artifact)).toThrow(
      BinaryResourceFailure,
    );
  });

  it("keeps exports when the version table lies outside the file", () => {
    const result = parse(
      elfExportImage({
        symbols: [{ name: "a" }, { name: "b", version: 2 }],
        versionDefinitions: ["lib.so", "V1"],
        versionsOutsideFile: true,
      }),
    );

    expect(
      result.format === "elf" && result.exports.map(({ version }) => version),
    ).toEqual(["unknown", "unknown"]);
    expect(result.coverage.status).toBe("partial");
  });

  it("reports an empty version name as unresolved", () => {
    const result = parse(
      elfExportImage({
        symbols: [{ name: "a", version: 2 }],
        versionDefinitions: ["lib.so", ""],
      }),
    );

    expect(
      result.format === "elf" && result.exports.map(({ version }) => version),
    ).toEqual([{ index: 2, name: null, hidden: false }]);
    expect(result.issues).toMatchObject([{ code: "version_unresolved" }]);
    expect(result.coverage.status).toBe("partial");
  });

  it("rejects a dynamic symbol table without its null entry", () => {
    expect(() =>
      parseNativeExports(
        elfExportImage({ symbols: [], emptyDynamicSymbols: true }),
        artifact,
      ),
    ).toThrow(BinaryFormatFailure);
  });
});

it("refuses formats other than PE and ELF", () => {
  const macho = Buffer.alloc(64);
  macho.writeUInt32LE(0xfeedfacf, 0);
  expect(() => parseNativeExports(macho, artifact)).toThrow(
    BinaryFormatFailure,
  );
});
