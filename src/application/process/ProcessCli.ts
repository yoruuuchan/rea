import { z } from "zod";

import { AnalysisError } from "../../domain/analysisErrorBase.js";
import { analysisErrorWithCleanupFailure } from "../../domain/analysisErrorCleanup.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
} from "../../domain/analysisErrorCore.js";
import { projectAnalysisError } from "../../domain/analysisErrorProjection.js";
import type { AnalysisErrorProjection } from "../../domain/analysisErrorProjection.js";
import { ProviderAdapterError } from "../../domain/providerAdapterError.js";
import { createEvidence } from "../../domain/evidence.js";
import { describeValidationFailure } from "../../domain/evidenceBundle.js";
import { jsonValueSchema } from "../../domain/jsonValue.js";
import {
  analysisInputErrorFromIssues,
  projectInputIssues,
} from "../../domain/inputIssueProjection.js";
import { processTraceSpecificationSchema } from "../../domain/process/processTraceSpecification.js";
import { processScenarioSchema } from "../../domain/process/processScenario.js";
import { compareProcessCaptures } from "../../domain/process/processComparison.js";
import { createProgressReporter } from "../ProgressReporter.js";
import { captureProcessScenario } from "../../process/capture/ProcessHarness.js";
import { ProcessCaptureResourceScope } from "../../process/capture/ProcessCaptureLifecycle.js";
import { ProcessCaptureError } from "../../process/capture/ProcessCaptureError.js";
import { PROCESS_PROVIDER } from "../../domain/process/processEvidenceProvider.js";
import {
  createProcessCaptureEvidence,
  parseProcessCaptureEvidence,
} from "./ProcessEvidence.js";
import { readJsonFile } from "../JsonFiles.js";
import { RegularFileCleanupFailure } from "../RegularFileRead.js";

/** Safe process-command failure returned to the CLI adapter. */
export interface ProcessCliErrorOutput extends AnalysisErrorProjection {
  readonly error: "Process command failed";
}

/** Identify the process workflow's typed diagnostic result for CLI exit status. */
export const isProcessCliFailure = (
  value: unknown,
): value is ProcessCliErrorOutput =>
  typeof value === "object" &&
  value !== null &&
  "error" in value &&
  value.error === "Process command failed" &&
  "category" in value &&
  typeof value.category === "string" &&
  "message" in value &&
  typeof value.message === "string" &&
  "code" in value &&
  typeof value.code === "string" &&
  "retryable" in value &&
  typeof value.retryable === "boolean" &&
  "remediation" in value &&
  typeof value.remediation === "object" &&
  value.remediation !== null &&
  "action" in value.remediation &&
  typeof value.remediation.action === "string";

/** Capture one JSON scenario through the shared process harness and Evidence contract. */
export const captureProcessScenarioFile = async (
  path: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  signal?: AbortSignal,
) => {
  try {
    const input = await readJson(path, "capture_process_scenario", signal);
    const parsed = processScenarioSchema.safeParse(input);
    if (!parsed.success)
      throw analysisInputErrorFromIssues(
        "capture_process_scenario",
        parsed.error.issues,
        input,
        { cause: parsed.error },
      );
    const progress = createProgressReporter(
      async (update) => {
        process.stderr.write(`${JSON.stringify({ rea_progress: update })}\n`);
      },
      { minimumIntervalMs: 100 },
    );
    const resourceScope = new ProcessCaptureResourceScope();
    const captured = await captureProcessScenario(
      parsed.data,
      signal,
      process.platform,
      environment,
      undefined,
      undefined,
      progress,
      resourceScope,
    );
    try {
      await resourceScope.close();
    } catch (cause: unknown) {
      if (!captured.ok && cause instanceof AnalysisError)
        return cliAnalysisError(
          captured.error instanceof ProcessCaptureError
            ? captured.error.withFinalization({ cleanupFailure: cause })
            : analysisErrorWithCleanupFailure(
                captured.error,
                cause,
                "capture_process_scenario",
              ).bindCleanupDependencies([captured.error, cause]),
        );
      throw cause;
    }
    if (!captured.ok) return cliAnalysisError(captured.error);
    return createProcessCaptureEvidence(parsed.data, captured.value);
  } catch (cause: unknown) {
    if (cause instanceof RegularFileCleanupFailure) throw cause;
    return projectProcessCliError(cause, "capture_process_scenario");
  }
};

/** Compare two capture Evidence files and emit derived comparison Evidence. */
export const compareProcessEvidenceFiles = async (
  leftPath: string,
  rightPath: string,
  traceSpecPath?: string,
  signal?: AbortSignal,
) => {
  try {
    const left = parseCaptureEvidence(
      await readJson(leftPath, "compare_process_captures", signal),
      "left",
    );
    const right = parseCaptureEvidence(
      await readJson(rightPath, "compare_process_captures", signal),
      "right",
    );
    const traceSpecification =
      traceSpecPath === undefined
        ? undefined
        : parseTraceSpecification(
            await readJson(traceSpecPath, "compare_process_captures", signal),
          );
    const comparison =
      traceSpecification === undefined
        ? compareProcessCaptures(left.capture, right.capture)
        : compareProcessCaptures(left.capture, right.capture, {
            traceSpecification,
          });
    return createEvidence(undefined, PROCESS_PROVIDER, {
      predicateType: "rea.process-comparison",
      operation: "compare_process_captures",
      parameters: {
        left_evidence_id: left.record.evidence_id,
        right_evidence_id: right.record.evidence_id,
        left_normalization: left.capture.normalization,
        right_normalization: right.capture.normalization,
        ...(traceSpecification === undefined
          ? {}
          : { trace_spec: jsonValueSchema.parse(traceSpecification) }),
      },
      result: jsonValueSchema.parse(comparison),
      confidence: "derived",
      authority: "analyst-inference",
      limitations: comparison.limitations,
      locations: [...left.record.locations, ...right.record.locations],
      evidenceLinks: [left.record.evidence_id, right.record.evidence_id],
    });
  } catch (cause: unknown) {
    if (cause instanceof RegularFileCleanupFailure) throw cause;
    return projectProcessCliError(cause, "compare_process_captures");
  }
};

const parseCaptureEvidence = (input: unknown, side: "left" | "right") => {
  const parsed = parseProcessCaptureEvidence(input);
  if (parsed.ok) return parsed.value;
  const failure = parsed.error;
  switch (failure.kind) {
    case "invalid-evidence":
      if (failure.cause instanceof z.ZodError)
        throw new AnalysisInputError(
          "compare_process_captures",
          { cause: failure.cause },
          projectInputIssues(failure.cause.issues, input),
        );
      throw invalidCaptureEvidence(failure.cause, side);
    case "wrong-workflow":
      throw processInputFailure(
        "compare_process_captures",
        "Capture evidence is not from the current process-capture workflow. Create new capture evidence, then try again.",
        [side],
        "invalid_value",
      );
    case "unsupported-provider":
      throw new AnalysisInputError("compare_process_captures", undefined, [
        {
          path: [side, "provider"],
          reason: "invalid_value",
          message: `The ${side} Evidence provider ${failure.provider.id} v${failure.provider.version} (${failure.provider.name}) is not the current or supported legacy ${PROCESS_PROVIDER.id} v${PROCESS_PROVIDER.version} process capture provider.`,
        },
      ]);
    case "invalid-capture":
      throw invalidCaptureEvidence(failure.cause, side);
  }
};

const parseTraceSpecification = (input: unknown) => {
  const parsed = processTraceSpecificationSchema.safeParse(input);
  if (parsed.success) return parsed.data;
  // Match the MCP boundary: the operation name and a trace_spec-rooted path.
  throw new AnalysisInputError(
    "compare_process_captures",
    { cause: parsed.error },
    projectInputIssues(parsed.error.issues, input).map((issue) => ({
      ...issue,
      path: ["trace_spec", ...issue.path],
    })),
  );
};

const invalidCaptureEvidence = (cause: unknown, side: "left" | "right") =>
  processInputFailure(
    "compare_process_captures",
    `Capture evidence is malformed (${describeValidationFailure(cause)}). Create new capture evidence, then try again.`,
    [side],
    "invalid_value",
  );

const readJson = async (
  path: string,
  operation: "capture_process_scenario" | "compare_process_captures",
  signal?: AbortSignal,
): Promise<unknown> => {
  if (signal?.aborted)
    throw new AnalysisCancelledError(operation, { cause: signal.reason });
  const loaded = await readJsonFile(path, signal);
  if (!loaded.ok && loaded.error instanceof AnalysisCancelledError)
    throw new AnalysisCancelledError(operation, { cause: loaded.error.cause });
  if (loaded.ok) {
    if (signal?.aborted)
      throw new AnalysisCancelledError(operation, { cause: signal.reason });
    return loaded.value;
  }
  if (loaded.error._tag !== "EvidenceFileError") throw loaded.error;
  if (loaded.error.reason === "io") throw loaded.error;
  const detail = describeValidationFailure(loaded.error.cause);
  throw processInputFailure(
    operation,
    loaded.error.reason === "invalid-json"
      ? `Process input file is not valid UTF-8 JSON: ${path} (${detail}). Repair the file, then try again.`
      : `Process input file could not be read: ${path} (${detail}). Check the reported filesystem constraint and retry.`,
    ["input_file"],
    "invalid_value",
  );
};

const processInputFailure = (
  operation: string,
  userMessage: string,
  path: readonly (string | number)[],
  reason: "invalid_value" | "missing_argument",
): AnalysisInputError =>
  new AnalysisInputError(operation, { userMessage }, [
    { path, reason, message: userMessage },
  ]);

const cliAnalysisError = (error: AnalysisError): ProcessCliErrorOutput => ({
  error: "Process command failed",
  ...projectAnalysisError(error),
});

/** Preserve typed failures and local diagnostics at the process CLI boundary. */
export const projectProcessCliError = (
  cause: unknown,
  operation: "capture_process_scenario" | "compare_process_captures",
): ProcessCliErrorOutput => {
  if (cause instanceof AnalysisError) return cliAnalysisError(cause);
  return cliAnalysisError(
    new ProviderAdapterError(PROCESS_PROVIDER.id, operation, {
      cause,
      diagnostics: { phase: "process_cli" },
      userMessage: `Process command could not complete: ${describeValidationFailure(cause)}`,
    }),
  );
};
