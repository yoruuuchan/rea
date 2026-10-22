import { describe, expect, it } from "vitest";

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

import {
  createEsmModuleProfileCollector,
  mcpStartupPhaseBudgetRecovery,
  measureMcpStartup,
  parseLinuxVmRssBytes,
  profileMcpModuleLoading,
} from "../../../scripts/lib/mcp-startup-probe.mjs";
import {
  DEFAULT_MCP_STARTUP_BUDGETS,
  mcpPhaseBudgetRecovery,
  resolveMcpStartupBudgets,
  type McpPhaseBudget,
} from "../../../src/config/mcpStartupBudgets.js";
import {
  mcpDoctorDeadlineRecovery,
  MCP_STARTUP_POLICY,
} from "../../../src/mcpStartupPolicy.js";

describe("MCP startup policy", () => {
  it("names phase budget settings without turning Codex's 30s into a REA knob", () => {
    const budgets = resolveMcpStartupBudgets({});
    expect(budgets).toEqual(DEFAULT_MCP_STARTUP_BUDGETS);
    expect(MCP_STARTUP_POLICY.codexStartupTimeoutSeconds).toBe(30);
    expect(budgets.initialize.milliseconds).toBe(15_000);
    expect(budgets.toolsList.milliseconds).toBe(5_000);
    expect(budgets.firstCatalog.milliseconds).toBe(20_000);
    expect(budgets.doctor.milliseconds).toBe(30_000);
    const initialize = mcpPhaseBudgetRecovery(budgets.initialize);
    expect(initialize).toBe(
      "The effective REA_MCP_INITIALIZE_BUDGET_MS value for the MCP initialize phase budget is 15000 ms (source default; default 15000 ms, floor 1 ms, maximum 2147483647 ms). Set REA_MCP_INITIALIZE_BUDGET_MS in the environment that starts REA to a positive decimal integer from 1 to 2147483647, then restart REA.",
    );
    expect(initialize).toBe(mcpStartupPhaseBudgetRecovery(budgets.initialize));
    expect(initialize).not.toContain("no runtime override");
    expect(mcpStartupPhaseBudgetRecovery(budgets.toolsList)).toContain(
      "The effective REA_MCP_TOOLS_LIST_BUDGET_MS value for the MCP tools/list phase budget is 5000 ms (source default; default 5000 ms, floor 1 ms, maximum 2147483647 ms).",
    );
    expect(mcpStartupPhaseBudgetRecovery(budgets.firstCatalog)).toContain(
      "REA_MCP_FIRST_CATALOG_BUDGET_MS",
    );
    expect(mcpStartupPhaseBudgetRecovery(budgets.firstCatalog)).toContain(
      "20000 ms (source default",
    );
    const doctor = mcpDoctorDeadlineRecovery(budgets.doctor);
    expect(doctor).toContain(
      "The effective REA_MCP_DOCTOR_DEADLINE_MS value for the MCP doctor startup deadline is 30000 ms (source default; default 30000 ms, floor 1 ms, maximum 2147483647 ms).",
    );
    expect(doctor).toContain(
      "Set REA_MCP_DOCTOR_DEADLINE_MS in the environment that starts REA",
    );
    expect(doctor).not.toContain("no runtime override");
    expect(doctor).toContain(
      "Codex startup_timeout_sec of 30 seconds is client guidance",
    );
    expect(doctor).toContain("does not enforce");
    expect(doctor).not.toContain("REA_MCP_STARTUP");
    const selected = resolveMcpStartupBudgets({
      REA_MCP_INITIALIZE_BUDGET_MS: "16000",
    });
    expect(selected.initialize.milliseconds).toBe(16_000);
    expect(selected.initialize.source).toBe("setting");
    expect(selected.toolsList).toEqual(budgets.toolsList);
    expect(MCP_STARTUP_POLICY.codexStartupTimeoutSeconds).toBe(30);
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

const selectedBudget = (
  budget: McpPhaseBudget,
  milliseconds: number,
): McpPhaseBudget => ({
  ...budget,
  milliseconds,
  source: "setting",
});

const probePolicy = (
  overrides: Partial<{
    initializeBudgetMs: number;
    toolsListBudgetMs: number;
    firstCatalogBudgetMs: number;
    doctorDeadlineMs: number;
  }> = {},
) => {
  const generous = 30_000;
  return {
    initialize: selectedBudget(
      DEFAULT_MCP_STARTUP_BUDGETS.initialize,
      overrides.initializeBudgetMs ?? generous,
    ),
    toolsList: selectedBudget(
      DEFAULT_MCP_STARTUP_BUDGETS.toolsList,
      overrides.toolsListBudgetMs ?? generous,
    ),
    firstCatalog: selectedBudget(
      DEFAULT_MCP_STARTUP_BUDGETS.firstCatalog,
      overrides.firstCatalogBudgetMs ?? generous,
    ),
    doctor: selectedBudget(
      DEFAULT_MCP_STARTUP_BUDGETS.doctor,
      overrides.doctorDeadlineMs ?? generous,
    ),
  };
};

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
      `The effective REA_MCP_INITIALIZE_BUDGET_MS value for the MCP initialize phase budget is ${String(budgetMs)} ms (source setting; default 15000 ms, floor 1 ms, maximum 2147483647 ms).`,
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
      `The effective REA_MCP_TOOLS_LIST_BUDGET_MS value for the MCP tools/list phase budget is ${String(budgetMs)} ms (source setting; default 5000 ms, floor 1 ms, maximum 2147483647 ms).`,
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
      `The effective REA_MCP_FIRST_CATALOG_BUDGET_MS value for the MCP first-catalog phase budget is ${String(budgetMs)} ms (source setting; default 20000 ms, floor 1 ms, maximum 2147483647 ms).`,
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
      `The effective REA_MCP_DOCTOR_DEADLINE_MS value for the MCP doctor startup deadline is ${String(budgetMs)} ms (source setting; default 30000 ms, floor 1 ms, maximum 2147483647 ms).`,
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
      `The effective REA_MCP_TOOLS_LIST_BUDGET_MS value for the MCP tools/list phase budget is ${String(budgetMs)} ms (source setting; default 5000 ms, floor 1 ms, maximum 2147483647 ms).`,
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

describe("packaged MCP first-catalog budget while a phase is pending", () => {
  it("stops a pending initialize at the shorter first-catalog budget", async () => {
    const firstCatalogMs = 250;
    const initializeMs = 8_000;
    const started = performance.now();
    let caught: unknown;
    try {
      await measureMcpStartup({
        command: process.execPath,
        args: [probeChild],
        environment: { ...process.env, REA_MCP_PROBE_MODE: "hang" },
        policy: probePolicy({
          initializeBudgetMs: initializeMs,
          firstCatalogBudgetMs: firstCatalogMs,
        }),
      });
    } catch (cause) {
      caught = cause;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = errorMessage(caught);
    expect(message).toContain(
      `The effective REA_MCP_FIRST_CATALOG_BUDGET_MS value for the MCP first-catalog phase budget is ${String(firstCatalogMs)} ms (source setting; default 20000 ms, floor 1 ms, maximum 2147483647 ms).`,
    );
    expect(message).not.toContain("REA_MCP_INITIALIZE_BUDGET_MS");
    const elapsedMs = performance.now() - started;
    expect(elapsedMs).toBeLessThan(initializeMs);
    expect(elapsedMs).toBeLessThan(firstCatalogMs + 2_000);
  });

  it("stops a pending tools/list at the remaining first-catalog budget", async () => {
    const firstCatalogMs = 800;
    const toolsListMs = 8_000;
    const root = await createTestTempDirectory("rea-mcp-startup-");
    const initializedPath = join(root, "initialized");
    const started = performance.now();
    let caught: unknown;
    try {
      await measureMcpStartup({
        command: process.execPath,
        args: [probeChild],
        environment: {
          ...process.env,
          REA_MCP_PROBE_MODE: "initialize-then-hang",
          REA_MCP_PROBE_INITIALIZED_PATH: initializedPath,
        },
        policy: probePolicy({
          toolsListBudgetMs: toolsListMs,
          firstCatalogBudgetMs: firstCatalogMs,
        }),
      });
    } catch (cause) {
      caught = cause;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = errorMessage(caught);
    expect(message).toContain(
      `The effective REA_MCP_FIRST_CATALOG_BUDGET_MS value for the MCP first-catalog phase budget is ${String(firstCatalogMs)} ms (source setting; default 20000 ms, floor 1 ms, maximum 2147483647 ms).`,
    );
    expect(message).not.toContain("REA_MCP_TOOLS_LIST_BUDGET_MS");
    const elapsedMs = performance.now() - started;
    expect(elapsedMs).toBeLessThan(toolsListMs);
    expect(elapsedMs).toBeLessThan(firstCatalogMs + 2_000);
    expect(await readFile(initializedPath, "utf8")).toBe("ready");
  });

  it("returns the catalog when every phase finishes inside its budget", async () => {
    const measurement = await measureMcpStartup({
      command: process.execPath,
      args: [probeChild],
      environment: { ...process.env, REA_MCP_PROBE_MODE: "serve" },
      policy: probePolicy(),
    });
    expect(measurement.listed_tool_count).toBe(0);
    expect(measurement.process_started_to_initialized_ms).toBeGreaterThan(0);
    expect(measurement.process_started_to_tools_list_ms).toBeGreaterThan(0);
    expect(measurement.process_started_to_tools_list_ms).toBeLessThan(30_000);
  });
});
