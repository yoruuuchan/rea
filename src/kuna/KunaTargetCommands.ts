import { basename, join } from "node:path";
import { realpath } from "node:fs/promises";

import type { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisArtifactChangedError,
  AnalysisCancelledError,
} from "../domain/analysisErrorCore.js";
import type { BinaryTarget } from "../domain/binaryTargetTypes.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { err, ok, type Result } from "../domain/result.js";
import { PrivateRuntimeRoot } from "../process/PrivateRuntimeRoot.js";
import { prepareProcessOwnershipInspection } from "../process/ProcessOwnershipObservation.js";
import type {
  ProviderProcessSnapshot,
  ProviderProcessSupervisor,
} from "../process/ProviderProcess.js";
import {
  copyAndHash,
  runKunaCommand,
  type KunaProcessLauncher,
} from "./KunaCommand.js";
import type { KunaInstallation } from "./KunaInstallation.js";
import { KUNA_PROVIDER_ID } from "./KunaRelease.js";
import type { KunaRunRelease } from "./KunaRunSlots.js";

interface Workspace {
  readonly root: PrivateRuntimeRoot;
  readonly input: string;
}

export interface KunaTargetCommandSnapshot extends ProviderProcessSnapshot {
  /** Canonical, digest-checked private input used by this command. */
  readonly input: string;
}

export interface KunaTargetCommandRequest {
  readonly installation: KunaInstallation;
  readonly operation: string;
  readonly arguments: (input: string) => readonly string[];
  readonly outputBytes: number;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
  /** Admission remains owned until the native process is proven stopped. */
  readonly releaseRun?: KunaRunRelease;
}

/** Own the digest-checked target copy and every command that can still use it. */
export class KunaTargetCommands {
  readonly #active = new Set<Promise<unknown>>();
  readonly #retained: {
    readonly error: ProviderCleanupError;
    readonly owner: ProviderProcessSupervisor | undefined;
    readonly releaseRun: KunaRunRelease | undefined;
  }[] = [];
  readonly #roots: PrivateRuntimeRoot[] = [];
  #workspace: Promise<Result<Workspace, AnalysisError>> | undefined;
  #closing = false;

  constructor(
    private readonly target: BinaryTarget,
    private readonly lifetime: {
      readonly signal: AbortSignal;
      readonly launcher?: KunaProcessLauncher;
    },
  ) {}

  run(
    request: KunaTargetCommandRequest,
  ): Promise<Result<KunaTargetCommandSnapshot, AnalysisError>> {
    if (this.#closing || request.signal.aborted) {
      request.releaseRun?.();
      return Promise.resolve(
        err(new AnalysisCancelledError(request.operation)),
      );
    }
    return this.#own(this.#run(request));
  }

  #own<T>(work: Promise<T>): Promise<T> {
    this.#active.add(work);
    const release = () => this.#active.delete(work);
    void work.then(release, release);
    return work;
  }

  /** Establish the immutable input before waiting for a foreground run slot. */
  prepare(): Promise<Result<null, AnalysisError>> {
    if (this.#closing || this.lifetime.signal.aborted)
      return Promise.resolve(err(new AnalysisCancelledError("kuna:workspace")));
    return this.#own(
      this.#ensureWorkspace().then((workspace) =>
        workspace.ok ? ok(null) : workspace,
      ),
    );
  }

  async #run(
    request: KunaTargetCommandRequest,
  ): Promise<Result<KunaTargetCommandSnapshot, AnalysisError>> {
    const { releaseRun, ...options } = request;
    let retained = false;
    try {
      const workspace = await this.#ensureWorkspace();
      if (!workspace.ok) return workspace;
      const outcome = await runKunaCommand({
        ...options,
        arguments: request.arguments(workspace.value.input),
        workspace: workspace.value.root.path,
        reportedTimeoutMs: request.timeoutMs,
        launcher: this.lifetime.launcher,
      });
      if (outcome.kind === "retained") {
        this.#retained.push({
          error: outcome.error,
          owner: outcome.owner,
          releaseRun,
        });
        retained = true;
        return err(outcome.error);
      }
      return outcome.kind === "ok"
        ? ok({ ...outcome.snapshot, input: workspace.value.input })
        : err(outcome.error);
    } finally {
      if (!retained) releaseRun?.();
    }
  }

  /** Called after the session signal aborts; failures keep their retry owners. */
  async close(): Promise<Result<null, ProviderCleanupError>> {
    this.#closing = true;
    while (this.#active.size > 0) await Promise.allSettled(this.#active);
    for (const retained of [...this.#retained]) {
      const stopped = await retained.owner?.stop();
      if (stopped !== undefined && stopped.status !== "incomplete") {
        retained.releaseRun?.();
        this.#retained.splice(this.#retained.indexOf(retained), 1);
      }
    }
    const failures = this.#retained.map(({ error }) => error);
    const workspace = await this.#workspace;
    if (this.#retained.length === 0) {
      if (workspace?.ok === true) {
        this.#roots.push(workspace.value.root);
        this.#workspace = undefined;
      }
      for (const root of [...this.#roots])
        try {
          await root.close();
          this.#roots.splice(this.#roots.indexOf(root), 1);
        } catch (cause: unknown) {
          failures.push(
            new ProviderCleanupError(
              KUNA_PROVIDER_ID,
              [root.path],
              {
                reason: cause instanceof Error ? cause.message : String(cause),
              },
              { cause },
            ),
          );
        }
    }
    return failures.length === 0
      ? ok(null)
      : err(
          new ProviderCleanupError(
            KUNA_PROVIDER_ID,
            failures.flatMap((failure) => failure.cleanupResources),
            {
              reason: failures
                .map((failure) =>
                  String(failure.diagnostics?.["reason"] ?? failure.message),
                )
                .join("; "),
            },
          ),
        );
  }

  async #ensureWorkspace(): Promise<Result<Workspace, AnalysisError>> {
    this.#workspace ??= (async () => {
      const root = await PrivateRuntimeRoot.create({ prefix: "rea-kuna-" });
      try {
        const input = join(root.path, basename(this.target.path));
        const digest = await copyAndHash(
          this.target.path,
          input,
          this.lifetime.signal,
        );
        if (digest !== this.target.sha256) {
          await this.#release(root);
          return err(
            new AnalysisArtifactChangedError(
              "kuna:workspace",
              this.target.path,
              "the target no longer matches the digest selected for analysis",
            ),
          );
        }
        await prepareProcessOwnershipInspection(this.lifetime.signal);
        return ok({ root, input: await realpath(input) });
      } catch (cause: unknown) {
        await this.#release(root);
        throw cause;
      }
    })().catch((cause: unknown) =>
      err(
        new ProviderAdapterError(KUNA_PROVIDER_ID, "kuna:workspace", {
          cause,
          userMessage: `Kuna workspace failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        }),
      ),
    );
    const result = await this.#workspace;
    if (!result.ok) this.#workspace = undefined;
    return result;
  }

  async #release(root: PrivateRuntimeRoot): Promise<void> {
    try {
      await root.close();
    } catch {
      this.#roots.push(root);
    }
  }
}
