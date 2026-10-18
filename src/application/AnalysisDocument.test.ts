import { expect, it } from "vitest";
import { resolveAnalysisDocument } from "./AnalysisDocument.js";
import {
  createAnalysisExecution,
  type AnalysisOperationPort,
} from "./AnalysisProvider.js";
import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisOutputError,
} from "../domain/analysisErrorCore.js";
import { parseEvidence } from "../domain/evidence.js";
import { err, ok } from "../domain/result.js";

const provider = {
  id: "controlled",
  name: "Controlled document provider",
  version: "1",
};
const unsupported = () =>
  new AnalysisCapabilityUnavailableError(
    "controlled",
    "current_document",
    "No current UI selection",
  );

it.each([
  null,
  "caller stopped",
  { request: "opaque" },
  new AnalysisCapabilityUnavailableError(
    "caller",
    "caller_operation",
    "Caller-owned cleanup",
    {
      cleanup: {
        reason: "caller resource not released",
        resources: ["caller resource"],
      },
    },
  ),
])("retains the exact admission cancellation reason: %j", async (reason) => {
  const controller = new AbortController();
  controller.abort(reason);
  const result = await resolveAnalysisDocument(
    {
      execute: async () => {
        throw new Error("must not query provider");
      },
    },
    undefined,
    controller.signal,
  );
  if (result.ok) throw new Error("expected cancelled admission");
  expect(result.error).toBeInstanceOf(AnalysisCancelledError);
  expect(result.error.cause).toBe(reason);
  expect(result.error.cleanupIncomplete).toBe(false);
  if (reason instanceof AnalysisCapabilityUnavailableError)
    expect(reason.cleanupIncomplete).toBe(true);
});

it.each([false, true])(
  "does not fall back from an unavailable selection with incomplete cleanup (cancelled: %s)",
  async (aborted) => {
    const controller = new AbortController();
    const failure = new AnalysisCapabilityUnavailableError(
      "controlled",
      "current_document",
      "Unavailable while cleanup is pending",
      {
        cleanup: {
          reason: "live provider resource",
          resources: ["controlled resource"],
        },
      },
    );
    const calls: string[] = [];
    const port: AnalysisOperationPort = {
      execute: async (operation) => {
        calls.push(operation);
        if (aborted) controller.abort(null);
        return operation === "current_document"
          ? err(failure)
          : ok(createAnalysisExecution(["selected"], provider));
      },
    };
    const result = await resolveAnalysisDocument(
      port,
      undefined,
      controller.signal,
    );
    expect(result).toEqual(err(failure));
    expect(calls).toEqual(["current_document"]);
    expect(failure.cleanupIncomplete).toBe(true);
  },
);

it("does not start fallback after a clean unavailable selection completes under cancellation", async () => {
  const controller = new AbortController();
  const reason = { request: "cancel before fallback" };
  const calls: string[] = [];
  const result = await resolveAnalysisDocument(
    {
      execute: async (operation) => {
        calls.push(operation);
        controller.abort(reason);
        return operation === "current_document"
          ? err(unsupported())
          : ok(createAnalysisExecution(["selected"], provider));
      },
    },
    undefined,
    controller.signal,
  );
  if (result.ok) throw new Error("expected cancelled fallback admission");
  expect(result.error).toBeInstanceOf(AnalysisCancelledError);
  expect(result.error.cause).toBe(reason);
  expect(calls).toEqual(["current_document"]);
});

it.each(["current_document", "list_documents"] as const)(
  "retains validated %s observations on late cancellation",
  async (completedOperation) => {
    const controller = new AbortController();
    const reason = { request: "late selection" };
    const result = await resolveAnalysisDocument(
      {
        execute: async (operation) => {
          if (operation !== completedOperation) return err(unsupported());
          controller.abort(reason);
          return ok(
            createAnalysisExecution(
              operation === "current_document" ? "selected" : ["selected"],
              provider,
              {
                rawResult: { selected_source: "controlled" },
                limitations: ["controlled provider only"],
                subject: {
                  path: "/selected/image",
                  sha256: "a".repeat(64),
                  format: "pe",
                },
                locations: [{ kind: "artifact-path", path: "/selected/image" }],
              },
            ),
          );
        },
      },
      undefined,
      controller.signal,
    );
    if (result.ok) throw new Error("expected cancelled completion");
    expect(result.error).toBeInstanceOf(AnalysisCancelledError);
    expect(result.error.cause).toBe(reason);
    expect(parseEvidence(result.error.partialObservation)).toMatchObject({
      operation: completedOperation,
      parameters: {},
      provider,
      confidence: "observed",
      normalized_result:
        completedOperation === "current_document" ? "selected" : ["selected"],
      raw_result: { selected_source: "controlled" },
      limitations: ["controlled provider only"],
      subject: { local_path: "/selected/image" },
      locations: [{ kind: "artifact-path", path: "/selected/image" }],
    });
  },
);

it.each(["current_document", "list_documents"] as const)(
  "validates malformed %s before late cancellation",
  async (completedOperation) => {
    const controller = new AbortController();
    const result = await resolveAnalysisDocument(
      {
        execute: async (operation) => {
          if (operation !== completedOperation) return err(unsupported());
          controller.abort(null);
          return ok(createAnalysisExecution(null, provider));
        },
      },
      undefined,
      controller.signal,
    );
    if (result.ok) throw new Error("expected output refusal");
    expect(result.error).toBeInstanceOf(AnalysisOutputError);
    expect(result.error.partialObservation).toBeUndefined();
  },
);

it("preserves an explicit document without provider selection", async () => {
  await expect(
    resolveAnalysisDocument(
      {
        execute: async () => {
          throw new Error("must not query");
        },
      },
      "caller selection",
      undefined,
    ),
  ).resolves.toEqual(ok("caller selection"));
});
