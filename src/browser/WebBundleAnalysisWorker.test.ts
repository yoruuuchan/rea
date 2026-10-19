import { createHash, randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { expect, it } from "vitest";

import { createWebTextArtifact } from "../domain/webContentArtifact.js";
import type { IncludedScript } from "../domain/webBundleAnalyzerInspection.js";
import {
  AnalysisCancelledError,
  AnalysisOutputError,
  AnalysisResourceConstraintError,
  AnalysisTimeoutError,
} from "../domain/analysisErrorCore.js";
import {
  resolvedAnalysisError,
  type AnalysisError,
} from "../domain/analysisErrorBase.js";
import { cleanupOwnedProcessGroup } from "../process/ProcessOwnership.js";
import {
  spawnOwnedProviderProcess,
  type ProviderProcessHandle,
} from "../process/ProviderProcess.js";
import { WebBundleAnalysisWorker } from "./WebBundleAnalysisWorker.js";
import { WEB_BUNDLE_WORKER_LIMITS } from "./WebBundleAnalysisWorkerProtocol.js";

const makeScript = (text: string): IncludedScript => ({
  script_key: `scr_${createHash("sha256").update(text).digest("hex")}`,
  frame_id: "frame-1",
  url: "https://app.example.test/app.js",
  origin: "https://app.example.test",
  cdp_hash: null,
  length: Buffer.byteLength(text),
  is_module: false,
  language: "JavaScript",
  source_map_url: null,
  resource_reconciliation: {
    status: "unmatched",
    reason: "no_exact_sanitized_url",
  },
  source: {
    included: true,
    artifact: createWebTextArtifact(text, "application/javascript"),
  },
});

const sourceWorkerProgram = (
  hangMarker?: string,
  oomMarker?: string,
): string => `
  const { serveWebBundleAnalysisWorker } = await import(${JSON.stringify(new URL("./WebBundleAnalysisWorkerServer.ts", import.meta.url).href)});
  const { analyzeCapturedWebScript } = await import(${JSON.stringify(new URL("../domain/webBundleAnalyzer.ts", import.meta.url).href)});
  const analyze = (script) => {
    if (${JSON.stringify(hangMarker)} !== undefined && script.source.artifact.text === ${JSON.stringify(hangMarker)}) {
      for (;;) {}
    }
    if (${JSON.stringify(oomMarker)} !== undefined && script.source.artifact.text === ${JSON.stringify(oomMarker)}) {
      const retained = [];
      for (;;) retained.push(new Array(50_000).fill({ marker: "bounded-child-oom" }));
    }
    return analyzeCapturedWebScript(script);
  };
  await serveWebBundleAnalysisWorker(analyze);
`;

type TestMode =
  | {
      readonly kind: "source";
      readonly hangMarker?: string;
      readonly oomMarker?: string;
    }
  | { readonly kind: "delayed-ready" }
  | {
      readonly kind: "protocol";
      readonly failure: "wrong-id" | "oversized-control" | "oversized-result";
    };

const protocolWorkerProgram = (
  failure: "wrong-id" | "oversized-control" | "oversized-result",
): string => `
  import { createInterface } from "node:readline";
  import { getHeapStatistics } from "node:v8";
  const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
  send({ kind: "ready", heap_limit_bytes: getHeapStatistics().heap_size_limit });
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.once("line", (line) => {
    const request = JSON.parse(line);
    ${
      failure === "wrong-id"
        ? `send({ kind: "phase", id: ${JSON.stringify(randomUUID())}, phase: "analyze" });`
        : failure === "oversized-control"
          ? `process.stdout.write("x".repeat(70 * 1024) + "\\n");`
          : `send({ kind: "complete", id: request.id, result: { bytes: request.result_budget_bytes + 1, sha256: "${"0".repeat(64)}" } });`
    }
  });
`;

const delayedReadyProgram = `
  import { createInterface } from "node:readline";
  import { getHeapStatistics } from "node:v8";
  setTimeout(() => {
    process.stdout.write(JSON.stringify({ kind: "ready", heap_limit_bytes: getHeapStatistics().heap_size_limit }) + "\\n");
  }, 1_500);
  createInterface({ input: process.stdin, crlfDelay: Infinity });
`;

interface SpawnedTestProcess {
  readonly process: ProviderProcessHandle;
  readonly root: string | undefined;
}

const launcherFor = (
  mode: TestMode,
  options: {
    readonly failCleanupOnce?: boolean;
    readonly onSpawn?: (spawned: SpawnedTestProcess) => void;
  } = {},
): typeof spawnOwnedProviderProcess => {
  let failCleanup = options.failCleanupOnce ?? false;
  return async (request) => {
    const loader = import.meta.resolve("tsx");
    const program =
      mode.kind === "source"
        ? sourceWorkerProgram(mode.hangMarker, mode.oomMarker)
        : mode.kind === "delayed-ready"
          ? delayedReadyProgram
          : protocolWorkerProgram(mode.failure);
    const spawned = await spawnOwnedProviderProcess({
      ...request,
      arguments: [
        ...request.arguments.slice(0, -1),
        "--import",
        loader,
        "--input-type=module",
        "-e",
        program,
      ],
    });
    options.onSpawn?.({ process: spawned.process, root: request.cwd });
    return {
      ...spawned,
      cleanup: async () => {
        if (failCleanup) {
          failCleanup = false;
          return { cleaned: false, reason: "controlled worker cleanup retry" };
        }
        return spawned.cleanup === undefined
          ? cleanupOwnedProcessGroup(spawned.ownership)
          : spawned.cleanup();
      },
    };
  };
};

const failureOf = <Value>(
  result: Awaited<ReturnType<WebBundleAnalysisWorker["analyze"]>>,
): AnalysisError => {
  if (result.ok) throw new Error("Expected web worker failure");
  return result.error.error;
};

const waitForExit = async (child: ProviderProcessHandle): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined;
    const finish = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      child.off("exit", onExit);
      resolve();
    };
    const onExit = (): void => finish();
    child.once("exit", onExit);
    timer = setTimeout(() => {
      child.off("exit", onExit);
      reject(new Error("Owned child did not exit"));
    }, 3_000);
    if (child.exitCode !== null || child.signalCode !== null) finish();
  });
};

it("reuses one real owned worker for completed facts from consecutive scripts", async () => {
  const children: ProviderProcessHandle[] = [];
  const worker = new WebBundleAnalysisWorker(
    WEB_BUNDLE_WORKER_LIMITS.heapMb,
    launcherFor(
      { kind: "source" },
      { onSpawn: ({ process: child }) => children.push(child) },
    ),
  );
  try {
    const first = await worker.analyze(makeScript("fetch('/users');"), 10_000);
    const second = await worker.analyze(
      makeScript("fetch('/orders');"),
      10_000,
    );
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok)
      throw new Error("Expected both captured scripts to complete");
    expect(first.value).toMatchObject({
      status: "analyzed",
      script_key: makeScript("fetch('/users');").script_key,
    });
    expect(second.value).toMatchObject({
      status: "analyzed",
      script_key: makeScript("fetch('/orders');").script_key,
    });
    expect(children).toHaveLength(1);
  } finally {
    await worker.close();
  }
});

it("kills a hung owned child at the deadline and starts a fresh worker for the next script", async () => {
  const children: ProviderProcessHandle[] = [];
  const worker = new WebBundleAnalysisWorker(
    WEB_BUNDLE_WORKER_LIMITS.heapMb,
    launcherFor(
      { kind: "source", hangMarker: "hang forever" },
      { onSpawn: ({ process: child }) => children.push(child) },
    ),
  );
  try {
    const timedOut = await worker.analyze(makeScript("hang forever"), 500);
    expect(failureOf(timedOut)).toBeInstanceOf(AnalysisTimeoutError);
    await waitForExit(children[0]!);
    expect(
      children[0]?.exitCode !== null || children[0]?.signalCode !== null,
    ).toBe(true);
    const recovered = await worker.analyze(
      makeScript("fetch('/after-timeout');"),
      10_000,
    );
    expect(recovered.ok).toBe(true);
    expect(children).toHaveLength(2);
  } finally {
    await worker.close();
  }
});

it("contains child heap exhaustion and reuses the host for a later script", async () => {
  const children: ProviderProcessHandle[] = [];
  const roots: string[] = [];
  const worker = new WebBundleAnalysisWorker(
    128,
    launcherFor(
      { kind: "source", oomMarker: "exhaust child heap" },
      {
        onSpawn: ({ process: child, root }) => {
          children.push(child);
          if (root !== undefined) roots.push(root);
        },
      },
    ),
  );
  try {
    const exhausted = await worker.analyze(
      makeScript("exhaust child heap"),
      15_000,
    );
    expect(failureOf(exhausted)).toBeInstanceOf(
      AnalysisResourceConstraintError,
    );
    await waitForExit(children[0]!);
    expect(
      children[0]?.exitCode !== null || children[0]?.signalCode !== null,
    ).toBe(true);
    const recovered = await worker.analyze(
      makeScript("fetch('/after-oom');"),
      10_000,
    );
    expect(recovered.ok).toBe(true);
    expect(children).toHaveLength(2);
    expect(roots).toHaveLength(2);
    expect(roots[0]).toBe(roots[1]);
    await access(roots[0]!);
    await worker.close();
    await expect(access(roots[0]!)).rejects.toThrow();
  } finally {
    await worker.close();
  }
});

it("cancels during the late ready handshake and retains failed cleanup until exact retry", async () => {
  const children: SpawnedTestProcess[] = [];
  let announceSpawn: () => void = () => {};
  const spawned = new Promise<void>((resolve) => {
    announceSpawn = resolve;
  });
  const worker = new WebBundleAnalysisWorker(
    WEB_BUNDLE_WORKER_LIMITS.heapMb,
    launcherFor(
      { kind: "delayed-ready" },
      {
        failCleanupOnce: true,
        onSpawn: (child) => {
          children.push(child);
          announceSpawn();
        },
      },
    ),
  );
  const controller = new AbortController();
  const reason = { source: "late-handshake-test" };
  try {
    const analyzing = worker.analyze(
      makeScript("fetch('/cancelled');"),
      10_000,
      controller.signal,
    );
    await spawned;
    controller.abort(reason);
    const result = await analyzing;
    const error = failureOf(result);
    expect(error.cleanupIncomplete).toBe(true);
    expect(error.cleanupPrimary).toBeInstanceOf(AnalysisCancelledError);
    expect(error.cleanupPrimary?.cause).toBe(reason);
    expect(children[0]?.root).toBeDefined();
    await access(children[0]?.root ?? "");

    await worker.close();
    expect(error.cleanupIncomplete).toBe(false);
    expect(resolvedAnalysisError(error).cause).toBe(reason);
    await expect(access(children[0]?.root ?? "")).rejects.toThrow();
    await waitForExit(children[0]!.process);
  } finally {
    if (
      children[0]?.process.exitCode === null &&
      children[0]?.process.signalCode === null
    )
      children[0]?.process.kill("SIGKILL");
    await worker.close().catch(() => undefined);
    await WebBundleAnalysisWorker.retryPending().catch(() => undefined);
  }
});

it.each([
  ["wrong-id", AnalysisOutputError],
  ["oversized-control", AnalysisOutputError],
  ["oversized-result", AnalysisResourceConstraintError],
] as const)(
  "rejects %s before accepting unverified result bytes",
  async (failure, ErrorType) => {
    const worker = new WebBundleAnalysisWorker(
      WEB_BUNDLE_WORKER_LIMITS.heapMb,
      launcherFor({ kind: "protocol", failure }),
    );
    try {
      const result = await worker.analyze(
        makeScript("fetch('/not-read');"),
        10_000,
      );
      expect(failureOf(result)).toBeInstanceOf(ErrorType);
      if (failure === "oversized-result")
        expect(failureOf(result).message).toContain(
          "exceed the host's remaining reserved result capacity",
        );
    } finally {
      await worker.close();
    }
  },
);
