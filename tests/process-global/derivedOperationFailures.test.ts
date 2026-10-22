import { InMemoryTransport, Client } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { ARTIFACT_COMPARISON_EXAMPLE } from "../../src/contracts/artifactComparisonExample.js";
import { FUNCTION_COMPARISON_EXAMPLE } from "../../src/contracts/functionComparisonExample.js";
import { completeReconstructionCoverageData } from "../../src/domain/reconstructionCoverage.fixture.js";
import { reconstructionClosureResultSchema } from "../../src/domain/reconstructionCoverage.js";
import { createEvidence } from "../../src/domain/evidence.js";
import { functionComparisonResultSchema } from "../../src/domain/functionComparisonSchemas.js";
import { createServer } from "../../src/server/createServer.js";
import { createTestBinarySession } from "../fixtures/binarySession.js";
import { parseMcpToolError } from "../fixtures/mcpToolError.js";

const unexpectedResultFailures = [
  ["TypeError", () => new TypeError("injected result parser TypeError")],
  ["Error", () => new Error("injected result parser Error")],
  [
    "ZodError",
    () => {
      const result = z.string().safeParse(1);
      if (result.success) throw new Error("Expected an invalid string parse");
      return result.error;
    },
  ],
] as const;

const invalidFunctionOperationEvidence = () => {
  const left = FUNCTION_COMPARISON_EXAMPLE.left;
  if (left.subject === null) throw new Error("Expected a function subject");
  return createEvidence(
    {
      path: "/tmp/wrong-function-operation",
      sha256: left.subject.digest.sha256,
      format: left.subject.format,
      ...(left.subject.architecture === null
        ? {}
        : { architecture: left.subject.architecture }),
    },
    left.provider,
    {
      predicateType: left.predicate_type,
      operation: "inspect_analysis_view",
      parameters: left.parameters,
      result: left.normalized_result,
      confidence: left.confidence,
      authority: left.authority,
      ...(left.relationship_coverage === null
        ? {}
        : { relationshipCoverage: left.relationship_coverage }),
    },
  );
};

const malformedFunctionResultEvidence = () => {
  const left = FUNCTION_COMPARISON_EXAMPLE.left;
  if (left.subject === null) throw new Error("Expected a function subject");
  return createEvidence(
    {
      path: "/tmp/malformed-function-result",
      sha256: left.subject.digest.sha256,
      format: left.subject.format,
      ...(left.subject.architecture === null
        ? {}
        : { architecture: left.subject.architecture }),
    },
    left.provider,
    {
      predicateType: left.predicate_type,
      operation: "analyze_function",
      parameters: left.parameters,
      result: { malformed: true },
      confidence: left.confidence,
      authority: left.authority,
      ...(left.relationship_coverage === null
        ? {}
        : { relationshipCoverage: left.relationship_coverage }),
    },
  );
};

const withSdk = async <Value>(
  run: (input: {
    readonly client: Client;
    readonly session: ReturnType<typeof createTestBinarySession>;
  }) => Promise<Value>,
): Promise<Value> => {
  const session = createTestBinarySession(() => {
    throw new Error(
      "These deterministic Evidence tools must not launch a provider",
    );
  });
  const server = createServer({ kind: "session", session });
  const client = new Client({
    name: "derived-operation-failures",
    version: "1",
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return await run({ client, session });
  } finally {
    await Promise.allSettled([client.close(), server.close(), session.close()]);
  }
};

describe("derived operation failures through the public SDK", () => {
  afterEach(() => vi.restoreAllMocks());

  it("keeps a wrong function operation as a caller constraint at left", async () => {
    await withSdk(async ({ client, session }) => {
      const response = await client.callTool({
        name: "compare_functions",
        arguments: {
          left: invalidFunctionOperationEvidence(),
          right: FUNCTION_COMPARISON_EXAMPLE.right,
        },
      });

      expect(parseMcpToolError(response).error).toMatchObject({
        code: "invalid_request",
        details: {
          issues: [expect.objectContaining({ path: ["left"] })],
        },
      });
      expect(session.exportEvidenceBundle().records).toEqual([]);
    });
  });

  it("keeps malformed analyze_function payloads as Evidence integrity failures", async () => {
    await withSdk(async ({ client, session }) => {
      const response = await client.callTool({
        name: "compare_functions",
        arguments: {
          left: malformedFunctionResultEvidence(),
          right: FUNCTION_COMPARISON_EXAMPLE.right,
        },
      });

      expect(parseMcpToolError(response).error.code).toBe(
        "evidence_integrity_mismatch",
      );
      expect(session.exportEvidenceBundle().records).toEqual([]);
    });
  });

  it("classifies a duplicated call-path function at its second selection", async () => {
    await withSdk(async ({ client, session }) => {
      const source = FUNCTION_COMPARISON_EXAMPLE.left;
      expect(session.recordEvidence(source).ok).toBe(true);
      const before = session.exportEvidenceBundle();
      const response = await client.callTool({
        name: "build_call_path",
        arguments: {
          functions: [source, source],
          start: { address: "0x1000" },
          goal: { address: "0x1001" },
        },
      });

      expect(parseMcpToolError(response).error).toMatchObject({
        code: "invalid_request",
        details: {
          issues: [expect.objectContaining({ path: ["functions", 1] })],
        },
      });
      expect(session.exportEvidenceBundle()).toEqual(before);
    });
  });

  it("classifies a non-inventory artifact carrier at left", async () => {
    await withSdk(async ({ client, session }) => {
      const response = await client.callTool({
        name: "compare_artifacts",
        arguments: {
          left: FUNCTION_COMPARISON_EXAMPLE.left,
          right: ARTIFACT_COMPARISON_EXAMPLE.right,
        },
      });

      expect(parseMcpToolError(response).error).toMatchObject({
        code: "invalid_request",
        details: {
          issues: [expect.objectContaining({ path: ["left"] })],
        },
      });
      expect(session.exportEvidenceBundle().records).toEqual([]);
    });
  });

  it.each(unexpectedResultFailures)(
    "preserves an unexpected %s from result validation",
    async (_label, createFailure) => {
      await withSdk(async ({ client, session }) => {
        const failure = createFailure();
        vi.spyOn(functionComparisonResultSchema, "parse").mockImplementation(
          () => {
            throw failure;
          },
        );
        const response = await client.callTool({
          name: "compare_functions",
          arguments: {
            left: FUNCTION_COMPARISON_EXAMPLE.left,
            right: FUNCTION_COMPARISON_EXAMPLE.right,
          },
        });

        expect(response).toMatchObject({
          isError: true,
          content: [{ type: "text", text: failure.message }],
        });
        expect(response.structuredContent).toBeUndefined();
        expect(session.exportEvidenceBundle().records).toEqual([]);
      });
    },
  );

  it.each(unexpectedResultFailures)(
    "preserves an unexpected %s from coverage result validation",
    async (_label, createFailure) => {
      await withSdk(async ({ client, session }) => {
        const coverage = completeReconstructionCoverageData();
        const failure = createFailure();
        vi.spyOn(reconstructionClosureResultSchema, "parse").mockImplementation(
          () => {
            throw failure;
          },
        );
        const response = await client.callTool({
          name: "evaluate_reconstruction_coverage",
          arguments: { coverage, boundary_id: "replacement.cli" },
        });
        expect(response).toMatchObject({
          isError: true,
          content: [{ type: "text", text: failure.message }],
        });
        expect(response.structuredContent).toBeUndefined();
        expect(session.exportEvidenceBundle().records).toEqual([]);
      });
    },
  );
});
