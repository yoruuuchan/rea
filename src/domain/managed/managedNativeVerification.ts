import { digestCanonicalValue } from "../canonicalDigest.js";
import {
  managedNativeVerificationResultSchema,
  type ManagedNativeVerificationInput,
  type ManagedNativeVerificationResult,
} from "./managedNativeVerificationSchemas.js";
import {
  buildVerificationResult,
  collectNativeSymbols,
  verifyPinvoke,
} from "./managedNativeVerificationMatch.js";
import {
  readManagedNativeVerificationSource,
  type ManagedNativeVerificationSource,
} from "./managedNativeVerificationSource.js";

/** Pure verification over authenticated, parsed source facts. */
export const verifyManagedNativeVerificationSource = (
  source: ManagedNativeVerificationSource,
): ManagedNativeVerificationResult => {
  const { managedEvidence, managed, nativeObservations } = source;
  const native = collectNativeSymbols(nativeObservations);
  const pinvokeImports = managed.pinvoke_imports
    .map((item) =>
      verifyPinvoke({
        item,
        managedEvidenceId: managedEvidence.evidence_id,
        native,
      }),
    )
    .map(({ verification }) => verification);
  const withoutId = buildVerificationResult({
    managedEvidence,
    managed,
    native,
    pinvokeImports,
    nativeObservationCount: nativeObservations.length,
    nativeEvidenceIds: nativeObservations.map(
      ({ evidence }) => evidence.evidence_id,
    ),
  });
  return managedNativeVerificationResultSchema.parse({
    ...withoutId,
    verification_id: `mnv_${digestCanonicalValue(
      withoutId,
      "Managed/native verification",
    )}`,
  });
};

/** Raw domain API retained for CLI and existing callers. */
export const verifyManagedNativeBoundaries = (
  input: ManagedNativeVerificationInput,
): ManagedNativeVerificationResult => {
  const source = readManagedNativeVerificationSource(input);
  if (!source.ok) throw source.error;
  return verifyManagedNativeVerificationSource(source.value);
};
