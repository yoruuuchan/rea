import { expect, it, vi } from "vitest";

import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { AnalysisTimeoutError } from "../domain/analysisErrorCore.js";
import { execFileOutput } from "../process/ExecFileOutput.js";
import { inspectAdbClient } from "./AdbConfiguration.js";

vi.mock("../process/ExecFileOutput.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../process/ExecFileOutput.js")>()),
  execFileOutput: vi.fn(),
}));

const selection = {
  binary: "/host/adb",
  pathSource: "environment",
} as const;

it("names the adb version-probe deadline and says it has no runtime override", async () => {
  vi.mocked(execFileOutput).mockRejectedValueOnce(
    Object.assign(new Error("deadline"), {
      code: "ETIMEDOUT",
      stdout: "",
      stderr: "",
      signal: null,
      killed: true,
    }),
  );
  const failure = await inspectAdbClient(selection).catch(
    (cause: unknown) => cause,
  );
  expect(failure).toBeInstanceOf(AnalysisTimeoutError);
  const projected = projectAnalysisError(failure as AnalysisTimeoutError);
  expect(projected).toMatchObject({
    code: "provider_timeout",
    details: { timeout_ms: 10_000 },
  });
  expect(projected.message).toContain("10000 ms");
  expect(projected.message).toContain("no runtime override");
  expect(projected.remediation.action).toContain("no runtime override");
});

it("names the adb version-output cap and says it has no runtime override", async () => {
  vi.mocked(execFileOutput).mockRejectedValueOnce(
    Object.assign(new Error("too much"), {
      code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
      stdout: "",
      stderr: "",
      signal: null,
      killed: false,
      outputTruncated: true,
    }),
  );
  const failure = await inspectAdbClient(selection).catch(
    (cause: unknown) => cause,
  );
  const projected = projectAnalysisError(
    failure as Parameters<typeof projectAnalysisError>[0],
  );
  expect(projected.message).toContain("65536-byte");
  expect(projected.remediation.action).toContain("65536 bytes");
  expect(projected.remediation.action).toContain("no runtime override");
});
