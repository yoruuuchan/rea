import { join } from "node:path";
import { writeFile } from "node:fs/promises";

import { describe, expect } from "vitest";
import { z } from "zod";

import { inspectMachoSchema } from "../../../src/domain/native/nativeInspection.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

const evidenceSchema = z.object({ normalized_result: inspectMachoSchema });

describe.skipIf(process.platform !== "darwin")(
  "native Mach-O CLI dylib identity",
  () => {
    cliTest(
      "keeps a dylib's own install name out of its dependencies",
      async ({ cli, processes }) => {
        const directory = await createTestTempDirectory("rea-dylib-identity-");
        const source = join(directory, "library.c");
        const library = join(directory, "libprobe.dylib");
        await writeFile(source, "int exported_value(void) { return 42; }\n");
        const compiled = await processes.run(
          "/usr/bin/xcrun",
          [
            "clang",
            "-dynamiclib",
            source,
            "-Wl,-install_name,@rpath/libprobe.dylib",
            "-o",
            library,
          ],
          { timeoutMs: 30_000 },
        );
        expect(compiled.exitCode, compiled.stderr).toBe(0);
        const result = await cli.run({
          arguments: ["inspect-macho", library, "--json"],
          environment: { REA_LOG_LEVEL: "silent" },
        });
        expect(result.exitCode, result.stdout + result.stderr).toBe(0);
        const inspected = evidenceSchema.parse(result.json).normalized_result;
        expect(inspected.dependencies).toMatchObject({
          items: [
            { path: "/usr/lib/libSystem.B.dylib", kind: "LC_LOAD_DYLIB" },
          ],
          total: 1,
          exhaustive: true,
        });
        expect(
          inspected.load_commands.items.find(
            ({ kind }) => kind === "LC_ID_DYLIB",
          )?.fields.name,
        ).toBe("@rpath/libprobe.dylib (offset 24)");
      },
    );
  },
);
