import { expect, it } from "vitest";
import { evmInterfaceFailure } from "./EvmoleFailures.js";
import { OwnedCommandFailure } from "../process/OwnedCommand.js";
import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import {
  DEFAULT_EVM_TIMEOUT_MS,
  MAX_EVM_TIMEOUT_MS,
} from "../domain/evm/evmInterface.js";
import type { ProviderProcessSnapshot } from "../process/ProviderProcess.js";

const snapshot: ProviderProcessSnapshot = {
  stdout: { text: "selected output", bytes: 15, observedBytes: 15 },
  stderr: { text: "warning", bytes: 7, observedBytes: 7 },
  exitCode: 0,
  signal: null,
};

it.each([
  undefined,
  null,
  "caller stopped",
  { requested: "stop" },
  new AnalysisCancelledError("foreign", {
    cleanup: { reason: "foreign owner", resources: ["foreign-resource"] },
  }),
])(
  "retains the exact command cancellation reason as opaque data: %j",
  (reason) => {
    const source = new OwnedCommandFailure(
      "cancelled",
      "cancelled",
      snapshot,
      null,
      {
        cancellation: { reason },
      },
    );
    const result = evmInterfaceFailure(source, "worker", "/selected.hex");
    expect(result).toBeInstanceOf(AnalysisCancelledError);
    expect(result.cause).toBe(reason);
    expect(result.capturedOutput).toEqual({
      stdout: "selected output",
      stderr: "warning",
      truncated: false,
    });
    expect(result.cleanupIncomplete).toBe(false);
  },
);

it("names timeout_ms, the omitted default, and the caps it does not raise", () => {
  const source = new OwnedCommandFailure(
    "timeout",
    "Command deadline elapsed.",
    snapshot,
    null,
  );
  const projected = projectAnalysisError(
    evmInterfaceFailure(
      source,
      "worker",
      "/selected.hex",
      undefined,
      undefined,
      undefined,
      45_000,
    ),
  );
  expect(projected).toMatchObject({
    code: "provider_timeout",
    details: { timeout_ms: 45_000 },
  });
  expect(projected.message).toContain("timeout_ms");
  expect(projected.message).toContain(String(DEFAULT_EVM_TIMEOUT_MS));
  expect(projected.remediation.action).toContain("--timeout-ms");
  expect(projected.remediation.action).toContain(String(MAX_EVM_TIMEOUT_MS));
  expect(projected.remediation.action).toContain("does not raise");
  expect(projected.remediation.action).toContain("no server restart");
});

it("says a CPU signal has no runtime override and timeout_ms does not raise it", () => {
  const source = new OwnedCommandFailure(
    "process",
    "signaled",
    {
      ...snapshot,
      exitCode: null,
      signal: "SIGXCPU",
    },
    null,
  );
  const projected = projectAnalysisError(
    evmInterfaceFailure(source, "worker", "/selected.hex", {
      addressSpaceBytes: 1024,
      cpuSeconds: 30,
      fileSizeBytes: 1024,
    }),
  );
  expect(projected).toMatchObject({
    code: "resource_constraint",
    details: { resource: "cpu" },
  });
  expect(projected.remediation.action).toContain("no runtime override");
  expect(projected.remediation.action).toContain(
    "timeout_ms does not raise it",
  );
});

it.each([
  { failure: "process" as const, cleanup: null, tag: "ProviderAdapterError" },
  { failure: "timeout" as const, cleanup: null, tag: "AnalysisTimeoutError" },
  {
    failure: "cancelled" as const,
    cleanup: "close refused",
    tag: "ProviderAdapterError",
  },
])("keeps $tag ahead of recorded cancellation", ({ failure, cleanup, tag }) => {
  const source = new OwnedCommandFailure(
    failure,
    "physical outcome",
    snapshot,
    cleanup,
    {
      cancellation: { reason: "later interruption" },
    },
    ["exact-owner"],
  );
  const result = evmInterfaceFailure(source, "worker", "/selected.hex");
  expect(result._tag).toBe(tag);
  if (cleanup !== null) {
    expect(result.cleanupIncomplete).toBe(true);
    expect(result.cleanupResources).toEqual(["exact-owner"]);
  }
});
