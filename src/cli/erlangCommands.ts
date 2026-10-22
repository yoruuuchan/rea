import { z } from "incur";
import { createBeamService } from "../composition/erlang.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import { finishAnalysisCommand } from "./finishAnalysisCommand.js";
import type { Logger } from "pino";
import type { CliInstance } from "./types.js";
import { withCommandCancellation } from "./commandCancellation.js";
import { absoluteCallerPath } from "../filesystem/callerPath.js";
import { inspectErlangBeamInputSchema } from "../domain/erlang/beam.js";
import { localPathStringSchema } from "../domain/localPath.js";

/** Resolve caller paths and inspect BEAM IFF tables through the shared workflow. */
export const registerErlangCommands = (
  cli: CliInstance,
  logger: Logger,
): void => {
  cli.command(CLI_COMMANDS.inspectErlangBeam, {
    description:
      "Inspect Erlang BEAM atoms, exports, imports and the Code header without executing bytecode",
    args: z.object({
      path: localPathStringSchema.describe("Local BEAM file"),
    }),
    options: z.object({
      maxFileBytes: inspectErlangBeamInputSchema.shape.max_file_bytes,
      maxChunks: inspectErlangBeamInputSchema.shape.max_chunks,
      maxAtoms: inspectErlangBeamInputSchema.shape.max_atoms,
    }),
    run: ({ args, options }) =>
      withCommandCancellation(async (signal) => {
        const service = createBeamService();
        return await logCliCommand(
          logger,
          CLI_COMMANDS.inspectErlangBeam,
          async () =>
            finishAnalysisCommand(
              () =>
                service.inspect(
                  {
                    path: absoluteCallerPath(args.path),
                    max_file_bytes: options.maxFileBytes,
                    max_chunks: options.maxChunks,
                    max_atoms: options.maxAtoms,
                  },
                  { signal },
                ),
              service,
              "rea-erlang-beam",
              "inspect_erlang_beam",
              signal,
            ),
        );
      }),
  });
};
