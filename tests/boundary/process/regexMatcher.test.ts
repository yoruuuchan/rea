import { expect, it } from "vitest";

import { ok } from "../../../src/domain/result.js";
import { HopperRegexSearch } from "../../../src/hopper/HopperRegexSearch.js";
import { OFFICIAL_TOOL_CONTRACTS } from "../../../src/contracts/officialToolContracts.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import {
  matchRegexValues,
  REGEX_MATCHING_LIMITATION,
  regexMatchingDeadlineError,
  regexWorkerHeapError,
} from "../../../src/process/RegexMatcher.js";

it("names the fixed regex deadline and heap and says neither has an override", () => {
  expect(REGEX_MATCHING_LIMITATION).toContain("5-second matching deadline");
  expect(REGEX_MATCHING_LIMITATION).toContain("128 MiB");
  expect(REGEX_MATCHING_LIMITATION).toContain(
    "This release has no runtime override",
  );
  const deadline = projectAnalysisError(
    regexMatchingDeadlineError("search_procedures"),
  );
  expect(deadline.message).toContain("5000 ms");
  expect(deadline.remediation.action).toContain(
    "this release has no runtime override",
  );
  const heap = projectAnalysisError(
    regexWorkerHeapError("search_procedures", new Error("heap")),
  );
  expect(heap.message).toContain("128 MiB");
  expect(heap.remediation.action).toContain(
    "additional host memory do not raise it",
  );
  for (const name of ["search_procedures", "search_strings"] as const) {
    const description = OFFICIAL_TOOL_CONTRACTS.find(
      (tool) => tool.name === name,
    )?.description;
    expect(description).toContain("5000 ms");
    expect(description).toContain("no runtime override");
  }
});

it("preserves Unicode matching order and refuses a pre-cancelled match", async () => {
  expect(
    await matchRegexValues({
      operation: "search_procedures",
      pattern: "^δ",
      caseSensitive: false,
      values: ["Δelta", "delta", "δίκη"],
    }),
  ).toEqual(ok([0, 2]));
  expect(
    await matchRegexValues({
      operation: "search_procedures",
      pattern: ".",
      caseSensitive: true,
      values: ["value"],
      signal: AbortSignal.abort(),
    }),
  ).toMatchObject({ ok: false, error: { _tag: "AnalysisCancelledError" } });
});

it("keeps Hopper's result projection and invalid-pattern contract with the shared worker", async () => {
  const search = new HopperRegexSearch({
    callTool: async () =>
      ok([
        { address: "0x10", value: "Δelta" },
        { address: "0x20", value: "other" },
      ]),
  });
  expect(
    await search.execute("search_strings", { pattern: "^δ", mode: "regex" }),
  ).toEqual(ok([{ address: "0x10", value: "Δelta" }]));
  expect(
    await search.execute("search_strings", { pattern: "[", mode: "regex" }),
  ).toMatchObject({
    ok: false,
    error: {
      _tag: "HopperRemoteError",
      code: -32000,
      diagnosticType: "invalid_request",
      operation: "search_strings",
    },
  });
  await search.close();
});
