import { describe, expect, it } from "vitest";
import {
  createAnalysisExecution,
  type AnalysisOperation,
  type AnalysisOperationPort,
} from "./AnalysisProvider.js";
import { AnalysisInputError } from "../domain/analysisErrorCore.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { err, ok } from "../domain/result.js";
import { EnhancedTools } from "./EnhancedTools.js";

const provider = { id: "fixture", name: "Fixture", version: "1" };

interface RecordedCall {
  readonly operation: AnalysisOperation;
  readonly procedure: unknown;
  readonly origin: unknown;
}

/** Port that knows `main` (0x1000, calling 0x2000) and rejects `nosuch`. */
const recordingPort = () => {
  const calls: RecordedCall[] = [];
  const sentParameters: Readonly<Record<string, JsonValue>>[] = [];
  const port: AnalysisOperationPort = {
    execute: async (operation, parameters, options) => {
      sentParameters.push(parameters);
      calls.push({
        operation,
        procedure: parameters.procedure,
        origin: options?.selectorOrigin,
      });
      const known = (value: JsonValue) =>
        ok(createAnalysisExecution(value, provider));
      if (parameters.procedure === "nosuch")
        return err(new AnalysisInputError(operation));
      switch (operation) {
        case "procedure_address":
          return known(parameters.procedure === "main" ? "0x1000" : "0x2000");
        case "procedure_callees":
          return known(parameters.procedure === "0x1000" ? ["0x2000"] : []);
        case "procedure_pseudo_code":
          return known("int main(void) { return 0; }");
        case "address_name":
          return known("main");
        default:
          throw new Error(`Unexpected operation: ${operation}`);
      }
    },
  };
  return { calls, sentParameters, tools: new EnhancedTools(port) };
};

const of = (
  calls: readonly RecordedCall[],
  operation: AnalysisOperation,
): RecordedCall[] => calls.filter((call) => call.operation === operation);

describe("selector origin of composed workflows", () => {
  it("marks every call-graph expansion as provider-derived and the root selector as caller-supplied", async () => {
    const { calls, tools } = recordingPort();

    const result = await tools.execute("get_call_graph", { address: "main" });

    expect(result.ok, "the graph is built").toBe(true);
    expect(
      of(calls, "procedure_address"),
      "the caller's selector carries no provider origin",
    ).toEqual([
      { operation: "procedure_address", procedure: "main", origin: undefined },
    ]);
    expect(
      of(calls, "procedure_callees"),
      "the canonical start and every discovered callee are provider-derived",
    ).toEqual([
      {
        operation: "procedure_callees",
        procedure: "0x1000",
        origin: "provider",
      },
      {
        operation: "procedure_callees",
        procedure: "0x2000",
        origin: "provider",
      },
    ]);
  });

  it("marks trace expansions as provider-derived and the start and goal as caller-supplied", async () => {
    const { calls, tools } = recordingPort();

    const result = await tools.execute("trace_call_path", {
      start: "main",
      goal: "0x2000",
    });

    expect(result.ok, "the trace completes").toBe(true);
    expect(
      of(calls, "procedure_address").map(({ origin }) => origin),
      "start and goal resolutions are caller-supplied",
    ).toEqual([undefined, undefined]);
    expect(
      of(calls, "procedure_callees").map(({ origin }) => origin),
      "expansion of the resolved start is provider-derived",
    ).toEqual(["provider"]);
  });

  it("marks the canonical retry of batch_decompile as derived and keeps the unresolved fallback caller-supplied", async () => {
    const { calls, tools } = recordingPort();

    const result = await tools.execute("batch_decompile", {
      addresses: ["main", "nosuch"],
    });

    expect(result.ok, "per-item failures do not fail the batch").toBe(true);
    expect(
      of(calls, "procedure_pseudo_code")
        .map(({ procedure, origin }) => [procedure, origin])
        .sort(([left], [right]) => String(left).localeCompare(String(right))),
      "the resolved canonical address is derived; the failed item keeps the caller's text",
    ).toEqual([
      ["0x1000", "provider"],
      ["nosuch", undefined],
    ]);
  });

  it("never copies the origin into the parameters sent to the provider", async () => {
    const { sentParameters, tools } = recordingPort();

    await tools.execute("get_call_graph", { address: "main" });
    await tools.execute("trace_call_path", { start: "main" });
    await tools.execute("batch_decompile", { addresses: ["main"] });

    expect(
      sentParameters.length,
      "workflows issued provider calls",
    ).toBeGreaterThan(0);
    expect(
      sentParameters.some((parameters) => "selectorOrigin" in parameters),
      "the origin travels in the options only, never in Evidence-bound parameters",
    ).toBe(false);
  });
});
