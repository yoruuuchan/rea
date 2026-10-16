import { lstat, open } from "node:fs/promises";
import type { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import {
  assertArtifactReadActive,
  artifactFileCancellationCause,
  artifactFilePrimaryFailure,
  bindArtifactFileCleanup,
  withArtifactFileHandle,
  withArtifactRegularFile,
} from "../artifacts/ArtifactFileOperation.js";
import { sameRegularFileState } from "../filesystem/RegularFile.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
import type { JsonValue } from "../domain/jsonValue.js";

/** Bounded serial read; the caller owns admission and final descriptor cleanup. */
export const readGhidraProfileArtifact = <Value>(
  path: string,
  maximumBytes: number,
  resources: ArtifactResourceScope,
  signal: AbortSignal | undefined,
  interpret: (bytes: Buffer) => Value,
): Promise<Value> =>
  withArtifactRegularFile(path, resources, signal, async (file) => {
    const before = await file.stat({ bigint: true });
    if (before.size > BigInt(maximumBytes))
      throw new Error(
        `Ghidra profile artifact must be at most ${String(maximumBytes)} bytes: ${path}`,
      );
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      assertArtifactReadActive(signal);
      const read = await file.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (read.bytesRead === 0)
        throw new Error(`Incomplete Ghidra profile artifact read: ${path}`);
      offset += read.bytesRead;
    }
    assertArtifactReadActive(signal);
    const extra = Buffer.alloc(1);
    if (
      (await file.read(extra, 0, 1, offset)).bytesRead !== 0 ||
      !sameRegularFileState(before, await file.stat({ bigint: true })) ||
      !sameRegularFileState(before, await lstat(path, { bigint: true }))
    )
      throw new Error(`Ghidra profile artifact changed during read: ${path}`);
    assertArtifactReadActive(signal);
    return interpret(bytes);
  });

/** Own the new private snapshot descriptor through write and final close. */
export const writeGhidraProfileArtifact = async (
  path: string,
  bytes: Buffer | string,
  resources: ArtifactResourceScope,
  signal?: AbortSignal,
): Promise<void> => {
  assertArtifactReadActive(signal);
  const file = await open(path, "wx", 0o600);
  await withArtifactFileHandle(path, file, resources, signal, (handle) =>
    handle.writeFile(bytes),
  );
};

/** Preserve physical failure, exact cancellation, and all retained file leases. */
export const ghidraProfileArtifactError = (
  cause: unknown,
  operation: string,
  diagnostics: Readonly<Record<string, JsonValue>> = {},
): AnalysisError => {
  if (cause instanceof AnalysisError) return cause;
  const primary = artifactFilePrimaryFailure(cause);
  const reason = primary instanceof Error ? primary.message : String(primary);
  const cleanup =
    cause instanceof ArtifactReaderFailure ? cause.cleanup : undefined;
  if (primary instanceof AnalysisError) {
    if (cleanup === undefined) return primary;
    const failure = new ProviderCleanupError(
      "ghidra",
      cleanup.resources,
      {
        reason: cleanup.reason,
      },
      { cause },
    );
    bindArtifactFileCleanup(cause, failure);
    return analysisErrorWithCleanupFailure(
      primary,
      failure,
      operation,
    ).bindCleanupDependencies([
      ...(primary.cleanupIncomplete ? [primary] : []),
      failure,
    ]);
  }
  const error =
    cause instanceof ArtifactReaderFailure && cause.reason === "cancelled"
      ? new AnalysisCancelledError(operation, {
          cause: artifactFileCancellationCause(cause),
          cleanup,
          diagnostics,
        })
      : new ProviderAdapterError("ghidra", operation, {
          cause,
          cleanup,
          diagnostics: { ...diagnostics, reason },
          userMessage: reason,
        });
  bindArtifactFileCleanup(cause, error);
  return error;
};
