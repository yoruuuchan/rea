import { chmod, copyFile, mkdir, readdir, rm, rmdir } from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";

import { describe, expect, onTestFinished } from "vitest";
import { z } from "zod";

import { workspaceCliTest } from "../../support/cli/workspaceCliFixture.js";

import { HOPPER_TARGET_LEASE_DIRECTORY } from "../../../src/hopper/HopperTargetLease.js";

const FAILED_LAUNCHER = `#!/bin/sh
printf 'Cannot launch Hopper!\\nNot authorized to send Apple events to Hopper Disassembler.\\n' >&2
exit 2
`;

/** The private runtime directory a failed launch reports as retained. */
const RetainedRuntime = z.object({
  details: z.object({
    diagnostics: z.object({
      cleanup_error: z.object({
        details: z.object({
          diagnostics: z.object({ runtime_root: z.string() }),
        }),
      }),
    }),
  }),
});

const listLeases = async (): Promise<ReadonlySet<string>> =>
  new Set(await readdir(HOPPER_TARGET_LEASE_DIRECTORY).catch(() => []));

const refusesConnections = (socketPath: string): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = createConnection(socketPath);
    socket.once("connect", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", (error: NodeJS.ErrnoException) =>
      resolve(error.code === "ECONNREFUSED"),
    );
  });

/**
 * Remove a lease socket only when its owner has exited, holding the same
 * recovery reservation as production so a concurrent acquirer is never
 * unlinked. Live or busy leases are left for their owners.
 */
const removeStaleLease = async (socketPath: string): Promise<void> => {
  const recoveryPath = `${socketPath}.recovery`;
  try {
    await mkdir(recoveryPath, { mode: 0o700 });
  } catch {
    return;
  }
  try {
    if (await refusesConnections(socketPath))
      await rm(socketPath, { force: true });
  } finally {
    await rmdir(recoveryPath);
  }
};

describe("Hopper launcher failure through the one-shot CLI", () => {
  // Hopper target leases are acquired only for the macOS launcher route.
  workspaceCliTest.skipIf(process.platform !== "darwin")(
    "exits after a retained-cleanup failure and releases the target to a retry",
    async ({ cli, workspace }) => {
      const launcherPath = await workspace.write(
        "failure-helper",
        FAILED_LAUNCHER,
      );
      await chmod(launcherPath, 0o700);
      const targetPath = workspace.path("probe");
      await copyFile("/usr/bin/true", targetPath);
      const leasesBefore = await listLeases();
      onTestFinished(async () => {
        for (const name of await listLeases())
          if (!leasesBefore.has(name) && name.endsWith(".sock"))
            await removeStaleLease(join(HOPPER_TARGET_LEASE_DIRECTORY, name));
      });

      for (const attempt of ["first", "retry"]) {
        const result = await cli.run({
          arguments: ["analyze", targetPath, "--provider", "hopper", "--json"],
          environment: {
            ...workspace.environment,
            HOPPER_LAUNCHER_PATH: launcherPath,
            REA_LOG_LEVEL: "silent",
          },
          timeoutMs: 30_000,
        });
        const retained = RetainedRuntime.safeParse(result.json);
        if (retained.success)
          await rm(
            retained.data.details.diagnostics.cleanup_error.details.diagnostics
              .runtime_root,
            { recursive: true, force: true },
          );

        expect(result.exitCode, attempt).toBe(1);
        expect(result.json, attempt).toMatchObject({
          code: "cleanup_incomplete",
          details: {
            cleanup: "incomplete",
            diagnostics: {
              primary_error: {
                code: "provider_unavailable",
                details: {
                  stage: "launch",
                  launcher: {
                    exit_code: 2,
                    stderr: {
                      text: expect.stringContaining(
                        "Not authorized to send Apple events",
                      ),
                    },
                  },
                },
              },
            },
          },
        });
      }
    },
  );
});
