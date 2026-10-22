import type { z } from "zod";
import type { AnalysisInputError } from "../analysisErrorCore.js";
import type { AnalysisError } from "../analysisErrorBase.js";
import { analysisInputErrorFromIssues } from "../inputIssueProjection.js";
import { err, ok, type Result } from "../result.js";
import type { AnalysisViewParent } from "./analysisView.js";

/** Parse a parent's result with its owning parser; issues point into the view source. */
export const parseAnalysisViewResult = <Value>(
  parser: {
    readonly safeParse: (input: unknown) => z.ZodSafeParseResult<Value>;
  },
  parent: AnalysisViewParent,
): Result<Value, AnalysisError> => {
  const parsed = parser.safeParse(parent.normalizedResult);
  if (parsed.success) return ok(parsed.data);
  return err(
    analysisViewResultInputError(parent.normalizedResult, parsed.error),
  );
};

/** Locate schema failures inside the retained result, including throwing parsers. */
export const analysisViewResultInputError = (
  input: unknown,
  cause: z.ZodError,
): AnalysisInputError =>
  analysisInputErrorFromIssues(
    "inspect_analysis_view",
    cause.issues.map((issue) => ({
      ...issue,
      path: ["source", "normalized_result", ...issue.path],
    })),
    { source: { normalized_result: input } },
    { cause },
  );
