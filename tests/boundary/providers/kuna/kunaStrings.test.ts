import { expect, it as test, vi } from "vitest";
import { readKunaConfiguration } from "../../../../src/kuna/KunaConfiguration.js";
import { projectAnalysisError } from "../../../../src/domain/analysisErrorProjection.js";
import { ProviderCleanupError } from "../../../../src/domain/providerCleanupError.js";

import { fakeKunaCalls, setFakeKunaBehavior } from "./fakeKuna.js";
import { run, session, unprovenCleanupLauncher } from "./kunaSessionFixture.js";

const it = test.skipIf(process.platform === "win32");
const scans = async (kuna: string) =>
  (await fakeKunaCalls(kuna)).filter(({ argv }) => argv[0] === "strings");

it("shares a typed string scan across concurrent searches and exact address reads without analysis", async () => {
  const { open, kuna } = await session("rea-kuna-strings-", {
    stringDelayMs: 50,
  });
  const client = open();
  try {
    const [literal, regex] = await Promise.all([
      run(client, "search_strings", { pattern: "FIXTURE" }),
      run(client, "search_strings", { pattern: "^δ", mode: "regex" }),
    ]);
    expect(literal.result).toEqual([
      {
        address: "0x3000",
        value: "REA fixture prompt",
        string: {
          encoding: "ascii",
          encoding_status: "observed",
          termination: "present_or_not_required",
          byte_length: 19,
        },
      },
    ]);
    expect(regex.result).toEqual([
      {
        address: "0x3020",
        value: "Δelta",
        string: {
          encoding: "utf8",
          encoding_status: "observed",
          termination: "missing",
          byte_length: 6,
        },
      },
    ]);
    expect(literal.rawResult).toMatchObject({
      strings: {
        kind: "kuna-string-inventory",
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
        inventory_count: 2,
        selected_count: 1,
        scanned: "sections",
        xrefs: false,
      },
    });
    expect(literal.limitations).toContainEqual(
      expect.stringContaining("not proof of absence"),
    );
    const exact = await run(client, "list_strings", { address: "0X00003020" });
    expect(exact.result).toEqual(regex.result);
    expect(
      (await run(client, "list_strings", { address: "0x9999" })).result,
    ).toEqual([]);
    expect(
      (
        await run(client, "search_strings", {
          pattern: "fixture",
          case_sensitive: true,
        })
      ).result,
    ).toEqual(literal.result);
    expect(
      (
        await run(client, "search_strings", {
          pattern: "FIXTURE",
          case_sensitive: true,
        })
      ).result,
    ).toEqual([]);
    expect(await scans(kuna)).toHaveLength(1);
    const commands = (await fakeKunaCalls(kuna)).map(({ argv }) => argv[0]);
    expect(commands.filter((command) => command !== "--version")).toEqual([
      "strings",
    ]);
    expect(
      await client.execute("list_strings", { address: "invalid" }),
    ).toMatchObject({ ok: false, error: { _tag: "AnalysisInputError" } });
    expect(
      await client.execute("search_strings", { pattern: "[", mode: "regex" }),
    ).toMatchObject({ ok: false, error: { _tag: "AnalysisInputError" } });
    expect((await run(client, "list_strings")).result).toHaveLength(2);
  } finally {
    expect(await client.close()).toEqual({ ok: true, value: null });
  }
});

it.each(["not-json", "miscounted"] as const)(
  "does not publish or cache a %s inventory",
  async (strings) => {
    const { open, kuna } = await session("rea-kuna-strings-invalid-", {
      strings,
    });
    const client = open();
    try {
      expect(
        await client.execute("search_strings", { pattern: "fixture" }),
      ).toMatchObject({ ok: false, error: { _tag: "AnalysisOutputError" } });
      await setFakeKunaBehavior(kuna, {});
      expect((await run(client, "list_strings")).result).toHaveLength(2);
      expect(await scans(kuna)).toHaveLength(2);
    } finally {
      expect(await client.close()).toEqual({ ok: true, value: null });
    }
  },
);

it("cancels one waiter without stopping the shared scan, and rebuilds in a fresh session", async () => {
  const { open, kuna } = await session("rea-kuna-strings-waiters-", {
    stringDelayMs: 200,
  });
  const first = open();
  try {
    const abort = new AbortController();
    const cancelled = first.execute(
      "list_strings",
      {},
      { signal: abort.signal },
    );
    const survivor = first.execute("search_strings", { pattern: "fixture" });
    await vi.waitFor(async () => expect(await scans(kuna)).toHaveLength(1));
    abort.abort();
    expect(await cancelled).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisCancelledError" },
    });
    expect(await survivor).toMatchObject({ ok: true });
    expect(await scans(kuna)).toHaveLength(1);
  } finally {
    expect(await first.close()).toEqual({ ok: true, value: null });
  }
  const fresh = open();
  try {
    await run(fresh, "list_strings");
    expect(await scans(kuna)).toHaveLength(2);
  } finally {
    expect(await fresh.close()).toEqual({ ok: true, value: null });
  }
});

it("drains a cancelled last scan before retrying", async () => {
  const { open, kuna } = await session("rea-kuna-strings-retry-", {
    strings: "hang",
  });
  const client = open();
  try {
    const abort = new AbortController();
    const pending = client.execute(
      "list_strings",
      {},
      { signal: abort.signal },
    );
    await vi.waitFor(async () => expect(await scans(kuna)).toHaveLength(1));
    abort.abort();
    expect(await pending).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisCancelledError" },
    });
    await setFakeKunaBehavior(kuna, {});
    expect((await run(client, "list_strings")).result).toHaveLength(2);
  } finally {
    expect(await client.close()).toEqual({ ok: true, value: null });
  }
});

it("retains metadata admission until a string process stop is proven", async () => {
  const cleanup = unprovenCleanupLauncher("strings");
  const { open, kuna } = await session(
    "rea-kuna-strings-owner-",
    { strings: "hang" },
    {},
    cleanup.launcher,
    1,
  );
  const client = open();
  const abort = new AbortController();
  try {
    const pending = client.execute(
      "list_strings",
      {},
      { signal: abort.signal },
    );
    await vi.waitFor(async () => expect(await scans(kuna)).toHaveLength(1));
    abort.abort();
    expect(await pending).toMatchObject({
      ok: false,
      error: expect.any(ProviderCleanupError),
    });
    const queuedAbort = new AbortController();
    const queued = client.execute(
      "procedure_callees",
      { procedure: "main" },
      { signal: queuedAbort.signal },
    );
    queuedAbort.abort();
    expect(await queued).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisCancelledError" },
    });
    expect(
      (await fakeKunaCalls(kuna)).some(
        ({ argv }) => argv[0] === "decompile-graph",
      ),
    ).toBe(false);
    expect(await client.close()).toMatchObject({
      ok: false,
      error: expect.any(ProviderCleanupError),
    });
  } finally {
    cleanup.release();
    expect(await client.close()).toEqual({ ok: true, value: null });
  }
});

it("uses the whole-program deadline independently of the single-function budget", async () => {
  const { open, kuna } = await session(
    "rea-kuna-strings-deadline-",
    { stringDelayMs: 200 },
    {
      REA_KUNA_TIMEOUT_MS: "20",
      REA_KUNA_PROJECT_TIMEOUT_MS: "1000",
    },
  );
  expect(
    readKunaConfiguration(
      {
        REA_KUNA_COMMAND: kuna,
        REA_KUNA_TIMEOUT_MS: "20",
        REA_KUNA_PROJECT_TIMEOUT_MS: "1000",
      },
      process.platform,
    ),
  ).toMatchObject({
    ok: true,
    value: { functionTimeoutMs: 20, projectTimeoutMs: 1000 },
  });
  const client = open();
  try {
    expect((await run(client, "list_strings")).result).toHaveLength(2);
  } finally {
    expect(await client.close()).toEqual({ ok: true, value: null });
  }
});

it.each([
  { starter: "list_strings", mode: "not-json", tag: "AnalysisOutputError" },
  { starter: "search_strings", mode: "not-json", tag: "AnalysisOutputError" },
  {
    starter: "list_strings",
    mode: "exit-failure",
    tag: "ProviderAdapterError",
  },
  {
    starter: "search_strings",
    mode: "exit-failure",
    tag: "ProviderAdapterError",
  },
  { starter: "list_strings", mode: "hang", tag: "AnalysisTimeoutError" },
  { starter: "search_strings", mode: "hang", tag: "AnalysisTimeoutError" },
  {
    starter: "list_strings",
    mode: "oversize",
    tag: "AnalysisResourceConstraintError",
  },
  {
    starter: "search_strings",
    mode: "oversize",
    tag: "AnalysisResourceConstraintError",
  },
] as const)(
  "keeps per-waiter context for $mode failures started by $starter",
  async ({ starter, mode, tag }) => {
    const { open, kuna } = await session(
      "rea-kuna-shared-string-failure-",
      mode === "oversize"
        ? { stringPadding: 16 * 1024 * 1024 }
        : { strings: mode },
      { REA_KUNA_PROJECT_TIMEOUT_MS: mode === "hang" ? "500" : "5000" },
    );
    const client = open();
    try {
      const other =
        starter === "list_strings" ? "search_strings" : "list_strings";
      const operations = [starter, other] as const;
      const results = await Promise.all(
        operations.map((operation) =>
          client.execute(
            operation,
            operation === "search_strings" ? { pattern: "fixture" } : {},
          ),
        ),
      );
      for (const [index, result] of results.entries()) {
        expect(result).toMatchObject({
          ok: false,
          error: {
            _tag: tag,
            operation: operations[index],
            diagnostics: { producer_operation: "kuna:strings" },
          },
        });
        if (result.ok) throw new Error("expected scan failure");
        if (mode === "exit-failure")
          expect(result.error.capturedOutput).toMatchObject({
            exit_code: 7,
            stderr: expect.stringContaining("fixture string scan failed"),
          });
        if (mode === "hang")
          expect(result.error).toMatchObject({ timeoutMs: 500 });
        if (mode === "oversize") {
          expect(projectAnalysisError(result.error)).toMatchObject({
            code: "resource_constraint",
            retryable: false,
          });
          expect(result.error.capturedOutput).toMatchObject({
            stdout: "",
            truncated: true,
          });
        }
      }
      if (results[0]?.ok === false && results[1]?.ok === false) {
        expect(results[0].error).not.toBe(results[1].error);
        expect(results[0].error.cause).toBe(results[1].error.cause);
      }
      expect(await scans(kuna)).toHaveLength(1);
      if (mode === "oversize") {
        await setFakeKunaBehavior(kuna, {});
        expect(
          await client.execute("search_strings", { pattern: "fixture" }),
        ).toMatchObject({
          ok: false,
          error: { operation: "search_strings", _tag: tag },
        });
        expect(await scans(kuna)).toHaveLength(1);
      }
    } finally {
      expect(await client.close()).toEqual({ ok: true, value: null });
    }
    if (mode === "oversize") {
      const fresh = open();
      try {
        expect((await run(fresh, "list_strings")).result).toHaveLength(2);
      } finally {
        expect(await fresh.close()).toEqual({ ok: true, value: null });
      }
    }
  },
);
