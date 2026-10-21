import type { AnalysisInputIssue } from "../domain/analysisErrorCore.js";
import type { InspectSignalDecodersInput } from "../domain/signals/signalDecoders.js";
import type { DecodeSignalRecordingInput } from "../domain/signals/signalRecording.js";

export type SigrokSelectorRejection = AnalysisInputIssue & {
  readonly message: string;
};

/** Caller selectors that a sigrok command loads, keyed by their input field. */
export type SigrokSelection =
  | Pick<DecodeSignalRecordingInput, "decoders" | "annotations">
  | Pick<InspectSignalDecodersInput, "decoder">;

const rejectedSelector = (
  field: "decoder" | "decoders" | "annotations",
  producerMessage: string,
  recovery: string,
): SigrokSelectorRejection => ({
  path: [field],
  reason: "invalid_value",
  message: `sigrok-cli rejected the ${field} selector: ${producerMessage} ${recovery}`,
});

const DECODE_RECOVERY =
  "Use inspect_signal_decoders to list installed decoder IDs, or pass a decoder ID to show its options and annotation classes.";
const HELP_RECOVERY =
  "Omit decoder to list installed decoder IDs, optionally filtered by query, then request help for one of those IDs.";

/**
 * sigrok-cli loads selected decoders before decoding or showing help, so an
 * unknown ID yields the same refusal for both commands. A missing module named
 * exactly after the decoder separates an unknown ID from an installed decoder
 * whose own imports or code fail to load.
 */
const unknownDecoderRefusal = (
  lines: ReadonlySet<string>,
  id: string,
): string | undefined => {
  const producerMessage = `Failed to load protocol decoder ${id}.`;
  return id !== "" &&
    lines.has(producerMessage) &&
    lines.has(
      `srd: ModuleNotFoundError: Failed to load decoder ${id}: import by name failed: No module named '${id}'`,
    )
    ? producerMessage
    : undefined;
};

/**
 * Recognize only observed sigrok-cli 0.7.2 selector refusals whose rejected
 * name equals a caller-supplied selector; other failures stay unclassified.
 */
export const parseSigrokSelectorRejection = (
  stderr: string,
  selection: SigrokSelection,
): SigrokSelectorRejection | undefined => {
  const lines = new Set(stderr.split("\n"));
  if ("decoder" in selection) {
    const refusal =
      selection.decoder === null
        ? undefined
        : unknownDecoderRefusal(lines, selection.decoder);
    return refusal === undefined
      ? undefined
      : rejectedSelector("decoder", refusal, HELP_RECOVERY);
  }
  // sigrok-cli stacks decoders with "," and appends options with ":".
  for (const entry of selection.decoders.split(",")) {
    const refusal = unknownDecoderRefusal(lines, entry.split(":")[0] ?? "");
    if (refusal !== undefined)
      return rejectedSelector("decoders", refusal, DECODE_RECOVERY);
  }
  // Annotation selections are "decoder=class:class,decoder".
  for (const entry of selection.annotations?.split(",") ?? []) {
    const [decoder = "", classes, ...rest] = entry.split("=");
    if (decoder === "" || classes === undefined || rest.length > 0) continue;
    for (const annotation of classes.split(":")) {
      const producerMessage = `Annotation '${annotation}' not found for protocol decoder '${decoder}'.`;
      if (annotation !== "" && lines.has(producerMessage))
        return rejectedSelector(
          "annotations",
          producerMessage,
          DECODE_RECOVERY,
        );
    }
  }
  return undefined;
};
