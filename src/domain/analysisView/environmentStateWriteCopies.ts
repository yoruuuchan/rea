import {
  pointerTokens,
  scalarText,
  type JsonObject,
} from "./environmentStateRules.js";
import { GENERATED } from "./environmentStateWriteGenerated.js";
import type { FieldRule } from "./environmentStateWriteRules.js";
import { delimitedOffsets } from "./environmentStateWriteValues.js";

/** Shorter body strings are too common to show that a field copied one. */
export const COPY_MIN_LENGTH = 8;

/** A string that embeds a generated value, or a long value copied from the call, delimited is rebuilt around the new value. */
export const templateRule = (
  entity: JsonObject,
  field: string,
  sources: readonly FieldRule[],
): FieldRule | undefined => {
  const value = entity[field];
  if (typeof value !== "string") return undefined;
  for (const rule of sources) {
    const token = scalarText(entity[rule.field]);
    const generated = GENERATED.has(rule.rule);
    if (
      rule.field !== field &&
      token !== undefined &&
      token.length >= (generated ? 1 : COPY_MIN_LENGTH) &&
      delimitedOffsets(value, token).length > 0
    )
      return { field, rule: "template", from: rule.field };
  }
  return undefined;
};

/** Body members the entity stores as sent, under their own name (echo) or only another (a copy of the whole member). */
export const storedMembers = (
  rules: readonly FieldRule[],
  entity: JsonObject,
): Set<string> =>
  new Set(
    rules.flatMap((rule) => {
      if (rule.rule === "echo") return [rule.field];
      const tokens = rule.rule === "copy" ? pointerTokens(rule.from) : [];
      // A member also stored otherwise under its own name is not stored as sent.
      return tokens.length === 1 && !Object.hasOwn(entity, tokens[0]!)
        ? tokens
        : [];
    }),
  );

/** Copy rules whose value also sits in text no template rebuilds around it, so a call changing their member would leave that text stale. */
export const strandedCopies = (
  rules: readonly FieldRule[],
  entity: JsonObject,
  texts: readonly string[],
): Set<string> => {
  const rebuilt = new Map(
    rules.flatMap((rule) =>
      rule.rule === "template" ? [[rule.field, rule.from] as const] : [],
    ),
  );
  return new Set(
    rules.flatMap((rule) => {
      const token = scalarText(entity[rule.field]);
      const text = (field: string): string | undefined => {
        const value = entity[field];
        return field === rule.field || typeof value !== "string"
          ? undefined
          : value;
      };
      return rule.rule === "copy" &&
        token !== undefined &&
        token.length >= COPY_MIN_LENGTH &&
        texts.some((field) => {
          const value = text(field);
          return (
            rebuilt.get(field) !== rule.field &&
            value !== undefined &&
            delimitedOffsets(value, token).length > 0
          );
        })
        ? [rule.field]
        : [];
    }),
  );
};
