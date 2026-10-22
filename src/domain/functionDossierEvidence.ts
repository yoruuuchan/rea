import type { Evidence } from "./evidence.js";
import { AnalysisInputError } from "./analysisErrorCore.js";
import type { EvidenceIntegrityError } from "./evidenceErrors.js";
import { readEvidence, readEvidencePayload } from "./evidenceValidation.js";
import { err, ok, type Result } from "./result.js";
import { compareUnicodeCodePoints } from "./unicodeCodePointOrder.js";
import { functionDossierSchema, type FunctionDossier } from "./hopperValues.js";
import { assessFunctionCallCoverage } from "./functionCallCoverage.js";

/** Complete function observation parsed from one analyze_function Evidence record. */
export interface FunctionSnapshot {
  readonly evidence: Evidence;
  readonly subject: NonNullable<Evidence["subject"]>;
  readonly dossier: FunctionDossier;
  readonly limitations: readonly string[];
  readonly callCoverageBlockers: readonly string[];
  readonly callCoverageDiagnostics: readonly string[];
}

/** Parse one complete analyze_function Evidence record for comparison workflows. */
export const parseFunctionEvidence = (
  input: unknown,
  selection: {
    readonly operation: "compare_functions" | "build_call_path";
    readonly path: readonly (string | number)[];
  },
): Result<FunctionSnapshot, AnalysisInputError | EvidenceIntegrityError> => {
  const parsed = readEvidence(input);
  if (!parsed.ok) return parsed;
  const evidence = parsed.value;
  const invalidSelection = (message: string) =>
    err(
      new AnalysisInputError(selection.operation, { userMessage: message }, [
        { path: selection.path, reason: "invalid_value", message },
      ]),
    );
  if (
    evidence.operation !== "analyze_function" ||
    evidence.predicate_type !== "rea.analysis"
  )
    return invalidSelection(
      "Function analysis requires analyze_function Evidence with the rea.analysis predicate",
    );
  if (evidence.subject === null)
    return invalidSelection(
      "Function analysis requires artifact-bound Evidence",
    );
  const dossier = readEvidencePayload(
    functionDossierSchema,
    evidence.normalized_result,
  );
  if (!dossier.ok) return dossier;
  const callCoverage = assessFunctionCallCoverage(
    evidence.relationship_coverage,
    dossier.value,
  );
  return ok({
    evidence,
    subject: evidence.subject,
    dossier: dossier.value,
    limitations: [
      ...new Set([...evidence.limitations, ...dossier.value.limitations]),
    ].sort((left, right) => compareUnicodeCodePoints(left, right)),
    callCoverageBlockers: callCoverage.blockers,
    callCoverageDiagnostics: callCoverage.diagnostics,
  });
};
