import { z } from "incur";
import {
  javaScriptRoutesDeliverySchema,
  webRoutesDeliverySchema,
} from "../domain/analysisView/javascriptRoutesView.js";
import { AnalysisInputError } from "../domain/analysisErrorCore.js";
import { analysisInputErrorFromIssues } from "../domain/inputIssueProjection.js";
import { err, ok } from "../domain/result.js";
import {
  analysisEvidenceDeliveryOptions,
  cliEvidenceDeliveryInputError,
} from "./analysisEvidenceDelivery.js";

export const javascriptRouteDeliveryOptions = {
  ...analysisEvidenceDeliveryOptions,
  view: z
    .string()
    .optional()
    .describe(
      "JSON javascript-routes view; requires --detail summary and --evidence_output",
    ),
};

/** Validate delivery before opening artifacts or attaching a browser. */
export const parseJavaScriptRouteDelivery = (
  operation: string,
  options: {
    detail: "complete" | "summary";
    evidence_output?: string | undefined;
    view?: string | undefined;
  },
) => {
  let view: unknown;
  try {
    view = options.view === undefined ? undefined : JSON.parse(options.view);
  } catch (cause) {
    return err(
      new AnalysisInputError(operation, { cause }, [
        {
          path: ["view"],
          reason: "invalid_format",
          message: "view must be valid JSON",
        },
      ]),
    );
  }
  const raw = {
    detail: options.detail,
    ...(view === undefined ? {} : { view }),
  };
  const schema =
    operation === "analyze_web_bundle"
      ? webRoutesDeliverySchema
      : javaScriptRoutesDeliverySchema;
  const parsed = schema.safeParse(raw);
  if (!parsed.success)
    return err(
      analysisInputErrorFromIssues(operation, parsed.error.issues, raw),
    );
  const value = { ...parsed.data, evidenceOutput: options.evidence_output };
  const invalid = cliEvidenceDeliveryInputError({ ...value, operation });
  return invalid === undefined ? ok(value) : err(invalid);
};
