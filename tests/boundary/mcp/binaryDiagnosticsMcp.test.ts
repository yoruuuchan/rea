import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { byteEntropySchema } from "../../../src/domain/native/byteEntropy.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { TOOL_EFFECTS } from "../../../src/contracts/toolEffects.js";
import {
  advertisedMcpToolSchemas,
  assertRecordedMcpEvidence,
} from "../../fixtures/advertisedMcpTool.js";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { expect, it, onTestFinished } from "vitest";
import { BinaryLayoutService } from "../../../src/application/binaryDiagnostics/BinaryLayoutService.js";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { ok } from "../../../src/domain/result.js";
import { createServer } from "../../../src/server/createServer.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import {
  binaryLayoutFixture,
  BINARY_LAYOUT_TEST_PROVIDER,
} from "../../fixtures/binaryDiagnostics/layout.js";

it("advertises exact valid schemas and records inline layout without a binary target", async () => {
  const value = binaryLayoutFixture();
  let providerClosed = false;
  let providerCalls = 0;
  const service = new BinaryLayoutService({
    inspectAndClose(input, options) {
      return this.inspect(input, options);
    },
    identity: BINARY_LAYOUT_TEST_PROVIDER,
    inspect: () => {
      providerCalls++;
      return Promise.resolve(ok(value));
    },
    close: async () => {
      providerClosed = true;
    },
  });
  const session = createTestBinarySession(() => {
    throw new Error("deep provider must not start");
  });
  const server = createServer(
    { kind: "session", session },
    { binaryLayout: service },
  );
  const client = new Client({ name: "binary-layout-contract", version: "1" });
  onTestFinished(async () => {
    await client.close();
    await server.close();
    expect(providerClosed).toBe(true);
    await session.close();
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const schemas = await advertisedMcpToolSchemas(
    client,
    "inspect_binary_layout",
  );
  const { ajv, inputSchema } = schemas;
  expect(ajv.validate(inputSchema, { path: value.artifact.path })).toBe(true);
  expect(ajv.validate(inputSchema, { path: "relative.elf" })).toBe(false);
  expect(
    ajv.validate(inputSchema, {
      path: value.artifact.path,
      approval: true,
    }),
  ).toBe(false);
  const response = await client.callTool({
    name: "inspect_binary_layout",
    arguments: { path: value.artifact.path },
  });
  const evidence = assertRecordedMcpEvidence(
    response,
    "inspect_binary_layout",
    schemas,
    session,
    value,
    "observed",
  );
  const viewed = await client.callTool({
    name: "inspect_analysis_view",
    arguments: {
      source: {
        kind: "retained-evidence",
        evidence_id: evidence.evidence_id,
      },
      view: { kind: "summary" },
    },
  });
  expect(viewed.isError).not.toBe(true);
  expect(
    toolContract("inspect_analysis_view").outputSchema.parse(
      viewed.structuredContent,
    ).normalized_result,
  ).toMatchObject({
    kind: "summary",
    parent_evidence_id: evidence.evidence_id,
    summary: { format: "elf", bytes: value.artifact.bytes },
  });
  expect(
    (
      await client.callTool({
        name: "inspect_binary_layout",
        arguments: { path: "relative.elf" },
      })
    ).isError,
  ).toBe(true);
  expect(providerCalls).toBe(1);
});

it("profiles real bytes with exact offsets, valid advertised schemas and read-only effects", async () => {
  const root = await createTestTempDirectory("rea-entropy-mcp-");
  const path = join(root, "firmware.bin");
  await writeFile(
    path,
    Buffer.concat([
      Buffer.alloc(4096),
      randomBytes(4096),
      Buffer.from("ordinary text ".repeat(400)),
    ]),
  );
  const session = createTestBinarySession(() => {
    throw new Error("No provider needed");
  });
  const server = createServer({ kind: "session", session });
  const client = new Client({ name: "entropy-contract", version: "1" });
  onTestFinished(async () => {
    await client.close();
    await server.close();
    await session.close();
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const { ajv, inputSchema, outputSchema } = await advertisedMcpToolSchemas(
    client,
    "inspect_byte_entropy",
  );
  expect(ajv.validate(inputSchema, { path, surprise: true })).toBe(false);
  const response = await client.callTool({
    name: "inspect_byte_entropy",
    arguments: { path },
  });
  expect(response.isError).not.toBe(true);
  expect(
    ajv.validate(outputSchema, response.structuredContent),
    JSON.stringify(ajv.errors),
  ).toBe(true);
  const evidence = parseEvidence(response.structuredContent);
  const report = byteEntropySchema.parse(evidence.normalized_result);
  expect(report.runs).toEqual([
    { offset: 0, length: 4096, classification: "low" },
    { offset: 4096, length: 4096, classification: "high" },
  ]);
  expect(
    report.blocks.map(({ offset, length }) => ({ offset, length })),
  ).toEqual([
    { offset: 0, length: 4096 },
    { offset: 4096, length: 4096 },
    { offset: 8192, length: 4096 },
    { offset: 12288, length: 1504 },
  ]);
  expect(session.evidenceById(evidence.evidence_id)).toEqual(evidence);
  expect(TOOL_EFFECTS.inspect_byte_entropy).toMatchObject({
    launchesProcess: false,
    writesFilesystem: false,
    accessesNetwork: false,
    mutatesTarget: false,
  });
  expect(
    (
      await client.callTool({
        name: "inspect_byte_entropy",
        arguments: { path, offset: 999999 },
      })
    ).isError,
  ).toBe(true);
});
