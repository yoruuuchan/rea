import { z } from "zod";

import { ConfigurationError } from "../domain/configurationErrors.js";
import { err, ok, type Result } from "../domain/result.js";

export const REGEX_WORKER_HEAP_REQUEST_SETTING =
  "REA_REGEX_WORKER_HEAP_REQUEST_MIB";

/** Worker old-generation request used when the setting is unset. Today's constant. */
export const DEFAULT_REGEX_WORKER_HEAP_REQUEST_MIB = 128;

/**
 * Smallest request that completes a trivial regex match on supported Node.
 * Linux runs of the production worker (`^a` against `["a"]`, no
 * `NODE_OPTIONS`) return `ERR_WORKER_OUT_OF_MEMORY` at 6 MiB on Node 24.21.0
 * and 24.22.1, and on most runs of 24.11.0, 24.18.0, and 26.0.0. 7 MiB
 * returned that match on Node 22.19.0, 22.23.4, 24.11.0, 24.18.0, 24.21.0,
 * 24.22.1, 26.0.0, and 26.12.1. A lower accepted value passes configuration
 * and then fails the search.
 */
export const MINIMUM_REGEX_WORKER_HEAP_REQUEST_MIB = 7;

/**
 * Largest request one regex worker may make. 16 GiB is the same ceiling REA
 * already uses for an isolated JavaScript analysis worker. A positive Node
 * `--max-old-space-size` can still set a different effective heap; this
 * maximum bounds only the REA request.
 */
export const MAXIMUM_REGEX_WORKER_HEAP_REQUEST_MIB = 16_384;

/** Effective regex worker heap request and where its value came from. */
export interface RegexWorkerHeapRequest {
  readonly heapMiB: number;
  readonly source: "default" | "setting";
}

export const DEFAULT_REGEX_WORKER_HEAP_REQUEST: RegexWorkerHeapRequest = {
  heapMiB: DEFAULT_REGEX_WORKER_HEAP_REQUEST_MIB,
  source: "default",
};

export const regexWorkerHeapRequestConstraint = `${REGEX_WORKER_HEAP_REQUEST_SETTING} must be a decimal integer from ${String(MINIMUM_REGEX_WORKER_HEAP_REQUEST_MIB)} to ${String(MAXIMUM_REGEX_WORKER_HEAP_REQUEST_MIB)} MiB; the default is ${String(DEFAULT_REGEX_WORKER_HEAP_REQUEST_MIB)} MiB. A request below ${String(MINIMUM_REGEX_WORKER_HEAP_REQUEST_MIB)} MiB aborts the worker during startup, and a larger value is refused.`;

const decimalInteger = /^[1-9]\d*$/u;

const withinHeapRange = (value: string): boolean => {
  // The pattern check reports a non-decimal value. Refine only bounds integers.
  if (!decimalInteger.test(value)) return true;
  const parsed = BigInt(value);
  return (
    parsed >= BigInt(MINIMUM_REGEX_WORKER_HEAP_REQUEST_MIB) &&
    parsed <= BigInt(MAXIMUM_REGEX_WORKER_HEAP_REQUEST_MIB)
  );
};

/** Optional decimal mebibyte count for the regex worker old-generation request. */
export const regexWorkerHeapRequestMiBSchema = z
  .string()
  .regex(decimalInteger, { error: regexWorkerHeapRequestConstraint })
  .refine(withinHeapRange, { error: regexWorkerHeapRequestConstraint })
  .transform(Number);

/** Resolve the effective request from one environment value. */
export const parseRegexWorkerHeapRequest = (
  value: string | undefined,
): Result<RegexWorkerHeapRequest, ConfigurationError> => {
  if (value === undefined) return ok(DEFAULT_REGEX_WORKER_HEAP_REQUEST);
  const parsed = regexWorkerHeapRequestMiBSchema.safeParse(value);
  return parsed.success
    ? ok({ heapMiB: parsed.data, source: "setting" })
    : err(
        new ConfigurationError(regexWorkerHeapRequestConstraint, {
          settings: [
            {
              setting: REGEX_WORKER_HEAP_REQUEST_SETTING,
              constraint: regexWorkerHeapRequestConstraint,
            },
          ],
        }),
      );
};

/**
 * Resolve the request from a composition root's selected environment. An
 * invalid setting is refused, not ignored. Callers that already resolved it
 * at startup pass that value through instead of reading the environment again.
 */
export const resolveRegexWorkerHeapRequest = (
  environment: Readonly<Record<string, string | undefined>>,
): RegexWorkerHeapRequest => {
  const parsed = parseRegexWorkerHeapRequest(
    environment[REGEX_WORKER_HEAP_REQUEST_SETTING],
  );
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
};

/** How to read and change the regex worker old-generation request. */
export const regexWorkerHeapRequestRecovery = (
  request: RegexWorkerHeapRequest,
): string =>
  [
    `The effective ${REGEX_WORKER_HEAP_REQUEST_SETTING} value is ${String(request.heapMiB)} MiB (source ${request.source}; default ${String(DEFAULT_REGEX_WORKER_HEAP_REQUEST_MIB)} MiB, floor ${String(MINIMUM_REGEX_WORKER_HEAP_REQUEST_MIB)} MiB, maximum ${String(MAXIMUM_REGEX_WORKER_HEAP_REQUEST_MIB)} MiB).`,
    `Set ${REGEX_WORKER_HEAP_REQUEST_SETTING} in the environment that starts REA to a decimal integer from ${String(MINIMUM_REGEX_WORKER_HEAP_REQUEST_MIB)} to ${String(MAXIMUM_REGEX_WORKER_HEAP_REQUEST_MIB)}, then restart REA.`,
    "A positive Node --max-old-space-size, including NODE_OPTIONS, overrides this request and sets the effective heap. That flag is not limited by this setting's floor or maximum. Raising host memory alone does not raise the request.",
  ].join(" ");
