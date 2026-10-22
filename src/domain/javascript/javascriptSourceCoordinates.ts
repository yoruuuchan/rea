import { z } from "zod";

const sourcePointSchema = z.strictObject({
  line: z.number().int().min(1),
  column: z.number().int().min(0),
});

/** JavaScript source coordinates use one-based lines and zero-based columns. */
export const javascriptSourceRangeSchema = z
  .strictObject({ start: sourcePointSchema, end: sourcePointSchema })
  .superRefine((range, context) => {
    if (
      range.end.line < range.start.line ||
      (range.end.line === range.start.line &&
        range.end.column < range.start.column)
    )
      context.addIssue({
        code: "custom",
        path: ["end"],
        message: "Source range end must not precede its start",
      });
  });
