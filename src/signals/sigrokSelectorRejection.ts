import type { AnalysisInputIssue } from "../domain/analysisErrorCore.js";
import type { DecodeSignalRecordingInput } from "../domain/signals/signalRecording.js";

export type SigrokSelectorRejection = AnalysisInputIssue & {
  readonly message: string;
};

const rejectedSelector = (
  field: "decoders" | "annotations",
  producerMessage: string,
): SigrokSelectorRejection => ({
  path: [field],
  reason: "invalid_value",
  message: `sigrok-cli rejected the ${field} selector: ${producerMessage} Use inspect_signal_decoders to list installed decoder IDs, or pass a decoder ID to show its options and annotation classes.`,
});

/**
 * Recognize only observed sigrok-cli 0.7.2 selector refusals whose rejected
 * name equals a caller-supplied selector; other failures stay unclassified.
 */
export const parseSigrokSelectorRejection = (
  stderr: string,
  input: Pick<DecodeSignalRecordingInput, "decoders" | "annotations">,
): SigrokSelectorRejection | undefined => {
  const lines = new Set(stderr.split("\n"));
  // sigrok-cli stacks decoders with "," and appends options with ":".
  for (const entry of input.decoders.split(",")) {
    const id = entry.split(":")[0] ?? "";
    const producerMessage = `Failed to load protocol decoder ${id}.`;
    // A missing module named exactly after the decoder separates an unknown ID
    // from an installed decoder whose own imports or code fail to load.
    if (
      id !== "" &&
      lines.has(producerMessage) &&
      lines.has(
        `srd: ModuleNotFoundError: Failed to load decoder ${id}: import by name failed: No module named '${id}'`,
      )
    )
      return rejectedSelector("decoders", producerMessage);
  }
  // Annotation selections are "decoder=class:class,decoder".
  for (const entry of input.annotations?.split(",") ?? []) {
    const [decoder = "", classes, ...rest] = entry.split("=");
    if (decoder === "" || classes === undefined || rest.length > 0) continue;
    for (const annotation of classes.split(":")) {
      const producerMessage = `Annotation '${annotation}' not found for protocol decoder '${decoder}'.`;
      if (annotation !== "" && lines.has(producerMessage))
        return rejectedSelector("annotations", producerMessage);
    }
  }
  return undefined;
};
