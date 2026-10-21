import { EventEmitter, PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

import { expect, test } from "vitest";
import { z } from "zod";

import { javascriptApplicationAnalysisResultSchema } from "../../../src/domain/javascript/javascriptApplicationAnalysis.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import {
  cliTest,
  type CliInvocation,
  type CliResult,
} from "../../support/cli/cliFixture.js";
import { createCliCommandSession } from "../../support/cli/cliCommandSession.js";
import {
  createCliSessionFrameReader,
  encodeCliSessionFrame,
  MAX_CLI_SESSION_FRAME_BYTES,
} from "../../support/cli/cliCommandSessionFrames.mjs";
import { analyzeJavaScriptDirectory } from "../../support/cli/javascriptApplication.js";
import { writeFixtureFiles } from "../../support/workspace/writeFixtureFiles.js";

const requestSchema = z.object({
  id: z.number(),
  arguments: z.array(z.string()),
});

const command = (
  arguments_: readonly string[],
  environment: Readonly<Record<string, string>>,
): CliInvocation & {
  cwd: string;
  environment: Readonly<Record<string, string>>;
} => ({
  arguments: arguments_,
  cwd: process.cwd(),
  environment,
});

interface FakeCliProcess extends EventEmitter {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  pid: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals): boolean;
}

const fakeProcess = (pid: number): FakeCliProcess => {
  const child = new EventEmitter() as FakeCliProcess;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = pid;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = (signal: NodeJS.Signals = "SIGTERM") => {
    if (child.exitCode !== null || child.signalCode !== null) return true;
    child.signalCode = signal;
    child.emit("exit", null, signal);
    child.emit("close", null, signal);
    return true;
  };
  return child;
};

const asCliProcess = (child: FakeCliProcess): ChildProcessWithoutNullStreams =>
  child as unknown as ChildProcessWithoutNullStreams;

const waitFor = async (ready: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (ready()) return;
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
  }
  throw new Error("shared CLI process did not reach the expected state");
};

test("reads a CLI session frame split across chunks", () => {
  const frames: unknown[] = [];
  const reader = createCliSessionFrameReader((frame) => {
    frames.push(frame);
  });
  const encoded = encodeCliSessionFrame({ ready: true, seq: 1 });
  const second = encodeCliSessionFrame({ id: 2 });
  const combined = Buffer.concat([encoded, second]);
  reader(combined.subarray(0, 1));
  expect(frames).toEqual([]);
  reader(combined.subarray(1, 3));
  expect(frames).toEqual([]);
  reader(combined.subarray(3));
  expect(frames).toEqual([{ ready: true, seq: 1 }, { id: 2 }]);
});

test("rejects an oversized CLI session frame", () => {
  const reader = createCliSessionFrameReader(() => undefined);
  const header = Buffer.alloc(4);
  header.writeUInt32BE(MAX_CLI_SESSION_FRAME_BYTES + 1);
  expect(() => reader(header)).toThrow(/limit/);
});

test("reads a CLI session frame delivered one byte at a time", () => {
  const frames: unknown[] = [];
  const reader = createCliSessionFrameReader((frame) => {
    frames.push(frame);
  });
  const encoded = encodeCliSessionFrame({
    id: 7,
    note: "x".repeat(64),
  });
  for (const byte of encoded) reader(Buffer.from([byte]));
  expect(frames).toEqual([{ id: 7, note: "x".repeat(64) }]);
});

test("stops an unready shared CLI process when the session closes", async () => {
  let spawned: FakeCliProcess | undefined;
  const session = createCliCommandSession({
    spawnWorker: () => {
      spawned = fakeProcess(41);
      return asCliProcess(spawned);
    },
  });
  const pending = session.run(
    command(["--version"], { PATH: "/usr/bin", REA_LOG_LEVEL: "silent" }),
  );
  await waitFor(() => spawned !== undefined);
  await session.close();
  await expect(pending).rejects.toThrow("Shared CLI session is closed");
  expect(spawned?.signalCode).toBe("SIGTERM");
  await expect(
    session.run(
      command(["--version"], { PATH: "/usr/bin", REA_LOG_LEVEL: "silent" }),
    ),
  ).rejects.toThrow("Shared CLI session is closed");
  await session.close();
});

test("stops an in-flight shared CLI command when the session closes", async () => {
  let received = false;
  let spawned: FakeCliProcess | undefined;
  const session = createCliCommandSession({
    spawnWorker: () => {
      const child = fakeProcess(42);
      spawned = child;
      child.stdout.write(encodeCliSessionFrame({ ready: true }));
      child.stdin.on("data", () => {
        received = true;
      });
      return asCliProcess(child);
    },
  });
  const pending = session.run(
    command(["--version"], { PATH: "/usr/bin", REA_LOG_LEVEL: "silent" }),
  );
  await waitFor(() => received);
  await session.close();
  await expect(pending).rejects.toThrow("Shared CLI session is closed");
  expect(spawned?.signalCode).toBe("SIGTERM");
});

test("reuses one process and restarts it when the environment changes", async () => {
  let spawns = 0;
  const session = createCliCommandSession({
    spawnWorker: (environment) => {
      spawns += 1;
      const child = fakeProcess(50 + spawns);
      const reader = createCliSessionFrameReader((value) => {
        const request = requestSchema.parse(value);
        child.stdout.write(
          encodeCliSessionFrame({
            id: request.id,
            exitCode: 0,
            stdout: request.arguments.join(" "),
            stderr: environment.MARKER ?? "",
          }),
        );
      });
      child.stdout.write(encodeCliSessionFrame({ ready: true }));
      child.stdin.on("data", (chunk) => {
        reader(chunk);
      });
      return asCliProcess(child);
    },
  });
  const first = await session.run(
    command(["one"], { PATH: "a", MARKER: "first" }),
  );
  const second = await session.run(
    command(["two"], { PATH: "a", MARKER: "first" }),
  );
  expect(spawns).toBe(1);
  expect(session.processId()).toBe(51);
  expect(first.stdout).toBe("one");
  expect(second.stdout).toBe("two");
  expect(first.stderr).toBe("first");
  expect(second.stderr).toBe("first");

  const changed = await session.run(
    command(["three"], { PATH: "b", MARKER: "second" }),
  );
  expect(spawns).toBe(2);
  expect(session.processId()).toBe(52);
  expect(changed.stdout).toBe("three");
  expect(changed.stderr).toBe("second");
  await session.close();
  expect(session.processId()).toBeUndefined();
});

const reply = (
  child: FakeCliProcess,
  id: number,
  fields: {
    exitCode?: number;
    stdout?: string;
    stderr?: string;
    rss?: number;
    fatal?: boolean;
  },
): void => {
  child.stdout.write(
    encodeCliSessionFrame({
      id,
      exitCode: fields.exitCode ?? 0,
      stdout: fields.stdout ?? "",
      stderr: fields.stderr ?? "",
      ...(fields.rss === undefined ? {} : { rss: fields.rss }),
      ...(fields.fatal === undefined ? {} : { fatal: fields.fatal }),
    }),
  );
};

const respondingProcess = (
  pid: number,
  onRequest: (
    request: { id: number; arguments: string[] },
    child: FakeCliProcess,
  ) => void,
): FakeCliProcess => {
  const child = fakeProcess(pid);
  child.stdout.write(encodeCliSessionFrame({ ready: true }));
  const reader = createCliSessionFrameReader((value) => {
    onRequest(requestSchema.parse(value), child);
  });
  child.stdin.on("data", (chunk: Buffer) => {
    reader(chunk);
  });
  return child;
};

test("starts another process after the shared CLI process exits", async () => {
  const children: FakeCliProcess[] = [];
  const session = createCliCommandSession({
    spawnWorker: () => {
      const child = fakeProcess(70 + children.length);
      children.push(child);
      child.stdout.write(encodeCliSessionFrame({ ready: true }));
      if (children.length === 1) {
        child.stdin.on("data", () => {
          child.kill("SIGTERM");
        });
      } else {
        const reader = createCliSessionFrameReader((value) => {
          const request = requestSchema.parse(value);
          child.stdout.write(
            encodeCliSessionFrame({
              id: request.id,
              exitCode: 0,
              stdout: "recovered",
              stderr: "",
            }),
          );
        });
        child.stdin.on("data", (chunk) => {
          reader(chunk);
        });
      }
      return asCliProcess(child);
    },
  });
  await expect(
    session.run(command(["fail"], { PATH: "/usr/bin" })),
  ).rejects.toThrow(/Shared CLI process exited/);
  await expect(
    session.run(command(["again"], { PATH: "/usr/bin" })),
  ).resolves.toMatchObject({
    exitCode: 0,
    stdout: "recovered",
  });
  expect(children).toHaveLength(2);
  await session.close();
});

test("retires a fatal worker before starting the next command", async () => {
  const events: string[] = [];
  const session = createCliCommandSession({
    spawnWorker: () => {
      const generation = events.filter((event) =>
        event.startsWith("spawn"),
      ).length;
      events.push(`spawn:${generation}`);
      const child = respondingProcess(80 + generation, (request, current) => {
        events.push(`command:${generation}`);
        if (generation === 0) {
          reply(current, request.id, {
            exitCode: 1,
            stderr: "boom",
            fatal: true,
          });
          return;
        }
        reply(current, request.id, { stdout: "next" });
      });
      const stop = child.kill.bind(child);
      child.kill = (signal?: NodeJS.Signals) => {
        events.push(`kill:${generation}`);
        return stop(signal);
      };
      return asCliProcess(child);
    },
  });
  const fatal = session.run(command(["fail"], { PATH: "/usr/bin" }));
  const next = session.run(command(["next"], { PATH: "/usr/bin" }));
  await expect(fatal).resolves.toMatchObject({ exitCode: 1, stderr: "boom" });
  await expect(next).resolves.toMatchObject({ exitCode: 0, stdout: "next" });
  expect(events).toEqual([
    "spawn:0",
    "command:0",
    "kill:0",
    "spawn:1",
    "command:1",
  ]);
  await session.close();
});

test("retires a transport failure before the next command reuses the worker", async () => {
  const events: string[] = [];
  const session = createCliCommandSession({
    spawnWorker: () => {
      const generation = events.filter((event) =>
        event.startsWith("spawn"),
      ).length;
      events.push(`spawn:${generation}`);
      const child = respondingProcess(120 + generation, (request, current) => {
        events.push(`command:${generation}`);
        if (generation === 0) {
          current.stdout.write(encodeCliSessionFrame({ id: request.id }));
          return;
        }
        reply(current, request.id, { stdout: "recovered" });
      });
      const stop = child.kill.bind(child);
      child.kill = (signal: NodeJS.Signals = "SIGTERM") => {
        events.push(`kill:${generation}`);
        // Leave signalCode unset until a later turn. A synchronous SIGTERM
        // does not update it, so reuse cannot depend on that field.
        queueMicrotask(() => {
          if (child.exitCode !== null || child.signalCode !== null) return;
          stop(signal);
        });
        return true;
      };
      return asCliProcess(child);
    },
  });
  const failed = session.run(command(["bad"], { PATH: "/usr/bin" }));
  const next = session.run(command(["next"], { PATH: "/usr/bin" }));
  await expect(failed).rejects.toThrow(/exit code/);
  await expect(next).resolves.toMatchObject({ stdout: "recovered" });
  expect(events).toEqual([
    "spawn:0",
    "command:0",
    "kill:0",
    "spawn:1",
    "command:1",
  ]);
  await session.close();
});

test("restarts the shared CLI process after the command limit", async () => {
  const children: FakeCliProcess[] = [];
  const session = createCliCommandSession({
    commandLimit: 2,
    spawnWorker: () => {
      const child = respondingProcess(
        90 + children.length,
        (request, current) => {
          reply(current, request.id, {
            stdout: String(children.indexOf(current)),
          });
        },
      );
      children.push(child);
      return asCliProcess(child);
    },
  });
  const first = await session.run(command(["one"], { PATH: "/usr/bin" }));
  const second = await session.run(command(["two"], { PATH: "/usr/bin" }));
  expect(children).toHaveLength(1);
  expect(first.stdout).toBe("0");
  expect(second.stdout).toBe("0");
  const third = await session.run(command(["three"], { PATH: "/usr/bin" }));
  expect(children).toHaveLength(2);
  expect(children[0]?.signalCode).toBe("SIGTERM");
  expect(third.stdout).toBe("1");
  expect(session.processId()).toBe(91);
  await session.close();
});

test("restarts the shared CLI process after the resident-set limit", async () => {
  const children: FakeCliProcess[] = [];
  const session = createCliCommandSession({
    commandLimit: 100,
    residentLimitBytes: 100,
    spawnWorker: () => {
      const generation = children.length;
      const child = respondingProcess(100 + generation, (request, current) => {
        reply(current, request.id, {
          stdout: String(generation),
          rss: generation === 0 ? 150 : 10,
        });
      });
      children.push(child);
      return asCliProcess(child);
    },
  });
  await expect(
    session.run(command(["one"], { PATH: "/usr/bin" })),
  ).resolves.toMatchObject({ stdout: "0" });
  expect(session.processId()).toBe(100);
  await expect(
    session.run(command(["two"], { PATH: "/usr/bin" })),
  ).resolves.toMatchObject({ stdout: "1" });
  expect(children[0]?.signalCode).toBe("SIGTERM");
  expect(session.processId()).toBe(101);
  await session.close();
});

test("starts a new process after the real worker reports a fatal failure", async () => {
  const session = createCliCommandSession();
  const failed = await session.run({
    arguments: ["--version"],
    cwd: "/workspace/this-directory-does-not-exist",
    environment: { PATH: process.env.PATH ?? "", REA_LOG_LEVEL: "silent" },
  });
  expect(failed.exitCode).toBe(1);
  expect(failed.stderr).toMatch(/ENOENT/);
  const recovered = await session.run({
    arguments: ["--version"],
    cwd: process.cwd(),
    environment: { PATH: process.env.PATH ?? "", REA_LOG_LEVEL: "silent" },
  });
  expect(recovered.exitCode).toBe(0);
  expect(recovered.stdout.length).toBeGreaterThan(0);
  expect(session.processId()).toEqual(expect.any(Number));
  await session.close();
});

const requireSharedCli = (cli: {
  sharedCliRun?: (invocation: CliInvocation) => Promise<CliResult>;
}): ((invocation: CliInvocation) => Promise<CliResult>) => {
  const run = cli.sharedCliRun;
  if (run === undefined)
    throw new Error("cliTest did not provide a shared CLI session");
  return run;
};

const normalized = (result: CliResult) =>
  z
    .object({ normalized_result: javascriptApplicationAnalysisResultSchema })
    .parse(result.json).normalized_result;

const analyzeArguments = (root: string): readonly string[] => [
  "analyze-javascript-application",
  root,
  "--format",
  "json",
];

const writeApplication = async (prefix: string): Promise<string> => {
  const root = await createTestTempDirectory(prefix);
  await writeFixtureFiles(root, {
    "package.json": JSON.stringify({ main: "main.cjs" }),
    "main.cjs":
      'const { BrowserWindow } = require("electron"); new BrowserWindow().loadFile("index.html");',
    "index.html": "page",
  });
  return root;
};

cliTest(
  "matches a fresh CLI process and reuses that process for the same environment",
  async ({ cli, cliCommandSession }) => {
    const sharedCliRun = requireSharedCli(cli);
    const fresh = await cli.run({
      arguments: ["--version"],
      environment: { REA_LOG_LEVEL: "silent" },
    });
    const shared = await sharedCliRun({
      arguments: ["--version"],
      environment: { REA_LOG_LEVEL: "silent" },
    });
    expect(shared.exitCode).toBe(fresh.exitCode);
    expect(shared.stdout).toBe(fresh.stdout);
    expect(shared.stderr).toBe(fresh.stderr);
    const pid = cliCommandSession.processId();
    expect(pid).toEqual(expect.any(Number));
    const again = await sharedCliRun({
      arguments: ["--version"],
      environment: { REA_LOG_LEVEL: "silent" },
    });
    expect(again.stdout).toBe(fresh.stdout);
    expect(cliCommandSession.processId()).toBe(pid);

    const freshInvalid = await cli.run({
      arguments: ["--version"],
      environment: { REA_LOG_LEVEL: "not-a-level" },
    });
    const sharedInvalid = await sharedCliRun({
      arguments: ["--version"],
      environment: { REA_LOG_LEVEL: "not-a-level" },
    });
    expect(sharedInvalid.exitCode).toBe(freshInvalid.exitCode);
    expect(sharedInvalid.exitCode).not.toBe(0);
    expect(sharedInvalid.stdout).toBe(freshInvalid.stdout);
    expect(sharedInvalid.stderr).toBe(freshInvalid.stderr);
    expect(cliCommandSession.processId()).not.toBe(pid);

    const restored = await sharedCliRun({
      arguments: ["--version"],
      environment: { REA_LOG_LEVEL: "silent" },
    });
    expect(restored.exitCode).toBe(0);
    expect(restored.stdout).toBe(fresh.stdout);
    expect(cliCommandSession.processId()).not.toBe(pid);
  },
);

cliTest(
  "reuses one CLI process across JavaScript application directories",
  async ({ cli, cliCommandSession }) => {
    const sharedCliRun = requireSharedCli(cli);
    const firstRoot = await writeApplication("rea-shared-cli-");
    const fresh = await cli.run({
      arguments: analyzeArguments(firstRoot),
      environment: { REA_LOG_LEVEL: "silent" },
    });
    const shared = await sharedCliRun({
      arguments: analyzeArguments(firstRoot),
      environment: { REA_LOG_LEVEL: "silent" },
    });
    expect(shared.exitCode).toBe(0);
    expect(normalized(shared)).toEqual(normalized(fresh));
    const pid = cliCommandSession.processId();
    expect(pid).toEqual(expect.any(Number));

    const secondRoot = await writeApplication("rea-shared-cli-next-");
    const freshNext = await cli.run({
      arguments: analyzeArguments(secondRoot),
      environment: { REA_LOG_LEVEL: "silent" },
    });
    const sharedNext = await sharedCliRun({
      arguments: analyzeArguments(secondRoot),
      environment: { REA_LOG_LEVEL: "silent" },
    });
    expect(normalized(sharedNext)).toEqual(normalized(freshNext));
    expect(normalized(sharedNext).input_path).not.toBe(
      normalized(shared).input_path,
    );
    expect(cliCommandSession.processId()).toBe(pid);

    const analyzed = await analyzeJavaScriptDirectory("CLI", cli, secondRoot);
    expect(analyzed.input_path).toBe(normalized(freshNext).input_path);
    expect(cliCommandSession.processId()).toBe(pid);
  },
);
