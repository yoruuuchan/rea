import { isSafeNumber } from "lossless-json";

/** Whether native JSON conversion and serialization preserve the recorded number. */
export const isExactJsonNumber = (
  value: number,
  source: string | undefined,
): boolean =>
  source !== undefined && isSafeNumber(source) && !Object.is(value, -0);
