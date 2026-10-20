import { AnalysisOutputError } from "../domain/analysisErrorCore.js";
import type { NativeCommandCapture } from "./CommandRunner.js";
import { withoutEchoedPathHeader } from "./parsers/echoedPath.js";

const MISSING_UUID_DIAGNOSTIC = "missing LC_UUID load command";

/** Recognize only dyld_info's target-specific missing-UUID refusal. */
export const isMissingUuidDyldFailure = (
  capture: NativeCommandCapture,
): boolean =>
  capture.tool === "dyld_info" &&
  capture.exitCode !== null &&
  capture.exitCode !== 0 &&
  capture.signal === null &&
  withoutEchoedPathHeader(capture.stdout, capture.arguments.at(-1))
    .split(/\r?\n/u)
    .some(
      (line) =>
        line.trim().replace(/^(?:dyld_info:\s*)/u, "") ===
        MISSING_UUID_DIAGNOSTIC,
    );

/** Keep the exact target diagnostic beside the incomplete collection. */
export const missingUuidLimitation = (mode: "imports" | "exports"): string =>
  mode === "imports"
    ? "dyld_info -imports reported 'missing LC_UUID load command'; import observations are unavailable."
    : "dyld_info -exports reported 'missing LC_UUID load command'; exports include nm symbol-table observations only.";

/** Preserve unrecognized nonzero command output as an inspection failure. */
export const unusableNativeCommandOutput = (
  capture: NativeCommandCapture,
): AnalysisOutputError =>
  new AnalysisOutputError(
    "inspect_macho",
    `${capture.tool} did not produce a usable inspection result`,
    {
      capturedOutput: {
        stdout: capture.stdout,
        stderr: capture.stderr,
        truncated: false,
        stdout_bytes: capture.stdoutBytes,
        stderr_bytes: capture.stderrBytes,
        exit_code: capture.exitCode,
        signal: capture.signal,
      },
    },
  );

/** Refuse a recognized error when the independently parsed load table contradicts it. */
export const conflictingUuidCommandEvidence = (
  command: NativeCommandCapture,
): AnalysisOutputError =>
  new AnalysisOutputError(
    "inspect_macho",
    "dyld_info reported a missing LC_UUID despite an observed LC_UUID load command",
    {
      capturedOutput: {
        stdout: command.stdout,
        stderr: command.stderr,
        truncated: false,
        stdout_bytes: command.stdoutBytes,
        stderr_bytes: command.stderrBytes,
        exit_code: command.exitCode,
        signal: command.signal,
      },
    },
  );
