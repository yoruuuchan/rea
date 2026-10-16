import { EventEmitter } from "node:events";
import { expect, it } from "vitest";
import pino from "pino";

import { createShutdown } from "../main/shutdown.js";
import { registerProcessShutdown } from "../main/processShutdown.js";
import type { RuntimeDependencies } from "../main/types.js";
import type { StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import { createManagedBinarySession } from "../composition/binary.js";

const shutdownEvents = ["SIGINT", "SIGTERM", "end", "close"] as const;

const flush = async (): Promise<void> => {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
};

it.each(shutdownEvents)(
  "retries failed cleanup after %s and unregisters every shutdown event on success",
  async (event) => {
    const signals = new EventEmitter();
    const input = new EventEmitter();
    const output: string[] = [];
    const exitCodes: number[] = [];
    let unregisterCount = 0;
    let transportCloseCalls = 0;
    let androidCloseCalls = 0;
    let optionalCloseCalls = 0;
    let sessionCloseCalls = 0;
    const session = createManagedBinarySession();
    const originalSessionClose = session.close.bind(session);
    session.close = async (...args) => {
      sessionCloseCalls += 1;
      return originalSessionClose(...args);
    };
    const dependencies: RuntimeDependencies = {
      env: {},
      serve: () => {
        throw new Error("unused fixture transport");
      },
      writeStderr: (text) => output.push(text),
      setExitCode: (code) => exitCodes.push(code),
      registerShutdown: (handler) => {
        const unregister = registerProcessShutdown(handler, {
          signals,
          stdin: input,
        });
        return () => {
          unregisterCount += 1;
          unregister();
        };
      },
    };
    const handle: StdioServerHandle = {
      close: async () => {
        transportCloseCalls += 1;
        if (transportCloseCalls === 1)
          throw new Error("first transport close failed");
      },
    };
    const lifecycle = createShutdown({
      handle,
      closeAndroid: async () => {
        androidCloseCalls += 1;
      },
      closeOptionalProviders: async () => {
        optionalCloseCalls += 1;
      },
      session,
      dependencies,
      serverLogger: pino({ enabled: false }),
    });

    if (event === "SIGINT" || event === "SIGTERM") signals.emit(event);
    else input.emit(event);
    await flush();

    expect([
      transportCloseCalls,
      androidCloseCalls,
      optionalCloseCalls,
    ]).toEqual([1, 1, 1]);
    expect(sessionCloseCalls).toBe(1);
    expect(output).toHaveLength(1);

    if (event === "SIGINT" || event === "SIGTERM") signals.emit(event);
    else input.emit(event);
    await lifecycle.shutdown();

    expect([
      transportCloseCalls,
      androidCloseCalls,
      optionalCloseCalls,
    ]).toEqual([2, 1, 1]);
    expect(sessionCloseCalls).toBe(1);
    expect(unregisterCount).toBe(1);
    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
    expect(input.listenerCount("end")).toBe(0);
    expect(input.listenerCount("close")).toBe(0);

    signals.emit("SIGINT");
    input.emit("end");
    await flush();
    expect([
      transportCloseCalls,
      androidCloseCalls,
      optionalCloseCalls,
    ]).toEqual([2, 1, 1]);
  },
);

it("joins concurrent shutdown events and retries only failed owners", async () => {
  const signals = new EventEmitter();
  const input = new EventEmitter();
  const output: string[] = [];
  let transportCloseCalls = 0;
  let androidCloseCalls = 0;
  let sessionCloseCalls = 0;
  let releaseFirstClose: ((error: Error) => void) | undefined;
  const session = createManagedBinarySession();
  const originalSessionClose = session.close.bind(session);
  session.close = async (...args) => {
    sessionCloseCalls += 1;
    return originalSessionClose(...args);
  };
  const dependencies: RuntimeDependencies = {
    env: {},
    serve: () => {
      throw new Error("unused fixture transport");
    },
    writeStderr: (text) => output.push(text),
    setExitCode: () => undefined,
    registerShutdown: (handler) =>
      registerProcessShutdown(handler, { signals, stdin: input }),
  };
  const handle: StdioServerHandle = {
    close: async () => {
      transportCloseCalls += 1;
      if (transportCloseCalls === 1)
        await new Promise<never>((_resolve, reject) => {
          releaseFirstClose = reject;
        });
    },
  };
  createShutdown({
    handle,
    closeAndroid: async () => {
      androidCloseCalls += 1;
    },
    session,
    dependencies,
    serverLogger: pino({ enabled: false }),
  });

  signals.emit("SIGINT");
  signals.emit("SIGTERM");
  await flush();
  expect([transportCloseCalls, androidCloseCalls, sessionCloseCalls]).toEqual([
    1, 1, 1,
  ]);

  if (releaseFirstClose === undefined)
    throw new Error("First close attempt did not start");
  releaseFirstClose(new Error("first transport close failed"));
  await flush();
  input.emit("end");
  await flush();

  expect([transportCloseCalls, androidCloseCalls, sessionCloseCalls]).toEqual([
    2, 1, 1,
  ]);
  expect(output.length).toBeGreaterThan(0);
  expect(signals.listenerCount("SIGINT")).toBe(0);
  expect(signals.listenerCount("SIGTERM")).toBe(0);
  expect(input.listenerCount("end")).toBe(0);
  expect(input.listenerCount("close")).toBe(0);
});
