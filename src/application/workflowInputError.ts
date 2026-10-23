import type { z } from "zod";

import type { AnalysisInputError } from "../domain/analysisErrorCore.js";
import { analysisInputErrorFromIssues } from "../domain/inputIssueProjection.js";

/** Project schema issues of the raw request onto their request paths. */
export const requestInputError = (
  operation: string,
  cause: z.ZodError,
  input: unknown,
): AnalysisInputError =>
  analysisInputErrorFromIssues(operation, cause.issues, input, { cause });
