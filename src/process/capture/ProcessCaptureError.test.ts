import { expect, it } from "vitest";
import { ProviderCleanupError } from "../../domain/providerCleanupError.js";
import { projectAnalysisError } from "../../domain/analysisErrorProjection.js";
import { DarwinProcessOwnershipInspectionError } from "../DarwinProcessRunTokenReader.js";
import {
  normalizeCaptureFailure,
  ProcessCaptureError,
} from "./ProcessCaptureError.js";
import { resolveProcessResult } from "./ProcessCaptureLifecycle.js";

const cleanupReport = {
  owned_process_group: { state: "not_required" as const, reason: null },
  terminal_renderer: { state: "not_required" as const, reason: null },
  temporary_root: { state: "cleaned" as const, reason: null },
};
const fixture = () => {
  const cleanup = new ProviderCleanupError(
    "process-ownership",
    ["/owned/helper-root"],
    { reason: "controlled removal failure" },
  );
  const compiler = new DarwinProcessOwnershipInspectionError(
    "compiler failed",
    {
      cleanupFailure: cleanup,
      capturedOutput: {
        stdout: "observed stdout",
        stderr: "controlled compiler diagnostic",
        truncated: false,
        stdout_bytes: 15,
        stderr_bytes: 30,
        exit_code: 7,
        signal: null,
      },
      compilerOutcome: {
        outcome: "exited",
        code: 7,
        signal: null,
        stderr: "controlled compiler diagnostic",
        stderrBytes: 30,
        stderrTruncated: false,
        outputTruncated: false,
        killed: false,
      },
    },
  );
  const error = normalizeCaptureFailure(compiler, undefined);
  if (!(error instanceof ProcessCaptureError))
    throw new Error("Expected normalized capture failure");
  return { cleanup, compiler, error };
};

it("preserves the compiler output and live cleanup owner at capture normalization", () => {
  const { cleanup, compiler, error } = fixture();
  expect(error.cause).toBe(compiler);
  expect(error).toMatchObject({
    cleanupIncomplete: true,
    cleanupResources: ["/owned/helper-root"],
    capturedOutput: { stderr: "controlled compiler diagnostic", exit_code: 7 },
  });
  expect(projectAnalysisError(error)).toMatchObject({
    code: "cleanup_incomplete",
  });
  cleanup.resolveCleanup();
  expect(error.cleanupIncomplete).toBe(false);
  expect(error.capturedOutput?.exit_code).toBe(7);
});

it("retains compiler facts and cleanup dependency through capture finalization", () => {
  const { cleanup, error } = fixture();
  let finalized: unknown;
  try {
    resolveProcessResult(undefined, error, cleanupReport);
  } catch (cause: unknown) {
    finalized = cause;
  }
  expect(finalized).toBeInstanceOf(ProcessCaptureError);
  expect(finalized).toMatchObject({
    cleanupIncomplete: true,
    capturedOutput: { stderr: "controlled compiler diagnostic", exit_code: 7 },
    cleanupReport,
  });
  cleanup.resolveCleanup();
  expect(finalized).toMatchObject({ cleanupIncomplete: false });
});

it("does not recreate unresolved cleanup after the exact owner already confirmed retry", () => {
  const { cleanup, compiler } = fixture();
  cleanup.resolveCleanup();
  const normalized = normalizeCaptureFailure(compiler, undefined);
  expect(normalized).toMatchObject({
    cleanupIncomplete: false,
    capturedOutput: { exit_code: 7 },
  });
});

it("keeps later capture cleanup unresolved after compiler cleanup succeeds", () => {
  const { cleanup, error } = fixture();
  let finalized: unknown;
  try {
    resolveProcessResult(undefined, error, {
      ...cleanupReport,
      temporary_root: {
        state: "failed",
        reason: "capture root removal denied",
      },
    });
  } catch (cause: unknown) {
    finalized = cause;
  }
  expect(finalized).toMatchObject({
    cleanupIncomplete: true,
    capturedOutput: { exit_code: 7 },
    cleanupResources: expect.arrayContaining([
      "/owned/helper-root",
      "temporary_root",
    ]),
  });
  cleanup.resolveCleanup();
  expect(finalized).toMatchObject({ cleanupIncomplete: true });
});

it.each(["compiler first", "capture first"] as const)(
  "keeps both cleanup owners through %s retry",
  (order) => {
    const { cleanup, error } = fixture();
    const captureCleanup = new ProviderCleanupError(
      "process-capture",
      ["/owned/capture-root"],
      { reason: "controlled capture root failure" },
    );
    const finalized = error.withFinalization({
      cleanupFailure: captureCleanup,
      cleanupReport,
    });
    const first = order === "compiler first" ? cleanup : captureCleanup;
    const second = order === "compiler first" ? captureCleanup : cleanup;
    first.resolveCleanup();
    expect(finalized.cleanupIncomplete).toBe(true);
    second.resolveCleanup();
    expect(finalized.cleanupIncomplete).toBe(false);
    expect(finalized.capturedOutput?.exit_code).toBe(7);
  },
);

it("does not infer captured stdout from partial compiler diagnostics", () => {
  const { compiler } = fixture();
  const partial = new DarwinProcessOwnershipInspectionError(
    "partial diagnostics",
    {
      compilerOutcome: compiler.compilerOutcome!,
    },
  );
  expect(normalizeCaptureFailure(partial, undefined)).toMatchObject({
    capturedOutput: undefined,
  });
});
