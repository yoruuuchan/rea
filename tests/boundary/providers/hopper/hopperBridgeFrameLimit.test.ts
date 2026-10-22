import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { expect, it } from "vitest";
import { z } from "zod";

const execute = promisify(execFile);

const bridgePath = new URL(
  "../../../../bridge/hopper_bridge.py",
  import.meta.url,
);
const probePath = new URL(
  "../../../fixtures/hopperBridgeFrameLimitProbe.py",
  import.meta.url,
);

/** Mirrors the Cutter bridge's frame ceiling so both bridges bound identically. */
const MAX_REQUEST_BYTES = 16 * 1024 * 1024;

const exchangeSchema = z.strictObject({
  reply: z.unknown(),
  next: z.unknown().optional(),
  thread_released: z.boolean(),
  dispatch_calls: z.number().int().nonnegative(),
});

const probeResultSchema = z.strictObject({
  limit: z.number().int().positive(),
  legit: exchangeSchema,
  at_limit: exchangeSchema,
  past_limit: exchangeSchema,
  stalled_line: exchangeSchema,
  eof_partial: exchangeSchema,
});

it("serves requests up to the frame limit and refuses a line that exceeds it", async () => {
  const { stdout } = await execute("python3", [
    fileURLToPath(probePath),
    fileURLToPath(bridgePath),
  ]);
  const result = probeResultSchema.parse(JSON.parse(stdout));
  expect(result.limit).toBe(MAX_REQUEST_BYTES);

  // Legitimate traffic is unaffected, including a request that fills the limit.
  for (const exchange of [result.legit, result.at_limit])
    expect(exchange.reply).toMatchObject({
      result: { run_id: "owned-run", ready: true },
    });

  // A peer that keeps a line open past the limit is answered without reading
  // the line to completion. The refusal can be consumed by the peer's own
  // reset, so this asserts boundedness rather than the diagnostic's arrival.
  expect(result.past_limit.reply).not.toEqual({
    socket_error: "TimeoutError",
  });
  expect(result.past_limit.thread_released).toBe(true);

  // An unterminated payload one byte over the limit is refused with a typed
  // diagnostic naming the limit and the connection is closed, instead of
  // resynchronizing mid-line. The peer stays connected, so this pins the
  // payload ceiling without charging the LF against it.
  expect(result.stalled_line.reply).toMatchObject({
    error: {
      code: -32000,
      type: "invalid_request",
      message: expect.stringContaining(String(MAX_REQUEST_BYTES)),
    },
  });
  expect(result.stalled_line.next).toEqual({ closed: true });
  expect(result.stalled_line.thread_released).toBe(true);

  // A valid authenticated payload without LF is still an incomplete frame.
  // Half-closing the write side supplies EOF; the bridge rejects without
  // dispatching the operation, then closes its response connection.
  expect(result.eof_partial.reply).toMatchObject({
    error: {
      code: -32000,
      type: "invalid_request",
      message: "Incomplete bridge request frame",
    },
  });
  expect(result.eof_partial.next).toEqual({ closed: true });
  expect(result.eof_partial.dispatch_calls).toBe(0);
  expect(result.eof_partial.thread_released).toBe(true);
});
