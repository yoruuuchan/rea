// Compare complete public MCP tasks with caller-selected input advertisements.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Ajv2020 } from "ajv/dist/2020.js";

const { values } = parseArgs({
  options: {
    runtime: { type: "string" },
    artifact: { type: "string" },
    oracle: { type: "string" },
    output: { type: "string" },
    profile: { type: "string", default: "default" },
  },
});
for (const key of ["runtime", "artifact", "oracle", "output"])
  assert.ok(
    values[key] && resolve(values[key]) === values[key],
    `${key} must be absolute`,
  );
assert.ok(["default", "full", "compact"].includes(values.profile));
await mkdir(values.output, { recursive: false });
const hash = (value) => createHash("sha256").update(value).digest("hex");
const oracle = JSON.parse(await readFile(values.oracle, "utf8"));
const artifactSha = hash(await readFile(values.artifact));
assert.equal(artifactSha, oracle.artifact_sha256);
const environment = {
  PATH: process.env.PATH,
  HOME: values.output,
  REA_LOG_LEVEL: "silent",
  UV_THREADPOOL_SIZE: "1",
  NODE_OPTIONS: "--max-old-space-size=2048",
  NODE_DISABLE_COMPILE_CACHE: "1",
  ...(values.profile === "default"
    ? {}
    : { REA_MCP_INPUT_SCHEMA_PROFILE: values.profile }),
};
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(values.runtime, "scripts/rea.mjs"), "mcp"],
  cwd: values.output,
  env: environment,
  stderr: "pipe",
});
const client = new Client({ name: "rea-catalog-task", version: "1" });
const report = {
  profile: values.profile,
  artifact_sha256: artifactSha,
  calls: [],
  checks: [],
  status: "incomplete",
  cleanup_verified: false,
};
const transcript = [];
let stderr = "";
transport.stderr?.on("data", (value) => {
  stderr += value;
});
const began = performance.now();
try {
  await client.connect(transport);
  const catalog = await client.listTools();
  assert.equal(catalog.nextCursor, undefined);
  const definitions = new Map(catalog.tools.map((tool) => [tool.name, tool]));
  assert.equal(definitions.size, catalog.tools.length);
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  for (const tool of catalog.tools)
    assert.ok(
      ajv.validateSchema(tool.inputSchema),
      `Invalid schema: ${tool.name}`,
    );
  await writeFile(join(values.output, "catalog.json"), JSON.stringify(catalog));
  report.tool_names = [...definitions.keys()];
  const call = async (name, args) => {
    const definition = definitions.get(name);
    assert.ok(definition, `Missing named tool ${name}`);
    const start = performance.now();
    const reply = await client.callTool(
      { name, arguments: args },
      { toolDefinition: definition },
    );
    report.calls.push({
      name,
      elapsed_ms: performance.now() - start,
      is_error: reply.isError === true,
    });
    transcript.push({ name, arguments: args, reply });
    return reply;
  };
  const input = {
    path: values.artifact,
    view: {
      collection: "packages",
      names: ["serde"],
      fields: ["name", "version", "kind"],
    },
  };
  const first = await call("inspect_rust_binary", input);
  assert.notEqual(first.isError, true);
  const selected = first.structuredContent;
  assert.ok(selected?.normalized_result?.page);
  assert.deepEqual(selected.normalized_result.page.rows, oracle.serde_rows);
  assert.equal(selected.subject.digest.sha256, artifactSha);
  const parentId = selected.normalized_result.parent_evidence_id;
  for (let index = 0; index < 2; index++) {
    const reply = await call("inspect_analysis_view", {
      source: { kind: "retained-evidence", evidence_id: parentId },
      view: {
        kind: "rust",
        collection: "packages",
        names: ["serde"],
        fields: ["name", "version", "kind"],
      },
    });
    assert.notEqual(reply.isError, true);
    assert.deepEqual(
      reply.structuredContent.normalized_result.page.rows,
      oracle.serde_rows,
    );
    assert.equal(
      reply.structuredContent.normalized_result.parent_evidence_id,
      parentId,
    );
  }
  const malformed = await call("inspect_rust_binary", {
    path: values.artifact,
    view: { collection: "packages", offset: -1 },
  });
  assert.equal(malformed.isError, true);
  report.checks.push(
    "Independent package rows and digest; repeated retained identity; canonical negative-offset refusal",
  );
  const exported = await call("export_evidence_bundle", {
    path: join(values.output, "evidence.json"),
  });
  assert.notEqual(exported.isError, true);
  const bundle = JSON.parse(
    await readFile(join(values.output, "evidence.json"), "utf8"),
  );
  const parent = bundle.records.find(
    (record) => record.evidence_id === parentId,
  );
  assert.ok(parent, "Complete original Evidence is retained");
  assert.equal(parent.subject.digest.sha256, artifactSha);
  assert.deepEqual(
    parent.normalized_result.auditable_metadata.packages,
    oracle.packages,
  );
  assert.deepEqual(
    parent.normalized_result.auditable_metadata.dependency_edges,
    oracle.edges,
  );
  report.parent_evidence_id = parentId;
  report.parent_semantic_sha256 = hash(JSON.stringify(parent));
  report.answer = oracle.serde_rows;
  report.status = "passed";
} finally {
  await client.close();
  await transport.close();
  report.cleanup_verified = transport.pid === null;
  assert.ok(report.cleanup_verified);
  report.elapsed_ms = performance.now() - began;
  await writeFile(
    join(values.output, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  await writeFile(
    join(values.output, "transcript.json"),
    JSON.stringify(transcript),
  );
  await writeFile(join(values.output, "server.log"), stderr);
}
