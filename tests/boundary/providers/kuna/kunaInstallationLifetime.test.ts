import { regularFileCancellation } from "../../../../src/filesystem/OwnedRegularFile.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const gates = vi.hoisted(() => {
  const createGate = () => {
    let enter!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { started, hold, enter, release };
  };
  return {
    createGate,
    hashClose: createGate(),
    shebangRead: createGate(),
    opens: 0,
  };
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
        const index = gates.opens++;
        return {
          get fd() {
            return handle.fd;
          },
          stat: (...statArgs: Parameters<typeof handle.stat>) =>
            handle.stat(...statArgs),
          read: async (...readArgs: Parameters<typeof handle.read>) => {
            if (index === 1) {
              gates.shebangRead.enter();
              await gates.shebangRead.hold;
            }
            return handle.read(...readArgs);
          },
          close: async () => {
            if (index === 0) {
              gates.hashClose.enter();
              await gates.hashClose.hold;
            }
            await handle.close();
          },
        } as unknown as typeof handle;
      },
    ),
  };
});

import { ArtifactResourceScope } from "../../../../src/artifacts/ArtifactResourceScope.js";
import type { FileCloseResourceOwner } from "../../../../src/application/AnalysisProvider.js";
import { inspectKunaInstallation } from "../../../../src/kuna/KunaInstallation.js";
import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";
import { writeFakeKuna } from "./fakeKuna.js";

beforeEach(() => {
  gates.opens = 0;
  gates.hashClose = gates.createGate();
  gates.shebangRead = gates.createGate();
});

afterEach(() => {
  gates.hashClose.release();
  gates.shebangRead.release();
});

it
  .skipIf(process.platform === "win32")
  .each(["hash-close", "shebang-read"] as const)(
  "keeps installation cleanup waiting for its active phase when cancelled during %s",
  async (phase) => {
    const root = await createTestTempDirectory("rea-kuna-inspection-lifetime-");
    const executable = await writeFakeKuna(root);
    const scope = new ArtifactResourceScope();
    const fileCloseResources: FileCloseResourceOwner = {
      retain: (owner, resource) =>
        scope.retain({
          kind: "lease",
          resource,
          lease: { release: () => owner.close() },
        }),
      run: (operation) => scope.run(operation),
    };
    const controller = new AbortController();
    const inspection = inspectKunaInstallation(
      { REA_KUNA_COMMAND: executable },
      { fileCloseResources, signal: controller.signal },
    );

    const inspectionOutcome = inspection.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    let cleanup: Promise<void> | undefined;
    try {
      await gates.hashClose.started;
      cleanup = scope.retryCleanup();
      let cleanupFinished = false;
      void cleanup.then(() => {
        cleanupFinished = true;
      });
      await Promise.resolve();
      expect(cleanupFinished).toBe(false);
      if (phase === "hash-close") controller.abort();
      gates.hashClose.release();
      const reachedShebang = await Promise.race([
        gates.shebangRead.started.then(() => true),
        inspection.then(
          () => false,
          () => false,
        ),
      ]);
      expect(reachedShebang).toBe(phase === "shebang-read");
      if (phase === "shebang-read") {
        controller.abort();
        await Promise.resolve();
        expect(cleanupFinished).toBe(false);
      }

      gates.shebangRead.release();
      const failure: unknown = await inspection.catch(
        (cause: unknown) => cause,
      );
      const cancellation = regularFileCancellation(failure);
      expect(cancellation).toBeDefined();
      expect(cancellation?.reason).toBe(controller.signal.reason);
      await expect(cleanup).resolves.toBeUndefined();
      expect(gates.opens).toBe(phase === "hash-close" ? 1 : 2);
      expect(scope.hasPending).toBe(false);
    } finally {
      gates.hashClose.release();
      gates.shebangRead.release();
      await inspectionOutcome;
      await cleanup;
      await scope.close();
    }
  },
);
