import { types } from "node:util";
import { z } from "zod";

import type { JsonValue } from "../jsonValue.js";

/**
 * Maximum plist value nesting the JSON projection supports. The XML decode
 * preflight shares this limit so oversized documents are rejected before any
 * recursive pass rather than during one.
 */
export const MAX_PLIST_DEPTH = 128;

/** A decoded plist projected into JSON, with values JSON cannot express. */
export interface ProjectedPlistValue {
  readonly value: JsonValue;
  /** Reals decoded as NaN, which the decoder also uses for ±infinity. */
  readonly unknownRealCount: number;
  /** Dates the decoder could not represent, reported without a timestamp. */
  readonly unknownDateCount: number;
}

/** Limitation for results whose plist held dates the decoder could not represent. */
export const unknownDateLimitation = (count: number): string =>
  `${String(count)} date value(s) are reported as { "$plist_type": "date", "iso8601": null } because the decoder could not represent them, such as XML dates with years beyond 9999 or negative years, or dates outside the JavaScript date range.`;

/**
 * Project a decoded plist into JSON. Data, dates and retained big integers become explicit
 * `$plist_type` objects; a non-finite real becomes an explicit unknown
 * because the XML decoder reports NaN and ±infinity alike.
 */
export const projectPlistValue = (
  value: unknown,
  /** Observe generated wrappers before consumers classify the JSON value tree. */
  onWrappedScalar?: (value: Record<string, JsonValue>) => void,
): ProjectedPlistValue => {
  let unknownRealCount = 0;
  let unknownDateCount = 0;
  const scalar = (value: Record<string, JsonValue>): JsonValue => {
    onWrappedScalar?.(value);
    return value;
  };
  const project = (item: unknown, depth: number): JsonValue => {
    if (depth > MAX_PLIST_DEPTH)
      throw new RangeError(
        `Plist exceeds ${String(MAX_PLIST_DEPTH)} nesting levels`,
      );
    if (item !== null && typeof item === "object" && types.isProxy(item))
      throw new TypeError("Plist values cannot contain proxies");
    if (item instanceof Uint8Array)
      return scalar({
        $plist_type: "data",
        base64: Buffer.from(item).toString("base64"),
      });
    if (item instanceof Date) {
      if (!Number.isNaN(Date.prototype.getTime.call(item)))
        return scalar({
          $plist_type: "date",
          iso8601: Date.prototype.toISOString.call(item),
        });
      unknownDateCount += 1;
      return scalar({ $plist_type: "date", iso8601: null });
    }
    if (typeof item === "number" && !Number.isFinite(item)) {
      unknownRealCount += 1;
      return scalar({ $plist_type: "real", value: null });
    }
    if (typeof item === "bigint")
      return scalar({ $plist_type: "integer", decimal: item.toString() });
    if (Array.isArray(item)) {
      const result: JsonValue[] = [];
      for (let index = 0; index < item.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(item, index);
        if (descriptor === undefined || !Object.hasOwn(descriptor, "value"))
          throw new TypeError(
            "Plist arrays require dense data properties without accessors",
          );
        result.push(project(descriptor.value, depth + 1));
      }
      return result;
    }
    if (item !== null && typeof item === "object") {
      const entries: [string, JsonValue][] = [];
      for (const key of Reflect.ownKeys(item)) {
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (descriptor?.enumerable !== true) continue;
        if (typeof key !== "string" || !Object.hasOwn(descriptor, "value"))
          throw new TypeError(
            "Plist dictionary entries require string keys and data properties",
          );
        entries.push([key, project(descriptor.value, depth + 1)]);
      }
      return Object.fromEntries(entries);
    }
    return z.union([z.string(), z.number(), z.boolean(), z.null()]).parse(item);
  };
  const projected = project(value, 0);
  return { value: projected, unknownRealCount, unknownDateCount };
};
