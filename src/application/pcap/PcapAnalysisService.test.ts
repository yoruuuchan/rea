import { expect, it } from "vitest";

import { PcapAnalysisService } from "./PcapAnalysisService.js";

it("preserves the exact caller reason when pcap admission is already aborted", async () => {
  const reason = Object.freeze({ requested: "stop" });
  const controller = new AbortController();
  controller.abort(reason);
  let calls = 0;
  const service = new PcapAnalysisService({
    inspectAvailability: () => Promise.reject(new Error("unused")),
    close: () => Promise.resolve(),
    execute: () => {
      calls += 1;
      return Promise.reject(new Error("provider must not run"));
    },
  });
  const result = await service.execute(
    "inspect_pcap_client",
    {},
    { signal: controller.signal },
  );
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error._tag).toBe("AnalysisCancelledError");
  expect(result.error.cause).toBe(reason);
  expect(calls).toBe(0);
});
