import { getHeapStatistics } from "node:v8";
import { AnalysisResourceConstraintError } from "../domain/analysisErrorCore.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import { err, ok, type Result } from "../domain/result.js";

/** Authentication clones parsed JSON and hashes its canonical commitment. */
const AUTHENTICATION_COPIES = 2;

/** Conservative bytes a parsed JSON value occupies: UTF-16 text plus container and slot overhead. */
export const estimateJsonValueBytes = (value: unknown): number => {
  let bytes = 0;
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const item = stack.pop();
    if (typeof item === "string") bytes += 64 + item.length * 2;
    else if (Array.isArray(item)) {
      bytes += 128 + item.length * 16;
      for (const entry of item) stack.push(entry);
    } else if (typeof item === "object" && item !== null) {
      bytes += 128;
      for (const [key, entry] of Object.entries(item)) {
        bytes += 64 + key.length * 2;
        stack.push(entry);
      }
    } else bytes += 16;
  }
  return bytes;
};

/** Refuse before authentication when live heap headroom cannot hold its validation and commitment working copies. */
export const requireAuthenticationHeadroom = (
  value: unknown,
  options: {
    readonly operation: string;
    readonly path: string;
    readonly description: string;
    readonly availableBytes?: number;
  },
): Result<void, AnalysisError> => {
  const availableBytes =
    options.availableBytes ?? getHeapStatistics().total_available_size;
  const valueBytes = estimateJsonValueBytes(value);
  const requiredBytes = valueBytes * AUTHENTICATION_COPIES;
  if (requiredBytes <= availableBytes) return ok(undefined);
  return err(
    new AnalysisResourceConstraintError(
      options.operation,
      "memory",
      options.description,
      {
        input_path: options.path,
        projected_value_bytes: valueBytes,
        authentication_bytes: requiredBytes,
        available_heap_bytes: availableBytes,
      },
    ),
  );
};
