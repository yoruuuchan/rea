import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { build, buildBinary } from "plist";
import { expect } from "vitest";

import { keyedArchiveResultSchema } from "../../../src/domain/apple/keyedArchive.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest.for(["xml", "binary"] as const)(
  "distinguishes serialized scalar objects from lookalike dictionaries in a %s keyed archive",
  async (format, { cli }) => {
    const root = await createTestTempDirectory("rea-keyed-scalar-kinds-");
    const archive = {
      $archiver: "NSKeyedArchiver",
      $version: 100000,
      $top: { root: { CF$UID: 12 }, data: { CF$UID: 1 } },
      $objects: [
        "$null",
        Buffer.from("deadbeef", "hex"),
        new Date("2001-01-01T00:00:00.000Z"),
        9007199254740992,
        "hello",
        42,
        1.5,
        Number.POSITIVE_INFINITY,
        { $plist_type: "data", base64: "3q2+7w==" },
        { $plist_type: "date", iso8601: "2001-01-01T00:00:00.000Z" },
        { $plist_type: "real", value: 0 },
        [{ CF$UID: 1 }],
        { $class: { CF$UID: 13 }, payload: { CF$UID: 1 } },
        { $classname: "ScalarHolder", $classes: ["ScalarHolder", "NSObject"] },
      ],
    };
    const bytes = Buffer.from(
      format === "binary" ? buildBinary(archive) : build(archive),
    );
    const path = join(root, "archive.plist");
    await writeFile(path, bytes);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const run = async (arguments_: readonly string[] = []) => {
      const output = await cli.run({
        arguments: ["inspect-keyed-archive", path, ...arguments_, "--json"],
        environment: {
          HOME: root,
          USERPROFILE: root,
          REA_LOG_LEVEL: "silent",
          REA_ANALYSIS_PROVIDER: "auto",
        },
      });
      expect(output.exitCode, output.stderr).toBe(0);
      return keyedArchiveResultSchema.parse(
        parseEvidence(output.json).normalized_result,
      );
    };
    const result = await run();
    const { call } = await connectLocalToolsMcp({
      HOME: root,
      USERPROFILE: root,
    });
    const opened = await call("open_binary", { path });
    expect(opened.isError, JSON.stringify(opened)).not.toBe(true);
    const mcp = await call("inspect_keyed_archive", {});
    expect(mcp.isError, JSON.stringify(mcp)).not.toBe(true);
    expect(
      keyedArchiveResultSchema.parse(
        parseEvidence(mcp.structuredContent).normalized_result,
      ),
    ).toEqual(result);
    expect(result.archive_sha256).toBe(digest);
    expect(result.archive_format).toBe(
      format === "binary" ? "binary-plist" : "xml-plist",
    );
    expect(result.objects.map(({ kind }) => kind)).toEqual([
      "nil",
      "scalar",
      "scalar",
      "scalar",
      "scalar",
      "scalar",
      "scalar",
      "scalar",
      "dictionary",
      "dictionary",
      "dictionary",
      "array",
      "archived-object",
      "class-descriptor",
    ]);
    for (const [scalar, dictionary] of [
      [1, 8],
      [2, 9],
    ] as const) {
      expect(result.objects[scalar]?.value).toEqual(
        result.objects[dictionary]?.value,
      );
      expect(result.objects[scalar]?.status).toBe("observed");
    }
    expect(result.objects[1]?.value).toEqual({
      $plist_type: "data",
      base64: "3q2+7w==",
    });
    expect(result.objects[2]?.value).toEqual({
      $plist_type: "date",
      iso8601: "2001-01-01T00:00:00.000Z",
    });
    expect(result.objects[7]?.value).toEqual({
      $plist_type: "real",
      value: null,
    });
    expect(result.objects[10]?.value).toEqual({
      $plist_type: "real",
      value: 0,
    });
    expect(result.objects[12]).toMatchObject({
      class_id: 13,
      class_name: "ScalarHolder",
      status: "unknown-class",
    });
    expect(result.references).toContainEqual(
      expect.objectContaining({
        source: 12,
        path: ["payload"],
        target: 1,
        status: "resolved",
      }),
    );
    expect(result.limitations).toContainEqual(
      expect.stringContaining("1 non-finite real value(s)"),
    );

    const page = await run(["--root", "data", "--offset", "1", "--limit", "2"]);
    expect(page.objects).toEqual(result.objects.slice(1, 3));
    expect(page).toMatchObject({
      archive_sha256: digest,
      total_objects: 14,
      offset: 1,
      next_offset: 3,
      truncated: true,
    });
    expect(Object.keys(page.roots)).toEqual(["data"]);
    expect(page.references).toEqual([
      expect.objectContaining({
        source: null,
        path: ["data"],
        target: 1,
        status: "resolved",
      }),
    ]);
    expect(await readFile(path)).toEqual(bytes);
  },
);

cliTest(
  "rejects scalar top dictionaries through the public CLI and MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-keyed-scalar-top-");
    const { call } = await connectLocalToolsMcp({
      HOME: root,
      USERPROFILE: root,
    });
    for (const format of ["xml", "binary"]) {
      const archive = {
        $archiver: "NSKeyedArchiver",
        $version: 100000,
        $objects: ["$null"],
        $top: new Uint8Array([0]),
      };
      const path = join(root, format + ".plist");
      await writeFile(
        path,
        Buffer.from(format === "xml" ? build(archive) : buildBinary(archive)),
      );
      const output = await cli.run({
        arguments: ["inspect-keyed-archive", path, "--json"],
        environment: { HOME: root, USERPROFILE: root },
      });
      expect(output.exitCode).toBe(1);
      expect(output.json).toMatchObject({
        code: "artifact_operation_failed",
        details: {
          reason: "format",
          detail: expect.stringContaining("Keyed archive has no $top roots"),
        },
      });
      const opened = await call("open_binary", { path });
      expect(opened.isError, JSON.stringify(opened)).not.toBe(true);
      const reply = await call("inspect_keyed_archive", {});
      expect(reply.isError).toBe(true);
      expect(JSON.stringify(reply)).toContain(
        "Keyed archive has no $top roots",
      );
    }
  },
);
