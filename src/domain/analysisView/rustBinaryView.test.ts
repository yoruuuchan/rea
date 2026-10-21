import { expect, it } from "vitest";
import { createEvidence } from "../evidence.js";
import type { RustBinary } from "../rust/rustBinary.js";
import {
  projectAnalysisView,
  type AnalysisViewParent,
} from "./analysisView.js";

const report: RustBinary = {
  artifact: { path: "/artifacts/rust", sha256: "a".repeat(64), bytes: 512 },
  format: "elf",
  architecture: "amd64",
  bits: 64,
  byte_order: "little",
  auditable_metadata: {
    section_name: ".dep-v0",
    file_offset: 32,
    section_bytes: 64,
    compressed_bytes: 64,
    uncompressed_bytes: 128,
    format_version: null,
    packages: [
      {
        name: "root",
        version: "1",
        source: "local",
        kind: null,
        root: true,
        dependencies: [0],
      },
    ],
    root_package_index: 0,
    dependency_edges: [{ from_index: 0, to_index: 0 }],
    cyclic_dependency_indices: [0],
  },
  rustc_commit: null,
  limitations: [],
};
const parent = (value = structuredClone(report)): AnalysisViewParent => {
  const evidence = createEvidence(
    {
      path: value.artifact.path,
      sha256: value.artifact.sha256,
      format: "elf",
      architecture: "x86_64",
    },
    { id: "rust-auditable", name: "Rust reader", version: "1" },
    {
      operation: "inspect_rust_binary",
      parameters: { path: value.artifact.path },
      result: value,
    },
  );
  return {
    evidenceId: evidence.evidence_id,
    operation: evidence.operation,
    subject: evidence.subject,
    normalizedResult: value,
    limitations: [],
  };
};

it("revalidates mutable and merely frozen Rust imports despite a claimed seal", () => {
  const mutable = structuredClone(report);
  const input = { ...parent(mutable), sealedResult: true };
  expect(projectAnalysisView(input, { kind: "summary" }).ok).toBe(true);
  Object.freeze(mutable);
  mutable.auditable_metadata!.dependency_edges[0]!.to_index = 99;
  expect(
    projectAnalysisView(input, {
      kind: "rust",
      collection: "edges",
      offset: 0,
      limit: 1,
    }).ok,
  ).toBe(false);
});

it("checks exact artifact identity and subject architecture for every Rust view", () => {
  for (const changed of [
    { local_path: "/different" },
    { format: "pe" as const },
    { architecture: "arm64" as const },
    { digest: { sha256: "b".repeat(64) } },
  ]) {
    const source = parent();
    if (source.subject == null || source.subject.format !== "elf")
      throw new Error("Missing ELF source");
    const input = { ...source, subject: { ...source.subject, ...changed } };
    expect(projectAnalysisView(input, { kind: "summary" }).ok).toBe(false);
    expect(
      projectAnalysisView(input, {
        kind: "rust",
        collection: "packages",
        offset: 0,
        limit: 1,
      }).ok,
    ).toBe(false);
  }
});

it("bounds inherited warnings and retains cycle counts without walking a cyclic graph", () => {
  const input = { ...parent(), limitations: ["x".repeat(300_000)] };
  const result = projectAnalysisView(input, { kind: "summary" });
  if (!result.ok) throw result.error;
  expect(result.value).toMatchObject({
    summary: {
      auditable_metadata: {
        format_version: null,
        counts: { packages: 1, edges: 1, cyclic_packages: 1 },
      },
    },
    source_coverage: {
      embedded_records: "complete",
      runtime_dependencies: "unknown",
    },
  });
  expect(JSON.stringify(result.value).length).toBeLessThan(5000);
  expect(result.value.limitations.join(" ")).toContain(input.evidenceId);
});

it("pages matching original indices and omits dependency vectors unless selected", () => {
  const value = structuredClone(report);
  value.auditable_metadata!.packages.push({
    name: "other",
    version: "1",
    source: "local",
    kind: null,
    root: false,
    dependencies: [],
  });
  const source = parent(value);
  const first = projectAnalysisView(source, {
    kind: "rust",
    collection: "packages",
    offset: 0,
    limit: 1,
  });
  if (!first.ok || first.value.kind !== "rust")
    throw new Error("Rust page failed");
  expect(first.value.page.rows).toEqual([
    {
      index: 0,
      name: "root",
      version: "1",
      source: "local",
      kind: null,
      root: true,
    },
  ]);
  expect(first.value.coverage).toMatchObject({
    total: 2,
    examined: 1,
    exhausted: false,
    next_offset: 1,
  });
  const next = projectAnalysisView(source, {
    kind: "rust",
    collection: "packages",
    offset: 1,
    limit: 1,
    fields: [],
  });
  if (!next.ok || next.value.kind !== "rust")
    throw new Error("Rust continuation failed");
  expect(next.value.page.rows).toEqual([{ index: 1 }]);
  expect(next.value.coverage).toMatchObject({
    total: 2,
    examined: 1,
    exhausted: true,
    next_offset: null,
  });
});
