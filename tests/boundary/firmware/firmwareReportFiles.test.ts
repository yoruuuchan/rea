import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";

import {
  inventoryFirmwareOutput,
  FirmwareFileAccess,
} from "../../../src/firmware/FirmwareFiles.js";
import { readFirmwareCommandReport } from "../../../src/firmware/FirmwareCommand.js";
import { FIRMWARE_LIMITS } from "../../../src/firmware/FirmwareRelease.js";
import { AnalysisError } from "../../../src/domain/analysisErrorBase.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it.each([
  ["invalid leading byte", [0xff]],
  ["incomplete sequence", [0xe2, 0x82]],
  ["overlong sequence", [0xc0, 0xaf]],
  ["encoded surrogate", [0xed, 0xa0, 0x80]],
])(
  "rejects complete JSON containing %s without repairing producer bytes",
  async (_name, bytes) => {
    const root = await createTestTempDirectory("rea-firmware-report-");
    const path = join(root, "report.json");
    await writeFile(
      path,
      Buffer.concat([
        Buffer.from('{"description":"'),
        Buffer.from(bytes),
        Buffer.from('"}'),
      ]),
    );
    await expect(
      new FirmwareFileAccess().report(path, "inspect_firmware_regions"),
    ).rejects.toMatchObject({
      _tag: "AnalysisOutputError",
      reason: "Tool report is not valid complete JSON",
    });
  },
);

it.each([
  ["missing", "Report was not created", async () => {}],
  ["empty", "Report is empty", (path: string) => writeFile(path, "")],
  [
    "invalid_json",
    "Tool report is not valid complete JSON",
    (path: string) => writeFile(path, '[{"Analysis":'),
  ],
  [
    "oversized",
    `Report exceeded ${FIRMWARE_LIMITS.reportBytes} bytes`,
    (path: string) =>
      writeFile(path, Buffer.alloc(FIRMWARE_LIMITS.reportBytes + 1, 0x20)),
  ],
  [
    "not_regular_file",
    "Report is not a regular file",
    (path: string) => mkdir(path),
  ],
] as const)(
  "keeps report state %s after a successful exit distinct from an empty scan",
  async (state, reason, prepare) => {
    const root = await createTestTempDirectory("rea-firmware-report-");
    const path = join(root, "report.json");
    await prepare(path);
    const failure: unknown = await readFirmwareCommandReport({
      path,
      engine: "binwalk",
      operation: "inspect_firmware_regions",
      execution: {
        stdout: { text: "", bytes: 0, observedBytes: 0 },
        stderr: { text: "", bytes: 0, observedBytes: 0 },
        exit_code: 0,
        signal: null,
        command: "/opt/binwalk",
        args: ["--quiet", "--log", path, "/work/firmware.bin"],
        resource_limiter: "/usr/bin/prlimit",
      },
      files: new FirmwareFileAccess(),
    }).catch((cause: unknown) => cause);
    if (!(failure instanceof AnalysisError))
      throw new Error("Expected a typed report failure");
    const projected = projectAnalysisError(failure);
    expect(projected).toMatchObject({
      code: "unreadable_output",
      retryable: false,
      message: expect.stringContaining("not an empty or complete result"),
      details: {
        reason: `binwalk exited 0 without a usable report: ${reason}`,
        diagnostics: {
          report_state: state,
          report_path: path,
          command: "/opt/binwalk",
          args: ["--quiet", "--log", path, "/work/firmware.bin"],
          resource_limiter: "/usr/bin/prlimit",
          exit_code: 0,
          signal: null,
          stdout_bytes: 0,
          stderr_bytes: 0,
        },
      },
    });
    // Generic doctor advice is not presented as a repair for a missing report.
    expect(projected.message).not.toContain("rea doctor");
    // Recorded arguments name a removed private workspace; recovery must not
    // present them as a replayable command.
    expect(projected.remediation.action).toContain("diagnostics.report_state");
    expect(projected.remediation.action).toContain("cannot be replayed as-is");
    if (state === "oversized") {
      expect(projected.remediation.action).toContain("no runtime override");
      expect(projected.remediation.action).toContain(
        "Repeating the unchanged request fails the same way",
      );
      expect(projected.remediation.action).not.toContain(
        "Rerun the same REA request",
      );
      expect(projected.message).toContain("no runtime override");
      expect(projected.message).not.toContain("Rerun the same REA request");
    } else {
      expect(projected.remediation.action).toContain(
        "replacing every private path",
      );
      expect(projected.remediation.action).toContain(
        "Rerun the same REA request",
      );
      expect(projected.remediation.action).not.toContain(
        "Repeating the unchanged request fails the same way",
      );
    }
  },
);

it("preserves valid Unicode and a literal replacement character in producer JSON", async () => {
  const root = await createTestTempDirectory("rea-firmware-report-");
  const path = join(root, "report.json");
  const report = { description: "固件 🧩 \ufffd", path: "/输入/firmware.bin" };
  await writeFile(path, JSON.stringify(report));
  expect(
    await new FirmwareFileAccess().report(path, "inspect_firmware_regions"),
  ).toEqual(report);
});

it("orders extracted firmware paths by code point independently of host locale", async () => {
  const root = await createTestTempDirectory("rea-firmware-inventory-");
  await mkdir(join(root, "Lib"));
  for (const path of ["a.bin", "z.bin", "\u00e4.bin", "B.bin", "Lib/x.bin"])
    await writeFile(join(root, path), "");
  const entries = await inventoryFirmwareOutput(
    root,
    1024,
    16,
    "inspect_firmware_regions",
  );
  // Locale collation would interleave case and place "ä" by language rules.
  expect(entries.map(({ relativePath }) => relativePath)).toEqual([
    "B.bin",
    "Lib/x.bin",
    "a.bin",
    "z.bin",
    "\u00e4.bin",
  ]);
});
