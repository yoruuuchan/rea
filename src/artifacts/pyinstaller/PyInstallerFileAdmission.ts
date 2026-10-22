import {
  NonRegularFileReadError,
  RegularFileAdmissionFailure,
  RegularFileChangedError,
  RegularFileOperationCancelled,
} from "../../filesystem/RegularFile.js";
import { ArtifactReaderFailure } from "../ArtifactReader.js";

/** Both carrier and private-image admission preserve cancellation and cleanup. */
export const pyInstallerFileAdmissionFailure = (
  path: string,
  cause: unknown,
): ArtifactReaderFailure => {
  if (cause instanceof ArtifactReaderFailure) return cause;
  if (cause instanceof RegularFileOperationCancelled)
    return new ArtifactReaderFailure(
      "cancelled",
      "PyInstaller file admission cancelled",
      { cause: cause.reason },
    );
  if (cause instanceof RegularFileAdmissionFailure)
    return ArtifactReaderFailure.withCleanup(
      pyInstallerFileAdmissionFailure(path, cause.cause),
      ArtifactReaderFailure.cleanupObservation(cause.cleanupCause, path),
    );
  if (cause instanceof RegularFileChangedError)
    return new ArtifactReaderFailure(
      "integrity",
      `PyInstaller source changed during admission: ${path}`,
      { cause },
    );
  if (cause instanceof NonRegularFileReadError)
    return new ArtifactReaderFailure(
      "format",
      `PyInstaller source is not a regular file: ${path}`,
      { cause },
    );
  return new ArtifactReaderFailure(
    "io",
    "PyInstaller archive could not be opened",
    { cause },
  );
};
