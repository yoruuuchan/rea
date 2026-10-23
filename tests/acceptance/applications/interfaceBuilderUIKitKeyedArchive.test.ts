import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { build } from "plist";
import { expect } from "vitest";

import { interfaceBuilderAnalysisSchema } from "../../../src/domain/apple/interfaceBuilderGraph.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { thinMach } from "../../../src/domain/binaryTarget.fixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

/** Write an app bundle whose only Interface Builder document is `Main.nib`. */
const writeUIKitApp = async (prefix: string, nib: string | Buffer) => {
  const root = await createTestTempDirectory(prefix);
  const app = join(root, "UIKitFixture.app");
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
    "<plist><dict><key>CFBundleExecutable</key><string>Fixture</string></dict></plist>",
  );
  await writeFile(join(resources, "Main.nib"), nib);
  return app;
};

cliTest(
  "decodes a rooted UIKit keyed-archive outlet through CLI",
  async ({ cli }) => {
    const app = await writeUIKitApp(
      "rea-cli-uikit-outlet-",
      await readFile(
        join(process.cwd(), "tests/fixtures/interface-builder/UIKitOutlet.xml"),
      ),
    );

    const output = await cli.run({
      arguments: ["decode-interface-builder", app, "--json"],
      environment: { REA_LOG_LEVEL: "silent" },
    });
    expect(output.exitCode, output.stderr).toBe(0);
    const result = interfaceBuilderAnalysisSchema.parse(
      parseEvidence(output.json).normalized_result,
    );
    const owner = result.graph.nodes.find(
      ({ attributes }) => attributes.interface_builder_object_id === "1",
    );
    const destination = result.graph.nodes.find(
      ({ attributes }) => attributes.interface_builder_object_id === "2",
    );
    const outlet = result.graph.nodes.find(({ kind }) => kind === "outlet");
    expect(result.documents).toEqual([
      expect.objectContaining({ connection_count: 1 }),
    ]);
    expect(outlet).toMatchObject({
      id: 'ib:"Contents/Resources/Main.nib":outlet:["archive:3"]',
      name: "view",
      attributes: {
        UISource: { archiveUID: 1 },
        UIDestination: { archiveUID: 2 },
        UILabel: "view",
      },
    });
    expect(owner).toBeDefined();
    expect(destination).toBeDefined();
    expect(
      result.graph.edges.some(
        ({ from, to, relation }) =>
          from === owner?.id && to === outlet?.id && relation === "contains",
      ),
    ).toBe(true);
    expect(
      result.graph.edges.some(
        ({ from, to, relation }) =>
          from === outlet?.id &&
          to === destination?.id &&
          relation === "outlet_to",
      ),
    ).toBe(true);
    expect(result.graph.coverage).toContainEqual(
      expect.objectContaining({
        facet: "connections:Contents/Resources/Main.nib",
        status: "complete",
        examined: 1,
        omitted: 0,
      }),
    );
  },
);

cliTest(
  "classifies UIKit keyed-archive objects by their declared superclasses through CLI",
  async ({ cli }) => {
    // Class name and its archived `$classes` chain, with the expected kind.
    // Neutral names classify only through their declared bases; controls also
    // declare their view base. The constraint declares no framework base, so
    // its name still classifies it.
    const cases = [
      ["UINavigationController", ["UIViewController"], "view_controller"],
      ["UITabBarController", ["UIViewController"], "view_controller"],
      ["UISearchController", ["UIViewController"], "view_controller"],
      ["UIViewController", [], "view_controller"],
      ["SettingsScreen", ["UIViewController"], "view_controller"],
      ["InspectorPane", ["NSViewController"], "view_controller"],
      ["DocumentShell", ["NSWindowController"], "view_controller"],
      ["UIButton", ["UIControl", "UIView"], "control"],
      ["RatingPicker", ["UIControl", "UIView"], "control"],
      ["LevelGauge", ["NSControl", "NSView"], "control"],
      ["UIImageView", ["UIView"], "view"],
      ["CanvasSurface", ["NSView"], "view"],
      ["AppShell", ["UIWindow", "UIView"], "view"],
      ["Palette", ["NSWindow"], "view"],
      ["NSLayoutConstraint", [], "constraint"],
    ] as const;
    const uid = (value: number) => ({ CF$UID: value });
    const descriptorUid = (index: number) => cases.length + 1 + index;
    const rootUid = cases.length * 2 + 1;
    const nib = build({
      $archiver: "NSKeyedArchiver",
      $version: 100000,
      $objects: [
        "$null",
        ...cases.map((_, index) => ({ $class: uid(descriptorUid(index)) })),
        ...cases.map(([name, bases]) => ({
          $classname: name,
          $classes: [name, ...bases, "NSObject"],
        })),
        {
          $class: uid(rootUid + 1),
          "NS.objects": cases.map((_, index) => uid(index + 1)),
        },
        { $classname: "NSArray", $classes: ["NSArray", "NSObject"] },
      ],
      $top: { root: uid(rootUid) },
    });
    const app = await writeUIKitApp("rea-cli-uikit-kinds-", nib);

    const output = await cli.run({
      arguments: ["decode-interface-builder", app, "--json"],
      environment: { REA_LOG_LEVEL: "silent" },
    });
    expect(output.exitCode, output.stderr).toBe(0);
    const result = interfaceBuilderAnalysisSchema.parse(
      parseEvidence(output.json).normalized_result,
    );
    const names = new Set<string>(cases.map(([name]) => name));
    expect(
      result.graph.nodes
        .filter(({ attributes }) =>
          names.has(String(attributes.class_name ?? "")),
        )
        .map(({ kind, attributes }) => [attributes.class_name, kind]),
    ).toEqual(cases.map(([name, , kind]) => [name, kind]));
    expect(result.graph.coverage).toContainEqual(
      expect.objectContaining({
        facet: "objects:Contents/Resources/Main.nib",
        status: "complete",
        examined: cases.length + 1,
        omitted: 0,
      }),
    );
  },
);
