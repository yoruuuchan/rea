import { describe, expect, it } from "vitest";

import { forgetPendingMcpRequest } from "./EvidenceMcpServer.js";

describe("MCP request bookkeeping", () => {
  it("releases list, tool, and completion state when cancellation arrives", () => {
    const completion = new AbortController();
    const pendingTools = new Map([[7, "inspect_artifact"]]);
    const pendingToolLists = new Set([7]);
    const pendingCompletions = new Map([[7, completion]]);

    forgetPendingMcpRequest(
      pendingTools,
      pendingToolLists,
      pendingCompletions,
      7,
    );

    expect(pendingTools.has(7)).toBe(false);
    expect(pendingToolLists.has(7)).toBe(false);
    expect(completion.signal.aborted).toBe(true);
    expect(pendingCompletions.has(7)).toBe(false);
  });
});
