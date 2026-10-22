import { dispatchQueuedInterrupts } from "../process/queuedInterrupts.js";
import { absoluteCallerPath } from "../filesystem/callerPath.js";
import { requireAuthenticationHeadroom } from "./JsonAuthenticationHeadroom.js";

import {
  EvidenceFileError,
  type PublishedEvidenceFile,
} from "../domain/evidenceErrors.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
} from "../domain/analysisErrorCore.js";
import type { Evidence } from "../domain/evidence.js";
import {
  createImmutableEvidenceBundle,
  type EvidenceBundle,
} from "../domain/evidenceBundle.js";
import type { InspectAnalysisViewInput } from "../domain/analysisView/analysisView.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { jsonValueSchema } from "../domain/jsonValue.js";
import { err, ok, type Result } from "../domain/result.js";
import { compareBundles } from "../domain/bundleComparison.js";
import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import {
  readEvidenceBundle,
  readImmutableEvidenceBundle,
  writeEvidenceBundle,
} from "./EvidenceBundleFiles.js";
import { inspectAnalysisViewValidated } from "./analysisView/AnalysisViewService.js";

/** Validate a standalone bundle and report its complete record/revision counts. */
export const importEvidenceBundleCommand = async (
  path: string,
): Promise<Result<JsonValue, AnalysisError>> => {
  const loaded = await readEvidenceBundle(
    path,
    undefined,
    undefined,
    "import_evidence_bundle",
  );
  if (!loaded.ok) return loaded;
  return ok({
    imported: loaded.value.records.length,
    unknowns_added: loaded.value.unknowns.length,
    total: loaded.value.records.length,
  });
};

/** Validate a source bundle and atomically export canonical bytes. */
export const exportEvidenceBundleCommand = async (
  sourcePath: string,
  outputPath: string,
  overwrite: boolean,
): Promise<Result<JsonValue, AnalysisError>> => {
  // The sealed snapshot lets the writer reuse this authentication.
  const loaded = await readImmutableEvidenceBundle(
    sourcePath,
    undefined,
    undefined,
    "export_evidence_bundle",
  );
  if (!loaded.ok) return loaded;
  return projectWrite(
    loaded.value,
    await persistEvidenceBundleCommand(loaded.value, outputPath, overwrite),
  );
};

/** Publish complete parent Evidence before delivering it or its linked summary. */
export const deliverAnalysisEvidence = async (
  evidence: Evidence,
  outputPath: string,
  detail: "complete" | "summary" = "complete",
  signal?: AbortSignal,
): Promise<Result<Evidence, AnalysisError>> => {
  const headroom = requireAuthenticationHeadroom(evidence, {
    operation: evidence.operation,
    path: absoluteCallerPath(outputPath),
    description:
      "Insufficient heap headroom to authenticate the complete parent Evidence",
  });
  if (!headroom.ok)
    return err(headroom.error.retainPartialObservation(evidence));
  const bundle = createImmutableEvidenceBundle([evidence]);
  const delivered =
    detail === "summary"
      ? inspectAnalysisViewValidated(
          {
            source: {
              kind: "retained-evidence",
              evidence_id: evidence.evidence_id,
            },
            view: { kind: "summary" },
          },
          (id) => bundle.records.find((record) => record.evidence_id === id),
        )
      : ok(evidence);
  if (!delivered.ok) return delivered;
  const published = await publishEvidenceDelivery({
    bundle,
    complete: evidence,
    delivered: delivered.value,
    outputPath,
    operation: evidence.operation,
    signal,
  });
  return published.ok ? ok(published.value.delivered) : published;
};

/** Selected Evidence delivered after its complete bundle was committed. */
export interface PublishedEvidenceDelivery {
  readonly delivered: Evidence;
  readonly evidenceBundle: PublishedEvidenceFile;
}

/**
 * Publish a complete bundle, then deliver Evidence already projected from it.
 * Cancellation observed before commit leaves no output and retains the
 * complete Evidence. A committed publication wins a later cancellation race;
 * its receipt stays in the typed cancellation as diagnostics.evidence_bundle,
 * and a cleanup failure after commit keeps its own published receipt.
 */
export const publishEvidenceDelivery = async (input: {
  readonly bundle: EvidenceBundle;
  readonly complete: Evidence;
  readonly delivered: Evidence;
  readonly outputPath: string;
  readonly operation: string;
  readonly signal?: AbortSignal | undefined;
}): Promise<Result<PublishedEvidenceDelivery, AnalysisError>> => {
  const { signal, operation } = input;
  const written = await persistEvidenceBundleCommand(
    input.bundle,
    input.outputPath,
    false,
    signal,
    operation,
  );
  // Deliver interrupts queued during final publication cleanup before the
  // command's signal owner accepts completion and removes its listeners.
  await dispatchQueuedInterrupts();
  if (!written.ok)
    return err(written.error.retainPartialObservation(input.complete));
  if (signal?.aborted)
    return err(
      new AnalysisCancelledError(operation, {
        cause: signal.reason,
        partialObservation: input.delivered,
        diagnostics: { evidence_bundle: { ...written.value } },
      }),
    );
  return ok({ delivered: input.delivered, evidenceBundle: written.value });
};

/** Resolve the caller's exact retained parent from an authenticated portable bundle. */
export const inspectAnalysisViewFromBundle = async (
  input: InspectAnalysisViewInput,
  bundlePath: string,
  resources: ArtifactResourceScope,
  signal?: AbortSignal,
): Promise<Result<Evidence, AnalysisError>> => {
  if (input.source.kind !== "retained-evidence")
    return err(
      new AnalysisInputError("inspect_analysis_view", undefined, [
        {
          path: ["source", "kind"],
          reason: "invalid_value",
          message:
            "--evidence-bundle requires a retained-evidence source with the exact parent evidence_id; inline Evidence already supplies its source",
        },
      ]),
    );
  const loaded = await readImmutableEvidenceBundle(
    bundlePath,
    signal,
    resources,
    "inspect_analysis_view",
  );
  // Authentication and projection are synchronous; dispatch queued interrupts before accepting either result.
  await dispatchQueuedInterrupts();
  if (!loaded.ok) return loaded;
  if (signal?.aborted)
    return err(
      new AnalysisCancelledError("inspect_analysis_view", {
        cause: signal.reason,
      }),
    );
  const projected = inspectAnalysisViewValidated(input, (id) =>
    loaded.value.records.find((record) => record.evidence_id === id),
  );
  await dispatchQueuedInterrupts();
  if (projected.ok && signal?.aborted)
    return err(
      new AnalysisCancelledError("inspect_analysis_view", {
        cause: signal.reason,
        partialObservation: projected.value,
      }),
    );
  return projected;
};

/** Publish a completed bundle and retry its exact staged-output cleanup owner. */
const persistEvidenceBundleCommand = async (
  bundle: EvidenceBundle,
  outputPath: string,
  overwrite: boolean,
  signal?: AbortSignal,
  operation?: string,
): Promise<Result<PublishedEvidenceFile, AnalysisError>> => {
  const resources = new ArtifactResourceScope();
  const written = await writeEvidenceBundle(
    bundle,
    outputPath,
    overwrite,
    resources,
    signal,
    operation,
  );
  if (written.ok) return written;

  // Confirmed release resolves the bound error to its primary outcome; a
  // failed retry leaves that error incomplete with its exact retained owner.
  await resources.close().catch(() => undefined);
  if (
    !written.error.cleanupIncomplete &&
    written.error instanceof EvidenceFileError &&
    written.error.published
  ) {
    return ok(written.error.published);
  }
  return written;
};

/** Compare two validated canonical Evidence bundles without session state. */
export const compareEvidenceBundlesCommand = async (input: {
  readonly leftPath: string;
  readonly rightPath: string;
}): Promise<Result<JsonValue, AnalysisError>> => {
  // Sealed snapshots let comparison and its bundle digests reuse this
  // authentication instead of re-validating every record twice more.
  const [left, right] = await Promise.all([
    readImmutableEvidenceBundle(
      input.leftPath,
      undefined,
      undefined,
      "compare_bundles",
    ),
    readImmutableEvidenceBundle(
      input.rightPath,
      undefined,
      undefined,
      "compare_bundles",
    ),
  ]);
  if (!left.ok) return left;
  if (!right.ok) return right;
  return ok(jsonValueSchema.parse(compareBundles(left.value, right.value)));
};

const projectWrite = (
  bundle: EvidenceBundle,
  written: Result<PublishedEvidenceFile, AnalysisError>,
): Result<JsonValue, AnalysisError> =>
  written.ok
    ? ok({
        path: written.value.path,
        bytes: written.value.bytes,
        records: bundle.records.length,
      })
    : err(written.error);
