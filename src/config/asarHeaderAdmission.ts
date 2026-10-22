import { z } from "zod";

import { ConfigurationError } from "../domain/configurationErrors.js";
import { err, ok, type Result } from "../domain/result.js";

export const ASAR_HEADER_ADMISSION_SETTING = "REA_ASAR_MAX_HEADER_BYTES";

/** Header/index bytes admitted when the setting is unset. */
export const DEFAULT_ASAR_MAX_HEADER_BYTES = 16 * 1024 * 1024;

/**
 * Largest configurable admission. The header JSON is decoded into one string
 * and parsed in memory; 256 MiB keeps that text and its parse copy well below
 * Node's single-string ceiling of about 512 Mi UTF-16 code units. A lower value
 * only refuses more archives, so the setting has no floor.
 */
export const MAXIMUM_ASAR_MAX_HEADER_BYTES = 256 * 1024 * 1024;

/** Effective ASAR header/index admission and where its value came from. */
export interface AsarHeaderAdmission {
  readonly maximumBytes: number;
  readonly source: "default" | "setting";
}

export const DEFAULT_ASAR_HEADER_ADMISSION: AsarHeaderAdmission = {
  maximumBytes: DEFAULT_ASAR_MAX_HEADER_BYTES,
  source: "default",
};

export const asarMaxHeaderBytesConstraint = `${ASAR_HEADER_ADMISSION_SETTING} must be a positive decimal integer of at most ${String(MAXIMUM_ASAR_MAX_HEADER_BYTES)} bytes (256 MiB); the default is ${String(DEFAULT_ASAR_MAX_HEADER_BYTES)} bytes (16 MiB).`;

/** Optional decimal byte count for the ASAR header/index admission. */
export const asarMaxHeaderBytesSchema = z
  .string()
  .regex(/^[1-9]\d*$/u, { error: asarMaxHeaderBytesConstraint })
  .transform(Number)
  .pipe(
    z.number().int().max(MAXIMUM_ASAR_MAX_HEADER_BYTES, {
      error: asarMaxHeaderBytesConstraint,
    }),
  );

/** Resolve the effective admission from one environment value. */
export const parseAsarHeaderAdmission = (
  value: string | undefined,
): Result<AsarHeaderAdmission, ConfigurationError> => {
  if (value === undefined) return ok(DEFAULT_ASAR_HEADER_ADMISSION);
  const parsed = asarMaxHeaderBytesSchema.safeParse(value);
  return parsed.success
    ? ok({ maximumBytes: parsed.data, source: "setting" })
    : err(
        new ConfigurationError(asarMaxHeaderBytesConstraint, {
          settings: [
            {
              setting: ASAR_HEADER_ADMISSION_SETTING,
              constraint: asarMaxHeaderBytesConstraint,
            },
          ],
        }),
      );
};
