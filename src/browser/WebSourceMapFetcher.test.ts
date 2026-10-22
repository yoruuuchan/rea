import process from "node:process";

import { expect, it } from "vitest";

import { fetchWebSourceMaps } from "./WebSourceMapFetcher.js";
import { analyzeWebBundleInputSchema } from "../domain/webBundleAnalysis.js";

const input = analyzeWebBundleInputSchema.parse({
  cdp_endpoint: "http://127.0.0.1:9222",
  allowed_origins: ["http://127.0.0.1:9222"],
  target_id: "page-1",
  fetch_source_maps: true,
});
const request = {
  scriptKey: `scr_${"1".repeat(64)}`,
  declaredUrl: "https://app.example.test/app.js.map",
  fetchUrl: "https://app.example.test/app.js.map",
};

it("reports an empty selected request set without starting fetch work", async () => {
  const result = await fetchWebSourceMaps([], input, undefined, {
    fetch: async () => {
      throw new Error("No source-map request should be made");
    },
  });

  expect(result).toEqual({
    status: "not_requested",
    requested: 0,
    processed: 0,
    items: [],
  });
});

it("honors cancellation before returning an empty request set", async () => {
  const controller = new AbortController();
  const reason = new Error("cancelled before fetching");
  controller.abort(reason);

  await expect(fetchWebSourceMaps([], input, controller.signal)).rejects.toBe(
    reason,
  );
});

it("cancels a response body that arrives after its fetch host aborts synchronously", async () => {
  const controller = new AbortController();
  const reason = new Error("fetch host aborted during admission");
  let resolveFetch!: (response: Response) => void;
  const fetchPromise = new Promise<Response>((resolve) => {
    resolveFetch = resolve;
  });
  let markCancelled!: () => void;
  const cancelled = new Promise<void>((resolve) => {
    markCancelled = resolve;
  });
  let cancellationReason: unknown;
  const body = new ReadableStream<Uint8Array>({
    cancel: (cause) => {
      cancellationReason = cause;
      markCancelled();
    },
  });
  const fetchInput = analyzeWebBundleInputSchema.parse({
    cdp_endpoint: "http://127.0.0.1:9222",
    allowed_origins: [new URL(request.fetchUrl).origin],
    target_id: "page-1",
    fetch_source_maps: true,
  });
  const pending = fetchWebSourceMaps([request], fetchInput, controller.signal, {
    fetch: () => {
      controller.abort(reason);
      return fetchPromise;
    },
  });

  await expect(pending).rejects.toBe(reason);
  resolveFetch(new Response(body));
  await cancelled;
  expect(cancellationReason).toBe(reason);
});

it("observes a fetch rejection that arrives after its host aborts synchronously", async () => {
  const controller = new AbortController();
  const reason = new Error("fetch host aborted during admission");
  const lateFailure = new Error("late fetch failure");
  let rejectFetch!: (cause: unknown) => void;
  const fetchPromise = new Promise<Response>((_resolve, reject) => {
    rejectFetch = reject;
  });
  const fetchInput = analyzeWebBundleInputSchema.parse({
    cdp_endpoint: "http://127.0.0.1:9222",
    allowed_origins: [new URL(request.fetchUrl).origin],
    target_id: "page-1",
    fetch_source_maps: true,
  });
  const pending = fetchWebSourceMaps([request], fetchInput, controller.signal, {
    fetch: () => {
      controller.abort(reason);
      return fetchPromise;
    },
  });
  let unhandled: unknown;
  const onUnhandled = (cause: unknown): void => {
    unhandled = cause;
  };
  process.on("unhandledRejection", onUnhandled);

  try {
    await expect(pending).rejects.toBe(reason);
    rejectFetch(lateFailure);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(unhandled).toBeUndefined();
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});
