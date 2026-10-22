import { z } from "zod";

/** Default absolute deadline for Ghidra import, analysis, bridge, and readiness. */
export const DEFAULT_GHIDRA_STARTUP_TIMEOUT_MS = 330_000;

/** Default absolute deadline for Hopper launch, analysis, bridge, and readiness. */
export const DEFAULT_HOPPER_STARTUP_TIMEOUT_MS = 120_000;

/** Default deadline for Darwin ownership-helper `swiftc` compilation. */
/** Fresh Swift SDK cache took ~88s on the supported Intel macOS VM. */
export const DEFAULT_SWIFTC_COMPILE_TIMEOUT_MS = 120_000;

/**
 * Largest delay Node schedules exactly. Delays above this signed 32-bit
 * boundary become a 1 ms timer, so startup and swiftc timeouts stop here.
 */
export const MAX_PROVIDER_STARTUP_TIMEOUT_MS = 2_147_483_647;

/** Parse the optional setting without reading the ambient process environment. */
export const providerStartupTimeoutSchema = z
  .string()
  .regex(/^[1-9]\d*$/u, "must be a positive decimal integer")
  .transform(Number)
  .pipe(z.int().min(1).max(MAX_PROVIDER_STARTUP_TIMEOUT_MS));
