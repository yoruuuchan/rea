import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

import { PROCESS_UNEXPECTED_FAILURE_REMEDIATION } from "../application/process/ProcessCli.js";
import {
  captureDecoderHeapRecovery,
  DEFAULT_CAPTURE_DECODER_HEAP,
} from "../config/captureDecoderHeap.js";
import {
  DEFAULT_MCP_STARTUP_BUDGETS,
  mcpPhaseBudgetRecovery,
} from "../config/mcpStartupBudgets.js";
import { AnalysisTimeoutError } from "../domain/analysisErrorCore.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import {
  MCP_CONNECTION_LOST,
  MCP_CONNECTION_START_FAILED,
  MCP_HTTP_LISTEN_FAILED,
  MCP_SHUTDOWN_FAILED,
  SERVER_START_FAILED,
} from "./messages.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const STALE_LIMIT_COPY =
  /without assuming adjustable limits|do not assume adjustable|Generic errors do not assume adjustable/u;

function prose(text: string): string {
  return text.replace(/\s+/gu, " ");
}

it("uses one retry then a user handoff for transient MCP failures", () => {
  expect(MCP_CONNECTION_LOST).toBe(
    "Retry the tool call once only when it is safe to repeat or known not to have started. If it may already have changed the target, or it fails again, tell the user REA lost its MCP client connection and ask them to restart the MCP client.",
  );
  expect(MCP_CONNECTION_LOST).not.toContain("rea doctor");
  expect(MCP_CONNECTION_START_FAILED).toBe(
    "Retry once. If it fails again, tell the user REA could not start its MCP connection and ask them to restart the MCP client, then run `rea doctor`.",
  );
  expect(MCP_CONNECTION_START_FAILED).toContain("Retry once.");
  expect(SERVER_START_FAILED).toBe(
    "Do not repeat this startup. Tell the user REA could not start and ask them to restart the MCP client, then run `rea doctor`.",
  );
  expect(SERVER_START_FAILED).not.toMatch(/\bretry\b/iu);
  for (const message of [MCP_CONNECTION_START_FAILED, SERVER_START_FAILED]) {
    expect(message).toMatch(/tell the user/iu);
    expect(message).toContain("restart the MCP client");
    expect(message).toContain("`rea doctor`");
  }
  expect(PROCESS_UNEXPECTED_FAILURE_REMEDIATION).toBe(
    "Do not repeat this command. Tell the user the process command could not complete and ask them to check the input files, then run `rea doctor`.",
  );
  expect(PROCESS_UNEXPECTED_FAILURE_REMEDIATION).not.toMatch(/\bretry\b/iu);
});

it("keeps non-retryable transport failures on their named fix", () => {
  expect(MCP_SHUTDOWN_FAILED).toBe(
    "REA could not close cleanly. End the REA process before starting it again.",
  );
  expect(MCP_HTTP_LISTEN_FAILED).toBe(
    "REA could not listen for MCP HTTP connections on the selected host and port. Choose another --port or stop the process using it.",
  );
  expect(MCP_SHUTDOWN_FAILED).not.toContain("Retry");
  expect(MCP_HTTP_LISTEN_FAILED).not.toContain("tell the user");
});

it("keeps ceiling dial recoveries and scrubs non-adjustable timeout teaching", async () => {
  const heap = captureDecoderHeapRecovery(DEFAULT_CAPTURE_DECODER_HEAP);
  expect(heap).toContain("source ");
  expect(heap).toContain("then restart REA");
  expect(heap).not.toContain("tell the user");
  const phase = mcpPhaseBudgetRecovery(DEFAULT_MCP_STARTUP_BUDGETS.initialize);
  expect(phase).toContain("Set ");
  expect(phase).toContain("then restart REA");
  expect(phase).not.toContain("tell the user");

  const timeout = projectAnalysisError(
    new AnalysisTimeoutError("inspect_binary_layout", 2_500),
  );
  expect(timeout.remediation.action).not.toMatch(STALE_LIMIT_COPY);
  expect(timeout.message).not.toMatch(STALE_LIMIT_COPY);

  const files = [
    "docs/user-visible-errors.csv",
    "docs/mcp-contracts.md",
    "src/server/createServer.ts",
    "src/domain/analysisErrorPresentation.ts",
    ".agents/skills/reverse-engineer-anything/SKILL.md",
    ".agents/skills/reverse-engineer-anything/references/connection-and-recovery.md",
  ];
  for (const path of files) {
    const text = await readFile(join(root, path), "utf8");
    expect(text, path).not.toMatch(STALE_LIMIT_COPY);
  }
  const catalog = await readFile(
    join(root, "docs/user-visible-errors.csv"),
    "utf8",
  );
  expect(catalog).toContain(MCP_CONNECTION_LOST);
  expect(catalog).toContain(MCP_CONNECTION_START_FAILED);
  expect(catalog).toContain(SERVER_START_FAILED);
  expect(catalog).toContain(PROCESS_UNEXPECTED_FAILURE_REMEDIATION);
  expect(catalog).toContain("analysis_timeout_ms");
  expect(catalog).toContain("REA_* setting");

  const skill = await readFile(
    join(
      root,
      ".agents/skills/reverse-engineer-anything/references/connection-and-recovery.md",
    ),
    "utf8",
  );
  const skillProse = prose(skill);
  expect(skillProse).toContain(
    "retry that call once only when it is safe to repeat or known not to have started",
  );
  expect(skillProse).toContain("tell the user REA's connection failed");
  expect(skillProse).toContain("Do not invent a setting");
  expect(skillProse).toContain("explicitly recommends that change");
  expect(skillProse).toContain("not a recommendation to change it");
  expect(skillProse).not.toContain("names a request field");
  const instructions = prose(
    await readFile(join(root, "src/server/createServer.ts"), "utf8"),
  );
  expect(instructions).toContain(
    "retry that call once only when it is safe to repeat or known not to have started",
  );
  expect(instructions).toContain("explicitly recommends that change");
  expect(instructions).toContain("not a recommendation to change it");
  expect(instructions).not.toContain("names a request field");

  const wakaru = await readFile(
    join(root, "src/javascript/recovery/RecoveryFiles.ts"),
    "utf8",
  );
  expect(wakaru).toContain(
    "Raising analysis_timeout_ms or max_heap_mb does not raise it",
  );
  for (const path of [
    "docs/mcp-contracts.md",
    "docs/user-visible-errors.csv",
  ]) {
    const text = prose(await readFile(join(root, path), "utf8"));
    expect(text, path).toContain("explicitly recommends that change");
    expect(text, path).toContain("not a recommendation to change it");
    expect(text, path).not.toContain("names a request field");
  }
});
