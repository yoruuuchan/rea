import pino, { type Logger } from "pino";
import { z } from "zod";

import { ConfigurationError } from "./domain/configurationErrors.js";
import { err, ok, type Result } from "./domain/result.js";

/**
 * Settings the executable rejects before a command starts. MCP startup rejects
 * the same values. Doctor requires them in every readiness scope.
 */
export const PROCESS_START_CONFIGURATION_SETTINGS = ["REA_LOG_LEVEL"] as const;

/** True when `setting` prevents the REA process from starting. */
export const blocksProcessStart = (setting: string): boolean =>
  PROCESS_START_CONFIGURATION_SETTINGS.some(
    (candidate) => candidate === setting,
  );

/** Supported structured log levels at the process boundary. */
export type LogLevel = z.infer<typeof logLevelSchema>;

const logLevelSchema = z
  .enum(["trace", "debug", "info", "warn", "error", "fatal", "silent"])
  .default("info");

/** Parse the optional REA_LOG_LEVEL environment variable. */
export const parseLogLevel = (
  value: unknown,
): Result<LogLevel, ConfigurationError> => {
  const parsed = logLevelSchema.safeParse(value);
  if (parsed.success) return ok(parsed.data);
  return err(
    new ConfigurationError("Invalid REA environment configuration", {
      cause: parsed.error,
      settings: parsed.error.issues.map(({ message }) => ({
        setting: "REA_LOG_LEVEL",
        constraint: message,
      })),
    }),
  );
};

/** Create a JSON logger on stderr so protocol and CLI result stdout stay valid. */
export const createLogger = (mode: "mcp" | "cli", level: LogLevel): Logger =>
  pino(
    {
      level,
      base: { application: "rea", mode },
    },
    pino.destination({ dest: 2, sync: false }),
  );

/** Logger used by embedders that have not opted into process output. */
export const silentLogger = pino({ level: "silent" });
