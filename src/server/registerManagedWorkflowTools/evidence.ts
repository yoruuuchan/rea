import type { Evidence } from "../../domain/evidence.js";
import { parseEvidence } from "../../domain/evidence.js";
import { EvidenceIntegrityError } from "../../domain/evidenceErrors.js";
import type { Result } from "../../domain/result.js";
import { err, ok } from "../../domain/result.js";

/** Authenticate one caller-supplied record and preserve Evidence errors. */
const parseEvidenceRecord = (
  rawEvidence: Evidence,
): Result<Evidence, EvidenceIntegrityError> => {
  try {
    return ok(parseEvidence(rawEvidence));
  } catch (cause: unknown) {
    return err(
      new EvidenceIntegrityError(
        cause instanceof Error ? cause.message : "Invalid Evidence",
      ),
    );
  }
};

const parseEvidenceRecords = (
  rawEvidence: readonly Evidence[],
): Result<Evidence[], EvidenceIntegrityError> => {
  const evidence: Evidence[] = [];
  for (const rawRecord of rawEvidence) {
    const record = parseEvidenceRecord(rawRecord);
    if (!record.ok) return err(record.error);
    evidence.push(record.value);
  }
  return ok(evidence);
};

const resolveExpectedEvidence = (
  rawEvidence: Evidence,
  expectedOperation: string,
): Result<Evidence, EvidenceIntegrityError> => {
  const evidence = parseEvidenceRecord(rawEvidence);
  if (!evidence.ok) return evidence;
  if (
    evidence.value.operation !== expectedOperation ||
    evidence.value.predicate_type !== "rea.analysis"
  )
    return err(
      new EvidenceIntegrityError(
        `Expected ${expectedOperation} Evidence, received ${evidence.value.operation}`,
      ),
    );
  return evidence;
};

export const resolveManagedEvidence = (
  evidence: Evidence,
): Result<Evidence, EvidenceIntegrityError> =>
  resolveExpectedEvidence(evidence, "inspect_managed_members");

export const resolveManagedArtifactEvidence = (
  evidence: Evidence,
): Result<Evidence, EvidenceIntegrityError> =>
  resolveExpectedEvidence(evidence, "inspect_managed_artifact");

export const resolveManagedBoundaryEvidence = (
  evidence: Evidence,
): Result<Evidence, EvidenceIntegrityError> =>
  resolveExpectedEvidence(evidence, "inspect_managed_native_boundaries");

/**
 * Authenticate native observations without an operation allowlist: the domain
 * counts authentic operations it cannot read symbols from as unsupported.
 */
export const resolveNativeEvidence = (
  evidence: readonly Evidence[],
): Result<Evidence[], EvidenceIntegrityError> => parseEvidenceRecords(evidence);

export const sourceEvidence = (input: {
  readonly managed_artifact?: Evidence | undefined;
  readonly managed_members?: Evidence | undefined;
  readonly managed_native_boundaries?: Evidence | undefined;
}): Evidence[] =>
  [
    input.managed_artifact,
    input.managed_members,
    input.managed_native_boundaries,
  ].filter((evidence): evidence is Evidence => evidence !== undefined);
