import { createHash } from "node:crypto";
import { symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createNativeExportsService } from "../../../src/composition/binaryDiagnostics.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { nativeExportsSchema } from "../../../src/domain/native/nativeExports.js";
import {
  elfExportImage,
  peExportImage,
} from "../../fixtures/binaryDiagnostics/nativeExports.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

describe("native export stable filesystem boundary", () => {
  it("binds PE and ELF export inventories to the selected file", async () => {
    const root = await createTestTempDirectory("rea-native-exports-");
    const service = createNativeExportsService();
    for (const [name, bytes, format] of [
      [
        "fixture.dll",
        peExportImage({
          functions: [{ rva: 0x2000 }],
          names: [{ name: "Exported", index: 0 }],
        }),
        "pe",
      ],
      [
        "libfixture.so",
        elfExportImage({ symbols: [{ name: "exported" }] }),
        "elf",
      ],
    ] as const) {
      const path = join(root, name);
      await writeFile(path, bytes);
      const result = await service.inspect({ path });
      if (!result.ok) throw new Error(JSON.stringify(result.error));
      const evidence = parseEvidence(result.value);
      const sha256 = createHash("sha256").update(bytes).digest("hex");

      expect(evidence).toMatchObject({
        operation: "inspect_native_exports",
        provider: { id: "rea-native-exports" },
        confidence: "observed",
        subject: { local_path: path, format, digest: { sha256 } },
      });
      expect(
        nativeExportsSchema.parse(evidence.normalized_result),
      ).toMatchObject({
        artifact: { path, sha256, bytes: bytes.length },
        format,
        coverage: { status: "complete", exports: 1 },
      });
    }
    await service.close();
  });

  it("returns typed input, unsupported, budget and cancellation failures", async () => {
    const root = await createTestTempDirectory("rea-native-export-failures-");
    const path = join(root, "fixture.dll");
    const alias = join(root, "alias.dll");
    const macho = join(root, "fixture.dylib");
    const malformed = join(root, "malformed.dll");
    await writeFile(path, peExportImage({ functions: [] }));
    const machoBytes = Buffer.alloc(64);
    machoBytes.writeUInt32LE(0xfeedfacf, 0);
    await writeFile(macho, machoBytes);
    await writeFile(malformed, Buffer.from("MZ not a PE image"));
    await symlink(path, alias);
    const service = createNativeExportsService();
    const failure = async (
      input: Record<string, unknown>,
      signal?: AbortSignal,
    ) => {
      const result = await service.inspect(
        input,
        signal === undefined ? undefined : { signal },
      );
      if (result.ok) throw new Error("Expected a failure");
      return result.error;
    };

    for (const [candidate, reason] of [
      [alias, "invalid_format"],
      [malformed, "invalid_format"],
      [join(root, "missing.dll"), "invalid_value"],
    ] as const)
      expect(await failure({ path: candidate })).toMatchObject({
        _tag: "AnalysisInputError",
        operation: "inspect_native_exports",
        issues: [{ path: ["path"], reason }],
      });
    expect(await failure({ path: macho })).toMatchObject({
      _tag: "AnalysisUnsupportedTargetError",
      reason: expect.stringContaining("inspect_macho"),
    });
    expect(await failure({ path, max_file_bytes: 64 })).toMatchObject({
      _tag: "AnalysisResourceConstraintError",
    });
    expect(
      await failure({ path }, AbortSignal.abort("caller stop")),
    ).toMatchObject({ _tag: "AnalysisCancelledError" });
    await service.close();
  });
});
