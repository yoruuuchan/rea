import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { ArtifactResourceScope } from "../../artifacts/ArtifactResourceScope.js";
import type { JavaScriptApplicationAnalysisResult } from "../../domain/javascript/javascriptApplicationAnalysis.js";
import { buildJavaScriptNativeHandoffs } from "../../domain/javascript/javascriptNativeHandoff.js";
import { analyzeJavaScriptApplication } from "./JavaScriptApplicationService.js";

const fixtures: string[] = [];

afterEach(async () => {
  await Promise.all(
    fixtures
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

const analyzeFixture = async (source: string) => {
  const fixture = await mkdtemp(join(tmpdir(), "rea-native-types-"));
  fixtures.push(fixture);
  const scope = new ArtifactResourceScope();
  try {
    await writeFile(join(fixture, "main.ts"), `${source}\n`);
    await writeFile(join(fixture, "addon.node"), "");
    const result = await analyzeJavaScriptApplication(
      { input_path: fixture, format: "directory" },
      scope,
    );
    if (!result.ok) throw result.error;
    return result.value
      .normalized_result as unknown as JavaScriptApplicationAnalysisResult;
  } finally {
    await scope.close();
  }
};

it("does not request native-addon members from erased TypeScript names", async () => {
  const typeImport = await analyzeFixture(
    'import type { NativeThing } from "./addon.node";',
  );
  expect(typeImport.summary.native_addon_bindings).toBe(0);
  expect(typeImport.summary.resolved_native_addon_bindings).toBe(0);
  expect(
    typeImport.graph.nodes.filter((node) => node.kind === "native-export"),
  ).toEqual([]);
  expect(
    buildJavaScriptNativeHandoffs(
      typeImport.graph.nodes,
      typeImport.graph.edges,
      [],
    ).flatMap((handoff) => handoff.requested_exports),
  ).toEqual([]);

  const typeReexport = await analyzeFixture(
    'export type { Extra } from "./addon.node";',
  );
  expect(typeReexport.summary.native_addon_bindings).toBe(0);
  expect(
    typeReexport.graph.nodes.filter((node) => node.kind === "native-export"),
  ).toEqual([]);
  expect(
    buildJavaScriptNativeHandoffs(
      typeReexport.graph.nodes,
      typeReexport.graph.edges,
      [],
    ).flatMap((handoff) => handoff.requested_exports),
  ).toEqual([]);

  const mixed = await analyzeFixture(
    'import { type OtherThing, load } from "./addon.node"; load();',
  );
  expect(mixed.summary.native_addon_bindings).toBe(1);
  const mixedExports = mixed.graph.nodes.filter(
    (node) => node.kind === "native-export",
  );
  expect(mixedExports).toHaveLength(1);
  expect(
    mixedExports[0]?.observations[0]?.properties.requested_members,
  ).toEqual(["load"]);
  expect(
    buildJavaScriptNativeHandoffs(mixed.graph.nodes, mixed.graph.edges, []).map(
      (handoff) => handoff.requested_exports,
    ),
  ).toEqual([["load"]]);

  const value = await analyzeFixture(
    'import { load } from "./addon.node"; load();',
  );
  expect(value.summary.native_addon_bindings).toBe(1);
  expect(
    value.graph.nodes.filter((node) => node.kind === "native-export")[0]
      ?.observations[0]?.properties.requested_members,
  ).toEqual(["load"]);
}, 30_000);
