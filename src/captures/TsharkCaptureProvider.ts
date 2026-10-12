import {
  readLinuxResourceLimits,
  type LinuxResourceLimits,
} from "../process/LinuxResourceLimits.js";
import { parsePacketOutput } from "./parsePacketOutput.js";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  createAnalysisExecution,
  type AnalysisExecution,
  type ExecutionOptions,
} from "../application/AnalysisProvider.js";
import type { PacketCapturePort } from "../application/captures/PacketCaptureService.js";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { readStableArtifact } from "../artifacts/readStableArtifact.js";
import {
  AnalysisError,
  type AnalysisCapturedOutput,
} from "../domain/analysisErrorBase.js";
import {
  AnalysisAccessDeniedError,
  AnalysisArtifactChangedError,
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
  AnalysisOutputError,
  AnalysisResourceConstraintError,
  AnalysisTimeoutError,
} from "../domain/analysisErrorCore.js";
import { createEvidence } from "../domain/evidence.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
import {
  type InspectPacketCaptureInput,
  packetCaptureSchema,
} from "../domain/captures/packetCapture.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  runOwnedCommand,
  OwnedCommandFailure,
} from "../process/OwnedCommand.js";
import { PrivateRuntimeRoot } from "../process/PrivateRuntimeRoot.js";
import type { ProviderProcessSupervisor } from "../process/ProviderProcess.js";

const OPERATION = "inspect_packet_capture";
export const TSHARK_PROVIDER_IDENTITY = {
  id: "tshark-capture",
  name: "REA TShark capture adapter",
  version: "tshark@4",
} as const;
// Bound the resident input copy and retained text before allocation/collection.
const LIMITS = {
  input_bytes: 32 * 1024 * 1024,
  output_bytes: 4 * 1024 * 1024,
  command_timeout_ms: 30_000,
  address_space_bytes: 1024 * 1024 * 1024,
  file_bytes: 64 * 1024 * 1024,
  cpu_seconds: 30,
} as const;
type Runtime = Pick<PrivateRuntimeRoot, "path" | "close">;
type Launcher = NonNullable<Parameters<typeof runOwnedCommand>[2]>["launcher"];

/** Inspect selected capture files only, retaining cleanup ownership across failures. */
export class TsharkCaptureProvider implements PacketCapturePort {
  readonly #artifactResources = new ArtifactResourceScope();
  readonly #pending = new Map<Runtime, ProviderProcessSupervisor | undefined>();
  #tail: Promise<void> = Promise.resolve();
  #busy = false;
  #closed = false;
  constructor(
    readonly environment: Readonly<NodeJS.ProcessEnv> = process.env,
    readonly launcher?: Launcher,
    readonly createRuntime: () => Promise<Runtime> = () =>
      PrivateRuntimeRoot.create({ prefix: "rea-tshark-" }),
    readonly platform: NodeJS.Platform = process.platform,
    readonly readArtifact: typeof readStableArtifact = readStableArtifact,
    readonly readLimits: typeof readLinuxResourceLimits = readLinuxResourceLimits,
  ) {}
  inspect(
    input: InspectPacketCaptureInput,
    options?: ExecutionOptions,
  ): Promise<Result<AnalysisExecution, AnalysisError>> {
    if (this.#closed || options?.signal?.aborted)
      return Promise.resolve(err(new AnalysisCancelledError(OPERATION)));
    if (this.#busy)
      return Promise.resolve(
        err(
          new AnalysisResourceConstraintError(
            OPERATION,
            "capacity",
            "A packet inspection is already active; retry after it completes.",
            { max_concurrent_inspections: 1 },
          ),
        ),
      );
    this.#busy = true;
    const work = this.#tail
      .then(() =>
        this.#artifactResources.run(() => this.#inspect(input, options)),
      )
      .catch((cause: unknown) =>
        err(
          this.#failure(
            cause,
            "artifact",
            input.path,
            null,
            undefined,
            undefined,
          ),
        ),
      )
      .finally(() => {
        this.#busy = false;
      });
    this.#tail = work.then(
      () => undefined,
      () => undefined,
    );
    return work;
  }
  close(): Promise<void> {
    this.#closed = true;
    const work = this.#tail.then(() => this.#closeResources());
    this.#tail = work.catch(() => undefined);
    return work;
  }
  async #closeResources(): Promise<void> {
    let descriptorFailure: AnalysisError | undefined;
    try {
      await this.#artifactResources.close();
    } catch (cause: unknown) {
      descriptorFailure = this.#failure(
        cause,
        "artifact",
        "TShark artifact descriptors",
        null,
        undefined,
        undefined,
      );
    }
    try {
      await this.#release();
    } catch (cause: unknown) {
      if (descriptorFailure !== undefined && cause instanceof AnalysisError)
        throw analysisErrorWithCleanupFailure(
          descriptorFailure,
          cause,
          OPERATION,
        );
      throw cause;
    }
    if (descriptorFailure !== undefined) throw descriptorFailure;
  }
  #read(path: string, maximumBytes: number, signal?: AbortSignal) {
    return this.readArtifact(
      path,
      maximumBytes,
      signal,
      undefined,
      this.#artifactResources,
    );
  }
  async #release(): Promise<void> {
    for (const [root, owner] of this.#pending) {
      try {
        if (owner !== undefined) {
          const stopped = await owner.stop();
          if (stopped.status === "incomplete") throw new Error(stopped.reason);
          this.#pending.set(root, undefined);
        }
        await root.close();
        this.#pending.delete(root);
      } catch (cause) {
        throw new ProviderCleanupError(
          TSHARK_PROVIDER_IDENTITY.id,
          [root.path],
          { reason: String(cause) },
          { operation: OPERATION, cause },
        );
      }
    }
  }
  async #inspect(
    input: InspectPacketCaptureInput,
    options?: ExecutionOptions,
  ): Promise<Result<AnalysisExecution, AnalysisError>> {
    let phase:
      | "configuration"
      | "artifact"
      | "workspace"
      | "producer"
      | "integrity" = "configuration";
    let capturedOutput: AnalysisCapturedOutput | undefined;
    let resourcePath = input.path;
    let effectiveLimits: LinuxResourceLimits | undefined;
    let root: Runtime | undefined;
    let result: Result<AnalysisExecution, AnalysisError>;
    try {
      if (options?.signal?.aborted) throw new AnalysisCancelledError(OPERATION);
      await this.#release();
      if (this.platform !== "linux")
        throw new Error(
          "Packet inspection requires Linux with util-linux prlimit and REA_TSHARK_COMMAND so expanded captures are processed under an enforced address-space limit.",
        );
      const configured = this.environment.REA_TSHARK_COMMAND ?? "";
      if (!isAbsolute(configured))
        throw new Error("Supply absolute REA_TSHARK_COMMAND for TShark 4.x.");
      const command = await realpath(configured);
      await access(command, constants.X_OK);
      const tool = await this.#read(command, 64 * 1024 * 1024, options?.signal);
      const configuredLimiter =
        this.environment.REA_TSHARK_PRLIMIT_COMMAND ?? "/usr/bin/prlimit";
      if (!isAbsolute(configuredLimiter))
        throw new Error("REA_TSHARK_PRLIMIT_COMMAND must be absolute.");
      const limiter = await realpath(configuredLimiter);
      await access(limiter, constants.X_OK);
      const limiterIdentity = await this.#read(
        limiter,
        64 * 1024 * 1024,
        options?.signal,
      );
      effectiveLimits = await this.readLimits(LIMITS, this.#artifactResources);
      const limitArguments = [
        `--as=${effectiveLimits.address_space_bytes}:${effectiveLimits.address_space_bytes}`,
        `--fsize=${effectiveLimits.file_bytes}:${effectiveLimits.file_bytes}`,
        `--cpu=${effectiveLimits.cpu_seconds}:${effectiveLimits.cpu_seconds}`,
        "--core=0:0",
        "--",
        command,
      ];
      phase = "workspace";
      root = await this.createRuntime();
      this.#pending.set(root, undefined);
      const snapshotPath = join(root.path, "capture");
      const configurationPath = join(root.path, "configuration");
      await mkdir(configurationPath, { mode: 0o700 });
      const execute = async (args: readonly string[]) => {
        const output = await runOwnedCommand(
          {
            command: limiter,
            arguments: [...limitArguments, ...args],
            ...(root === undefined ? {} : { cwd: root.path }),
            expectedCommand: null,
            runId: `rea-tshark-${randomUUID()}`,
            hostEnvironment: {
              ...this.environment,
              WIRESHARK_CONFIG_DIR: configurationPath,
            },
          },
          {
            timeoutMs: LIMITS.command_timeout_ms,
            diagnosticBytes: LIMITS.output_bytes,
            acceptNonZeroExit: true,
          },
          {
            ...(options?.signal === undefined
              ? {}
              : { signal: options.signal }),
            ...(this.launcher === undefined ? {} : { launcher: this.launcher }),
          },
        );
        capturedOutput = {
          stdout: output.stdout.text,
          stderr: output.stderr.text,
          truncated: output.diagnosticTruncated ?? false,
          exit_code: output.exitCode ?? null,
          signal: output.signal ?? null,
        };
        // Finish bounded integrity checks after output; service handles late cancellation with Evidence.
        const previousPhase = phase;
        phase = "integrity";
        resourcePath = command;
        const current = await this.#read(command, 64 * 1024 * 1024);
        resourcePath = limiter;
        const currentLimiter = await this.#read(limiter, 64 * 1024 * 1024);
        if (currentLimiter.sha256 !== limiterIdentity.sha256)
          throw new AnalysisArtifactChangedError(
            OPERATION,
            limiter,
            "Configured resource limiter changed during analysis.",
            { capturedOutput },
          );
        if (current.sha256 !== tool.sha256)
          throw new AnalysisArtifactChangedError(
            OPERATION,
            command,
            "Configured TShark executable changed during analysis.",
            { capturedOutput },
          );
        phase = previousPhase;
        resourcePath = input.path;
        if (output.exitCode !== 0)
          throw new ProviderAdapterError(
            TSHARK_PROVIDER_IDENTITY.id,
            OPERATION,
            {
              diagnostics: {
                exit_code: output.exitCode ?? null,
                stdout: output.stdout.text,
                stderr: output.stderr.text,
              },
            },
          );
        return output;
      };
      phase = "configuration";
      const version = await execute(["--version"]);
      if (
        !/^TShark \(Wireshark\) 4\.[0-9]+\.[0-9]+(?:[ .(\r\n]|$)/u.test(
          version.stdout.text,
        )
      )
        throw new Error(
          "Expected TShark 4.x; inspect the selected installation.",
        );
      phase = "artifact";
      const selected = await this.#read(
        input.path,
        LIMITS.input_bytes,
        options?.signal,
      );
      phase = "workspace";
      await writeFile(snapshotPath, selected.bytes, {
        flag: "wx",
        mode: 0o400,
      });
      phase = "producer";
      const args = [
        "-n",
        "-r",
        "capture",
        "-T",
        "json",
        "--no-duplicate-keys",
        "--temp-dir=.",
        ...(input.two_pass ? ["-2"] : []),
        ...(input.packet_limit === null
          ? []
          : ["-c", String(input.packet_limit)]),
        ...(input.display_filter === null ? [] : ["-Y", input.display_filter]),
        ...input.decode_as.flatMap((value) => ["-d", value]),
        ...[...new Set(["frame.number", ...input.fields])].flatMap((field) => [
          "-e",
          field,
        ]),
      ];
      const output = await execute(args);
      phase = "integrity";
      resourcePath = snapshotPath;
      if (
        (await this.#read(snapshotPath, LIMITS.input_bytes)).sha256 !==
        selected.sha256
      )
        throw new AnalysisArtifactChangedError(
          OPERATION,
          snapshotPath,
          "TShark changed the private capture copy.",
          capturedOutput === undefined ? {} : { capturedOutput },
        );
      phase = "producer";
      resourcePath = input.path;
      const matchingPackets = parsePacketOutput(
        output.stdout.text,
        input.fields,
      );
      const start = Math.min(input.match_offset, matchingPackets.length);
      const end =
        input.match_limit === null
          ? matchingPackets.length
          : start + Math.min(input.match_limit, matchingPackets.length - start);
      const packets = matchingPackets.slice(start, end);
      const report = packetCaptureSchema.parse({
        artifact: {
          path: input.path,
          sha256: selected.sha256,
          bytes: selected.bytes.length,
        },
        selection: input,
        packets,
        output_window: {
          matching_packets: matchingPackets.length,
          returned_packets: packets.length,
          has_more: end < matchingPackets.length,
        },
        read_scope:
          input.packet_limit === null ? "to-eof" : "up-to-input-packet-limit",
        configuration: "private-empty-personal-profile",
        diagnostics: output.stderr.text,
        tool: {
          configured_path: configured,
          path: command,
          sha256: tool.sha256,
          version_banner: version.stdout.text,
          version_diagnostics: version.stderr.text,
          arguments: args,
        },
        resource_limiter: {
          configured_path: configuredLimiter,
          path: limiter,
          sha256: limiterIdentity.sha256,
          arguments: limitArguments,
        },
        limits: { ...LIMITS, ...effectiveLimits },
        hardware_acquisition: "not-performed",
      });
      result = ok(
        createAnalysisExecution(report, TSHARK_PROVIDER_IDENTITY, {
          subject: {
            path: input.path,
            sha256: selected.sha256,
            format: "file",
          },
          locations: [{ kind: "artifact-path", path: input.path }],
          limitations: [
            "Fields are TShark dissector observations under the selected filter/decode-as/pass settings, not independently verified protocol semantics. Missing fields are absent from the producer output, not known zero or empty values.",
            "Packet limits count input packets before display filtering. Filtered results do not establish whole-capture or device traffic absence. Two-pass reassembly cannot recover bytes missing from the recording or beyond the read limit.",
            "Repeated field values remain ordered string arrays; raw packet bytes are included only when explicitly selected as a supported field. Export index/score metadata are omitted. All stderr, including warnings on exit zero, is retained.",
            "A private empty personal configuration is used. Installed libraries, global configuration and dissector plugins are trusted and not fully fingerprinted. File-only analysis and disabled name resolution do not constitute an OS sandbox.",
            "Linux prlimit enforces soft and hard ceilings before execution, preserving stricter inherited limits: at most 1 GiB address space per process, 64 MiB per file, 30 CPU seconds and no core dumps. Effective limits are reported. Resident input is capped at 32 MiB, each command at 30 wall-clock seconds and combined output at 4 MiB. Output overflow fails. These are per-process/per-file limits, not aggregate memory or filesystem quotas; caller-supplied tools and the limiter are trusted.",
          ],
        }),
      );
    } catch (cause) {
      if (
        root !== undefined &&
        cause instanceof OwnedCommandFailure &&
        cause.cleanupOwner !== undefined
      )
        this.#pending.set(root, cause.cleanupOwner);
      result = err(
        this.#failure(
          cause,
          phase,
          resourcePath,
          root?.path ?? null,
          effectiveLimits,
          capturedOutput,
        ),
      );
    }
    try {
      await this.#release();
    } catch (cause) {
      const partialObservation = result.ok
        ? createEvidence(
            result.value.subject ?? undefined,
            result.value.provider,
            {
              operation: OPERATION,
              parameters: input,
              result: result.value.result,
              confidence: "observed",
              locations: result.value.locations,
              limitations: result.value.limitations,
            },
          )
        : result.error.partialObservation;
      return err(
        new ProviderCleanupError(
          TSHARK_PROVIDER_IDENTITY.id,
          [...this.#pending.keys()].map((item) => item.path),
          {
            reason: String(cause),
            previous_error: result.ok
              ? null
              : projectAnalysisError(result.error),
          },
          {
            operation: OPERATION,
            cause,
            ...(partialObservation === undefined ? {} : { partialObservation }),
          },
        ),
      );
    }
    return result;
  }
  #failure(
    cause: unknown,
    phase:
      | "configuration"
      | "artifact"
      | "workspace"
      | "producer"
      | "integrity",
    path: string,
    workspacePath: string | null,
    effectiveLimits: LinuxResourceLimits | undefined,
    observedOutput: AnalysisCapturedOutput | undefined,
  ): AnalysisError {
    if (cause instanceof AnalysisError) return cause;
    if (cause instanceof ArtifactReaderFailure && cause.cleanup !== undefined)
      return new ProviderCleanupError(
        TSHARK_PROVIDER_IDENTITY.id,
        cause.cleanup.resources,
        {
          reason: cause.cleanup.reason,
          ...(observedOutput === undefined
            ? {}
            : { captured_output: { ...observedOutput } }),
        },
        { operation: OPERATION, cause },
      );
    if (
      (cause instanceof Error && cause.name === "AbortError") ||
      (cause instanceof ArtifactReaderFailure && cause.reason === "cancelled")
    )
      return new AnalysisCancelledError(OPERATION, { cause });
    const reason = cause instanceof Error ? cause.message : String(cause);
    if (cause instanceof OwnedCommandFailure) {
      const capturedOutput =
        cause.snapshot === null
          ? undefined
          : {
              stdout: cause.snapshot.stdout.text,
              stderr: cause.snapshot.stderr.text,
              truncated: cause.snapshot.diagnosticTruncated ?? false,
              exit_code: cause.snapshot.exitCode ?? null,
              signal: cause.snapshot.signal ?? null,
            };
      const detail = {
        cause,
        ...(capturedOutput === undefined ? {} : { capturedOutput }),
      };
      if (cause.reason === "cancelled")
        return new AnalysisCancelledError(OPERATION, detail);
      if (cause.reason === "timeout")
        return new AnalysisTimeoutError(
          OPERATION,
          LIMITS.command_timeout_ms,
          detail,
        );
      if (cause.reason === "output-limit")
        return new AnalysisResourceConstraintError(
          OPERATION,
          "memory",
          reason,
          { output_bytes: LIMITS.output_bytes },
          detail,
        );
      if (
        cause.reason === "process" &&
        (cause.snapshot?.signal === "SIGXFSZ" ||
          cause.snapshot?.signal === "SIGXCPU")
      )
        return new AnalysisResourceConstraintError(
          OPERATION,
          cause.snapshot.signal === "SIGXFSZ" ? "file-size" : "cpu",
          `Producer terminated with ${cause.snapshot.signal}; the signal's exact cause is not independently established.`,
          effectiveLimits === undefined ? null : { ...effectiveLimits },
          detail,
        );
      return new AnalysisOutputError(OPERATION, reason, detail);
    }
    if (phase === "workspace") {
      const code =
        cause instanceof Error &&
        "code" in cause &&
        typeof cause.code === "string"
          ? cause.code
          : null;
      if (code === "ENOSPC" || code === "EDQUOT" || code === "EFBIG")
        return new AnalysisResourceConstraintError(
          OPERATION,
          "file-size",
          `Private analysis workspace failed (${code}): ${reason}`,
          { workspace_path: workspacePath, system_code: code },
          { cause },
        );
      return new ProviderAdapterError(TSHARK_PROVIDER_IDENTITY.id, OPERATION, {
        cause,
        userMessage: `Cannot prepare the private analysis workspace: ${reason}`,
        diagnostics: {
          stage: "workspace",
          workspace_path: workspacePath,
          system_code: code,
          reason,
        },
      });
    }
    if (phase === "integrity") {
      const detail = {
        cause,
        ...(observedOutput === undefined
          ? {}
          : { capturedOutput: observedOutput }),
      };
      if (
        cause instanceof ArtifactReaderFailure &&
        ["limit", "integrity", "path"].includes(cause.reason)
      )
        return new AnalysisArtifactChangedError(
          OPERATION,
          path,
          `Post-run identity verification failed for ${path}: ${reason}`,
          detail,
        );
      return new ProviderAdapterError(TSHARK_PROVIDER_IDENTITY.id, OPERATION, {
        ...detail,
        diagnostics: { stage: "integrity", resource_path: path, reason },
      });
    }
    if (phase === "configuration")
      return new AnalysisCapabilityUnavailableError(
        TSHARK_PROVIDER_IDENTITY.id,
        OPERATION,
        reason,
        {
          cause,
          userMessage: `${reason} On Linux, configure TShark 4.x through REA_TSHARK_COMMAND and util-linux prlimit through REA_TSHARK_PRLIMIT_COMMAND (default /usr/bin/prlimit).`,
        },
      );
    if (
      phase === "artifact" &&
      cause instanceof ArtifactReaderFailure &&
      cause.reason === "limit"
    )
      return new AnalysisResourceConstraintError(
        OPERATION,
        "file-size",
        reason,
        { input_bytes: LIMITS.input_bytes },
        { cause },
      );
    if (cause instanceof ArtifactReaderFailure && cause.reason === "integrity")
      return new AnalysisArtifactChangedError(OPERATION, path, reason, {
        cause,
      });
    if (
      phase === "artifact" &&
      cause instanceof Error &&
      "code" in cause &&
      (cause.code === "EACCES" || cause.code === "EPERM")
    )
      return new AnalysisAccessDeniedError(OPERATION, path, cause.code, {
        cause,
      });
    if (phase === "artifact")
      return new AnalysisInputError(OPERATION, { cause }, [
        { path: ["path"], reason: "invalid_value", message: reason },
      ]);
    return new AnalysisOutputError(OPERATION, reason, { cause });
  }
}
