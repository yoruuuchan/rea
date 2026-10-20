import { z } from "incur";
import type { Evidence } from "../domain/evidence.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import type { AnalysisErrorProjection } from "../domain/analysisErrorProjection.js";
import type { Result } from "../domain/result.js";
import { AnalysisInputError } from "../domain/analysisErrorCore.js";
import { createEvidenceBundle } from "../domain/evidenceBundle.js";
import { writeEvidenceBundle } from "../application/EvidenceBundleFiles.js";
import { inspectAnalysisView } from "../application/analysisView/AnalysisViewService.js";
import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { absoluteCallerPath } from "../filesystem/callerPath.js";
import { finishAnalysisCommand } from "./finishAnalysisCommand.js";

export const analysisEvidenceDeliveryOptions = {
  detail: z
    .enum(["complete", "summary"])
    .default("complete")
    .describe("Deliver complete Evidence, or a summary with --evidence_output"),
  evidence_output: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Save complete Evidence as a bundle; required for summary delivery. Never overwrites.",
    ),
};

const isEvidence = (
  value: Evidence | AnalysisErrorProjection,
): value is Evidence => "evidence_id" in value && "normalized_result" in value;

/** One-shot delivery owns report publication; analysis keeps its own cleanup owner. */
export const deliverCliAnalysisEvidence = async (input: {
  readonly run: () => Promise<Result<Evidence, AnalysisError>>;
  readonly service: { close(): Promise<void> };
  readonly providerId: string;
  readonly operation: string;
  readonly signal: AbortSignal;
  readonly detail: "complete" | "summary";
  readonly evidenceOutput: string | undefined;
}) => {
  const {
    run,
    service,
    providerId,
    operation,
    signal,
    detail,
    evidenceOutput,
  } = input;
  if (detail === "summary" && evidenceOutput === undefined)
    return finishAnalysisCommand(
      async () => ({
        ok: false,
        error: new AnalysisInputError(operation, undefined, [
          {
            path: ["evidence_output"],
            reason: "invalid_value",
            message:
              "Summary delivery requires --evidence_output so complete source Evidence remains available.",
          },
        ]),
      }),
      service,
      providerId,
      operation,
      signal,
    );
  const complete = await finishAnalysisCommand(
    run,
    service,
    providerId,
    operation,
    signal,
  );
  if (!isEvidence(complete) || evidenceOutput === undefined) return complete;
  const resources = new ArtifactResourceScope();
  let receipt: { readonly path: string; readonly bytes: number } | undefined;
  const delivered = await finishAnalysisCommand(
    async () => {
      const written = await writeEvidenceBundle(
        createEvidenceBundle([complete]),
        absoluteCallerPath(evidenceOutput),
        false,
        resources,
        signal,
      );
      if (!written.ok) {
        if (written.error.partialObservation === undefined)
          written.error.retainPartialObservation(complete);
        return written;
      }
      receipt = written.value;
      return detail === "summary"
        ? inspectAnalysisView({
            source: { kind: "inline", evidence: complete },
            view: { kind: "summary" },
          })
        : { ok: true as const, value: complete };
    },
    { close: () => resources.close() },
    providerId,
    operation,
    signal,
  );
  return isEvidence(delivered) && detail === "summary"
    ? { summary: delivered, evidence_bundle: receipt }
    : delivered;
};
