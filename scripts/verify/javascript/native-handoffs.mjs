#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createEvidence } from "../../../dist/domain/evidence.js";
import { PrivateRuntimeRoot } from "../../../dist/process/PrivateRuntimeRoot.js";
import {
  OwnedCommandFailure,
  runOwnedCommand,
} from "../../../dist/process/OwnedCommand.js";
import { closeVerifierResources } from "../../lib/verifier-cleanup.mjs";

const { values } = parseArgs({
  options: {
    artifact: { type: "string" },
    "addon-path": { type: "string" },
    "native-sha256": { type: "string" },
    "source-path": { type: "string", multiple: true },
    rounds: { type: "string", default: "3" },
    "cli-parity": { type: "boolean", default: false },
    "tokenizer-python": { type: "string" },
    "require-safe": { type: "boolean", default: false },
  },
  strict: true,
});
assert.ok(
  values.artifact && isAbsolute(values.artifact),
  "--artifact must be absolute",
);
assert.ok(
  values["addon-path"] &&
    !isAbsolute(values["addon-path"]) &&
    values["addon-path"]
      .split("/")
      .every((part) => part !== "" && part !== "." && part !== ".."),
  "--addon-path must be a normalized archive-relative path",
);
assert.match(
  values["native-sha256"] ?? "",
  /^[a-f0-9]{64}$/,
  "--native-sha256 pins prior native bytes; it does not prove availability",
);
const rounds = Number(values.rounds);
assert.ok(Number.isSafeInteger(rounds) && rounds > 0);
const environment = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  REA_LOG_LEVEL: "silent",
  REA_ANALYSIS_PROVIDER: "auto",
  HOPPER_LAUNCHER_PATH: "/rea-unconfigured-deep-provider/hopper",
};
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL("../../rea.mjs", import.meta.url)), "mcp"],
  env: environment,
  stderr: "pipe",
});
const client = new Client({
  name: "javascript-native-handoff-verifier",
  version: "1",
});
const serialize = (value) => JSON.stringify(value);
const digest = (value) =>
  createHash("sha256").update(serialize(value)).digest("hex");
const fileDigest = async (path) => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
};
const simulatedNativeEvidence = (path, sha256) =>
  createEvidence(
    { path, sha256, format: "raw-binary" },
    { id: "ghidra", name: "Ghidra", version: "simulated" },
    {
      operation: "binary_overview",
      parameters: {},
      result: {
        summary:
          "Simulated subject-linkage input; no native provider executed.",
      },
      limitations: ["No native provider behavior is established."],
    },
  );
let temporary;
let primaryError;
let retainTemporary = false;
let report;
const ownedCommand = async (command, arguments_, timeoutMs = 60_000) => {
  try {
    return await runOwnedCommand(
      {
        command,
        arguments: arguments_,
        cwd: temporary.path,
        env: environment,
        runId: `rea-native-handoff-${randomUUID()}`,
        expectedCommand: command === process.execPath ? process.execPath : null,
        sweepTokenOwnedProcesses: true,
      },
      { timeoutMs, diagnosticBytes: 16 * 1024 * 1024 },
    );
  } catch (cause) {
    retainTemporary ||=
      cause instanceof OwnedCommandFailure && cause.cleanupOwner !== undefined;
    throw cause;
  }
};
try {
  const archiveSha256 = await fileDigest(values.artifact);
  const companion = join(`${values.artifact}.unpacked`, values["addon-path"]);
  let companionSha256 = null;
  try {
    companionSha256 = await fileDigest(companion);
  } catch (cause) {
    if (cause?.code !== "ENOENT") throw cause;
  }
  if (companionSha256 !== null)
    assert.equal(companionSha256, values["native-sha256"]);
  const native = simulatedNativeEvidence(companion, values["native-sha256"]);
  const container = simulatedNativeEvidence(values.artifact, archiveSha256);
  await client.connect(transport);
  transport.stderr?.on("data", () => undefined);
  const tools = (await client.listTools()).tools;
  const catalog = tools.map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema,
  }));
  const selected = catalog.filter(({ name }) =>
    ["analyze_javascript_application", "trace_application_feature"].includes(
      name,
    ),
  );
  assert.equal(selected.length, 2);
  const call = async (name, arguments_) => {
    const response = await client.callTool(
      { name, arguments: arguments_ },
      { timeout: 360_000 },
    );
    assert.notEqual(response.isError, true, serialize(response));
    assert.ok(response.structuredContent?.evidence_id);
    return {
      request: { name, arguments: arguments_ },
      response: response.structuredContent,
      wire_response: response,
    };
  };
  const prepStart = performance.now();
  const preparation = await call("analyze_javascript_application", {
    input_path: values.artifact,
    detail: "summary",
    ...(values["source-path"] === undefined
      ? {}
      : { source_paths: values["source-path"] }),
  });
  const preparationMs = performance.now() - prepStart;
  assert.equal(preparation.response.subject.digest.sha256, archiveSha256);
  const sourceId = preparation.response.normalized_result.parent_evidence_id;
  assert.match(sourceId, /^ev_[a-f0-9]{64}$/);
  const query = {
    application: { kind: "retained-evidence", evidence_id: sourceId },
    native_observations: [container, native],
    seed: {
      kind: "string",
      value: values["addon-path"],
      match: "exact",
      case_sensitive: true,
    },
    direction: "outgoing",
  };
  const samples = [];
  let first;
  for (let round = 0; round < rounds; round++) {
    const start = performance.now();
    const result = await call("trace_application_feature", query);
    const elapsedMs = performance.now() - start;
    if (first === undefined) first = result;
    else assert.equal(result.response.evidence_id, first.response.evidence_id);
    samples.push({
      round,
      elapsed_ms: elapsedMs,
      structured_reply_bytes: Buffer.byteLength(serialize(result.response)),
      full_tool_reply_bytes: Buffer.byteLength(serialize(result.wire_response)),
    });
  }
  const trace = first.response.normalized_result;
  const addons = trace.graph.nodes.filter(
    ({ kind }) => kind === "native-addon",
  );
  assert.equal(
    addons.length,
    1,
    "The selected native add-on must remain visible",
  );
  const addon = addons[0];
  const unavailable = addon.observations.some(
    ({ properties }) => properties.availability === "unavailable",
  );
  const expectedLinks = [
    sourceId,
    ...(companionSha256 === null ? [] : [native.evidence_id]),
  ].sort();
  const safeIdentity =
    serialize(trace.evidence_links) === serialize(expectedLinks) &&
    (companionSha256 === null
      ? unavailable &&
        addon.identity.strategy !== "content-digest" &&
        trace.coverage.status === "partial" &&
        trace.native_handoffs.length === 0
      : addon.identity.strategy === "content-digest" &&
        addon.identity.sha256 === companionSha256 &&
        trace.native_handoffs.length === 1 &&
        trace.native_handoffs[0].artifact_sha256 === companionSha256 &&
        trace.native_handoffs[0].status === "evidence-linked" &&
        serialize(trace.native_handoffs[0].evidence_ids) ===
          serialize([native.evidence_id]));
  let cliParity = null;
  if (values["cli-parity"]) {
    temporary = await PrivateRuntimeRoot.create({
      prefix: "rea-native-handoff-verifier-",
    });
    const bundlePath = join(temporary.path, "bundle.json");
    const exported = await client.callTool({
      name: "export_evidence_bundle",
      arguments: { path: bundlePath },
    });
    assert.notEqual(exported.isError, true, serialize(exported));
    const bundle = JSON.parse(await readFile(bundlePath, "utf8"));
    const parent = bundle.records.find(
      ({ evidence_id }) => evidence_id === sourceId,
    );
    assert.ok(parent, "Export omitted the retained parent");
    const request = join(temporary.path, "trace.json");
    // The CLI's portable file contract takes complete Evidence; MCP resolves a
    // same-session reference into the same shared application workflow.
    await writeFile(request, serialize({ ...query, application: parent }));
    const result = await ownedCommand(
      process.execPath,
      [
        fileURLToPath(new URL("../../rea.mjs", import.meta.url)),
        "trace-application-feature",
        request,
        "--json",
      ],
      120_000,
    );
    const evidence = JSON.parse(result.stdout.text);
    assert.deepEqual(evidence.normalized_result, trace);
    assert.equal(evidence.evidence_id, first.response.evidence_id);
    cliParity = {
      exact_cli_mcp_trace_parity: true,
      evidence_id: evidence.evidence_id,
    };
  }
  let tokenCosts = null;
  if (values["tokenizer-python"]) {
    temporary ??= await PrivateRuntimeRoot.create({
      prefix: "rea-native-handoff-verifier-",
    });
    const input = join(temporary.path, "token-input.json");
    await writeFile(
      input,
      serialize({ catalog, selected, preparation, query: first }),
    );
    const result = await ownedCommand(values["tokenizer-python"], [
      "-c",
      `import json,sys,tiktoken
with open(sys.argv[1],encoding='utf-8') as f:d=json.load(f)
enc=tiktoken.get_encoding('cl100k_base')
def n(v):return len(enc.encode(json.dumps(v,ensure_ascii=False,separators=(',',':')),disallowed_special=()))
requests=n(d['preparation']['request'])+n(d['query']['request'])
structured=n(d['preparation']['response'])+n(d['query']['response'])
full_reply=n(d['preparation']['wire_response'])+n(d['query']['wire_response'])
s=n(d['selected']);a=n(d['catalog'])
print(json.dumps(dict(tokenizer='cl100k_base',tiktoken_version=tiktoken.__version__,selected_catalog=s,full_catalog=a,requests=requests,structured_replies=structured,full_tool_replies=full_reply,selected_catalog_structured_task=s+requests+structured,full_catalog_structured_task=a+requests+structured,selected_catalog_full_reply_task=s+requests+full_reply,full_catalog_full_reply_task=a+requests+full_reply)))`,
      input,
    ]);
    tokenCosts = JSON.parse(result.stdout.text);
  }
  report = {
    scope:
      "Real shipped-ASAR native identity through public CLI/stdio MCP; simulated native Evidence only, no provider/application executed",
    artifact: { path: values.artifact, sha256: archiveSha256 },
    addon_path: values["addon-path"],
    companion_sha256_observed: companionSha256,
    prior_native_sha256_supplied: values["native-sha256"],
    source_paths: values["source-path"] ?? null,
    parent_evidence_id: sourceId,
    trace_evidence_id: first.response.evidence_id,
    preparation_ms: preparationMs,
    samples,
    safe_identity: safeIdentity,
    node: {
      node_id: addon.node_id,
      identity: addon.identity,
      unavailable_observed: unavailable,
      basis: addon.observations.map(({ evidence }) => ({
        authority: evidence.authority,
        state: evidence.state,
        confidence: evidence.confidence,
        artifact: evidence.artifact,
        location: evidence.location,
      })),
    },
    native_handoffs: trace.native_handoffs,
    evidence_links: trace.evidence_links,
    source_coverage: trace.coverage,
    graph_coverage: trace.graph.coverage,
    facts_sha256: digest({
      node: addon,
      native_handoffs: trace.native_handoffs,
      evidence_links: trace.evidence_links,
      coverage: trace.coverage,
    }),
    cli_parity: cliParity,
    token_costs: tokenCosts,
    conditions:
      "Fresh MCP session, one selected analysis followed by repeated identical retained traces. Filesystem/build caches uncontrolled. Task token counts include one analysis summary and one trace with name/description/inputSchema catalog projections; structured and complete-tool-reply projections are alternatives, not billing. Repeated rounds, export, CLI parity and tokenizer are validation overhead outside that one-task token count but inside total resource receipts. A wrong-identity baseline is not a successful equivalent task or efficiency credit.",
  };
  if (values["require-safe"])
    assert.ok(safeIdentity, "Native identity/linkage oracle failed");
} catch (cause) {
  primaryError = cause;
  throw cause;
} finally {
  await closeVerifierResources(
    [
      () => client.close(),
      () => transport.close(),
      async () => {
        if (retainTemporary)
          throw new Error(
            `Command cleanup incomplete; retaining owned inputs at ${temporary?.path}.`,
          );
        await temporary?.close();
      },
    ],
    primaryError,
  );
}
console.log(serialize(report));
