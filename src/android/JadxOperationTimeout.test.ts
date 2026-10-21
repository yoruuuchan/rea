import { expect, it } from "vitest";

import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { captureJadxFailure } from "./JadxFailure.js";
import { jadxOperationTimeoutGuidance } from "./JadxRelease.js";

it("names REA_JADX_OPERATION_TIMEOUT_MS when the operation deadline elapses", () => {
  const timeout = AbortSignal.abort(new Error("deadline"));
  const present = captureJadxFailure({
    cause: timeout.reason,
    request: {
      operation: "inspect_android_package",
      input: { path: "/targets/app.apk" },
    },
    timeout,
    timeoutMs: 1500,
    signal: undefined,
    session: undefined,
  });
  const projected = projectAnalysisError(present());
  const guidance = jadxOperationTimeoutGuidance(1500);
  expect(projected.message).toBe(guidance.userMessage);
  expect(projected.remediation.action).toBe(guidance.remediationAction);
  expect(projected.message).toContain("1500 ms");
  expect(projected.remediation.action).toContain(
    "REA_JADX_OPERATION_TIMEOUT_MS",
  );
  expect(projected.remediation.action).toContain("1 to 2147483647");
  expect(projected.remediation.action).toContain("120000");
  expect(projected.remediation.action).toContain("next process start");
  expect(projected).toMatchObject({
    code: "provider_timeout",
    details: { timeout_ms: 1500 },
  });
});
