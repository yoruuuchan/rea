import { afterEach, expect, it, vi } from "vitest";

const gates = vi.hoisted(() => {
  let releaseHashClose!: () => void;
  let releaseShebangRead!: () => void;
  let hashCloseEntered!: () => void;
  let shebangReadEntered!: () => void;
  const hashClose = new Promise<void>((resolve) => {
    releaseHashClose = resolve;
  });
  const shebangRead = new Promise<void>((resolve) => {
    releaseShebangRead = resolve;
  });
  const hashCloseStarted = new Promise<void>((resolve) => {
    hashCloseEntered = resolve;
  });
  const shebangReadStarted = new Promise<void>((resolve) => {
    shebangReadEntered = resolve;
  });
  return {
    hashClose,
    hashCloseStarted,
    shebangRead,
    shebangReadStarted,
    releaseHashClose,
    releaseShebangRead,
    hashCloseEntered,
    shebangReadEntered,
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
              gates.shebangReadEntered();
              await gates.shebangRead;
            }
            return handle.read(...readArgs);
          },
          close: async () => {
            if (index === 0) {
              gates.hashCloseEntered();
              await gates.hashClose;
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

afterEach(() => {
  gates.releaseHashClose();
  gates.releaseShebangRead();
});

it.skipIf(process.platform === "win32")(
  "keeps installation inspection inside the resource owner's lifetime through shebang reading",
  async () => {
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
      await gates.hashCloseStarted;
      cleanup = scope.retryCleanup();
      controller.abort();
      gates.releaseHashClose();
      const reachedShebang = await Promise.race([
        gates.shebangReadStarted.then(() => true),
        inspection.then(
          () => false,
          () => false,
        ),
      ]);
      expect(reachedShebang).toBe(true);

      let cleanupFinished = false;
      void cleanup.then(() => {
        cleanupFinished = true;
      });
      await Promise.resolve();
      expect(cleanupFinished).toBe(false);

      gates.releaseShebangRead();
      await expect(inspection).rejects.toMatchObject({ name: "AbortError" });
      await expect(cleanup).resolves.toBeUndefined();
    } finally {
      gates.releaseHashClose();
      gates.releaseShebangRead();
      await inspectionOutcome;
      await cleanup;
      await scope.close();
    }
  },
);
