import { bindArtifactFileCleanup } from "../artifacts/ArtifactFileOperation.js";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import { readStableArtifact } from "../artifacts/readStableArtifact.js";
import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
import type { PythonPycPort } from "../application/python/PythonPycPort.js";
import type { ExecutionOptions } from "../application/AnalysisProvider.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisAccessDeniedError,
  AnalysisArtifactChangedError,
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisResourceConstraintError,
  AnalysisUnsupportedTargetError,
} from "../domain/analysisErrorCore.js";
import type { InspectPythonPycInput } from "../domain/python/pythonPyc.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { err, ok } from "../domain/result.js";
import {
  PythonPycFormatFailure,
  PythonPycResourceFailure,
} from "./PythonPyc.errors.js";
import { parsePythonPyc } from "./PythonPycParser.js";

/** Bundled reader identity. Header python_version is a separate observed mapping. */
export const PYTHON_PYC_PROVIDER_IDENTITY = {
  id: "rea-python-pyc",
  name: "REA CPython pyc parser",
  version: "1",
} as const;

const OPERATION = "inspect_python_pyc";

const failureForPrimary = (
  cause: unknown,
  input: InspectPythonPycInput,
  signal: AbortSignal | undefined,
) => {
  if (cause instanceof AnalysisError) return cause;
  if (cause instanceof ArtifactReaderFailure && cause.reason === "integrity")
    return new AnalysisArtifactChangedError(
      OPERATION,
      input.path,
      cause.message,
      { cause },
    );
  if (cause instanceof ArtifactReaderFailure && cause.reason === "cancelled")
    return new AnalysisCancelledError(OPERATION, { cause });
  if (signal?.aborted) return new AnalysisCancelledError(OPERATION, { cause });
  if (cause instanceof PythonPycResourceFailure)
    return new AnalysisResourceConstraintError(
      OPERATION,
      cause.boundary === "depth" ? "capacity" : "memory",
      cause.message,
      cause.reported_limits,
      { cause },
    );
  if (cause instanceof PythonPycFormatFailure)
    return cause.kind === "unsupported"
      ? new AnalysisUnsupportedTargetError(
          OPERATION,
          input.path,
          cause.message,
          { cause },
        )
      : new AnalysisInputError(OPERATION, { cause }, [
          {
            path: ["path"],
            reason: "invalid_format",
            message: `Selected pyc ${input.path}: ${cause.message}`,
          },
        ]);
  if (cause instanceof ArtifactReaderFailure) {
    if (cause.reason === "limit")
      return new AnalysisResourceConstraintError(
        OPERATION,
        "file-size",
        cause.message,
        { max_file_bytes: input.max_file_bytes },
        { cause },
      );
    if (cause.reason === "path" || cause.reason === "format")
      return new AnalysisInputError(OPERATION, { cause }, [
        {
          path: ["path"],
          reason: "invalid_format",
          message: cause.message,
        },
      ]);
  }
  if (cause instanceof Error && "code" in cause) {
    if (cause.code === "EACCES" || cause.code === "EPERM")
      return new AnalysisAccessDeniedError(OPERATION, input.path, cause.code, {
        cause,
      });
    if (
      ["ENOENT", "ENOTDIR", "ELOOP", "ENAMETOOLONG"].includes(
        String(cause.code),
      )
    )
      return new AnalysisInputError(OPERATION, { cause }, [
        {
          path: ["path"],
          reason: "invalid_value",
          message: `Selected pyc could not be read (${String(cause.code)}): ${input.path}.`,
        },
      ]);
  }
  return new ProviderAdapterError(PYTHON_PYC_PROVIDER_IDENTITY.id, OPERATION, {
    cause,
    diagnostics: {
      path: input.path,
      reason: cause instanceof Error ? cause.message : String(cause),
    },
  });
};

const failureFor = (
  cause: unknown,
  input: InspectPythonPycInput,
  signal: AbortSignal | undefined,
) => {
  const primary = failureForPrimary(cause, input, signal);
  if (!(cause instanceof ArtifactReaderFailure) || cause.cleanup === undefined)
    return primary;
  const cleanup = new ProviderCleanupError(
    PYTHON_PYC_PROVIDER_IDENTITY.id,
    cause.cleanup.resources,
    { reason: cause.cleanup.reason },
    { operation: OPERATION, cause },
  );
  const error = analysisErrorWithCleanupFailure(primary, cleanup, OPERATION);
  bindArtifactFileCleanup(cause, error);
  return error;
};

/** Portable parser over one bounded, identity-checked regular file. */
export class PythonPycProvider implements PythonPycPort {
  readonly identity = PYTHON_PYC_PROVIDER_IDENTITY;
  readonly #resources = new ArtifactResourceScope();

  close(): Promise<void> {
    return this.#resources.close();
  }

  async inspect(input: InspectPythonPycInput, options?: ExecutionOptions) {
    try {
      const snapshot = await this.#resources.run(() =>
        readStableArtifact(
          input.path,
          input.max_file_bytes,
          options?.signal,
          undefined,
          this.#resources,
        ),
      );
      return ok(
        parsePythonPyc(
          snapshot.bytes,
          {
            path: input.path,
            sha256: snapshot.sha256,
            bytes: snapshot.bytes.length,
          },
          input,
        ),
      );
    } catch (cause) {
      return err(failureFor(cause, input, options?.signal));
    }
  }
}
