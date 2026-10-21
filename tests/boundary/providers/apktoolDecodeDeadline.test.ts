import { execFile } from "node:child_process";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { expect, it } from "vitest";

import { ApktoolProvider } from "../../../src/apktool/ApktoolProvider.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

/**
 * Only an exited process counts as stopped: it is gone, a zombie waiting to
 * be reaped, or absent from `ps`. A failed inspection is not proof of exit.
 */
const alive = async (pid: number): Promise<boolean> => {
  try {
    process.kill(pid, 0);
  } catch (cause: unknown) {
    if ((cause as NodeJS.ErrnoException).code === "ESRCH") return false;
    return true;
  }
  return promisify(execFile)("ps", ["-o", "stat=", "-p", `${pid}`]).then(
    ({ stdout }) => {
      const state = stdout.trim();
      return state !== "" && !state.startsWith("Z");
    },
    // `ps` exits 1 when no process matches; any other failure is unknown.
    (cause: unknown) => (cause as { code?: unknown }).code !== 1,
  );
};

const waitFor = async (check: () => Promise<boolean>, ms: number) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await delay(25);
  }
  return false;
};

const readPids = async (path: string): Promise<readonly number[]> =>
  readFile(path, "utf8")
    .then((text) => JSON.parse(text) as number[])
    .catch(() => []);

const DECODE_TIMEOUT_MS = 2_500;
const CHILD_SCRIPT =
  "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);";

// Windows Job Object cleanup is a separate owned-command lane. This observes
// the POSIX process group the apktool decode launcher actually uses.
it.skipIf(process.platform === "win32")(
  "stops a hanging launcher and its pipe-holding child when the decode deadline elapses",
  async () => {
    const root = await createTestTempDirectory("rea-apktool-decode-deadline-");
    const pidsPath = join(root, "pids.json");
    const launcher = join(root, "apktool");
    await writeFile(
      launcher,
      [
        `#!${process.execPath}`,
        'const { spawn } = require("node:child_process");',
        'const { writeFileSync } = require("node:fs");',
        'if (process.argv[2] === "--version") { process.stdout.write("2.9.3\\n"); process.exit(0); }',
        'if (process.argv[2] !== "d") { process.stderr.write("unexpected " + process.argv.slice(2).join(" ")); process.exit(1); }',
        `const child = spawn(process.execPath, ["-e", ${JSON.stringify(CHILD_SCRIPT)}], { stdio: "inherit" });`,
        "if (child.pid === undefined) process.exit(1);",
        `writeFileSync(${JSON.stringify(pidsPath)}, JSON.stringify([process.pid, child.pid]));`,
        'process.on("SIGTERM", () => {});',
        "setInterval(() => {}, 1000);",
        "",
      ].join("\n"),
    );
    await chmod(launcher, 0o755);
    const apk = join(root, "probe.apk");
    await writeFile(apk, "apk-bytes");
    const provider = new ApktoolProvider({
      environment: { REA_APKTOOL_COMMAND: launcher },
    });
    const started = performance.now();
    const pending = provider.execute({
      operation: "decode_android_resources",
      input: {
        path: apk,
        include_strings: false,
        decode_timeout_ms: DECODE_TIMEOUT_MS,
      },
    });
    let launched: readonly number[] = [];
    try {
      expect(
        await waitFor(async () => {
          const pids = await readPids(pidsPath);
          if (pids.length !== 2) return false;
          launched = pids;
          return (await Promise.all(pids.map(alive))).every(Boolean);
        }, 8_000),
      ).toBe(true);
      const outcome = await Promise.race([
        pending,
        delay(15_000).then(() => "still pending" as const),
      ]);
      if (outcome === "still pending")
        throw new Error("apktool decode deadline did not settle");
      const elapsed = performance.now() - started;
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.error.cleanupIncomplete).toBe(false);
      const projected = projectAnalysisError(outcome.error);
      expect(projected).toMatchObject({
        code: "provider_timeout",
        details: { timeout_ms: DECODE_TIMEOUT_MS },
      });
      expect(projected.message).toContain(`${String(DECODE_TIMEOUT_MS)} ms`);
      expect(projected.remediation.action).toContain("decode_timeout_ms");
      expect(projected.remediation.action).toContain("next decode");
      // Settlement includes the owned-command deadline, so the timer elapsed.
      expect(elapsed).toBeGreaterThanOrEqual(DECODE_TIMEOUT_MS - 50);
      expect(elapsed).toBeLessThan(15_000);
      expect(
        await waitFor(
          async () =>
            (await Promise.all(launched.map(alive))).every((live) => !live),
          5_000,
        ),
      ).toBe(true);
    } finally {
      const closing = provider.close();
      await Promise.race([pending, delay(10_000)]).catch(() => undefined);
      for (const pid of await readPids(pidsPath))
        if (await alive(pid))
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // Already exited between the check and the signal.
          }
      await Promise.race([closing, delay(10_000)]).catch(() => undefined);
    }
  },
  30_000,
);
