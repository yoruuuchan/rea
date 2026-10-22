import type { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisInputError,
  AnalysisCancelledError,
  AnalysisUnsupportedTargetError,
} from "../domain/analysisErrorCore.js";
import { ArtifactOperationError } from "../domain/artifactOperationError.js";
import {
  BinaryTargetError,
  ConfigurationError,
} from "../domain/configurationErrors.js";
import { ArtifactReaderFailure } from "./ArtifactReader.js";
import {
  artifactFileCancellationCause,
  bindArtifactFileCleanup,
} from "./ArtifactFileOperation.js";

/** Translate one artifact boundary failure while retaining cleanup evidence. */
export const translateArtifactFailure = (
  operation: ArtifactOperationError["operation"],
  cause: unknown,
): AnalysisError => {
  if (cause instanceof ArtifactReaderFailure) {
    const error = new ArtifactOperationError(
      operation,
      cause.reason,
      cause.details,
      cause.message,
      {
        cause:
          cause.reason === "cancelled"
            ? artifactFileCancellationCause(cause)
            : cause,
        ...(cause.cleanup === undefined ? {} : { cleanup: cause.cleanup }),
        ...(cause.partialObservation === undefined
          ? {}
          : { partialObservation: cause.partialObservation }),
        ...(cause.admission === undefined
          ? {}
          : { admission: cause.admission }),
      },
    );
    bindArtifactFileCleanup(cause, error);
    return error;
  }
  // Caller-selection, target, unsupported-target and configuration failures are already typed;
  // keep their correction details instead of reducing them to an I/O failure.
  if (
    cause instanceof AnalysisInputError ||
    cause instanceof AnalysisCancelledError ||
    cause instanceof AnalysisUnsupportedTargetError ||
    cause instanceof BinaryTargetError ||
    cause instanceof ConfigurationError
  )
    return cause;
  return new ArtifactOperationError(operation, "io");
};
