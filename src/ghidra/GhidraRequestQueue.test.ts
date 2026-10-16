import { describe, expect, it } from "vitest";

import { err, ok } from "../domain/result.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { GhidraRequestQueue } from "./GhidraRequestQueue.js";
import { bindGhidraSessionFailure } from "./GhidraSessionError.js";

const failure = bindGhidraSessionFailure(() => ({
  target_path: "/tmp/queue-fixture",
}));

describe("Ghidra request queue failure settlement", () => {
  it("forwards the request deadline to the executor", async () => {
    const optionsSeen: { timeoutMs?: number }[] = [];
    const queue = new GhidraRequestQueue(
      (_method, _parameters, options) => {
        optionsSeen.push(options);
        return Promise.resolve(
          options.timeoutMs === 0
            ? err(
                failure(
                  "timeout",
                  "Ghidra request deadline elapsed",
                  undefined,
                  { timeoutMs: 0 },
                ),
              )
            : ok(null),
        );
      },
      failure,
      () => Promise.resolve(ok(null)),
    );

    await expect(
      queue.run("ping", {}, { timeoutMs: 0 }),
    ).resolves.toMatchObject({
      ok: false,
      error: { kind: "timeout", timeoutMs: 0 },
    });
    expect(optionsSeen).toEqual([{ timeoutMs: 0 }]);
  });

  it.each([new TypeError("Decoder rejected"), "decoder rejected", null])(
    "preserves a rejected executor cause (%j) and drains the next request",
    async (cause) => {
      const executed: string[] = [];
      const queue = new GhidraRequestQueue(
        async (method) => {
          executed.push(method);
          if (method === "first") throw cause;
          return ok({ method });
        },
        failure,
        () => Promise.resolve(ok(null)),
      );
      const first = queue.run("first", {}, {});
      const second = queue.run("second", {}, {});
      const result = await first;
      expect(result).toMatchObject({
        ok: false,
        error: {
          kind: "protocol",
          message: "Ghidra serial request execution rejected unexpectedly",
          diagnostics: { target_path: "/tmp/queue-fixture" },
        },
      });
      if (result.ok) throw new Error("Expected queue failure");
      expect(result.error.cause).toBe(cause);
      expect(result.error.diagnostics).toHaveProperty("failure_cause");
      await expect(second).resolves.toEqual(ok({ method: "second" }));
      expect(executed).toEqual(["first", "second"]);
    },
  );

  it("does not replace an executor's typed failure", async () => {
    const original = failure("timeout", "Request deadline elapsed");
    const queue = new GhidraRequestQueue(
      () => Promise.resolve(err(original)),
      failure,
      () => Promise.resolve(ok(null)),
    );
    const result = await queue.run("first", {}, {});
    expect(result).toEqual(err(original));
    if (!result.ok) expect(result.error).toBe(original);
  });
});

describe("Ghidra request queue cancellation", () => {
  it("preserves cancellation cleanup failures and rejects queued work", async () => {
    const controller = new AbortController();
    const cause = new Error("Runtime removal failed");
    const cleanupFailure = new ProviderCleanupError(
      "ghidra",
      ["/tmp/runtime"],
      { reason: cause.message },
      { cause },
    );
    let release: (() => void) | undefined;
    const completed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queue = new GhidraRequestQueue(
      async () => {
        await completed;
        return err(failure("cancelled", "Request cancelled"));
      },
      failure,
      () => Promise.resolve(err(cleanupFailure)),
    );
    const active = queue.run("active", {}, { signal: controller.signal });
    const queued = queue.run("queued", {}, {});
    controller.abort();
    release?.();
    const result = await active;
    expect(result).toMatchObject({
      ok: false,
      error: {
        kind: "cancelled",
        message: "Request cancelled",
      },
    });
    if (result.ok) throw new Error("Expected cancellation");
    expect(result.error.cleanupFailure).toBe(cleanupFailure);
    await expect(queued).resolves.toMatchObject({
      ok: false,
      error: { kind: "process" },
    });
  });

  it.each([
    {
      cause: new Error("Unexpected cleanup rejection"),
      diagnostic: { message: "Unexpected cleanup rejection" },
    },
    { cause: undefined, diagnostic: { type: "undefined" } },
  ])(
    "keeps cancellation primary when cleanup rejects with $diagnostic",
    async ({ cause, diagnostic }) => {
      const controller = new AbortController();
      const cancellationCause = new Error("Caller cancelled");
      const original = failure(
        "cancelled",
        "Request cancelled",
        cancellationCause,
      );
      let release: (() => void) | undefined;
      const completed = new Promise<void>((resolve) => {
        release = resolve;
      });
      const queue = new GhidraRequestQueue(
        async () => {
          await completed;
          return err(original);
        },
        failure,
        async () => {
          throw cause;
        },
      );
      const active = queue.run("active", {}, { signal: controller.signal });
      controller.abort();
      release?.();

      const result = await active;
      expect(result).toMatchObject({
        ok: false,
        error: {
          kind: "cancelled",
          message: "Request cancelled",
          diagnostics: {
            unexpected_cleanup_rejection: diagnostic,
          },
        },
      });
      if (result.ok) throw new Error("Expected cancellation");
      expect(result.error.cause).toBe(cancellationCause);
      expect(result.error.cleanupFailure).toBeUndefined();
    },
  );

  it("preserves the cancellation result when cleanup succeeds", async () => {
    const controller = new AbortController();
    const original = failure("cancelled", "Request cancelled");
    let release: (() => void) | undefined;
    const completed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queue = new GhidraRequestQueue(
      async () => {
        await completed;
        return err(original);
      },
      failure,
      () => Promise.resolve(ok(null)),
    );
    const active = queue.run("active", {}, { signal: controller.signal });
    controller.abort();
    release?.();

    await expect(active).resolves.toEqual(err(original));
  });
});
