import { expect, it as test } from "vitest";

import { projectAnalysisError } from "../../../../src/domain/analysisErrorProjection.js";
import { inspectKunaInstallation } from "../../../../src/kuna/KunaInstallation.js";
import { KunaTargetCommands } from "../../../../src/kuna/KunaTargetCommands.js";
import { fakeKunaCalls } from "./fakeKuna.js";
import { session } from "./kunaSessionFixture.js";

const it = test.skipIf(process.platform === "win32");

it("reports output beyond REA's fixed buffer as a deterministic memory bound", async () => {
  const { kuna, target, cacheRoot } = await session("rea-kuna-output-limit-");
  const installed = await inspectKunaInstallation({
    REA_KUNA_COMMAND: kuna,
    REA_KUNA_CACHE_DIR: cacheRoot,
  });
  if (!installed.ok) throw new Error(installed.error.reason);
  const controller = new AbortController();
  const commands = new KunaTargetCommands(target, {
    signal: controller.signal,
  });
  try {
    // The fake's inventory is a few hundred bytes; admit fewer.
    const result = await commands.run({
      installation: installed.value,
      operation: "list_procedures",
      arguments: (input) => ["functions", input, "--json"],
      timeoutMs: 10_000,
      outputBytes: 100,
      signal: controller.signal,
    });
    if (result.ok) throw new Error("the oversized inventory was admitted");
    expect(result.error).toMatchObject({
      _tag: "AnalysisResourceConstraintError",
      resource: "memory",
      reportedLimits: { output_limit_bytes: 100 },
      // A cut-off document's tail explains nothing; it is not returned.
      capturedOutput: { stdout: "", truncated: true },
    });
    // The same target and executable overflow the same buffer again, so the
    // caller is not told to wait and retry.
    expect(projectAnalysisError(result.error)).toMatchObject({
      code: "resource_constraint",
      retryable: false,
      remediation: {
        action:
          "REA buffers at most 100 bytes of kuna functions output, so repeating this request for this target fails the same way. Use another provider for it.",
      },
    });
  } finally {
    controller.abort();
    expect(await commands.close()).toEqual({ ok: true, value: null });
  }
});

it("reports a graph beyond REA's buffer once per session instead of rebuilding it", async () => {
  const { kuna, open } = await session("rea-kuna-graph-overflow-", {
    graph: "oversized",
  });
  const client = open();
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await client.execute("procedure_callers", {
        procedure: "0x1000",
      });
      if (result.ok) throw new Error("the oversized graph was admitted");
      expect(result.error).toMatchObject({
        _tag: "AnalysisResourceConstraintError",
        resource: "memory",
      });
      expect(projectAnalysisError(result.error).retryable).toBe(false);
    }
    // The second query reused the failure instead of walking the program again.
    expect(
      (await fakeKunaCalls(kuna)).filter(
        ({ argv }) => argv[0] === "decompile-graph",
      ),
    ).toHaveLength(1);
  } finally {
    expect(await client.close()).toEqual({ ok: true, value: null });
  }
});
