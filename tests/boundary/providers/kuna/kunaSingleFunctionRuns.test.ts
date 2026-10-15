import { expect, it as test } from "vitest";

import {
  fakeKunaCalls,
  fakeKunaExits,
  setFakeKunaBehavior,
} from "./fakeKuna.js";
import {
  FUNCTIONS,
  run,
  session,
  unprovenCleanupLauncher,
} from "./kunaSessionFixture.js";

const it = test.skipIf(process.platform === "win32");

const decompilesOf = async (kuna: string) =>
  (await fakeKunaCalls(kuna)).filter(({ argv }) => argv[0] === "decompile");

it("shares one single-function run among concurrent requests for one entry", async () => {
  const { kuna, open } = await session("rea-kuna-single-shared-", {
    project: "hang",
    decompileDelayMs: 300,
  });
  const client = open();
  try {
    const answers = await Promise.all(
      ["main", "main", "0x1000"].map((procedure) =>
        run(client, "procedure_pseudo_code", { procedure }),
      ),
    );
    for (const answer of answers)
      expect(answer).toMatchObject({
        result: "int main(void) // single-function\n{\n  return 0;\n}",
        rawResult: { source: { kind: "single-function" } },
      });
    expect(await decompilesOf(kuna)).toHaveLength(1);
  } finally {
    expect(await client.close()).toEqual({ ok: true, value: null });
  }
});

it("keeps a shared run for the callers still waiting when one cancels", async () => {
  const { kuna, open } = await session("rea-kuna-single-cancel-", {
    project: "hang",
    decompileDelayMs: 500,
  });
  const client = open();
  const caller = new AbortController();
  try {
    const leaving = client.execute(
      "procedure_pseudo_code",
      { procedure: "main" },
      { signal: caller.signal },
    );
    const staying = run(client, "procedure_pseudo_code", { procedure: "main" });
    await expect.poll(() => decompilesOf(kuna)).toHaveLength(1);
    caller.abort();
    expect(await leaving).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisCancelledError" },
    });
    expect((await staying).rawResult).toMatchObject({
      source: { kind: "single-function" },
    });
    const [call] = await decompilesOf(kuna);
    expect((await fakeKunaExits(kuna)).has(call?.pid ?? 0)).toBe(true);
    expect(await decompilesOf(kuna)).toHaveLength(1);
  } finally {
    caller.abort();
    expect(await client.close()).toEqual({ ok: true, value: null });
  }
});

it("admits no more concurrent single-function runs than its slots", async () => {
  const { kuna, open } = await session(
    "rea-kuna-single-slots-",
    { project: "hang", decompileDelayMs: 200 },
    {},
    undefined,
    1,
  );
  const client = open();
  try {
    await Promise.all(
      ["main", "parse"].map((procedure) =>
        run(client, "procedure_pseudo_code", { procedure }),
      ),
    );
    const [first, second] = [...(await decompilesOf(kuna))].sort(
      (left, right) => left.at - right.at,
    );
    const exits = await fakeKunaExits(kuna);
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    // The second run starts only after the first one's process finished.
    expect(second?.at).toBeGreaterThanOrEqual(exits.get(first?.pid ?? 0) ?? 0);
  } finally {
    expect(await client.close()).toEqual({ ok: true, value: null });
  }
});

it("answers a queued request from the export once it finishes first", async () => {
  const { kuna, open } = await session(
    "rea-kuna-single-yield-",
    { delayMs: 400, decompile: "hang" },
    {},
    undefined,
    1,
  );
  const client = open();
  const holder = new AbortController();
  try {
    // This run holds the only slot until its caller leaves.
    const holding = client.execute(
      "procedure_pseudo_code",
      { procedure: "main" },
      { signal: holder.signal },
    );
    await expect.poll(() => decompilesOf(kuna)).toHaveLength(1);
    const queued = await run(client, "procedure_pseudo_code", {
      procedure: "parse",
    });
    expect(queued).toMatchObject({
      result: "int parse(void)\n{\n  return 1;\n}",
      rawResult: { source: { kind: "project-export" } },
    });
    expect(await decompilesOf(kuna)).toHaveLength(1);
    holder.abort();
    expect(await holding).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisCancelledError" },
    });
  } finally {
    holder.abort();
    expect(await client.close()).toEqual({ ok: true, value: null });
  }
});

it("keeps the slot of a run whose stop is unproven until close proves it", async () => {
  const unproven = unprovenCleanupLauncher("decompile");
  const { kuna, open } = await session(
    "rea-kuna-single-retained-slot-",
    { project: "hang", decompile: "hang" },
    { REA_KUNA_TIMEOUT_MS: "300" },
    unproven.launcher,
    1,
  );
  const client = open();
  const waiter = new AbortController();
  try {
    expect(
      await client.execute("procedure_pseudo_code", { procedure: "main" }),
    ).toMatchObject({ ok: false, error: { cleanupIncomplete: true } });
    // The timed-out tree may still run, so the next run must not start.
    const queued = client.execute(
      "procedure_pseudo_code",
      { procedure: "parse" },
      { signal: waiter.signal },
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await decompilesOf(kuna)).toHaveLength(1);
    waiter.abort();
    expect(await queued).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisCancelledError" },
    });
    expect((await client.close()).ok).toBe(false);
    unproven.release();
    expect(await client.close()).toEqual({ ok: true, value: null });

    // The proven stop returns the slot to the provider.
    await setFakeKunaBehavior(kuna, { functions: FUNCTIONS, project: "hang" });
    const next = open();
    try {
      expect(
        (await run(next, "procedure_pseudo_code", { procedure: "parse" }))
          .rawResult,
      ).toMatchObject({ source: { kind: "single-function" } });
    } finally {
      expect(await next.close()).toEqual({ ok: true, value: null });
    }
  } finally {
    waiter.abort();
    unproven.release();
    await client.close();
  }
});
