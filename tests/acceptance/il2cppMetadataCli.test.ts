import { desktopSummarySchema } from "../../src/domain/analysisView/desktopApplicationView.js";
import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  realpath,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { readEvidenceBundle } from "../../src/application/EvidenceBundleFiles.js";
import { toolContract } from "../../src/contracts/toolContracts.js";
import {
  analysisViewResultSchema,
  il2cppMetadataSummaryViewResultSchema,
} from "../../src/domain/analysisView/analysisView.js";
import { parseEvidence } from "../../src/domain/evidence.js";
import { il2cppMetadataSchema } from "../../src/domain/il2cpp/il2cppMetadata.js";
import {
  createIl2cppMetadataFixture,
  FIXTURE_IMAGES,
  FIXTURE_METHODS,
  FIXTURE_TYPES,
} from "../fixtures/il2cpp/metadata.js";
import { connectLocalToolsMcp } from "../fixtures/localToolsMcp.js";
import { parseMcpToolError } from "../fixtures/mcpToolError.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";

cliTest(
  "returns identical complete inventories through CLI and MCP and pages a retained summary after removal",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-il2cpp-metadata-");
    const path = join(root, "global-metadata.dat");
    const { bytes } = createIl2cppMetadataFixture({ typeIndexWidth: 2 });
    await writeFile(path, bytes);
    const result = await cli.run({
      arguments: ["inspect-il2cpp-metadata", path, "--json"],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const evidence = toolContract("inspect_il2cpp_metadata").outputSchema.parse(
      result.json,
    );
    const report = il2cppMetadataSchema.parse(evidence.normalized_result);
    expect(report.magic).toBe(bytes.readUInt32LE(0));
    expect(report.artifact).toEqual({
      path,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
    });
    expect(report.images).toEqual(FIXTURE_IMAGES);
    expect(report.types).toEqual(FIXTURE_TYPES);
    expect(report.methods).toEqual(FIXTURE_METHODS);
    expect(evidence.parameters).toEqual({ path });

    const { client, call } = await connectLocalToolsMcp();
    const complete = await call("inspect_il2cpp_metadata", {
      path,
      detail: "complete",
    });
    expect(complete.isError, JSON.stringify(complete)).not.toBe(true);
    expect(parseEvidence(complete.structuredContent).normalized_result).toEqual(
      report,
    );

    // The default keeps complete Evidence while returning a compact receipt.
    const omitted = await call("inspect_il2cpp_metadata", { path });
    expect(omitted.isError, JSON.stringify(omitted)).not.toBe(true);
    expect(
      il2cppMetadataSummaryViewResultSchema.parse(
        parseEvidence(omitted.structuredContent).normalized_result,
      ).summary.counts.methods,
    ).toBe(FIXTURE_METHODS.length);
    const summarized = await call("inspect_il2cpp_metadata", {
      path,
      detail: "summary",
    });
    expect(summarized.isError, JSON.stringify(summarized)).not.toBe(true);
    const view = il2cppMetadataSummaryViewResultSchema.parse(
      parseEvidence(summarized.structuredContent).normalized_result,
    );
    expect(view.summary.magic).toBe(report.magic);
    expect(view.summary.counts).toEqual({
      sections: 31,
      images: 2,
      types: 4,
      methods: 5,
      nested_types: 1,
    });
    expect(view.summary).not.toHaveProperty("sections");
    expect(view.summary.index_widths).toEqual(report.index_widths);

    // Pages come from retained Evidence, not the file.
    await unlink(path);
    for (const collection of [
      "sections",
      "images",
      "types",
      "methods",
    ] as const) {
      const rows: unknown[] = [];
      let offset = 0;
      do {
        const page = await call("inspect_analysis_view", {
          source: {
            kind: "retained-evidence",
            evidence_id: view.parent_evidence_id,
          },
          view: { kind: "il2cpp-metadata", collection, offset, limit: 2 },
        });
        expect(page.isError, JSON.stringify(page)).not.toBe(true);
        const projected = analysisViewResultSchema.parse(
          parseEvidence(page.structuredContent).normalized_result,
        );
        if (projected.kind !== "il2cpp-metadata")
          throw new Error("Wrong IL2CPP page kind");
        expect(projected.counts).toEqual(view.summary.counts);
        rows.push(...projected.items);
        offset = projected.coverage.next_offset ?? report[collection].length;
      } while (offset < report[collection].length);
      expect(rows).toEqual(
        report[collection].map((row, index) => ({ index, ...row })),
      );
    }
    await client.ping();
  },
  30000,
);

cliTest(
  "distinguishes unsupported versions from corrupt metadata through CLI and MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-il2cpp-metadata-fail-");
    const { client, call } = await connectLocalToolsMcp();
    const fixture = createIl2cppMetadataFixture();
    const unsupported = Buffer.from(fixture.bytes);
    unsupported.writeInt32LE(27, 4);
    const corrupt = Buffer.from(fixture.bytes);
    corrupt.writeInt32LE(
      fixture.section("typeDefinitions").offset + 4,
      fixture.header("images", "offset"),
    );
    for (const [name, bytes, expected] of [
      [
        "v27.dat",
        unsupported,
        {
          code: "unsupported_target",
          details: { operation: "inspect_il2cpp_metadata" },
          message: expect.stringContaining("unsupported-version"),
        },
      ],
      [
        "overlap.dat",
        corrupt,
        {
          code: "invalid_request",
          details: {
            operation: "inspect_il2cpp_metadata",
            issues: [
              {
                path: ["path"],
                reason: "invalid_format",
                message: expect.stringContaining("section-overlap"),
              },
            ],
          },
        },
      ],
    ] as const) {
      const path = join(root, name);
      await writeFile(path, bytes);
      const result = await cli.run({
        arguments: ["inspect-il2cpp-metadata", path, "--json"],
      });
      expect(result.exitCode).toBe(1);
      expect(result.json).toMatchObject(expected);
      const response = await call("inspect_il2cpp_metadata", { path });
      expect(parseMcpToolError(response).error).toMatchObject(expected);
    }
    await client.ping();
  },
  30000,
);

it("queries compact retained metadata through the real SDK with exact row identities and fields", async () => {
  const root = await createTestTempDirectory("rea-il2cpp-sdk-selection-");
  const path = join(root, "global-metadata.dat");
  const fixture = createIl2cppMetadataFixture({ version: 31 });
  await writeFile(path, fixture.bytes);
  const { client, call } = await connectLocalToolsMcp();
  const directory = await call("inspect_desktop_application", { path: root });
  const directoryView = analysisViewResultSchema.parse(
    parseEvidence(directory.structuredContent).normalized_result,
  );
  if (directoryView.kind !== "summary")
    throw new Error("Expected a directory summary");
  const probe = desktopSummarySchema
    .parse(directoryView.summary)
    .next_probe_groups.find(
      (group) => group.operation === "inspect_il2cpp_metadata",
    )?.example;
  if (probe === undefined)
    throw new Error("Missing IL2CPP metadata next operation");
  expect(probe.path).toBe(await realpath(path));
  const response = await call(probe.operation, { path: probe.path });
  expect(response.isError).not.toBe(true);
  const overview = il2cppMetadataSummaryViewResultSchema.parse(
    parseEvidence(response.structuredContent).normalized_result,
  );
  expect(overview.summary.counts).toEqual({
    sections: 31,
    images: 2,
    types: 4,
    methods: 5,
    nested_types: 1,
  });
  expect(overview.summary).not.toHaveProperty("sections");
  expect(overview.summary).not.toHaveProperty("methods");
  await unlink(path);
  const source = {
    kind: "retained-evidence",
    evidence_id: overview.parent_evidence_id,
  };
  const selected = async (view: Record<string, unknown>) => {
    const result = await call("inspect_analysis_view", {
      source,
      view: { kind: "il2cpp-metadata", ...view },
    });
    expect(result.isError).not.toBe(true);
    const evidence = parseEvidence(result.structuredContent);
    expect(evidence.evidence_links).toContain(overview.parent_evidence_id);
    const payload = analysisViewResultSchema.parse(evidence.normalized_result);
    if (payload.kind !== "il2cpp-metadata")
      throw new Error("Wrong collection response");
    expect(payload.artifact.sha256).toBe(
      createHash("sha256").update(fixture.bytes).digest("hex"),
    );
    return payload;
  };
  expect(
    (
      await selected({
        collection: "sections",
        names: ["methods"],
        fields: ["count"],
      })
    ).items,
  ).toEqual([{ index: 5, count: null }]);
  expect(
    (
      await selected({
        collection: "types",
        indices: [3, 0, 3, 999],
        fields: ["namespace"],
      })
    ).items,
  ).toEqual([
    { index: 0, namespace: "Game" },
    { index: 3, namespace: "System" },
  ]);
  expect(
    (
      await selected({
        collection: "types",
        image_indices: [0],
        namespaces: ["Game"],
        names: ["Player"],
        fields: ["name"],
      })
    ).items,
  ).toEqual([{ index: 0, name: "Player" }]);
  const methods = {
    collection: "methods",
    declaring_types: [0, 1],
    names: [".ctor", "Add"],
    fields: ["name", "declaring_type"],
  };
  expect((await selected(methods)).items).toEqual([
    { index: 0, name: ".ctor", declaring_type: 0 },
    { index: 2, name: "Add", declaring_type: 1 },
  ]);
  expect(await selected({ ...methods, offset: 1, limit: 1 })).toMatchObject({
    items: [{ index: 2, name: "Add", declaring_type: 1 }],
    coverage: { total: 2, exhausted: true, next_offset: null },
  });
  expect(
    (await selected({ collection: "methods", indices: [2, 0], fields: [] }))
      .items,
  ).toEqual([{ index: 0 }, { index: 2 }]);
  expect(await selected({ collection: "types", indices: [] })).toMatchObject({
    items: [],
    coverage: { total: 0, exhausted: true },
  });
  const invalid = await call("inspect_analysis_view", {
    source,
    view: {
      kind: "il2cpp-metadata",
      collection: "methods",
      fields: ["namespace"],
    },
  });
  expect(parseMcpToolError(invalid).error.code).toBe("invalid_request");
  await client.ping();
}, 30000);

cliTest(
  "exports complete metadata Evidence for compact CLI delivery and portable selected reads",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-il2cpp-cli-export-");
    const path = join(root, "global-metadata.dat");
    const bundle = join(root, "evidence.json");
    const refused = await cli.run({
      arguments: [
        "inspect-il2cpp-metadata",
        join(root, "must-not-be-read"),
        "--detail",
        "summary",
        "--json",
      ],
    });
    expect(refused.exitCode).toBe(1);
    expect(refused.json).toMatchObject({
      code: "invalid_request",
      details: { issues: [{ path: ["evidence_output"] }] },
    });
    await writeFile(path, createIl2cppMetadataFixture().bytes);
    const args = [
      "inspect-il2cpp-metadata",
      path,
      "--detail",
      "summary",
      "--evidence_output",
      bundle,
      "--json",
    ];
    const result = await cli.run({ arguments: args });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.json).toMatchObject({
      evidence_bundle: { path: bundle, bytes: expect.any(Number) },
      summary: { normalized_result: { kind: "summary" } },
    });
    const before = await readFile(bundle);
    const overwrite = await cli.run({ arguments: args });
    expect(overwrite.exitCode).toBe(1);
    expect(await readFile(bundle)).toEqual(before);
    const saved = await readEvidenceBundle(bundle);
    if (!saved.ok) throw saved.error;
    const evidence = saved.value.records[0];
    if (evidence === undefined)
      throw new Error("Missing exported source Evidence");
    expect(JSON.stringify(overwrite.json)).toContain(evidence.evidence_id);
    expect(
      il2cppMetadataSchema.parse(evidence.normalized_result).methods,
    ).toEqual(FIXTURE_METHODS);
    await unlink(path);
    const query = join(root, "query.json");
    await writeFile(
      query,
      JSON.stringify({
        source: { kind: "inline", evidence },
        view: {
          kind: "il2cpp-metadata",
          collection: "methods",
          indices: [2, 0],
          fields: ["name"],
        },
      }),
    );
    const selected = await cli.run({
      arguments: ["inspect-analysis-view", query, "--json"],
    });
    expect(selected.exitCode, selected.stderr).toBe(0);
    expect(parseEvidence(selected.json).normalized_result).toMatchObject({
      items: [
        { index: 0, name: ".ctor" },
        { index: 2, name: "Add" },
      ],
      parent_evidence_id: evidence.evidence_id,
    });
  },
  30000,
);

cliTest.skipIf(process.platform === "win32")(
  "exports and reads Evidence at the filesystem-selected symlink-parent path",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-il2cpp-export-path-");
    const path = join(root, "global-metadata.dat");
    await writeFile(path, createIl2cppMetadataFixture().bytes);
    const actual = join(root, "actual");
    await mkdir(join(actual, "nested"), { recursive: true });
    await symlink(join(actual, "nested"), join(root, "link"));
    const decoy = join(root, "evidence.json");
    await writeFile(decoy, "unrelated caller data");
    const selected = `${root}/link/../evidence.json`;
    const result = await cli.run({
      arguments: [
        "inspect-il2cpp-metadata",
        path,
        "--detail",
        "summary",
        "--evidence_output",
        selected,
        "--json",
      ],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.json).toMatchObject({ evidence_bundle: { path: selected } });
    expect(await readFile(decoy, "utf8")).toBe("unrelated caller data");
    const saved = await readEvidenceBundle(selected);
    if (!saved.ok) throw saved.error;
    expect(
      JSON.parse(await readFile(join(actual, "evidence.json"), "utf8")),
    ).toEqual(saved.value);
    const read = await cli.run({
      arguments: [
        "inspect-evidence-bundle",
        JSON.stringify({ path: selected, detail: "summary" }),
        "--json",
      ],
    });
    expect(read.exitCode, read.stderr).toBe(0);
    expect(read.stdout).toContain(saved.value.records[0]?.evidence_id);
  },
  30000,
);
