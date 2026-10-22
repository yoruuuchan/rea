import { z } from "zod";

import { AnalysisInputError } from "../domain/analysisErrorCore.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  createEvidence,
  type Evidence,
  type EvidenceProvider,
  type EvidenceSubjectTarget,
} from "../domain/evidence.js";
import { jsonValueSchema } from "../domain/jsonValue.js";
import type { MobileApplicationProjectionWithSources } from "../domain/mobileApplicationGraphProjection.js";
import { err, ok, type Result } from "../domain/result.js";
import { requestInputError } from "./workflowInputError.js";
import { ArtifactInventoryCarrierError } from "../domain/artifactInventoryEvidence.js";

interface InventoryProjectionInput {
  readonly inventory_evidence: readonly Evidence[];
  readonly limits?: unknown;
}

interface InventoryProjectionResult {
  readonly root_sha256: string;
  readonly source_evidence_ids: readonly string[];
  readonly limitations: readonly string[];
}

export interface InventoryProjectionEvidenceResult {
  readonly evidence: Evidence;
  readonly sources: readonly Evidence[];
}

interface InventoryProjectionOptions<
  Input extends InventoryProjectionInput,
  Output extends InventoryProjectionResult,
> {
  readonly rawInput: unknown;
  readonly schema: z.ZodType<Input>;
  readonly project: (
    input: Input,
  ) => MobileApplicationProjectionWithSources<Output>;
  readonly operation: string;
  readonly predicateType: string;
  readonly provider: EvidenceProvider;
  readonly subjectFormat: (first: Evidence) => EvidenceSubjectTarget["format"];
}

/** Parse one inventory projection and wrap its deterministic result in Evidence. */
export const projectInventoryEvidence = <
  Input extends InventoryProjectionInput,
  Output extends InventoryProjectionResult,
>(
  options: InventoryProjectionOptions<Input, Output>,
): Result<InventoryProjectionEvidenceResult, AnalysisError> => {
  const parsed = options.schema.safeParse(options.rawInput);
  if (!parsed.success)
    return err(
      requestInputError(options.operation, parsed.error, options.rawInput),
    );
  try {
    const projected = options.project(parsed.data);
    const result = projected.projection;
    const first = projected.sources[0];
    return ok({
      evidence: createEvidence(
        first?.subject === null || first?.subject === undefined
          ? undefined
          : {
              path: first.subject.local_path,
              sha256: result.root_sha256,
              format: options.subjectFormat(first),
            },
        options.provider,
        {
          predicateType: options.predicateType,
          operation: options.operation,
          parameters: {
            inventory_evidence_ids: [...result.source_evidence_ids],
            ...("limits" in parsed.data && parsed.data.limits !== undefined
              ? { limits: jsonValueSchema.parse(parsed.data.limits) }
              : {}),
          },
          result: jsonValueSchema.parse(result),
          rawResult: null,
          confidence: "inferred",
          authority: "analyst-inference",
          environment: null,
          limitations: result.limitations,
          evidenceLinks: result.source_evidence_ids,
        },
      ),
      sources: projected.sources,
    });
  } catch (cause: unknown) {
    if (cause instanceof AnalysisError) return err(cause);
    if (cause instanceof ArtifactInventoryCarrierError)
      return err(
        new AnalysisInputError(
          options.operation,
          { cause, userMessage: cause.message },
          [
            {
              path: [
                "inventory_evidence",
                ...(cause.index === undefined ? [] : [cause.index]),
                ...(cause.index === undefined ? [] : ["operation"]),
              ],
              reason: "invalid_value",
              message: cause.message,
            },
          ],
        ),
      );
    throw cause;
  }
};
