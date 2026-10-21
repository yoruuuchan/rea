import {
  processCaptureSchema,
  type UnverifiedProcessCapture,
} from "./processCapture.js";

declare class ProcessCaptureProof {
  private readonly verified: never;
}

/** Semantically verified process capture value. */
export type ProcessCapture = UnverifiedProcessCapture & ProcessCaptureProof;

const verifiedCaptures = new WeakSet<UnverifiedProcessCapture>();

const isVerifiedCapture = (
  capture: UnverifiedProcessCapture,
): capture is ProcessCapture => verifiedCaptures.has(capture);

const attachProof = (capture: UnverifiedProcessCapture): ProcessCapture => {
  verifiedCaptures.add(capture);
  if (isVerifiedCapture(capture)) return capture;
  throw new TypeError("Process Capture proof ownership failed");
};

/**
 * Parse unknown input and reject invalid commitments or semantics. Failures
 * throw the schema's ZodError so structural and semantic issues stay together.
 */
export const parseProcessCapture = (input: unknown): ProcessCapture =>
  attachProof(processCaptureSchema.parse(input));
