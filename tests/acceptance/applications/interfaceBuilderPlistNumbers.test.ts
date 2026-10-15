import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { build, buildBinary } from "plist";
import { expect } from "vitest";

import { interfaceBuilderAnalysisSchema } from "../../../src/domain/apple/interfaceBuilderGraph.js";
import { thinMach } from "../../../src/domain/binaryTarget.fixture.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

const scenarios = [
  "XML",
  "binary",
  "integer collision",
  "integer-real collision",
  "real",
  "mixed XML",
] as const;

cliTest.for(scenarios)(
  "preserves numeric meaning and graph identity for %s Interface Builder attributes",
  async (scenario, { cli }) => {
    const root = await createTestTempDirectory("rea-ib-plist-numbers-");
    const app = join(root, "Numbers.app");
    const contents = join(app, "Contents");
    const resources = join(contents, "Resources");
    await mkdir(resources, { recursive: true });
    await mkdir(join(contents, "MacOS"));
    await writeFile(
      join(contents, "MacOS", "Fixture"),
      thinMach(0xfeedfacf, 0x0100000c),
    );
    await writeFile(
      join(contents, "Info.plist"),
      build({ CFBundleExecutable: "Fixture" }),
    );
    const source = {
      $archiver: "NSKeyedArchiver",
      $version: 100000,
      $top: { root: { CF$UID: 1 } },
      $objects: [
        "$null",
        {
          $class: { CF$UID: 3 },
          large: scenario === "binary" ? 9007199254740992 : "__INTEGER__",
          safe: 42,
          children: [{ CF$UID: 2 }],
          ...(scenario.includes("collision") ? { other: "__OTHER__" } : {}),
        },
        { $class: { CF$UID: 3 }, label: "Child" },
        { $classname: "UIView", $classes: ["UIView", "NSObject"] },
      ],
    };
    const bytes =
      scenario === "binary"
        ? Buffer.from(buildBinary(source))
        : Buffer.from(
            build(source)
              .replace(
                "<string>__INTEGER__</string>",
                scenario === "real"
                  ? "<real>9007199254740992</real>"
                  : scenario === "mixed XML"
                    ? "<integer>9007199254740992<!-- split -->3</integer>"
                    : "<integer>9007199254740993</integer>",
              )
              .replace(
                "<string>__OTHER__</string>",
                scenario === "integer collision"
                  ? "<integer>9007199254740992</integer>"
                  : "<real>9007199254740992</real>",
              ),
          );
    if (scenario === "binary") {
      // The builder emits an unsafe JS number as a real. Replace that one
      // 8-byte scalar with an exact signed integer of the same byte width.
      const marker = Buffer.alloc(9);
      marker[0] = 0x23;
      marker.writeDoubleBE(9007199254740992, 1);
      const offset = bytes.indexOf(marker);
      expect(offset).toBeGreaterThan(0);
      expect(bytes.indexOf(marker, offset + marker.length)).toBe(-1);
      bytes[offset] = 0x13;
      bytes.writeBigInt64BE(9007199254740993n, offset + 1);
    }
    await writeFile(join(resources, "Main.nib"), bytes);
    const output = await cli.run({
      arguments: ["decode-interface-builder", app, "--json"],
      environment: { REA_LOG_LEVEL: "silent", REA_ANALYSIS_PROVIDER: "auto" },
    });
    expect(output.exitCode, output.stderr).toBe(0);
    const result = interfaceBuilderAnalysisSchema.parse(
      parseEvidence(output.json).normalized_result,
    );
    expect(result.documents).toEqual([
      expect.objectContaining({
        archive_sha256: createHash("sha256").update(bytes).digest("hex"),
        object_count: 2,
      }),
    ]);
    expect(
      result.graph.nodes.find(
        ({ attributes }) => attributes.interface_builder_object_id === "1",
      ),
    ).toMatchObject({
      id: 'ib:"Contents/Resources/Main.nib":object:["1"]',
      attributes: {
        large:
          scenario === "XML" || scenario === "binary"
            ? { $plist_type: "integer", decimal: "9007199254740993" }
            : 9007199254740992,
        safe: 42,
        children: [{ archiveUID: 2, className: "UIView" }],
        interface_builder_object_id: "1",
        class_name: "UIView",
      },
    });
    expect(result.graph.nodes).toHaveLength(3);
    expect(result.graph.edges).toContainEqual(
      expect.objectContaining({
        from: 'ib:"Contents/Resources/Main.nib":object:["1"]',
        to: 'ib:"Contents/Resources/Main.nib":object:["2"]',
        relation: "contains",
      }),
    );
    if (scenario === "XML" || scenario === "binary")
      expect(result.limitations).toContainEqual(
        expect.stringContaining("1 unambiguous integer value"),
      );
    else if (scenario !== "real")
      expect(result.limitations).toContainEqual(
        expect.stringContaining("integer precision loss remains possible"),
      );
    else
      expect(
        result.limitations.some((note) => note.includes("integer precision")),
      ).toBe(false);
    if (scenario === "mixed XML")
      expect(result.limitations).toContainEqual(
        expect.stringContaining("could not be completely observed"),
      );
    expect(result.graph.truncated).toBe(false);
  },
);
