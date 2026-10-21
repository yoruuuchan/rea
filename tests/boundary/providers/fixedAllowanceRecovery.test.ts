import { expect, it } from "vitest";

import { AnalysisResourceConstraintError } from "../../../src/domain/analysisErrorCore.js";
import type { AnalysisError } from "../../../src/domain/analysisErrorBase.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { redactExplicitFailure } from "../../../src/domain/explicitSensitiveFailure.js";
import {
  fixedAllowanceOptions,
  fixedAllowanceRemediation,
} from "../../../src/domain/fixedAllowanceRemediation.js";
import { analysisClientFailureForOperation } from "../../../src/providers/AnalysisClientFailure.js";

const refusal = () =>
  new AnalysisResourceConstraintError(
    "provider_stage",
    "memory",
    "decoded representation exceeds the fixture allowance",
    { maximum_decoded_bytes: 64 },
    fixedAllowanceOptions(
      "The explicit-secret fixture decode allowance",
      "parser",
    ),
  );

it.each([
  {
    boundary: "operation attribution",
    copy: (error: AnalysisError) =>
      analysisClientFailureForOperation(error, "fixture", "inspect_fixture"),
    allowance: "The explicit-secret fixture decode allowance",
  },
  {
    boundary: "explicit redaction",
    copy: (error: AnalysisError) =>
      redactExplicitFailure(error, ["explicit-secret"]),
    allowance: "The [REDACTED] fixture decode allowance",
  },
])(
  "keeps a fixed allowance's derived recovery through $boundary",
  ({ copy, allowance }) => {
    const copied = copy(refusal());
    expect(copied).toBeInstanceOf(AnalysisResourceConstraintError);
    expect(copied).toMatchObject({
      fixedAllowance: { name: allowance, kind: "parser" },
      remediationAction: undefined,
      retryable: false,
    });
    expect(projectAnalysisError(copied)).toMatchObject({
      code: "resource_constraint",
      retryable: false,
      remediation: { action: fixedAllowanceRemediation(allowance, "parser") },
      details: { reported_limits: { maximum_decoded_bytes: 64 } },
    });
  },
);
