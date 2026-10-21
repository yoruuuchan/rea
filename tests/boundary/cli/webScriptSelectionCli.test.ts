import { access } from "node:fs/promises";
import { join } from "node:path";

import pino from "pino";
import { expect, it, vi } from "vitest";

import { registerWebScriptCommands } from "../../../src/cli/webScriptCommands.js";
import * as webScriptExport from "../../../src/application/WebScriptExportService.js";
import { CLI_COMMANDS } from "../../../src/cliCommandNames.js";
import { AnalysisCancelledError } from "../../../src/domain/analysisErrorCore.js";
import { err } from "../../../src/domain/result.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

it("forwards an interrupt into the export workflow and reports cancellation", async () => {
  const commands = new Map<string, { run(input: unknown): Promise<unknown> }>();
  const cli = {
    command: (
      name: string,
      definition: { run(input: unknown): Promise<unknown> },
    ) => {
      commands.set(name, definition);
      return cli;
    },
  } as unknown as Parameters<typeof registerWebScriptCommands>[0];
  registerWebScriptCommands(cli, pino({ enabled: false }));
  const exported = vi
    .spyOn(webScriptExport, "exportWebScripts")
    .mockImplementation(async (_input, _resources, options) => {
      process.emit("SIGINT");
      return err(
        new AnalysisCancelledError("export_web_scripts", {
          cause: options?.signal?.reason,
        }),
      );
    });
  const previousExitCode = process.exitCode;
  try {
    const output = await commands.get(CLI_COMMANDS.exportWebScripts)?.run({
      args: {
        capturePath: "/unused/capture.json",
        outputDirectory: "/unused/out",
      },
    });
    expect(exported.mock.calls[0]?.[2]?.signal?.aborted).toBe(true);
    expect(output).toMatchObject({ code: "cancelled" });
    expect(process.exitCode).toBe(130);
  } finally {
    exported.mockRestore();
    process.exitCode = previousExitCode;
  }
});

cliTest.skipIf(process.platform === "win32")(
  "exits with a capture_path invalid_request for a named pipe before publishing output",
  async ({ cli, processes }) => {
    const root = await createTestTempDirectory("rea-script-selection-cli-");
    const capturePath = join(root, "capture.pipe");
    const outputDirectory = join(root, "export");
    const created = await processes.run("mkfifo", [capturePath], {
      timeoutMs: 5_000,
    });
    expect(created.exitCode).toBe(0);

    const response = await cli.run({
      arguments: ["export-web-scripts", capturePath, outputDirectory, "--json"],
      environment: { REA_LOG_LEVEL: "silent" },
      timeoutMs: 5_000,
    });
    expect(response.exitCode).toBe(1);
    expect(response.signal).toBeNull();
    expect(response.json).toMatchObject({
      error: "Script export failed",
      code: "invalid_request",
      details: {
        operation: "export_web_scripts",
        issues: [
          {
            path: ["capture_path"],
            reason: "invalid_value",
            message: expect.stringContaining("regular file"),
          },
        ],
      },
    });
    expect(response.stdout).toContain(capturePath);
    await expect(access(outputDirectory)).rejects.toMatchObject({
      code: "ENOENT",
    });
  },
);
