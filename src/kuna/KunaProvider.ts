import { KUNA_STRING_MIN_LENGTH } from "./KunaLimits.js";
import { accessSync, constants, statSync } from "node:fs";

import type {
  AnalysisClient,
  AnalysisProfileResolutionOptions,
  AnalysisProviderCandidate,
  ProviderAvailability,
  ProviderTargetSupport,
} from "../application/AnalysisProvider.js";
import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import {
  createAnalysisProfile,
  type AnalysisProfileCommitment,
} from "../domain/analysisProfile.js";
import type { BinaryTarget } from "../domain/binaryTargetTypes.js";
import { err, ok } from "../domain/result.js";
import type { OwnedFileHandle } from "../filesystem/OwnedFileHandle.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
import { StableFileHashCleanupFailure } from "../filesystem/StableFileHash.js";
import { snapshotEnvironment } from "../process/snapshotEnvironment.js";
import type { KunaProcessLauncher } from "./KunaCommand.js";
import {
  readKunaConfiguration,
  type KunaConfiguration,
} from "./KunaConfiguration.js";
import {
  inspectKunaInstallation,
  type KunaInstallation,
} from "./KunaInstallation.js";
import { KunaProjectCache } from "./KunaProjectCache.js";
import {
  KUNA_PROVIDER_IDENTITY,
  kunaCapabilities,
} from "./KunaProviderCapabilities.js";
import { KUNA_COMMAND_REMEDIATION, KUNA_PROVIDER_ID } from "./KunaRelease.js";
import { KunaRunSlots } from "./KunaRunSlots.js";
import { KunaSessionClient } from "./KunaSessionClient.js";
import { kunaUnavailable } from "./KunaUnavailable.js";

/** Architectures REA verified Kuna on: x86-64 and AArch64 ELF and Mach-O, plus ARM Thumb. */
const VERIFIED_ARCHITECTURES: ReadonlySet<string> = new Set([
  "x86_64",
  "arm64",
  "arm",
]);

/**
 * Bring-your-own Kuna candidate. Discovery reads configuration and the
 * executable's metadata only; the version probe runs when a target is opened.
 */
export class KunaProvider implements AnalysisProviderCandidate {
  readonly #environment: Readonly<NodeJS.ProcessEnv>;
  readonly #readinessFileOwners = new Map<OwnedFileHandle, string>();
  readonly #platform: NodeJS.Platform;
  readonly #launcher: KunaProcessLauncher | undefined;
  readonly #singleFunctionRuns: number | undefined;
  #cache: KunaProjectCache | undefined;
  #runSlots: KunaRunSlots | undefined;

  constructor(
    environment: Readonly<NodeJS.ProcessEnv>,
    options: {
      readonly platform?: NodeJS.Platform;
      readonly launcher?: KunaProcessLauncher;
      /** Test seam for foreground native runs; production derives it from the host. */
      readonly singleFunctionRuns?: number;
    } = {},
  ) {
    this.#platform = options.platform ?? process.platform;
    this.#environment = snapshotEnvironment(environment, this.#platform);
    this.#launcher = options.launcher;
    this.#singleFunctionRuns = options.singleFunctionRuns;
  }

  identity() {
    return KUNA_PROVIDER_IDENTITY;
  }

  capabilities() {
    const availability = this.inspectAvailability();
    return kunaCapabilities(
      availability.status === "available"
        ? { available: true }
        : {
            available: false,
            reason: availability.reason,
            code: availability.code,
          },
    );
  }

  inspectAvailability(): ProviderAvailability {
    const configuration = readKunaConfiguration(
      this.#environment,
      this.#platform,
    );
    if (!configuration.ok)
      return {
        status: "unavailable",
        code: configuration.error.code,
        reason: configuration.error.reason,
        diagnostics: {
          configured: configuration.error.code !== "not_configured",
          version_probed: false,
        },
      };
    const { command } = configuration.value;
    try {
      accessSync(command, constants.X_OK);
      if (!statSync(command).isFile()) throw new Error("not a regular file");
    } catch (cause: unknown) {
      return {
        status: "unavailable",
        code: "executable_missing",
        reason: `Cannot execute REA_KUNA_COMMAND ${command}: ${cause instanceof Error ? cause.message : String(cause)}. ${KUNA_COMMAND_REMEDIATION}`,
        diagnostics: { configured: true, command, version_probed: false },
      };
    }
    return {
      status: "available",
      code: null,
      reason: null,
      diagnostics: {
        configured: true,
        command,
        cache_root: configuration.value.cacheRoot,
        jobs: configuration.value.jobs,
        version_probed: false,
      },
    };
  }

  inspectTargetSupport(target: BinaryTarget): ProviderTargetSupport {
    const diagnostics = {
      target_kind: target.kind,
      target_format: target.format,
    };
    if (target.kind !== "executable")
      return {
        status: "unsupported",
        code: "target_kind_unsupported",
        reason: "Kuna decompiles executable images, not databases or archives.",
        diagnostics,
      };
    if (target.format !== "elf" && target.format !== "mach-o")
      return {
        status: "unsupported",
        code: "target_format_unsupported",
        reason:
          target.format === "mach-o-universal"
            ? "REA's Kuna provider has no verified universal Mach-O slice selection yet; open a thin slice or use another provider."
            : `REA verified the Kuna provider on ELF and thin Mach-O images; ${target.format} is not admitted yet.`,
        diagnostics,
      };
    if (!VERIFIED_ARCHITECTURES.has(target.architecture))
      return {
        status: "unsupported",
        code: "architecture_unsupported",
        reason: `REA verified the Kuna provider on x86-64, AArch64 and ARM; ${target.architecture} is not admitted yet.`,
        diagnostics: { ...diagnostics, architecture: target.architecture },
      };
    return { status: "supported", code: null, reason: null, diagnostics };
  }

  async resolveAnalysisProfile(
    _target: BinaryTarget,
    options?: AnalysisProfileResolutionOptions,
  ) {
    if (options?.signal?.aborted === true)
      return err(new AnalysisCancelledError("kuna:profile"));
    const pending = await this.#closeReadinessOwners();
    if (!pending.ok) return pending;
    const installation = await inspectKunaInstallation(this.#environment, {
      platform: this.#platform,
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
    });
    let value: KunaInstallation;
    if (!installation.ok) {
      const readiness = installation.error;
      const hashFailure =
        readiness.code === "hash_cleanup_failed"
          ? readiness.hashCleanupFailure
          : undefined;
      if (hashFailure !== undefined) {
        this.#readinessFileOwners.set(hashFailure.owner, hashFailure.path);
        try {
          await hashFailure.owner.close();
          this.#readinessFileOwners.delete(hashFailure.owner);
        } catch (cleanupCause: unknown) {
          const cleanup = new ProviderCleanupError(
            KUNA_PROVIDER_ID,
            [hashFailure.path],
            {
              reason:
                cleanupCause instanceof Error
                  ? cleanupCause.message
                  : String(cleanupCause),
              ...(hashFailure instanceof StableFileHashCleanupFailure &&
              hashFailure.completedHash !== undefined
                ? { completed_hash: hashFailure.completedHash }
                : {}),
            },
            { operation: "open_binary", cause: cleanupCause },
          );
          const primary = options?.signal?.aborted
            ? new AnalysisCancelledError("kuna:profile", {
                cause: hashFailure.cause,
              })
            : hashFailure instanceof StableFileHashCleanupFailure &&
                hashFailure.hasPrimaryCause
              ? new ProviderAdapterError(KUNA_PROVIDER_ID, "open_binary", {
                  cause: hashFailure.cause,
                  userMessage: readiness.reason,
                })
              : kunaUnavailable("open_binary", readiness.reason);
          return err(
            analysisErrorWithCleanupFailure(primary, cleanup, "open_binary"),
          );
        }
        if (
          hashFailure instanceof StableFileHashCleanupFailure &&
          hashFailure.hasPrimaryCause
        ) {
          if (options?.signal?.aborted)
            return err(
              new AnalysisCancelledError("kuna:profile", {
                cause: hashFailure.cause,
              }),
            );
          return err(
            new ProviderAdapterError(KUNA_PROVIDER_ID, "open_binary", {
              cause: hashFailure.cause,
              userMessage: readiness.reason,
            }),
          );
        }
        const completedInstallation =
          readiness.code === "hash_cleanup_failed"
            ? readiness.completedInstallation
            : undefined;
        if (completedInstallation === undefined)
          return err(kunaUnavailable("open_binary", installation.error.reason));
        value = completedInstallation;
      } else {
        return err(kunaUnavailable("open_binary", installation.error.reason));
      }
    } else value = installation.value;
    return ok({
      profile: createAnalysisProfile(
        { ...KUNA_PROVIDER_IDENTITY, version: value.version },
        {
          kuna_version: value.version,
          kuna_sha256: value.sha256,
          verified_release: value.verified,
          jobs: value.configuration.jobs,
          export: "decompile-project",
          reference_graph: {
            command: "decompile-graph",
            schema_version: 4,
            bodies: false,
            edge_kind: "call",
          },
          xrefs: { command: "xrefs", direction: "to", exact_address: true },
          strings: {
            command: "strings",
            encoding: "all",
            min_length: KUNA_STRING_MIN_LENGTH,
            termination: "any",
            xrefs: false,
          },
          cache_policy: "live",
        },
      ),
    });
  }

  /** Release candidate resources even when no target client was opened. */
  async closeOwnedResources() {
    const readiness = await this.#closeReadinessOwners();
    const cache = await this.#cache?.close();
    if (readiness.ok && (cache === undefined || cache.ok)) return ok(null);
    if (!readiness.ok && (cache === undefined || cache.ok)) return readiness;
    if (readiness.ok && cache !== undefined && !cache.ok) return cache;
    const failures = [
      ...(readiness.ok ? [] : [readiness.error]),
      ...(cache === undefined || cache.ok ? [] : [cache.error]),
    ];
    return err(
      new ProviderCleanupError(
        KUNA_PROVIDER_ID,
        failures.flatMap((failure) => failure.cleanupResources),
        { reason: failures.map((failure) => failure.message).join("; ") },
        { cause: new AggregateError(failures) },
      ),
    );
  }

  /** Report retained file cleanup without probing readiness or retrying owners. */
  hasPendingOwnedResources(): boolean {
    return (
      this.#readinessFileOwners.size > 0 ||
      this.#cache?.hasPendingCleanup === true
    );
  }

  async #closeReadinessOwners() {
    const failures: { readonly path: string; readonly cause: unknown }[] = [];
    for (const [owner, path] of this.#readinessFileOwners) {
      try {
        await owner.close();
        this.#readinessFileOwners.delete(owner);
      } catch (cause: unknown) {
        failures.push({ path, cause });
      }
    }
    if (failures.length === 0) return ok(null);
    return err(
      new ProviderCleanupError(
        KUNA_PROVIDER_ID,
        failures.map(({ path }) => path),
        { reason: "Kuna executable hash descriptors remain open" },
        { operation: "open_binary", cause: new AggregateError(failures) },
      ),
    );
  }

  createClient(
    target: BinaryTarget,
    profile?: AnalysisProfileCommitment,
  ): AnalysisClient {
    const configuration = readKunaConfiguration(
      this.#environment,
      this.#platform,
    );
    if (!configuration.ok)
      return {
        execute: async (operation) =>
          err(kunaUnavailable(operation, configuration.error.reason)),
        close: async () => ok(null),
      };
    return new KunaSessionClient(target, profile, {
      cache: this.#projectCache(configuration.value),
      runSlots: this.#foregroundSlots(configuration.value),
      environment: this.#environment,
      ...(this.#launcher === undefined ? {} : { launcher: this.#launcher }),
    });
  }

  /** One cache per provider, so sessions of one server share exports in flight. */
  #projectCache(configuration: KunaConfiguration): KunaProjectCache {
    this.#cache ??= new KunaProjectCache(configuration.cacheRoot, {
      maxBytes: configuration.cacheMaxBytes,
      ...(this.#launcher === undefined ? {} : { launcher: this.#launcher }),
    });
    return this.#cache;
  }

  /** One admission pool per provider, so concurrent sessions share the host's cores. */
  #foregroundSlots(configuration: KunaConfiguration): KunaRunSlots {
    this.#runSlots ??=
      this.#singleFunctionRuns === undefined
        ? KunaRunSlots.forHost(configuration.jobs)
        : new KunaRunSlots(this.#singleFunctionRuns);
    return this.#runSlots;
  }
}
