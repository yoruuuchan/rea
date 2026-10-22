import { z } from "zod";

import { parseEvidence, type Evidence } from "./evidence.js";
import { EvidenceIntegrityError } from "./evidenceErrors.js";
import { describeValidationFailure } from "./validationFailure.js";
import { err, ok, type Result } from "./result.js";

/** Authenticate one source record, preserving unexpected implementation failures. */
export const readEvidence = (
  input: unknown,
): Result<Evidence, EvidenceIntegrityError> => {
  try {
    return ok(parseEvidence(input));
  } catch (cause: unknown) {
    if (!(cause instanceof z.ZodError)) throw cause;
    return err(integrityFailure(cause));
  }
};

/** Validate an authenticated source payload, separately from generated output. */
export const readEvidencePayload = <Output>(
  schema: z.ZodType<Output>,
  input: unknown,
): Result<Output, EvidenceIntegrityError> => {
  const parsed = schema.safeParse(input);
  return parsed.success ? ok(parsed.data) : err(integrityFailure(parsed.error));
};

const integrityFailure = (cause: z.ZodError): EvidenceIntegrityError => {
  const message = `Evidence validation failed ${describeValidationFailure(cause)}`;
  return new EvidenceIntegrityError(message, { cause, userMessage: message });
};
