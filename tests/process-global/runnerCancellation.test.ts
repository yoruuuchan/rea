import { spawn } from "node:child_process";
import { copyFile, mkdir, readFile, utimes, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

import { expect, it } from "vitest";

import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";

const runnerPath = fileURLToPath(
  new URL("../../scripts/run-exclusive.mjs", import.meta.url),
);
const supervisorPath = fileURLToPath(
  new URL("../../scripts/run-exclusive-command.mjs", import.meta.url),
);

it.runIf(process.platform !== "win32")(
  "holds ownership until an uncooperative command has finished cancellation",
  async () => {
    const directory = await createTestTempDirectory("rea-runner-cancel-");
    const runner = launch(
      directory,
      'process.on("SIGTERM", () => {}); process.stdout.write("ready"); setInterval(() => {}, 1000);',
    );
    try {
      await runner.ready;
      runner.child.kill("SIGTERM");
      expect(await runner.closed).toMatchObject({ code: 143, signal: null });
      const replacement = launch(directory, 'process.stdout.write("ready");');
      expect(await replacement.closed).toMatchObject({ code: 0, signal: null });
    } finally {
      if (runner.child.exitCode === null) runner.child.kill("SIGKILL");
      await runner.closed;
    }
  },
);

it.runIf(process.platform !== "win32")(
  "retains the lock when the command exits but a descendant ignores cancellation",
  async () => {
    const directory = await createTestTempDirectory("rea-runner-descendant-");
    const pidPath = join(directory, "descendant.pid");
    const activityPath = join(directory, "activity.log");
    const descendant = `
      const fs = require("node:fs");
      process.on("SIGTERM", () => {});
      fs.writeFileSync(${JSON.stringify(activityPath)}, "active\\n");
      fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
      setInterval(() => fs.appendFileSync(${JSON.stringify(activityPath)}, "active\\n"), 20);
    `;
    const runner = launch(
      directory,
      `
      const fs = require("node:fs");
      require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { stdio: "ignore" });
      const ready = setInterval(() => {
        if (fs.existsSync(${JSON.stringify(pidPath)})) {
          clearInterval(ready);
          process.stdout.write("ready");
        }
      }, 10);
      setInterval(() => {}, 1000);
    `,
    );
    let descendantPid: number | undefined;
    try {
      await runner.ready;
      descendantPid = Number(await readFile(pidPath, "utf8"));
      runner.child.kill("SIGTERM");
      const contender = launch(
        directory,
        'process.stdout.write("unexpected");',
      );
      expect(await contender.closed).toMatchObject({
        code: 1,
        stderr: expect.stringContaining("already running"),
      });
      expect(await runner.closed).toMatchObject({ code: 143 });
      const stopped = await readFile(activityPath, "utf8");
      await delay(100);
      expect(await readFile(activityPath, "utf8")).toBe(stopped);
      expect(
        await launch(directory, 'process.stdout.write("done");').closed,
      ).toMatchObject({ code: 0 });
    } finally {
      if (runner.child.exitCode === null) runner.child.kill("SIGTERM");
      await runner.closed;
      // Also clean up when this regression is run against the broken runner.
      if (descendantPid !== undefined) stopIfPresent(descendantPid);
    }
  },
);

it("does not treat an old database timestamp as permission to replace a live owner", async () => {
  const directory = await createTestTempDirectory("rea-runner-live-");
  const runner = launch(
    directory,
    'process.stdout.write("ready"); setTimeout(() => {}, 1500);',
  );
  try {
    await runner.ready;
    const old = new Date("2000-01-01T00:00:00Z");
    await utimes(
      join(directory, ".cache/rea-command-locks/test.sqlite"),
      old,
      old,
    );
    const contender = launch(directory, 'process.stdout.write("unexpected");');
    expect(await contender.closed).toMatchObject({
      code: 1,
      stderr: expect.stringContaining("already running"),
      stdout: "",
    });
    expect(await runner.closed).toMatchObject({ code: 0 });
  } finally {
    if (runner.child.exitCode === null) runner.child.kill("SIGKILL");
    await runner.closed;
  }
});

it("preserves executable arguments through the public runner", async () => {
  const directory = await createTestTempDirectory("rea-runner-argv-");
  const payload = 'spaces, "quotes", & ^ % ! (parens)';
  const code = "process.stdout.write(JSON.stringify(process.argv.slice(1)))";
  expect(
    await execute(directory, process.execPath, ["-e", code, payload]),
  ).toMatchObject({
    code: 0,
    stdout: JSON.stringify([payload]),
    stderr: "",
  });
});

it.runIf(process.platform === "win32")(
  "launches an executable from a path containing spaces",
  async () => {
    const directory = await createTestTempDirectory("rea-runner-spaced-exe-");
    const executable = join(directory, "node runtime", "node.exe");
    await mkdir(join(directory, "node runtime"), { recursive: true });
    await copyFile(process.execPath, executable);
    const payload = 'argument with spaces and "quotes" & ^ % !';
    const code = "process.stdout.write(JSON.stringify(process.argv.slice(1)))";
    expect(
      await execute(directory, executable, ["-e", code, payload]),
    ).toMatchObject({
      code: 0,
      stdout: JSON.stringify([payload]),
      stderr: "",
    });
  },
);

it.runIf(process.platform === "win32")(
  "resolves bare node and Windows command shims without losing arguments",
  async () => {
    const directory = await createTestTempDirectory("rea-runner-shims-");
    const payload = 'argument with spaces and "quotes" & ^ % !';
    const code = "process.stdout.write(JSON.stringify(process.argv.slice(1)))";
    expect(
      await execute(directory, "node", ["-e", code, payload]),
    ).toMatchObject({
      code: 0,
      stdout: JSON.stringify([payload]),
      stderr: "",
    });

    const npm = await execute(directory, "npm", ["--version"]);
    expect(npm).toMatchObject({ code: 0, stderr: "" });
    expect(npm.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/u);

    const turbo = await execute(
      directory,
      join(process.cwd(), "node_modules", ".bin", "turbo"),
      ["--version"],
    );
    expect(turbo).toMatchObject({ code: 0, stderr: "" });
    expect(turbo.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/u);
  },
);

it.runIf(process.platform !== "win32")(
  "recovers after abrupt owner death and keeps simultaneous contenders exclusive",
  async () => {
    const directory = await createTestTempDirectory("rea-runner-recover-");
    // Killing the public runner disconnects its supervisor, which retains
    // ownership while cancelling the group before automatic OS lock release.
    const interrupted = launch(
      directory,
      'process.on("SIGTERM", () => {}); process.stdout.write("ready"); setInterval(() => {}, 1000);',
    );
    await interrupted.ready;
    interrupted.child.kill("SIGKILL");
    expect(await interrupted.closed).toMatchObject({
      code: null,
      signal: "SIGKILL",
    });
    const activityPath = join(directory, "active");
    const logPath = join(directory, "activity.log");
    await writeFile(logPath, "");
    const command = `
      const fs = require("node:fs");
      const active = ${JSON.stringify(activityPath)};
      const log = ${JSON.stringify(logPath)};
      try { fs.closeSync(fs.openSync(active, "wx")); }
      catch { process.stderr.write("commands overlapped"); process.exit(77); }
      fs.appendFileSync(log, "start\\n");
      setTimeout(() => {
        fs.appendFileSync(log, "end\\n");
        fs.unlinkSync(active);
      }, 250);
    `;
    const results = await Promise.all(
      Array.from({ length: 8 }, () => launch(directory, command).closed),
    );
    expect(results.some(({ code }) => code === 0)).toBe(true);
    for (const result of results) {
      expect([0, 1]).toContain(result.code);
      if (result.code === 1) expect(result.stderr).toContain("already running");
      expect(result.stderr).not.toContain("commands overlapped");
    }
    const events = (await readFile(logPath, "utf8")).trim().split("\n");
    expect(events.length).toBeGreaterThan(0);
    for (let index = 0; index < events.length; index += 2)
      expect(events.slice(index, index + 2)).toEqual(["start", "end"]);
    expect(
      await launch(directory, 'process.stdout.write("done");').closed,
    ).toMatchObject({ code: 0, stdout: "done" });
  },
);

function stopIfPresent(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch (cause) {
    if (
      !(cause instanceof Error) ||
      !("code" in cause) ||
      cause.code !== "ESRCH"
    )
      throw cause;
  }
}

function launch(directory: string, command: string) {
  const child = spawn(
    process.execPath,
    [runnerPath, "test", process.execPath, "-e", command],
    { cwd: directory, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  let notifyReady: (() => void) | undefined;
  const ready = withTimeout(
    new Promise<void>((resolveReady) => {
      notifyReady = resolveReady;
    }),
    "runner child did not start",
  );
  // Some scenarios intentionally never print a ready marker.
  void ready.catch(() => {});
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
    if (stdout.includes("ready")) notifyReady?.();
  });
  child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
  const closed = withTimeout(
    new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
      stdout: string;
      stderr: string;
    }>((resolveClosed, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => {
        notifyReady?.();
        resolveClosed({ code, signal, stdout, stderr });
      });
    }),
    "runner did not finish",
  );
  return { child, ready, closed };
}

function execute(
  directory: string,
  command: string,
  arguments_: string[] = [],
) {
  return new Promise<{
    code: number | null;
    stdout: string;
    stderr: string;
  }>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [runnerPath, "test", command, ...arguments_],
      { cwd: directory, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function withTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error(message)), 5_000);
    }),
  ]).finally(() => clearTimeout(timeout));
}

/** True while the directly owned command PID remains signalable. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Run the supervisor over IPC to cover Windows cancellation and disconnect. */
function launchSupervisor(directory: string) {
  const pidPath = join(directory, "command.pid");
  const gated = `
    const fs = require("node:fs");
    fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
    process.stdout.write("ready");
    setInterval(() => {}, 1000);
  `;
  const supervisor = spawn(
    process.execPath,
    [supervisorPath, "test", process.execPath, "-e", gated],
    { cwd: directory, stdio: ["ignore", "pipe", "pipe", "ipc"] },
  );
  if (supervisor.stdout === null || supervisor.stderr === null) {
    supervisor.kill("SIGKILL");
    throw new Error("supervisor output pipes were not created");
  }
  const stdoutStream = supervisor.stdout;
  const stderrStream = supervisor.stderr;
  let stdout = "";
  let stderr = "";
  let notifyReady: (() => void) | undefined;
  const ready = withTimeout(
    new Promise<void>((resolveReady) => {
      notifyReady = resolveReady;
    }),
    "supervisor command did not start",
  );
  void ready.catch(() => undefined);
  stdoutStream.on("data", (chunk) => {
    stdout += chunk.toString();
    if (stdout.includes("ready")) notifyReady?.();
  });
  stderrStream.on("data", (chunk) => (stderr += chunk.toString()));
  const closed = withTimeout(
    new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolveClosed, reject) => {
        supervisor.once("error", reject);
        supervisor.once("close", (code, signal) =>
          resolveClosed({ code, signal }),
        );
      },
    ),
    "supervisor did not finish",
  );
  const commandPid = async () =>
    Number(await readFile(pidPath, "utf8").catch(() => "0"));
  const stop = async () => {
    const pid = await commandPid();
    if (pid > 0) stopIfPresent(pid);
    if (supervisor.exitCode === null && supervisor.signalCode === null)
      supervisor.kill("SIGKILL");
    await closed.catch(() => undefined);
  };
  return { supervisor, ready, closed, commandPid, stop, stderr: () => stderr };
}

it.runIf(process.platform === "win32")(
  "terminates the owned command and releases the lock after forwarded cancellation",
  async () => {
    const directory = await createTestTempDirectory("rea-runner-win-ipc-");
    const runner = launchSupervisor(directory);
    try {
      await runner.ready;
      const pid = await runner.commandPid();
      expect(pid).toBeGreaterThan(0);
      expect(isAlive(pid)).toBe(true);
      runner.supervisor.send("SIGTERM");
      expect(await runner.closed).toEqual({ code: 143, signal: null });
      expect(isAlive(pid)).toBe(false);
      expect(
        await execute(directory, 'process.stdout.write("lock released");'),
      ).toMatchObject({ code: 0, stdout: "lock released" });
    } finally {
      await runner.stop();
    }
  },
);

it.runIf(process.platform === "win32")(
  "terminates the owned command and releases the lock after parent disconnect",
  async () => {
    const directory = await createTestTempDirectory("rea-runner-win-drop-");
    const runner = launchSupervisor(directory);
    try {
      await runner.ready;
      const pid = await runner.commandPid();
      expect(pid).toBeGreaterThan(0);
      expect(isAlive(pid)).toBe(true);
      runner.supervisor.disconnect();
      expect(await runner.closed).toEqual({ code: 143, signal: null });
      expect(isAlive(pid)).toBe(false);
      expect(
        await execute(directory, 'process.stdout.write("lock released");'),
      ).toMatchObject({ code: 0, stdout: "lock released" });
    } finally {
      await runner.stop();
    }
  },
);

it("retains lock ownership through a post-spawn child error until close", async () => {
  const directory = await createTestTempDirectory("rea-runner-child-error-");
  const readyPath = join(directory, "command-ready");
  const gatePath = join(directory, "allow-command-exit");
  const closedPath = join(directory, "command-closed");
  const source = await readFile(supervisorPath, "utf8");
  const crossSpawn = pathToFileURL(
    createRequire(import.meta.url).resolve("cross-spawn"),
  ).href;
  const spawnCall =
    /child = spawn\(command\[0\], command\.slice\(1\), \{\n\s+cwd: process\.cwd\(\),\n\s+env: process\.env,\n\s+stdio: "inherit",\n\s+\}\);/u;
  const postSpawnInjection = `child.once("spawn", () => {
  const waitForReady = setInterval(() => {
    if (!existsSync(${JSON.stringify(readyPath)})) return;
    clearInterval(waitForReady);
    process.stdout.write("controlled-post-spawn-error\\n");
    child.emit("error", new Error("controlled post-spawn child error"));
    child.emit("error", new Error("controlled secondary child error"));
  }, 5);
});`;
  expect(source).toMatch(spawnCall);
  const injectedSource = source
    .replace(
      'import spawn from "cross-spawn";',
      `import spawn from ${JSON.stringify(crossSpawn)};\nimport { existsSync } from "node:fs";`,
    )
    .replace(spawnCall, (call) => `${call}\n    ${postSpawnInjection}`);
  expect(injectedSource).toContain(postSpawnInjection);
  expect(injectedSource).toContain("controlled post-spawn child error");
  const copiedSupervisor = join(directory, "run-exclusive-command.mjs");
  await writeFile(copiedSupervisor, injectedSource);

  const gatedCommand = `
    const fs = require("node:fs");
    fs.writeFileSync(${JSON.stringify(readyPath)}, "ready");
    process.stdout.write("command-ready\\n");
    const waitForGate = setInterval(() => {
      if (!fs.existsSync(${JSON.stringify(gatePath)})) return;
      clearInterval(waitForGate);
      fs.writeFileSync(${JSON.stringify(closedPath)}, "closed");
      process.stdout.write("command-closed\\n");
    }, 5);
  `;
  const supervisor = spawn(
    process.execPath,
    [copiedSupervisor, "test", process.execPath, "-e", gatedCommand],
    { cwd: directory, stdio: ["ignore", "pipe", "pipe", "ipc"] },
  );
  if (supervisor.stdout === null || supervisor.stderr === null) {
    supervisor.kill("SIGKILL");
    throw new Error("supervisor output pipes were not created");
  }
  const stdoutStream = supervisor.stdout;
  const stderrStream = supervisor.stderr;
  let stdout = "";
  let stderr = "";
  const outputWaiters = new Map<string, (() => void)[]>();
  stdoutStream.on("data", (chunk) => {
    stdout += chunk.toString();
    for (const [marker, waiters] of outputWaiters) {
      if (!stdout.includes(marker)) continue;
      outputWaiters.delete(marker);
      for (const notify of waiters) notify();
    }
  });
  stderrStream.on("data", (chunk) => (stderr += chunk.toString()));
  const waitForOutput = (marker: string) => {
    if (stdout.includes(marker)) return Promise.resolve();
    return withTimeout(
      new Promise<void>((resolveOutput) => {
        outputWaiters.set(marker, [
          ...(outputWaiters.get(marker) ?? []),
          resolveOutput,
        ]);
      }),
      `supervisor did not write ${marker}`,
    );
  };
  const exited = withTimeout(
    new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolveExit, reject) => {
        supervisor.once("error", reject);
        supervisor.once("exit", (code, signal) =>
          resolveExit({ code, signal }),
        );
      },
    ),
    "supervisor did not exit",
  );
  try {
    await waitForOutput("controlled-post-spawn-error");
    const contender = await execute(directory, process.execPath, [
      "-e",
      'process.stdout.write("lock acquired");',
    ]);
    expect(contender).toMatchObject({
      code: 1,
      stdout: "",
      stderr: expect.stringContaining("already running"),
    });
    expect(stdout).not.toContain("command-closed");

    await writeFile(gatePath, "open");
    await waitForOutput("command-closed");
    expect(await exited).toEqual({ code: 1, signal: null });
    expect(stderr).toContain("controlled post-spawn child error");
    expect(stderr).not.toContain("controlled secondary child error");
    expect(
      await execute(directory, process.execPath, [
        "-e",
        'process.stdout.write("lock acquired");',
      ]),
    ).toMatchObject({ code: 0, stdout: "lock acquired" });
  } finally {
    await writeFile(gatePath, "open");
    await waitForOutput("command-closed").catch(() => undefined);
    await exited.catch(() => undefined);
  }
});
