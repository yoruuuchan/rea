import { compareUnicodeCodePoints } from "./unicodeCodePointOrder.js";

/** Deduplicate and sort strings with canonical code-point ordering. */
export const uniqueSorted = <Value extends string>(
  values: readonly Value[],
): Value[] => [...new Set(values)].sort(compareUnicodeCodePoints);

/** Lexical ordering for identifiers and digests already validated as ASCII. */
export const compareAsciiStrings = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

/** Whether validated ASCII strings are already ordered without duplicates. */
export const isSortedUniqueAscii = (values: readonly string[]): boolean =>
  values.every(
    (value, index) =>
      index === 0 || compareAsciiStrings(values[index - 1] ?? "", value) < 0,
  );
