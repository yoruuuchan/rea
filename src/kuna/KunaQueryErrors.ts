import type {
  AnalysisError,
  AnalysisErrorOptions,
} from "../domain/analysisErrorBase.js";
import {
  AnalysisArtifactChangedError,
  AnalysisCancelledError,
  AnalysisOutputError,
  AnalysisResourceConstraintError,
  AnalysisTimeoutError,
} from "../domain/analysisErrorCore.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";

/** Keep one producer failure immutable while each waiter receives its context. */
export const kunaQueryFailureForCaller = (
  source: AnalysisError,
  operation: string,
): AnalysisError => {
  if (
    !("operation" in source) ||
    typeof source.operation !== "string" ||
    source.operation === operation
  )
    return source;
  const diagnostics = {
    ...source.diagnostics,
    producer_operation: source.operation,
  };
  const options: AnalysisErrorOptions & {
    userMessage?: string;
    remediationAction?: string;
  } = {
    cause: source,
    diagnostics,
    ...(source.capturedOutput === undefined
      ? {}
      : { capturedOutput: source.capturedOutput }),
    ...(source.cleanup === undefined ? {} : { cleanup: source.cleanup }),
    ...(source.partialObservation === undefined
      ? {}
      : { partialObservation: source.partialObservation }),
    ...(source.userMessage === undefined
      ? {}
      : { userMessage: source.userMessage }),
    ...("remediationAction" in source &&
    typeof source.remediationAction === "string"
      ? { remediationAction: source.remediationAction }
      : {}),
  };
  // The command owner keeps the original cleanup failure and its supervisor.
  // This contextual diagnostic retains that source as its cause and every resource.
  if (source instanceof ProviderCleanupError)
    return new ProviderCleanupError(
      source.providerId,
      source.cleanupResources,
      diagnostics,
      {
        operation,
        cause: source,
        ...(source.partialObservation === undefined
          ? {}
          : { partialObservation: source.partialObservation }),
      },
    );
  if (source instanceof AnalysisTimeoutError)
    return new AnalysisTimeoutError(operation, source.timeoutMs, options);
  if (source instanceof AnalysisResourceConstraintError)
    return new AnalysisResourceConstraintError(
      operation,
      source.resource,
      source.reason,
      source.reportedLimits,
      options,
    );
  if (source instanceof AnalysisOutputError)
    return new AnalysisOutputError(operation, source.reason, {
      ...options,
      cleanupOnly: source.cleanupOnly,
    });
  if (source instanceof ProviderAdapterError)
    return new ProviderAdapterError(source.providerId, operation, options);
  if (source instanceof AnalysisCancelledError)
    return new AnalysisCancelledError(operation, options);
  if (source instanceof AnalysisArtifactChangedError)
    return new AnalysisArtifactChangedError(
      operation,
      source.path,
      source.reason,
      options,
    );
  // Preserve unfamiliar error variants rather than flattening their semantics.
  return source;
};
