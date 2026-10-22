import { z } from "incur";
import { absoluteCallerPath } from "../filesystem/callerPath.js";
import { createPythonPycService } from "../composition/pythonPyc.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import type { Logger } from "pino";
import type { CliInstance } from "./types.js";
import { withCommandCancellation } from "./commandCancellation.js";
import { inspectPythonPycInputSchema } from "../domain/python/pythonPyc.js";
import { finishAnalysisCommand } from "./finishAnalysisCommand.js";

/** Inspect operator-selected pyc files through the same shared workflow as MCP. */
export const registerPythonPycCommands = (
  cli: CliInstance,
  logger: Logger,
): void => {
  cli.command(CLI_COMMANDS.inspectPythonPyc, {
    description:
      "Inspect a CPython 3.7–3.13 pyc header and marshal code objects without executing bytecode",
    args: z.object({
      path: z.string().describe("Local CPython .pyc file"),
    }),
    options: z.object({
      maxFileBytes: inspectPythonPycInputSchema.shape.max_file_bytes,
      maxObjects: inspectPythonPycInputSchema.shape.max_objects,
      maxDepth: inspectPythonPycInputSchema.shape.max_depth,
      maxStringBytes: inspectPythonPycInputSchema.shape.max_string_bytes,
    }),
    run: ({ args, options }) =>
      withCommandCancellation(async (signal) => {
        const service = createPythonPycService();
        return await logCliCommand(
          logger,
          CLI_COMMANDS.inspectPythonPyc,
          async () =>
            finishAnalysisCommand(
              () =>
                service.inspect(
                  {
                    path: absoluteCallerPath(args.path),
                    max_file_bytes: options.maxFileBytes,
                    max_objects: options.maxObjects,
                    max_depth: options.maxDepth,
                    max_string_bytes: options.maxStringBytes,
                  },
                  { signal },
                ),
              service,
              "rea-python-pyc",
              "inspect_python_pyc",
              signal,
            ),
        );
      }),
  });
};
