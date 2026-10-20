import { afterEach, expect, it, vi } from "vitest";
import {
  IL2CPP_METADATA_SECTION_NAMES,
  il2cppMetadataSchema,
  type Il2cppMetadata,
} from "../il2cpp/il2cppMetadata.js";
import { createEvidence } from "../evidence.js";
import { freezeJsonSnapshot } from "../immutableJson.js";
import { projectIl2cppMetadataView } from "./il2cppMetadataView.js";

afterEach(() => {
  vi.restoreAllMocks();
});

const report: Il2cppMetadata = {
  artifact: {
    path: "/artifacts/global-metadata.dat",
    sha256: "a".repeat(64),
    bytes: 1024,
  },
  magic: 0xfab11baf,
  metadata_version: 39,
  index_widths: {
    type_definition: 1,
    generic_container: 1,
    parameter: 1,
    type: 1,
    type_width_source: "interface-offsets-record",
  },
  sections: IL2CPP_METADATA_SECTION_NAMES.map((name) => ({
    name,
    offset: 380,
    size: 0,
    count: 0,
  })),
  images: [{ name: "A.dll", type_start: 0, type_count: 2 }],
  types: [
    {
      name: "Outer",
      namespace: "N",
      method_start: 0,
      method_count: 1,
      nested_type_start: 0,
      nested_type_count: 1,
      declaring_type: -1,
    },
    {
      name: "Inner",
      namespace: "",
      method_start: -1,
      method_count: 0,
      nested_type_start: -1,
      nested_type_count: 0,
      declaring_type: 0,
    },
  ],
  methods: [{ name: "Run", declaring_type: 0 }],
  limitations: [],
};

const parent = (normalizedResult: unknown, sealedResult: boolean) => ({
  evidenceId: `ev_${"b".repeat(64)}`,
  operation: "inspect_il2cpp_metadata",
  normalizedResult,
  sealedResult,
  limitations: [],
});

const page = {
  kind: "il2cpp-metadata",
  collection: "types",
  offset: 0,
  limit: 1,
} as const;

it("validates a sealed parent once across pages and keeps counts exact", () => {
  const parse = vi.spyOn(il2cppMetadataSchema, "safeParse");
  const sealed = parent(freezeJsonSnapshot(structuredClone(report)), true);
  for (const offset of [0, 1]) {
    const view = projectIl2cppMetadataView(sealed, { ...page, offset });
    if (!view.ok) throw view.error;
    expect(view.value).toMatchObject({
      items: [{ index: offset, ...report.types[offset] }],
      counts: { images: 1, types: 2, methods: 1, nested_types: 1 },
    });
  }
  expect(parse).toHaveBeenCalledTimes(1);
});

it("revalidates unsealed inline input on every page", () => {
  const parse = vi.spyOn(il2cppMetadataSchema, "safeParse");
  const inline = parent(structuredClone(report), false);
  projectIl2cppMetadataView(inline, page);
  projectIl2cppMetadataView(inline, page);
  expect(parse).toHaveBeenCalledTimes(2);
});

it("intersects batch identities, fields, image ranges and exact names in source order", () => {
  const source = parent(freezeJsonSnapshot(structuredClone(report)), true);
  const result = projectIl2cppMetadataView(source, {
    ...page,
    indices: [1, 0, 1, 100],
    image_indices: [0],
    names: ["Inner"],
    namespaces: [""],
    declaring_types: [0],
    fields: ["name"],
  });
  if (!result.ok) throw result.error;
  expect(result.value).toMatchObject({
    items: [{ index: 1, name: "Inner" }],
    coverage: { total: 1, exhausted: true },
    counts: { images: 1, types: 2, methods: 1 },
  });
  const identityOnly = projectIl2cppMetadataView(source, {
    ...page,
    fields: [],
  });
  if (!identityOnly.ok) throw identityOnly.error;
  expect(identityOnly.value).toMatchObject({ items: [{ index: 0 }] });
});

it.each([
  "indices",
  "image_indices",
  "names",
  "namespaces",
  "declaring_types",
] as const)("keeps an empty %s selection empty", (field) => {
  const result = projectIl2cppMetadataView(parent(report, false), {
    ...page,
    [field]: [],
  });
  if (!result.ok) throw result.error;
  expect(result.value).toMatchObject({
    items: [],
    coverage: { total: 0, exhausted: true },
  });
});

it("does not trust a forged seal flag or a shallow frozen mutable report", () => {
  const mutable = structuredClone(report);
  Object.freeze(mutable);
  const source = parent(mutable, true);
  const first = projectIl2cppMetadataView(source, page);
  if (!first.ok) throw first.error;
  mutable.types[0]!.name = "Changed";
  const second = projectIl2cppMetadataView(source, page);
  if (!second.ok) throw second.error;
  expect(second.value).toMatchObject({
    items: [{ index: 0, name: "Changed" }],
  });
});

it("refuses a parent whose subject contradicts the recorded artifact identity", () => {
  const result = projectIl2cppMetadataView(
    {
      ...parent(report, false),
      subject: createEvidence(
        { path: report.artifact.path, format: "file", sha256: "c".repeat(64) },
        { id: "fixture", name: "fixture", version: "1" },
        {
          operation: "inspect_il2cpp_metadata",
          parameters: {},
          result: report,
        },
      ).subject,
    },
    page,
  );
  expect(result.ok).toBe(false);
});
