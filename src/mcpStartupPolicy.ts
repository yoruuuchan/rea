import type { AnalysisProviderSelector } from "./contracts/providerSelection.js";

/**
 * Supported MCP startup deadlines and operation headroom.
 *
 * Client timeouts are caller-facing configuration. The smaller phase budgets
 * preserve operational headroom, while the doctor deadline covers additional
 * inventory requests after initialization.
 */
export const MCP_STARTUP_POLICY = {
  codexStartupTimeoutSeconds: 30,
  kimiStartupTimeoutMs: 30_000,
  toolOperationHeadroomMs: 120_000,
  initializeBudgetMs: 15_000,
  toolsListBudgetMs: 5_000,
  firstCatalogBudgetMs: 20_000,
  doctorDeadlineMs: 30_000,
  doctorStderrBytes: 64 * 1024,
} as const;

/**
 * Recovery for a fixed MCP startup phase budget. Codex's startup figure is
 * client guidance and is not named here; doctor text adds that distinction
 * because its deadline uses the same 30 second magnitude.
 */
export const fixedMcpPhaseBudgetRecovery = (
  phase: string,
  value: number,
  unit: "ms" | "bytes",
): string =>
  `REA's fixed ${phase} is ${String(value)} ${unit} and this release has no runtime override.`;

/** Doctor startup recovery. The Codex figure is client guidance REA does not enforce. */
export const mcpDoctorDeadlineRecovery = (budgetMs: number): string =>
  `${fixedMcpPhaseBudgetRecovery("MCP doctor startup deadline", budgetMs, "ms")} Codex startup_timeout_sec of ${String(MCP_STARTUP_POLICY.codexStartupTimeoutSeconds)} seconds is client guidance; REA does not enforce that figure as this deadline.`;

/** Parsed startup and upstream request budgets affecting a client's tool deadline. */
export interface McpToolTimeoutInputs {
  readonly analysisProvider: AnalysisProviderSelector;
  readonly ghidraStartupTimeoutMs: number;
  readonly hopperStartupTimeoutMs: number;
  readonly jebMcpTimeoutMs?: number;
  readonly providerRequestTimeoutMs?: number;
}

/** Allow for known startup phases and caller-selected upstream request budgets. */
export const mcpProviderDeadlineAllowanceMs = (
  inputs: McpToolTimeoutInputs,
): number => {
  const selectedProvider = inputs.analysisProvider;
  const selectedTimeout =
    selectedProvider === "ghidra"
      ? inputs.ghidraStartupTimeoutMs
      : selectedProvider === "hopper"
        ? inputs.hopperStartupTimeoutMs
        : Math.max(
            inputs.ghidraStartupTimeoutMs,
            inputs.hopperStartupTimeoutMs,
          );
  return Math.max(
    selectedTimeout,
    inputs.jebMcpTimeoutMs ?? 0,
    inputs.providerRequestTimeoutMs ?? 0,
  );
};

/** Add operation headroom to the parsed provider deadline allowance. */
export const recommendedMcpToolTimeoutMs = (
  inputs: McpToolTimeoutInputs,
): number =>
  mcpProviderDeadlineAllowanceMs(inputs) +
  MCP_STARTUP_POLICY.toolOperationHeadroomMs;

/** Round up so Codex's whole-second deadline still covers the millisecond budget. */
export const recommendedMcpToolTimeoutSeconds = (
  inputs: McpToolTimeoutInputs,
): number => Math.ceil(recommendedMcpToolTimeoutMs(inputs) / 1000);
