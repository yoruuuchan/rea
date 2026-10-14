import { z } from "zod";

/** Fixed tuples with explicit item and length constraints in JSON Schema. */
export const fixedTupleSchema = <
  const Items extends readonly [z.ZodType, ...z.ZodType[]],
>(
  items: Items,
): z.ZodTuple<Items, z.ZodNever> =>
  // Zod's tuple projection omits implicit arity and, without a rest schema,
  // `items` in Draft 2020-12. Spell out both at the canonical boundary so
  // consumers agree with the parser and clients accept the declaration.
  z
    .tuple(items, z.never())
    .check(z.minLength(items.length), z.maxLength(items.length));
