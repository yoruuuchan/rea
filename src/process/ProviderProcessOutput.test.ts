import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { expect, it } from "vitest";
import { ProviderProcessSupervisor } from "./ProviderProcess.js";

it("exit does not establish complete output when a producer closes its streams later", async () => {
  const producer = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null,
    signalCode: null,
    kill: () => false,
  });
  const supervisor = new ProviderProcessSupervisor({
    process: producer,
    ownsProcessLifetime: false,
  });
  try {
    producer.stdout.write("first");
    producer.emit("exit", 0, null);
    expect(await supervisor.waitForExit(0)).toBe(true);
    expect(await supervisor.waitForOutputClose(0)).toBe(false);
    producer.stdout.end("last");
    producer.stderr.end("diagnostic");
    producer.emit("close", 0, null);
    expect(await supervisor.waitForOutputClose(0)).toBe(true);
    expect(supervisor.snapshot()).toMatchObject({
      stdout: { text: "firstlast" },
      stderr: { text: "diagnostic" },
      exitCode: 0,
    });
  } finally {
    supervisor.dispose();
  }
});

it("reports a reached process memory limit only when the handle observed one", () => {
  let reached = false;
  const producer = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null,
    signalCode: null,
    kill: () => false,
  });
  // A live accessor, as on the owned Windows process handle.
  Object.defineProperty(producer, "memoryLimitReached", { get: () => reached });
  const exitSnapshots: unknown[] = [];
  const supervisor = new ProviderProcessSupervisor(
    { process: producer, ownsProcessLifetime: false },
    {
      onDiagnostic: (event) => {
        if (event.type === "exit") exitSnapshots.push(event.snapshot);
      },
    },
  );
  try {
    expect(supervisor.snapshot()).not.toHaveProperty("memoryLimitReached");
    // Owned launchers record the job notification before emitting exit.
    reached = true;
    producer.emit("exit", 3, null);
    expect(supervisor.snapshot()).toMatchObject({
      exitCode: 3,
      memoryLimitReached: true,
    });
    expect(exitSnapshots).toEqual([
      expect.objectContaining({ memoryLimitReached: true }),
    ]);
  } finally {
    supervisor.dispose();
  }
});
