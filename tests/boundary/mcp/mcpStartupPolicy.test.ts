import { describe, expect, it } from "vitest";

import { resolve } from "node:path";

import {
  createEsmModuleProfileCollector,
  fixedMcpStartupPhaseBudgetRecovery,
  measureMcpStartup,
  parseLinuxVmRssBytes,
  profileMcpModuleLoading,
} from "../../../scripts/lib/mcp-startup-probe.mjs";
import {
  fixedMcpPhaseBudgetRecovery,
  mcpDoctorDeadlineRecovery,
  MCP_STARTUP_POLICY,
} from "../../../src/mcpStartupPolicy.js";

describe("MCP startup policy", () => {
  it("names fixed phase budgets without turning Codex's 30s into a REA knob", () => {
    const initialize = fixedMcpPhaseBudgetRecovery(
      "MCP initialize phase budget",
      MCP_STARTUP_POLICY.initializeBudgetMs,
      "ms",
    );
    expect(initialize).toBe(
      "REA's fixed MCP initialize phase budget is 15000 ms and this release has no runtime override.",
    );
    expect(initialize).toBe(
      fixedMcpStartupPhaseBudgetRecovery(
        "MCP initialize phase budget",
        MCP_STARTUP_POLICY.initializeBudgetMs,
        "ms",
      ),
    );
    expect(
      fixedMcpStartupPhaseBudgetRecovery(
        "MCP tools/list phase budget",
        MCP_STARTUP_POLICY.toolsListBudgetMs,
        "ms",
      ),
    ).toContain("5000 ms");
    expect(
      fixedMcpStartupPhaseBudgetRecovery(
        "MCP first-catalog phase budget",
        MCP_STARTUP_POLICY.firstCatalogBudgetMs,
        "ms",
      ),
    ).toContain("20000 ms");
    const doctor = mcpDoctorDeadlineRecovery(
      MCP_STARTUP_POLICY.doctorDeadlineMs,
    );
    expect(doctor).toContain("30000 ms");
    expect(doctor).toContain("no runtime override");
    expect(doctor).toContain(
      "Codex startup_timeout_sec of 30 seconds is client guidance",
    );
    expect(doctor).toContain("does not enforce");
    expect(doctor).not.toContain("REA_MCP_STARTUP");
  });

  it("parses Linux resident memory without accepting other fields", () => {
    expect(
      parseLinuxVmRssBytes("Name:\tnode\nVmRSS:\t  12345 kB\nThreads:\t7\n"),
    ).toBe(12_641_280);
    expect(parseLinuxVmRssBytes("VmSize:\t12345 kB\n")).toBeNull();
  });

  it("profiles unique file-backed ESM modules without retaining paths", () => {
    const collector = createEsmModuleProfileCollector();
    collector.append(
      "ESM 1: Storing file:///opt/rea/dist/main.js\n" +
        "ESM 1: Translating StandardModule file:///opt/rea/dist/main.js\n" +
        "ESM 1: Storing file:///opt/rea/node_modules/zod/index.js",
    );

    expect(collector.result()).toEqual({
      supported: true,
      method: "node-debug-esm",
      unique_file_modules: 2,
      unique_package_modules: 0,
      unique_dependency_modules: 1,
      debug_lines: 3,
      truncated: false,
    });
  });
});

const probeChild = resolve("tests/fixtures/mcpStartupProbeChild.mjs");

const probePolicy = (
  overrides: Partial<{
    initializeBudgetMs: number;
    toolsListBudgetMs: number;
    firstCatalogBudgetMs: number;
    doctorDeadlineMs: number;
  }> = {},
) => ({
  initializeBudgetMs: 30_000,
  toolsListBudgetMs: 30_000,
  firstCatalogBudgetMs: 30_000,
  doctorDeadlineMs: 30_000,
  ...overrides,
});

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

describe("packaged MCP startup probe failures", () => {
  it("names the initialize budget when that phase times out", async () => {
    const budgetMs = 200;
    await expect(
      measureMcpStartup({
        command: process.execPath,
        args: [probeChild],
        environment: { ...process.env, REA_MCP_PROBE_MODE: "hang" },
        policy: probePolicy({ initializeBudgetMs: budgetMs }),
      }),
    ).rejects.toThrow(
      `MCP initialize phase budget is ${String(budgetMs)} ms and this release has no runtime override.`,
    );
  });

  it("names the tools/list budget when that phase times out", async () => {
    const budgetMs = 200;
    await expect(
      measureMcpStartup({
        command: process.execPath,
        args: [probeChild],
        environment: {
          ...process.env,
          REA_MCP_PROBE_MODE: "initialize-then-hang",
        },
        policy: probePolicy({ toolsListBudgetMs: budgetMs }),
      }),
    ).rejects.toThrow(
      `MCP tools/list phase budget is ${String(budgetMs)} ms and this release has no runtime override.`,
    );
  });

  it("names the first-catalog budget when startup exceeds it", async () => {
    const budgetMs = 1;
    await expect(
      measureMcpStartup({
        command: process.execPath,
        args: [probeChild],
        environment: { ...process.env, REA_MCP_PROBE_MODE: "serve" },
        policy: probePolicy({ firstCatalogBudgetMs: budgetMs }),
      }),
    ).rejects.toThrow(
      `MCP first-catalog phase budget is ${String(budgetMs)} ms and this release has no runtime override.`,
    );
  });

  it("does not add timeout guidance to an unrelated startup failure", async () => {
    try {
      await measureMcpStartup({
        command: process.execPath,
        args: [probeChild],
        environment: { ...process.env, REA_MCP_PROBE_MODE: "fail" },
        policy: probePolicy(),
      });
      throw new Error("expected the unrelated probe failure");
    } catch (cause) {
      const message = errorMessage(cause);
      expect(message).toContain("unrelated probe failure");
      expect(message).not.toContain("expected the unrelated probe failure");
      expect(message).not.toContain("no runtime override");
      expect(message).not.toContain("phase budget");
    }
  });

  it("names the doctor deadline when module profiling cannot initialize", async () => {
    const budgetMs = 200;
    await expect(
      profileMcpModuleLoading({
        command: process.execPath,
        args: [probeChild],
        environment: { ...process.env, REA_MCP_PROBE_MODE: "hang" },
        policy: probePolicy({ doctorDeadlineMs: budgetMs }),
        packageName: "rea-agents",
      }),
    ).rejects.toThrow(
      `MCP doctor startup deadline is ${String(budgetMs)} ms and this release has no runtime override.`,
    );
  });

  it("names the tools/list budget when module profiling passes initialize", async () => {
    const budgetMs = 200;
    await expect(
      profileMcpModuleLoading({
        command: process.execPath,
        args: [probeChild],
        environment: {
          ...process.env,
          REA_MCP_PROBE_MODE: "initialize-then-hang",
        },
        policy: probePolicy({ toolsListBudgetMs: budgetMs }),
        packageName: "rea-agents",
      }),
    ).rejects.toThrow(
      `MCP tools/list phase budget is ${String(budgetMs)} ms and this release has no runtime override.`,
    );
  });

  it("does not add timeout guidance to an unrelated module-profile failure", async () => {
    try {
      await profileMcpModuleLoading({
        command: process.execPath,
        args: [probeChild],
        environment: { ...process.env, REA_MCP_PROBE_MODE: "fail" },
        policy: probePolicy(),
        packageName: "rea-agents",
      });
      throw new Error("expected the unrelated probe failure");
    } catch (cause) {
      const message = errorMessage(cause);
      expect(message).not.toContain("expected the unrelated probe failure");
      expect(message).not.toContain("no runtime override");
      expect(message).not.toContain("phase budget");
      expect(message).not.toContain("MCP doctor startup deadline");
    }
  });
});
