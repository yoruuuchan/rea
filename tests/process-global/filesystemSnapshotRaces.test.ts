import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

const race = vi.hoisted(() => ({
  mode: "" as
    | "readlink_missing"
    | "lstat_missing"
    | "lstat_identity_changed"
    | "directory_missing"
    | "readlink_eio"
    | "readlink_eacces"
    | "readlink_regular_replacement"
    | "cancel_readlink"
    | "cancel_readlink_missing"
    | "cancel_directory_close"
    | "",
  target: "",
  followup: false,
  opened: false,
  closeCompleted: false,
  controller: undefined as AbortController | undefined,
  reason: undefined as Error | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    readlink: async (...args: Parameters<typeof original.readlink>) => {
      const path = args[0];
      if (path === race.target && race.mode === "readlink_missing") {
        await original.rm(path);
        return original.readlink(...args);
      }
      if (path === race.target && race.mode === "readlink_eio")
        throw Object.assign(new Error("injected unexpected readlink failure"), {
          code: "EIO",
        });
      if (path === race.target && race.mode === "readlink_eacces")
        throw Object.assign(new Error("injected denied readlink"), {
          code: "EACCES",
        });
      if (
        path === race.target &&
        race.mode === "readlink_regular_replacement"
      ) {
        await original.rm(path);
        await original.writeFile(path, "replacement regular file");
      }
      if (path === race.target && race.mode === "cancel_readlink_missing") {
        await original.rm(path);
        try {
          return await original.readlink(...args);
        } catch (cause: unknown) {
          race.controller?.abort(race.reason);
          throw cause;
        }
      }
      const target = await original.readlink(...args);
      if (path === race.target) {
        if (race.mode === "lstat_missing") {
          race.followup = true;
          await original.rm(path);
        } else if (race.mode === "lstat_identity_changed") {
          const replacement = `${path}.replacement`;
          await original.symlink("replacement-target", replacement);
          await original.rm(path);
          await original.rename(replacement, path);
          race.followup = true;
        } else if (race.mode === "cancel_readlink") {
          race.controller?.abort(race.reason);
        }
      }
      return target;
    },
    lstat: async (...args: Parameters<typeof original.lstat>) => {
      const path = args[0];
      if (
        path === race.target &&
        (race.mode === "lstat_missing" ||
          race.mode === "lstat_identity_changed") &&
        race.followup
      ) {
        race.followup = false;
        return original.lstat(...args);
      }
      if (
        path === race.target &&
        race.mode === "directory_missing" &&
        race.opened
      ) {
        race.mode = "";
        race.opened = false;
        await original.rm(path, { recursive: true });
        return original.lstat(...args);
      }
      return original.lstat(...args);
    },
    opendir: async (...args: Parameters<typeof original.opendir>) => {
      const directory = await original.opendir(...args);
      if (args[0] === race.target && race.mode === "directory_missing")
        race.opened = true;
      if (args[0] === race.target && race.mode === "cancel_directory_close") {
        const iterator = directory[Symbol.asyncIterator]();
        let closed = false;
        const closeBeforeCancel = async () => {
          if (closed) return;
          closed = true;
          try {
            await directory.close();
          } catch (cause: unknown) {
            if (
              !(cause instanceof Error) ||
              !("code" in cause) ||
              cause.code !== "ERR_DIR_CLOSED"
            )
              throw cause;
          }
          race.closeCompleted = true;
          race.controller?.abort(race.reason);
        };
        const wrappedIterator = {
          [Symbol.asyncIterator]() {
            return this;
          },
          async next() {
            const next = await iterator.next();
            if (next.done) await closeBeforeCancel();
            return next;
          },
          async return() {
            const result = await iterator.return?.();
            await closeBeforeCancel();
            return result ?? { done: true, value: undefined };
          },
        };
        return new Proxy(directory, {
          get(target, property, receiver) {
            if (property === Symbol.asyncIterator) return () => wrappedIterator;
            return Reflect.get(target, property, receiver);
          },
        });
      }
      // The selected directory's next lstat is snapshotRoots' post-enumeration
      // identity check. The deletion itself happens in that lstat wrapper.
      return directory;
    },
  };
});

import { parseProcessScenario } from "../../src/domain/process/processScenario.js";
import { classifyFilesystemEffects } from "../../src/process/capture/ProcessFilesystemEffects.js";
import { snapshotRoots } from "../../src/process/capture/FilesystemSnapshot.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";

const resetRace = () => {
  race.mode = "";
  race.target = "";
  race.followup = false;
  race.opened = false;
  race.closeCompleted = false;
  race.controller = undefined;
  race.reason = undefined;
};

afterEach(resetRace);

const withTemporaryRoot = async <Value>(
  prefix: string,
  run: (root: string) => Promise<Value>,
): Promise<Value> => {
  const root = await createTestTempDirectory(prefix);
  try {
    return await run(root);
  } finally {
    resetRace();
    await rm(root, { recursive: true, force: true });
  }
};

const entryUnavailable = async (
  mode:
    | "readlink_missing"
    | "lstat_missing"
    | "readlink_eacces"
    | "readlink_regular_replacement",
  systemCode: string,
) => {
  await withTemporaryRoot("rea-snapshot-entry-race-", async (root) => {
    const sibling = join(root, "a-sibling");
    const link = join(root, "z-link");
    await writeFile(sibling, "retain this sibling");
    await symlink("missing-target", link);
    const scenario = parseProcessScenario({
      executable: process.execPath,
      working_directory: root,
      filesystem_observation_paths: [root],
    });
    const before = await snapshotRoots(scenario);
    race.mode = mode;
    race.target = link;
    const after = await snapshotRoots(scenario);
    expect(after.files.map(({ path }) => path)).toContain("root_0:a-sibling");
    expect(after.files.map(({ path }) => path)).not.toContain("root_0:z-link");
    expect(after.completeRoots).toEqual([]);
    expect(after.coverage).toMatchObject({
      enumeration_truncated: true,
      enumeration_reasons: ["entry_unavailable"],
      enumeration_omissions: [
        {
          path: "root_0:z-link",
          reason: "entry_unavailable",
          system_code: systemCode,
        },
      ],
    });
    expect(
      classifyFilesystemEffects(before, after).find(
        ({ path }) => path === "root_0:z-link",
      ),
    ).toMatchObject({
      status: "unknown",
      reason: expect.stringContaining("absence remains unknown"),
    });
  });
};

it.skipIf(process.platform === "win32").each([
  { name: "readlink ENOENT", mode: "readlink_missing", systemCode: "ENOENT" },
  {
    name: "follow-up lstat ENOENT",
    mode: "lstat_missing",
    systemCode: "ENOENT",
  },
  { name: "readlink EACCES", mode: "readlink_eacces", systemCode: "EACCES" },
  {
    name: "regular-file replacement (readlink EINVAL)",
    mode: "readlink_regular_replacement",
    systemCode: "EINVAL",
  },
] as const)(
  "retains sibling observations after $name",
  async ({ mode, systemCode }) => {
    await entryUnavailable(mode, systemCode);
  },
);

it.skipIf(process.platform === "win32")(
  "records known symlink identity replacement separately from unavailable entries",
  async () =>
    withTemporaryRoot("rea-snapshot-link-identity-", async (root) => {
      const sibling = join(root, "a-sibling");
      const link = join(root, "z-link");
      await writeFile(sibling, "retain this sibling");
      await symlink("original-target", link);
      const scenario = parseProcessScenario({
        executable: process.execPath,
        working_directory: root,
        filesystem_observation_paths: [root],
      });
      const before = await snapshotRoots(scenario);
      race.mode = "lstat_identity_changed";
      race.target = link;
      const after = await snapshotRoots(scenario);
      expect(after.files.map(({ path }) => path)).toContain("root_0:a-sibling");
      expect(after.files.map(({ path }) => path)).not.toContain(
        "root_0:z-link",
      );
      expect(after.completeRoots).toEqual([]);
      expect(after.coverage.enumeration_reasons).toEqual(["identity_changed"]);
      expect(after.coverage.enumeration_omissions).toContainEqual({
        path: "root_0:z-link",
        reason: "identity_changed",
        system_code: null,
      });
      expect(
        classifyFilesystemEffects(before, after).find(
          ({ path }) => path === "root_0:z-link",
        )?.status,
      ).toBe("unknown");
    }),
);

it("retains siblings and marks child absence unknown when directory revalidation sees ENOENT", async () =>
  withTemporaryRoot("rea-snapshot-directory-race-", async (root) => {
    const sibling = join(root, "a-sibling");
    const directory = join(root, "z-directory");
    await writeFile(sibling, "retain this sibling");
    await mkdir(directory);
    await writeFile(join(directory, "child"), "child observed before race");
    const scenario = parseProcessScenario({
      executable: process.execPath,
      working_directory: root,
      filesystem_observation_paths: [root],
    });
    const before = await snapshotRoots(scenario);
    race.mode = "directory_missing";
    race.target = directory;
    const after = await snapshotRoots(scenario);
    expect(after.files.map(({ path }) => path)).toContain("root_0:a-sibling");
    expect(after.files.map(({ path }) => path)).toContain("root_0:z-directory");
    expect(after.files.map(({ path }) => path)).not.toContain(
      join("root_0:z-directory", "child"),
    );
    expect(after.completeRoots).toEqual([]);
    expect(after.coverage.enumeration_reasons).toEqual(["entry_unavailable"]);
    expect(after.coverage.enumeration_omissions).toContainEqual({
      path: "root_0:z-directory",
      reason: "entry_unavailable",
      system_code: "ENOENT",
    });
    expect(
      classifyFilesystemEffects(before, after).find(
        ({ path }) => path === join("root_0:z-directory", "child"),
      ),
    ).toMatchObject({ status: "unknown" });
  }));

it.skipIf(process.platform === "win32")(
  "propagates cancellation exactly during symlink read",
  async () =>
    withTemporaryRoot("rea-snapshot-cancel-race-", async (root) => {
      const link = join(root, "link");
      await symlink("missing-target", link);
      const scenario = parseProcessScenario({
        executable: process.execPath,
        working_directory: root,
        filesystem_observation_paths: [root],
      });
      const controller = new AbortController();
      const reason = new Error("cancel during symlink read");
      race.mode = "cancel_readlink";
      race.target = link;
      race.controller = controller;
      race.reason = reason;
      await expect(snapshotRoots(scenario, controller.signal)).rejects.toBe(
        reason,
      );
    }),
);

it.skipIf(process.platform === "win32")(
  "prefers the exact cancellation reason over ENOENT from the pending readlink",
  async () =>
    withTemporaryRoot("rea-snapshot-cancel-missing-", async (root) => {
      const link = join(root, "link");
      await symlink("missing-target", link);
      const scenario = parseProcessScenario({
        executable: process.execPath,
        working_directory: root,
        filesystem_observation_paths: [root],
      });
      const controller = new AbortController();
      const reason = new Error("cancel while readlink reports ENOENT");
      race.mode = "cancel_readlink_missing";
      race.target = link;
      race.controller = controller;
      race.reason = reason;
      await expect(snapshotRoots(scenario, controller.signal)).rejects.toBe(
        reason,
      );
    }),
);

it("observes cancellation after the selected directory iterator closes", async () =>
  withTemporaryRoot("rea-snapshot-directory-close-cancel-", async (root) => {
    const directory = join(root, "selected");
    await mkdir(directory);
    await writeFile(join(directory, "child"), "observed child");
    const scenario = parseProcessScenario({
      executable: process.execPath,
      working_directory: root,
      filesystem_observation_paths: [directory],
    });
    const controller = new AbortController();
    const reason = new Error("cancel after directory iterator close");
    race.mode = "cancel_directory_close";
    race.target = directory;
    race.controller = controller;
    race.reason = reason;
    await expect(snapshotRoots(scenario, controller.signal)).rejects.toBe(
      reason,
    );
    expect(race.closeCompleted).toBe(true);
  }));

it("releases buffered names after a failed directory revalidation before visiting the next root", async () =>
  withTemporaryRoot("rea-snapshot-pending-names-", async (parent) => {
    const firstRoot = join(parent, "first");
    const secondRoot = join(parent, "second");
    await mkdir(firstRoot);
    await mkdir(secondRoot);
    await writeFile(join(firstRoot, "a-child"), "first");
    await writeFile(join(firstRoot, "b-child"), "second");
    await writeFile(join(secondRoot, "child"), "retain this root");
    const scenario = parseProcessScenario({
      executable: process.execPath,
      working_directory: parent,
      filesystem_observation_paths: [firstRoot, secondRoot],
      limits: { files: 4 },
    });
    race.mode = "directory_missing";
    race.target = firstRoot;
    const after = await snapshotRoots(scenario);
    expect(after.files.map(({ path }) => path)).toContain("root_1:child");
    expect(after.completeRoots).toEqual(["root_1"]);
    expect(after.coverage.enumeration_omissions).toContainEqual({
      path: "root_0:.",
      reason: "entry_unavailable",
      system_code: "ENOENT",
    });
  }));

it.skipIf(process.platform === "win32")(
  "propagates unexpected EIO instead of classifying it as an unavailable entry",
  async () =>
    withTemporaryRoot("rea-snapshot-eio-control-", async (root) => {
      const link = join(root, "link");
      await symlink("missing-target", link);
      const scenario = parseProcessScenario({
        executable: process.execPath,
        working_directory: root,
        filesystem_observation_paths: [root],
      });
      race.mode = "readlink_eio";
      race.target = link;
      await expect(snapshotRoots(scenario)).rejects.toMatchObject({
        code: "EIO",
      });
    }),
);
