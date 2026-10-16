import { expect, it, vi } from "vitest";
import { execFileBytes } from "../process/ExecFileOutput.js";
import { probeAdbPathExistence } from "./AdbCommand.js";

vi.mock("../process/ExecFileOutput.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../process/ExecFileOutput.js")>()),
  execFileBytes: vi.fn(),
}));

const probe = (signal?: AbortSignal) =>
  probeAdbPathExistence(
    "push_adb_file",
    "device",
    "/device/path",
    "/host/adb",
    {
      timeoutMs: 100,
      maxOutputBytes: 1024,
    },
    signal,
  );

it("recognizes only the completed empty false result as absence", async () => {
  vi.mocked(execFileBytes).mockRejectedValueOnce(
    Object.assign(new Error("test false"), {
      code: 1,
      stdout: "",
      stderr: "",
      signal: null,
      killed: false,
    }),
  );
  await expect(probe()).resolves.toEqual({ ok: true, value: false });
});

it.each([
  { code: 2 },
  { code: "ENOENT" },
  { signal: "SIGTERM" },
  { collectionFailure: true },
  { stdout: "unexpected" },
  { stderr: " " },
])("keeps nonstandard false completion unknown: %j", async (extra) => {
  vi.mocked(execFileBytes).mockRejectedValueOnce(
    Object.assign(new Error("probe failed"), {
      code: 1,
      stdout: "",
      stderr: "",
      signal: null,
      killed: false,
      ...extra,
    }),
  );
  const result = await probe();
  expect(result).toMatchObject({
    ok: false,
    error: {
      _tag: "AnalysisProtocolError",
      diagnostics: { destination_existence: "unknown" },
    },
  });
});

it.each([
  [{ killed: true }, "AnalysisTimeoutError"],
  [{ outputTruncated: true }, "AnalysisResourceConstraintError"],
  [{ code: "ABORT_ERR" }, "AnalysisCancelledError"],
] as const)(
  "preserves a stopped or incomplete probe: %j",
  async (extra, tag) => {
    vi.mocked(execFileBytes).mockRejectedValueOnce(
      Object.assign(new Error("probe failed"), {
        code: 1,
        stdout: "",
        stderr: "",
        signal: null,
        killed: false,
        ...extra,
      }),
    );
    await expect(probe()).resolves.toMatchObject({
      ok: false,
      error: { _tag: tag },
    });
  },
);

it("recognizes an empty successful probe as existence", async () => {
  vi.mocked(execFileBytes).mockResolvedValueOnce({
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
  });
  await expect(probe()).resolves.toEqual({ ok: true, value: true });
});

it.each(["stdout", "stderr"] as const)(
  "retains unexpected successful %s as unknown",
  async (stream) => {
    vi.mocked(execFileBytes).mockResolvedValueOnce({
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      [stream]: Buffer.from("unexpected"),
    });
    await expect(probe()).resolves.toMatchObject({
      ok: false,
      error: {
        _tag: "AnalysisProtocolError",
        capturedOutput: { [stream]: "unexpected", exit_code: 0 },
      },
    });
  },
);
