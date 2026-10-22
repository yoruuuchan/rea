import { ok as resultOk } from "../../../src/domain/result.js";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";

import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { createEvidenceBundle } from "../../../src/domain/evidenceBundle.js";
import { createEvidence } from "../../../src/domain/evidence.js";
import {
  createResidualUnknown,
  recordUnknownInputSchema,
  updateResidualUnknown,
} from "../../../src/domain/residualUnknown.js";
import { createServer } from "../../../src/server/createServer.js";
import {
  MIXED_AUTHORITY_SUMMARY,
  mixedAuthorityRequest,
  reviewedObligation,
} from "../../../src/application/ReconstructionObligationLedger.fixture.js";
import { observed } from "../../fixtures/analysisExecution.js";

type LedgerRequest = (
  evidenceBundle: unknown,
  reviewedObligations?: readonly unknown[],
) => ReturnType<Client["callTool"]>;

const withLedgerClient = async (
  run: (request: LedgerRequest) => Promise<void>,
): Promise<void> => {
  const session = createTestBinarySession(() => ({
    execute: () => Promise.resolve(observed(null)),
    close: () => Promise.resolve(resultOk(null)),
  }));
  const server = createServer({ kind: "session", session });
  const client = new Client({ name: "obligation-ledger-test", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    await run((evidenceBundle, reviewedObligations = []) =>
      client.callTool({
        name: "build_reconstruction_obligation_ledger",
        arguments: {
          evidence_bundle: evidenceBundle,
          reviewed_obligations: reviewedObligations,
          manifest: { bindings: [], contradictions: [] },
        },
      }),
    );
  } finally {
    await client.close();
    await server.close();
    await session.close();
  }
};

const inputError = (message: string) => ({
  error: {
    code: "invalid_request",
    category: "invalid_input",
    details: {
      operation: "build_reconstruction_obligation_ledger",
      issues: [
        expect.objectContaining({ message: expect.stringContaining(message) }),
      ],
    },
  },
});

describe("reconstruction obligation ledger residual graph input", () => {
  it("reports missing residual Evidence references and accepts the repaired bundle", async () => {
    const input = recordUnknownInputSchema.parse({
      question: "Does the fixture retain state?",
      severity: "low",
      domain: "persistence",
      required_authority: null,
      required_confidence: "observed",
      required_environment: null,
      recommended_probes: [],
      relationships: [],
    });
    const mutation = createEvidence(
      undefined,
      { id: "fixture", name: "Fixture", version: "1" },
      {
        predicateType: "rea.residual-unknown-mutation",
        operation: "record_unknown",
        parameters: {},
        result: { question: input.question },
      },
    );
    const unknown = createResidualUnknown(input, mutation.evidence_id, null);
    const valid = createEvidenceBundle([mutation], [unknown]);
    await withLedgerClient(async (request) => {
      expect((await request(valid)).isError).not.toBe(true);
      const result = await request(createEvidenceBundle([], [unknown]));
      expect(result.isError).toBe(true);
      expect(parseMcpToolError(result)).toMatchObject(
        inputError(
          `Residual unknown references missing evidence ${mutation.evidence_id}`,
        ),
      );
      const repaired = await request(valid);
      expect(repaired.isError).not.toBe(true);
      expect(repaired.structuredContent).toMatchObject({
        normalized_result: { status: "unknown", summary: { total: 0 } },
      });
    });
  });

  it.each(["history", "relationship", "resolution"] as const)(
    "reports residual %s constraints as caller input",
    async (constraint) => {
      const missingId = `unk_${"a".repeat(64)}`;
      const input = recordUnknownInputSchema.parse({
        question: "Does the fixture retain state?",
        severity: "low",
        domain: "persistence",
        required_authority: null,
        required_confidence: "observed",
        required_environment: null,
        recommended_probes: [],
        relationships:
          constraint === "relationship"
            ? [{ type: "related-to", unknown_id: missingId }]
            : [],
      });
      const mutation = createEvidence(
        undefined,
        { id: "fixture", name: "Fixture", version: "1" },
        {
          predicateType: "rea.residual-unknown-mutation",
          operation: "record_unknown",
          parameters: {},
          result: { question: input.question },
        },
      );
      const first = createResidualUnknown(input, mutation.evidence_id, null);
      const revision = updateResidualUnknown(
        first,
        {
          ...input,
          unknown_id: first.unknown_id,
          expected_revision: 1,
          status: constraint === "resolution" ? "resolved" : "investigating",
          resolution:
            constraint === "resolution"
              ? {
                  disposition: "verified",
                  rationale: "A mutation alone does not prove the answer",
                  evidence_ids: [mutation.evidence_id],
                }
              : null,
        },
        mutation.evidence_id,
      );
      const unknowns =
        constraint === "history" ? [revision] : [first, revision];
      const reason =
        constraint === "history"
          ? `Residual unknown ${first.unknown_id} revision history has a gap`
          : constraint === "relationship"
            ? `Residual unknown references missing unknown ${missingId}`
            : `Residual unknown ${first.unknown_id} has no qualifying resolution evidence`;
      await withLedgerClient(async (request) => {
        const result = await request(
          createEvidenceBundle([mutation], unknowns),
        );
        expect(result.isError).toBe(true);
        expect(parseMcpToolError(result)).toMatchObject(inputError(reason));
      });
    },
  );
});

describe("reconstruction obligation ledger MCP parity", () => {
  it("returns canonical bundle failures as caller input errors", async () => {
    const records = ["first", "second"].map((label) =>
      createEvidence(
        undefined,
        { id: "fixture", name: "Fixture", version: "1" },
        {
          operation: "observe",
          parameters: { label },
          result: { label },
        },
      ),
    );
    const canonical = createEvidenceBundle(records);
    const session = createTestBinarySession(() => ({
      execute: () => Promise.resolve(observed(null)),
      close: () => Promise.resolve(resultOk(null)),
    }));
    const server = createServer({ kind: "session", session });
    const client = new Client({ name: "obligation-ledger-test", version: "1" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const request = (evidenceBundle: unknown) =>
        client.callTool({
          name: "build_reconstruction_obligation_ledger",
          arguments: {
            evidence_bundle: evidenceBundle,
            reviewed_obligations: [],
            manifest: { bindings: [], contradictions: [] },
          },
        });
      const valid = await request(canonical);
      expect(valid.isError).not.toBe(true);
      expect(valid.structuredContent).toMatchObject({
        normalized_result: { status: "unknown", summary: { total: 0 } },
      });
      const result = await request({
        ...canonical,
        records: [...canonical.records].reverse(),
      });
      expect(result.isError).toBe(true);
      expect(parseMcpToolError(result)).toMatchObject({
        error: {
          code: "invalid_request",
          category: "invalid_input",
          details: {
            operation: "build_reconstruction_obligation_ledger",
            issues: [
              expect.objectContaining({
                message: expect.stringContaining(
                  "Evidence bundle manifests are not canonical",
                ),
              }),
            ],
          },
        },
      });
    } finally {
      await client.close();
      await server.close();
      await session.close();
    }
  });

  it("returns duplicate records and missing review Evidence as caller input errors", async () => {
    const record = createEvidence(
      undefined,
      { id: "fixture", name: "Fixture", version: "1" },
      { operation: "observe", parameters: {}, result: {} },
    );
    const canonical = createEvidenceBundle([record]);
    const missingEvidenceId = `ev_${"a".repeat(64)}`;
    await withLedgerClient(async (request) => {
      const duplicate = await request({
        ...canonical,
        records: [...canonical.records, ...canonical.records],
      });
      expect(duplicate.isError).toBe(true);
      expect(parseMcpToolError(duplicate)).toMatchObject(
        inputError("Evidence bundle contains duplicate record IDs"),
      );
      const missing = await request(canonical, [
        reviewedObligation("obl.reviewed", missingEvidenceId),
      ]);
      expect(missing.isError).toBe(true);
      expect(parseMcpToolError(missing)).toMatchObject(
        inputError(
          `Reviewed obligation Evidence is missing: ${missingEvidenceId}`,
        ),
      );
    });
  });

  it("summarizes obligations by their cited Evidence authorities", async () => {
    const input = mixedAuthorityRequest();
    await withLedgerClient(async (request) => {
      const result = await request(
        input.evidence_bundle,
        input.reviewed_obligations,
      );
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        normalized_result: { summary: MIXED_AUTHORITY_SUMMARY },
      });
    });
  });

  it("returns the complete Evidence-backed ledger inline", async () => {
    const session = createTestBinarySession(() => ({
      execute: () => Promise.resolve(observed(null)),
      close: () => Promise.resolve(resultOk(null)),
    }));
    const server = createServer({ kind: "session", session });
    const client = new Client({ name: "obligation-ledger-test", version: "1" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const result = await client.callTool({
        name: "build_reconstruction_obligation_ledger",
        arguments: {
          evidence_bundle: createEvidenceBundle([]),
          reviewed_obligations: [],
          manifest: {
            bindings: [],
            contradictions: [],
          },
        },
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        evidence_id: expect.stringMatching(/^ev_[a-f0-9]{64}$/u),
        normalized_result: {
          schema: "ReconstructionObligationLedger",
          status: "unknown",
          summary: { total: 0 },
        },
      });
    } finally {
      await client.close();
      await server.close();
      await session.close();
    }
  });
});
