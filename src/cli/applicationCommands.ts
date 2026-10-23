import { reconstructionCoverageEvaluationInputSchema } from "../domain/reconstructionCoverageInput.js";
import { Cli, z } from "incur";

import { CLI_COMMANDS } from "../cliCommandNames.js";
import { parseCliJsonInput } from "../cliJsonInput.js";
import { logCliCommand } from "../cliLogging.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import type { JsonValue } from "../domain/jsonValue.js";
import type { Logger } from "pino";
import { traceApplicationFeatureInputSchema } from "../domain/javascript/javascriptFeatureTraceSchemas.js";
import { traceJavaScriptSemanticsInputSchema } from "../domain/javascript/javascriptSemanticTraceSchemas.js";
import { compareApplicationVersionsInputSchema } from "../domain/javascript/javascriptApplicationVersionComparisonSchemas.js";
import { registerSourceToBundleCommand } from "./sourceToBundleCommand.js";
import { compareJavaScriptExportShapesInputSchema } from "../domain/javascript/javascriptExportShapeComparisonSchemas.js";
import { analysisInputErrorFromIssues } from "../domain/inputIssueProjection.js";

type CliInstance = ReturnType<typeof Cli.create>;

/** Register CLI equivalents of provider-neutral application graph workflows. */
export const registerApplicationCommands = (
  cli: ReturnType<typeof Cli.create>,
  logger: Logger,
): void => {
  registerJsonCommand({
    cli,
    logger,
    name: CLI_COMMANDS.traceApplicationFeature,
    description:
      "Trace a typed seed through authenticated application Evidence JSON",
    inputSchema: traceApplicationFeatureInputSchema,
    workflow: async (input) => {
      const { traceApplicationFeatureEvidenceValidated } =
        await import("../application/javascript/JavaScriptApplicationWorkflowService.js");
      return traceApplicationFeatureEvidenceValidated(input);
    },
  });
  registerJsonCommand({
    cli,
    logger,
    name: CLI_COMMANDS.traceJavaScriptSemantics,
    description:
      "Trace bounded static semantic relations through authenticated application Evidence",
    inputSchema: traceJavaScriptSemanticsInputSchema,
    workflow: async (input) => {
      const { traceJavaScriptSemanticsEvidenceValidated } =
        await import("../application/javascript/JavaScriptSemanticTraceService.js");
      return traceJavaScriptSemanticsEvidenceValidated(input);
    },
  });
  registerJsonCommand({
    cli,
    logger,
    name: CLI_COMMANDS.compareApplicationVersions,
    description:
      "Compare two authenticated JavaScript Application Graph versions",
    inputSchema: compareApplicationVersionsInputSchema,
    workflow: async (input) => {
      const { compareApplicationVersionsEvidenceValidated } =
        await import("../application/javascript/JavaScriptApplicationWorkflowService.js");
      return compareApplicationVersionsEvidenceValidated(input);
    },
  });
  registerSourceToBundleCommand(cli, logger);
  registerJsonCommand({
    cli,
    logger,
    name: CLI_COMMANDS.compareJavaScriptExportShapes,
    description:
      "Compare exact static JavaScript export return shapes without execution",
    inputSchema: compareJavaScriptExportShapesInputSchema,
    workflow: async (input) => {
      const { compareJavaScriptExportShapesEvidenceValidated } =
        await import("../application/javascript/JavaScriptApplicationWorkflowService.js");
      return compareJavaScriptExportShapesEvidenceValidated(input);
    },
  });
  registerObligationLedgerCommand(cli, logger);
  registerCoverageCommand(cli, logger);
  registerJsonCommand({
    cli,
    logger,
    name: CLI_COMMANDS.projectAndroidApplicationGraph,
    description:
      "Project authenticated APK inventory Evidence into an Android application graph",
    inputSchema: z.unknown(),
    workflow: async (input) => {
      const { projectAndroidApplicationEvidence } =
        await import("../application/android/AndroidApplicationService.js");
      const result = projectAndroidApplicationEvidence(input);
      return result.ok ? { ok: true, value: result.value.evidence } : result;
    },
  });
  registerJsonCommand({
    cli,
    logger,
    name: CLI_COMMANDS.projectAppleApplicationGraph,
    description:
      "Project authenticated IPA or macOS app inventory Evidence into an Apple application graph",
    inputSchema: z.unknown(),
    workflow: async (input) => {
      const { projectAppleApplicationEvidence } =
        await import("../application/apple/AppleApplicationService.js");
      const result = projectAppleApplicationEvidence(input);
      return result.ok ? { ok: true, value: result.value.evidence } : result;
    },
  });
  registerJsonCommand({
    cli,
    logger,
    name: CLI_COMMANDS.projectHarmonyApplicationGraph,
    description:
      "Project authenticated HarmonyOS HAP, HSP, or App Pack inventory Evidence into an application graph",
    inputSchema: z.unknown(),
    workflow: async (input) => {
      const { projectHarmonyApplicationEvidence } =
        await import("../application/harmony/HarmonyApplicationService.js");
      const result = projectHarmonyApplicationEvidence(input);
      return result.ok ? { ok: true, value: result.value.evidence } : result;
    },
  });
};

const registerObligationLedgerCommand = (
  cli: CliInstance,
  logger: Logger,
): void =>
  registerJsonCommand({
    cli,
    logger,
    name: CLI_COMMANDS.buildReconstructionObligationLedger,
    description:
      "Generate a deterministic Evidence-backed reconstruction obligation ledger page",
    inputSchema: z.unknown(),
    workflow: async (input) => {
      const { buildReconstructionObligationLedgerEvidence } =
        await import("../application/ReconstructionObligationLedgerService.js");
      return buildReconstructionObligationLedgerEvidence(input);
    },
  });

const registerCoverageCommand = (cli: CliInstance, logger: Logger): void =>
  registerJsonCommand({
    cli,
    logger,
    name: CLI_COMMANDS.evaluateReconstructionCoverage,
    description: "Evaluate inline fail-closed reconstruction coverage",
    inputSchema: reconstructionCoverageEvaluationInputSchema,
    workflow: async (input) => {
      const { evaluateReconstructionCoverage } =
        await import("../application/ReconstructionCoverageService.js");
      return evaluateReconstructionCoverage(input);
    },
  });

interface JsonCommandOptions<Schema extends z.ZodType> {
  readonly cli: CliInstance;
  readonly logger: Logger;
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Schema;
  readonly workflow: (
    input: z.output<Schema>,
  ) => Promise<
    | { readonly ok: true; readonly value: JsonValue }
    | { readonly ok: false; readonly error: AnalysisError }
  >;
}

const registerJsonCommand = <Schema extends z.ZodType>({
  cli,
  logger,
  name,
  description,
  inputSchema,
  workflow,
}: JsonCommandOptions<Schema>): void => {
  cli.command(name, {
    description,
    args: z.object({
      inputJson: z.string().describe("Inline workflow JSON or JSON file path"),
    }),
    run: ({ args }) =>
      logCliCommand(logger, name, async () => {
        const input = await parseCliJsonInput(args.inputJson, name);
        if (!input.ok) return input.error;
        const parsed = inputSchema.safeParse(input.value);
        if (!parsed.success)
          return {
            error: "Application workflow failed",
            ...projectAnalysisError(
              analysisInputErrorFromIssues(
                name,
                parsed.error.issues,
                input.value,
              ),
            ),
          };
        const result = await workflow(parsed.data);
        return result.ok
          ? result.value
          : {
              error: "Application workflow failed",
              ...projectAnalysisError(result.error),
            };
      }),
  });
};
