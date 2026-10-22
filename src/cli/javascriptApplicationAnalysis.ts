import type { AnalysisViewRequest } from "../domain/analysisView/analysisView.js";
import { publishCliAnalysisEvidence } from "./analysisEvidenceDelivery.js";
import { JAVASCRIPT_APPLICATION_PROVIDER } from "../application/InvestigationProviders.js";
import { createProgressReporter } from "../application/ProgressReporter.js";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";

/**
 * One scope for every JavaScript analysis in this process. A healthy worker
 * stays parked between commands; {@link closeCliJavaScriptResources} stops it.
 * Pending cleanup is still retried before each command returns.
 */
let retainedScope: ArtifactResourceScope | undefined;
/** One shutdown shared by the exit callback and the dispatch `finally`. */
let closing: Promise<void> | undefined;

const cliAnalysisScope = (): ArtifactResourceScope => {
  retainedScope ??= new ArtifactResourceScope();
  return retainedScope;
};

/**
 * Stop the process-owned JavaScript worker. Callers that overlap share the
 * attempt in flight. The scope stays owned when shutdown fails, so the next
 * call retries instead of treating the worker as already released.
 */
export const closeCliJavaScriptResources = (): Promise<void> => {
  if (closing !== undefined) return closing;
  const scope = retainedScope;
  if (scope === undefined) return Promise.resolve();
  let published: Promise<void>;
  published = scope
    .close()
    .then(() => {
      if (retainedScope === scope) retainedScope = undefined;
    })
    .finally(() => {
      if (closing === published) closing = undefined;
    });
  closing = published;
  return published;
};

/** Execute the shared CLI boundary for static JavaScript analysis. */
export const runCliJavaScriptApplicationAnalysis = async (
  input: unknown,
  environment: Readonly<Record<string, string | undefined>>,
  signal?: AbortSignal,
  delivery?: {
    readonly detail: "complete" | "summary";
    readonly evidenceOutput: string | undefined;
    readonly view?: AnalysisViewRequest;
  },
): Promise<JsonValue> => {
  const { analyzeJavaScriptApplication } =
    await import("../application/javascript/JavaScriptApplicationService.js");
  const progress = createProgressReporter(
    async (update) => {
      process.stderr.write(`${JSON.stringify({ rea_progress: update })}\n`);
    },
    { minimumIntervalMs: 0 },
  );
  const resources = cliAnalysisScope();
  const result = await analyzeJavaScriptApplication(input, resources, {
    environment,
    progress,
    ...(signal === undefined ? {} : { signal }),
  });
  try {
    // Retry failed owners without stopping a healthy parked worker.
    await resources.retryCleanup();
  } catch (cause: unknown) {
    const cleanup = ArtifactReaderFailure.cleanupObservation(
      cause,
      "JavaScript application resources",
    );
    const failure = new ProviderCleanupError(
      JAVASCRIPT_APPLICATION_PROVIDER.id,
      cleanup.resources,
      { reason: cleanup.reason },
      { cause, operation: "analyze_javascript_application" },
    );
    return cliError(
      result.ok
        ? failure
        : analysisErrorWithCleanupFailure(
            result.error,
            failure,
            "analyze_javascript_application",
          ),
    );
  }
  const value = result.ok ? result.value : cliError(result.error);
  return delivery === undefined
    ? value
    : publishCliAnalysisEvidence(value, {
        ...delivery,
        providerId: JAVASCRIPT_APPLICATION_PROVIDER.id,
        operation: "analyze_javascript_application",
        signal: signal ?? new AbortController().signal,
      });
};

const cliError = (
  error: Parameters<typeof projectAnalysisError>[0],
): JsonValue => ({
  error: "JavaScript application analysis failed",
  ...projectAnalysisError(error),
});
