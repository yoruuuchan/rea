import type { Evidence } from "../domain/evidence.js";
import type { AnalysisErrorProjection } from "../domain/analysisErrorProjection.js";
import { z } from "incur";
import type { Logger } from "pino";
import type { CliInstance } from "./types.js";
import { createDesktopApplicationService } from "../composition/desktop.js";
import { absoluteCallerPath } from "../filesystem/callerPath.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import { withCommandCancellation } from "./commandCancellation.js";
import { finishAnalysisCommand } from "./finishAnalysisCommand.js";
import { inspectAnalysisView } from "../application/analysisView/AnalysisViewService.js";
import { writeEvidenceBundle } from "../application/EvidenceBundleFiles.js";
import { createEvidenceBundle } from "../domain/evidenceBundle.js";
import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { AnalysisInputError } from "../domain/analysisErrorCore.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";

const isEvidenceResult = (
  value: Evidence | AnalysisErrorProjection,
): value is Evidence => "evidence_id" in value && "normalized_result" in value;

/** One-shot complete Evidence can be saved and queried with inspect-analysis-view. */
export const registerDesktopApplicationCommands = (
  cli: CliInstance,
  logger: Logger,
): void => {
  cli.command(CLI_COMMANDS.inspectDesktopApplication, {
    description:
      "Identify desktop runtime candidates from bounded directory and header observations",
    args: z.object({
      path: z.string().describe("Local installation directory"),
    }),
    options: z.object({
      max_entries: z
        .number()
        .int()
        .positive()
        .max(100_000)
        .default(20_000)
        .describe(
          "Maximum directory entries to examine; exhaustion leaves partial coverage",
        ),
      detail: z
        .enum(["complete", "summary"])
        .default("complete")
        .describe(
          "Deliver complete Evidence, or a summary with --evidence_output",
        ),
      evidence_output: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Save complete Evidence as a bundle; required for summary delivery. Never overwrites.",
        ),
      max_probe_bytes: z
        .number()
        .int()
        .min(4096)
        .max(64 * 1024 * 1024)
        .default(8 * 1024 * 1024)
        .describe("Maximum total bytes read from selected file ranges"),
    }),
    run: ({ args, options }) =>
      withCommandCancellation((signal) =>
        logCliCommand(
          logger,
          CLI_COMMANDS.inspectDesktopApplication,
          async () => {
            const { detail, evidence_output, ...limits } = options;
            if (detail === "summary" && evidence_output === undefined)
              return projectAnalysisError(
                new AnalysisInputError(
                  "inspect_desktop_application",
                  undefined,
                  [
                    {
                      path: ["evidence_output"],
                      reason: "invalid_value",
                      message:
                        "Summary delivery requires --evidence_output so complete source Evidence remains available.",
                    },
                  ],
                ),
              );
            const service = createDesktopApplicationService();
            const complete = await finishAnalysisCommand(
              () =>
                service.inspect(
                  { path: absoluteCallerPath(args.path), ...limits },
                  { signal },
                ),
              service,
              "rea-artifact-graph",
              "inspect_desktop_application",
              signal,
            );
            if (!isEvidenceResult(complete) || evidence_output === undefined)
              return complete;
            const resources = new ArtifactResourceScope();
            let receipt:
              | { readonly path: string; readonly bytes: number }
              | undefined;
            const delivered = await finishAnalysisCommand(
              async () => {
                const written = await writeEvidenceBundle(
                  createEvidenceBundle([complete]),
                  absoluteCallerPath(evidence_output),
                  false,
                  resources,
                  signal,
                );
                if (!written.ok) return written;
                receipt = written.value;
                return detail === "summary"
                  ? inspectAnalysisView({
                      source: { kind: "inline", evidence: complete },
                      view: { kind: "summary" },
                    })
                  : { ok: true as const, value: complete };
              },
              { close: () => resources.close() },
              "rea-artifact-graph",
              "inspect_desktop_application",
              signal,
            );
            return isEvidenceResult(delivered) && detail === "summary"
              ? { summary: delivered, evidence_bundle: receipt }
              : delivered;
          },
        ),
      ),
  });
};
