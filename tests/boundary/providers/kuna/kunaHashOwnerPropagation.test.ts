import { afterEach, expect, it, vi } from "vitest";

const injected = vi.hoisted(() => ({
  failNextClose: false,
  holdCloseFailures: false,
  releaseCloseFailures: false,
  closeCalls: 0,
  handles: [] as import("node:fs/promises").FileHandle[],
}));

afterEach(async () => {
  injected.failNextClose = false;
  injected.holdCloseFailures = false;
  injected.releaseCloseFailures = false;
  injected.closeCalls = 0;
  for (const handle of injected.handles.splice(0))
    if (handle.fd >= 0) await handle.close();
});

vi.mock("../../../../src/filesystem/RegularFile.js", async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import("../../../../src/filesystem/RegularFile.js")
    >();
  return {
    ...original,
    openRegularFile: vi.fn(
      async (...args: Parameters<typeof original.openRegularFile>) => {
        const handle = await original.openRegularFile(...args);
        injected.handles.push(handle);
        if (!injected.failNextClose && !injected.holdCloseFailures)
          return handle;
        injected.failNextClose = false;
        return {
          get fd() {
            return handle.fd;
          },
          stat: (...statArgs: Parameters<typeof handle.stat>) =>
            handle.stat(...statArgs),
          read: (...readArgs: Parameters<typeof handle.read>) =>
            handle.read(...readArgs),
          close: async () => {
            injected.closeCalls += 1;
            if (
              injected.closeCalls === 1 ||
              (injected.holdCloseFailures && !injected.releaseCloseFailures)
            )
              throw new Error("injected close fault");
            await handle.close();
          },
        } as unknown as typeof handle;
      },
    ),
  };
});

import { AnalysisProviderRegistry } from "../../../../src/application/binary/AnalysisProviderRegistry.js";
import { composeBinarySession } from "../../../../src/application/binary/BinarySessionComposition.js";
import { KunaTargetCommands } from "../../../../src/kuna/KunaTargetCommands.js";
import { inspectKunaProvider } from "../../../../src/kuna/KunaDoctor.js";
import { inspectKunaInstallation } from "../../../../src/kuna/KunaInstallation.js";
import { fakeKunaCalls } from "./fakeKuna.js";
import { session } from "./kunaSessionFixture.js";

it.skipIf(process.platform === "win32")(
  "retains and retries the exact Kuna executable hash owner without running Kuna",
  async () => {
    const fixture = await session("rea-kuna-hash-owner-");
    const installed = await inspectKunaInstallation({
      REA_KUNA_COMMAND: fixture.kuna,
      REA_KUNA_CACHE_DIR: fixture.cacheRoot,
    });
    if (!installed.ok) throw new Error(installed.error.reason);
    const controller = new AbortController();
    const commands = new KunaTargetCommands(fixture.target, {
      signal: controller.signal,
    });
    injected.closeCalls = 0;
    injected.failNextClose = true;
    try {
      const result = await commands.run({
        installation: installed.value,
        operation: "list_procedures",
        arguments: (input) => ["functions", input, "--json"],
        timeoutMs: 10_000,
        outputBytes: 1024 * 1024,
        signal: controller.signal,
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("Kuna command unexpectedly ran");
      expect(result.error).toMatchObject({
        cleanupIncomplete: true,
        cleanupResources: [installed.value.executable],
      });
      expect(await commands.close()).toEqual({ ok: true, value: null });
      expect(injected.closeCalls).toBe(2);
      expect(
        (await fakeKunaCalls(fixture.kuna)).map(({ argv }) => argv),
      ).toEqual([["--version"], ["--version"]]);
    } finally {
      controller.abort();
      const closed = await commands.close();
      if (!closed.ok) throw closed.error;
    }
  },
);

it.skipIf(process.platform === "win32")(
  "drains a Kuna candidate's retained hash owner when the binary session closes without an active client",
  async () => {
    const fixture = await session("rea-kuna-candidate-hash-owner-");
    const binary = composeBinarySession(
      new AnalysisProviderRegistry([fixture.provider]),
    );
    injected.closeCalls = 0;
    injected.holdCloseFailures = true;
    injected.releaseCloseFailures = false;

    const resolved = await fixture.provider.resolveAnalysisProfile(
      fixture.target,
    );
    expect(resolved.ok).toBe(false);
    if (resolved.ok) throw new Error("Kuna readiness unexpectedly succeeded");
    expect(resolved.error).toMatchObject({
      cleanupIncomplete: true,
      cleanupResources: [fixture.kuna],
    });
    expect(injected.closeCalls).toBe(2);
    expect(binary.status()).toMatchObject({
      open: false,
      cleanup_pending: true,
    });

    expect(await binary.close()).toMatchObject({
      ok: false,
      error: {
        cleanupIncomplete: true,
        cleanupResources: [fixture.kuna],
      },
    });
    expect(injected.closeCalls).toBe(3);
    expect(binary.status()).toMatchObject({ cleanup_pending: true });

    injected.releaseCloseFailures = true;
    expect(await binary.close()).toEqual({ ok: true, value: null });
    expect(injected.closeCalls).toBe(4);
    expect(binary.status()).toMatchObject({ cleanup_pending: false });
    expect((await fakeKunaCalls(fixture.kuna)).map(({ argv }) => argv)).toEqual(
      [["--version"], ["--version"]],
    );
  },
);

it.skipIf(process.platform === "win32")(
  "returns the exact Kuna doctor owner when no lifecycle sink was supplied",
  async () => {
    const fixture = await session("rea-kuna-doctor-hash-owner-");
    injected.closeCalls = 0;
    injected.failNextClose = true;
    let failure: unknown;
    try {
      await inspectKunaProvider({
        REA_KUNA_COMMAND: fixture.kuna,
        REA_KUNA_CACHE_DIR: fixture.cacheRoot,
      });
    } catch (cause: unknown) {
      failure = cause;
    }
    expect(failure).toMatchObject({
      name: "KunaDoctorHashCleanupFailure",
      readinessFailure: { code: "hash_cleanup_failed" },
      cleanupCause: expect.any(Error),
      owner: { handle: { fd: expect.any(Number) } },
    });
    const owned = failure as {
      readonly owner: { close(): Promise<void> };
    };
    await owned.owner.close();
    expect(injected.closeCalls).toBe(2);
    expect((await fakeKunaCalls(fixture.kuna)).map(({ argv }) => argv)).toEqual(
      [["--version"], ["--version"]],
    );
  },
);
