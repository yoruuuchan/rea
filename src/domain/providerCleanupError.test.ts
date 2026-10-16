import { expect, it } from "vitest";
import { ProviderCleanupError } from "./providerCleanupError.js";
import { projectAnalysisError } from "./analysisErrorProjection.js";
import { analysisErrorWithCleanupFailure } from "./analysisErrorCleanup.js";
it("preserves the binary cleanup default and an explicitly owned nonbinary operation", () => {
  expect(new ProviderCleanupError("ghidra", ["database"], {}).operation).toBe(
    "close_binary",
  );
  const error = new ProviderCleanupError(
    "source-map-decoder",
    ["runtime"],
    { reason: "cleanup failed" },
    { operation: "trace_web_source_location" },
  );
  expect(error.operation).toBe("trace_web_source_location");
  expect(projectAnalysisError(error)).toMatchObject({
    code: "cleanup_incomplete",
    details: { operation: "trace_web_source_location" },
  });
});

it.each([false, true])(
  "combines only live cleanup resources when primary resolution is %s",
  (resolved) => {
    const primary = new ProviderCleanupError(
      "adb",
      ["publication-handle"],
      { reason: "first descriptor close failed" },
      { operation: "capture_adb_screen" },
    );
    if (resolved) primary.resolveCleanup();
    const cleanup = new ProviderCleanupError("adb", ["runtime-root"], {
      reason: "workspace removal failed",
    });

    const combined = analysisErrorWithCleanupFailure(primary, cleanup);
    expect(projectAnalysisError(combined)).toMatchObject({
      code: "cleanup_incomplete",
      details: {
        resources: resolved
          ? ["runtime-root"]
          : ["publication-handle", "runtime-root"],
        diagnostics: {
          primary_error: {
            details: {
              diagnostics: { reason: "first descriptor close failed" },
            },
          },
          cleanup_error: {
            details: { diagnostics: { reason: "workspace removal failed" } },
          },
        },
      },
    });
    expect(combined.cause).toBeInstanceOf(AggregateError);
    expect((combined.cause as AggregateError).errors).toEqual([
      primary,
      cleanup,
    ]);
  },
);
