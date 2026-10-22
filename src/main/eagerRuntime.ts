import { snapshotEnvironment } from "../process/snapshotEnvironment.js";

import type { AppConfig } from "../config/types.js";
import { ok } from "../domain/result.js";
import { parseConfig } from "../config/parseConfig.js";
import { createBinarySession } from "../composition/binary.js";
import { createLogger } from "../logger.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import type { RuntimeDependencies } from "./types.js";
import { openInitialTarget } from "./startup.js";
import { startMcpTransport } from "./transport.js";
import {
  createOptionalObservationFactories,
  loadOptionalObservationProviders,
} from "../composition/optionalObservationProviders.js";
import { createToolResultDelivery } from "../server/toolResult.js";
import { createShutdown } from "./shutdown.js";

/**
 * Start the long-lived MCP adapter and install idempotent shutdown handlers.
 * The adapter owns its BinarySession for the process lifetime; EOF and process
 * signals close bridge resources without assuming ownership of the Hopper app.
 */
export const runEager = async (
  dependencies: RuntimeDependencies,
  selectedConfig?: AppConfig,
): Promise<number> => {
  const environment = snapshotEnvironment(dependencies.env);
  const config =
    selectedConfig === undefined
      ? parseConfig(environment)
      : ok(selectedConfig);
  if (!config.ok) {
    dependencies.writeStderr(`${projectAnalysisError(config.error).message}\n`);
    return 1;
  }
  const logger = createLogger("mcp", config.value.logLevel);
  const serverLogger = logger.child({ layer: "server" });
  const session = createBinarySession(config.value, logger, environment);
  const opened = await openInitialTarget(
    session,
    config.value,
    serverLogger,
    dependencies.writeStderr,
  );
  if (!opened.ok) return opened.exitCode;
  const transport = await startMcpTransport(dependencies, session, {
    logger,
    serverLogger,
    environment,
    delivery: createToolResultDelivery(config.value.mcpMaxResponseBytes),
    loadOptionalProviders:
      dependencies.loadOptionalProviders ??
      (() =>
        loadOptionalObservationProviders(
          createOptionalObservationFactories(environment),
        )),
  });
  if (!transport.ok) return 1;
  const shutdown = createShutdown({
    handle: transport.handle,
    closeAndroid: transport.closeAndroid,
    closeOptionalProviders: transport.closeOptionalProviders,
    session,
    dependencies,
    serverLogger,
  });
  dependencies.captureShutdown?.(shutdown.shutdown);
  return 0;
};
