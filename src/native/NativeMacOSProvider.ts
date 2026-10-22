import {
  plistSourceFormat,
  isBinaryPlistDescription,
  readNativePlistBytes,
  requireRegularPlist,
  nativePlistFailure,
  resolveNativePlistSelection,
  unreadablePlist,
  type NativePlistSelection,
} from "./NativePlistSource.js";
import { bindArtifactFileCleanup } from "../artifacts/ArtifactFileOperation.js";
import { snapshotEnvironment } from "../process/snapshotEnvironment.js";
import {
  APPLE_DISPATCH_METADATA_ANALYSIS_PROFILE,
  NATIVE_MACOS_PROVIDER_IDENTITY as IDENTITY,
  nativeMacOSCapabilities,
} from "./NativeMacOSProviderMetadata.js";
import {
  appleDispatchMetadataFailure,
  inspectAppleDispatchMetadata,
} from "./AppleDispatchMetadata.js";
import {
  observeNativeUi,
  finishNativeUiObservation,
} from "./NativeUiObservation.js";
import { NativeUiCleanupError } from "./NativeUiCleanupError.js";
import { LldbCallTracer, type NativeCallTracer } from "./LldbCallTracer.js";
import { observeNativeCalls } from "./NativeCallObservation.js";
import { realpath } from "node:fs/promises";

import { z } from "zod";

import {
  createAnalysisExecution,
  type AnalysisClient,
  type AnalysisOperation,
  type AnalysisProvider,
  type CapabilityDescriptor,
  type ProviderIdentity,
} from "../application/AnalysisProvider.js";
import {
  NATIVE_TOOL_CONTRACTS,
  type NativeToolName,
} from "../contracts/native/nativeToolContracts.js";
import {
  isMachOFormat,
  type BinaryTarget,
} from "../domain/binaryTargetTypes.js";
import { isAppleDispatchMetadataTarget } from "../domain/native/objcSwiftMetadata.js";
import { toolContract } from "../contracts/toolContracts.js";
import { analysisInputErrorFromIssues } from "../domain/inputIssueProjection.js";
import type { EvidenceLocation } from "../domain/evidence.js";
import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
  AnalysisOutputError,
  AnalysisResourceConstraintError,
  AnalysisTimeoutError,
} from "../domain/analysisErrorCore.js";
import {
  DEFAULT_NATIVE_COMMAND_TIMEOUT_MS,
  DEFAULT_NATIVE_UI_DEADLINE_MS,
  MAX_NATIVE_TIMER_MS,
  fixedNativeAllowance,
  nativeDeadlineRecovery,
  readNativeDeadline,
} from "../domain/native/nativeDeadlines.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import {
  AnalysisError,
  resolvedAnalysisError,
} from "../domain/analysisErrorBase.js";
import { jsonValueSchema, type JsonValue } from "../domain/jsonValue.js";
import {
  projectPlistValue,
  nonFiniteRealLimitation,
  negativeZeroRealLimitation,
  unknownDateLimitation,
  unknownScalarLimitation,
} from "../domain/apple/plistValue.js";
import { createPlistNumberProjection } from "../domain/apple/plistNumbers.js";
import type { NativeUiObservationResult } from "../domain/native/nativeUiObservation.js";
import {
  omittedPrototypeKeysLimitation,
  parseXmlPropertyList,
} from "../domain/propertyListKeys.js";
import {
  demangleSwiftSchema,
  inspectPlistSchema,
  inspectSignatureSchema,
  type InspectSignature,
  listArchitecturesSchema,
  type NativeCommandInvocation,
} from "../domain/native/nativeInspection.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  NATIVE_COMMAND_OUTPUT_BUDGET_BYTES,
  NATIVE_FAILURE_DIAGNOSTIC_BYTES,
  NativeCommandFailure,
  XcrunCommandRunner,
  failureCapture,
  type NativeCommandCleanupFailure,
  type NativeCommandCapture,
  type NativeCommandRunner,
} from "./CommandRunner.js";
import {
  withSignatureTarget,
  verifySignatureTarget,
  type SignatureTargetBinding,
} from "./SignatureTargetBinding.js";
import { parseCodeSignature } from "./parsers/codesign.js";
import { parseDemangledSymbols } from "./parsers/demangle.js";
import { parseLipoOutput } from "./parsers/lipo.js";
import {
  parsePlistJson,
  parsePlistBinary,
  parsePlistXml,
  plistJsonNeedsNumberTypes,
  type ParsedPlist,
} from "./parsers/plist.js";
import {
  architectureLocations,
  inspectNativeMacho,
} from "./NativeMachoInspection.js";
import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import type { PrivateRuntimeRoot } from "../process/PrivateRuntimeRoot.js";
import {
  createNativeUiHelperRuntime,
  type NativeUiHelperRuntime,
} from "./NativeUiHelperRuntime.js";
import { NativeUiInterruptionControl } from "./NativeUiInterruptionControl.js";
import type { ResolvedAppBundleResourceRoot } from "../application/AppBundleExecutable.js";
import { resolveBundleResourcePlistSelection } from "./NativePlistSource.js";

type SignatureRuntimeRootFactory = () => Promise<
  Pick<PrivateRuntimeRoot, "path" | "close">
>;

interface NativePlistReadContext {
  readonly selection: NativePlistSelection;
  readonly resources: ArtifactResourceScope;
  readonly signal: AbortSignal | undefined;
  readonly timeoutMs: number;
}

/** Read-only semantic provider composed from Xcode command-line utilities. */
export class NativeMacOSProvider implements AnalysisProvider {
  readonly #capabilities: readonly CapabilityDescriptor[];
  readonly #environment: NodeJS.ProcessEnv;
  readonly #tracerFactory: () => NativeCallTracer;
  readonly #privateRuntimeRootFactory: SignatureRuntimeRootFactory | undefined;

  constructor(
    environment: Readonly<NodeJS.ProcessEnv>,
    private readonly runner: NativeCommandRunner = new XcrunCommandRunner(
      environment,
    ),
    platform: NodeJS.Platform = process.platform,
    tracerFactory?: () => NativeCallTracer,
    privateRuntimeRootFactory?: SignatureRuntimeRootFactory,
  ) {
    this.#environment = snapshotEnvironment(environment, platform);
    this.#tracerFactory =
      tracerFactory ?? (() => new LldbCallTracer(this.#environment));
    this.#privateRuntimeRootFactory = privateRuntimeRootFactory;
    this.#capabilities = nativeMacOSCapabilities(platform);
  }

  identity(): ProviderIdentity {
    return IDENTITY;
  }

  capabilities(): readonly CapabilityDescriptor[] {
    return this.#capabilities;
  }

  createClient(target: BinaryTarget): AnalysisClient {
    return new NativeMacOSClient(
      target,
      this.runner,
      this.#tracerFactory(),
      this.#environment,
      this.#privateRuntimeRootFactory,
    );
  }

  createBundleResourceClient(
    root: ResolvedAppBundleResourceRoot,
  ): AnalysisClient {
    const plistAvailable = this.#capabilities.some(
      ({ operation, available }) => operation === "inspect_plist" && available,
    );
    return new NativeMacOSClient(
      undefined,
      this.runner,
      this.#tracerFactory(),
      this.#environment,
      this.#privateRuntimeRootFactory,
      root,
      plistAvailable,
    );
  }
}

class NativeMacOSClient implements AnalysisClient {
  readonly #pendingNativeUiRuntimes = new Set<NativeUiHelperRuntime>();
  readonly #pendingCommands = new Set<Promise<unknown>>();
  readonly #signatureResources = new ArtifactResourceScope();
  readonly #plistResources = new ArtifactResourceScope();
  readonly #callResources = new ArtifactResourceScope();
  readonly #dispatchResources = new ArtifactResourceScope();
  #nativeUiTail: Promise<void> = Promise.resolve();
  #closed = false;

  constructor(
    private readonly activeTarget: BinaryTarget | undefined,
    private readonly runner: NativeCommandRunner,
    private readonly tracer: NativeCallTracer,
    private readonly environment: Readonly<NodeJS.ProcessEnv>,
    private readonly privateRuntimeRootFactory:
      | SignatureRuntimeRootFactory
      | undefined,
    private readonly bundleResourceRoot?: ResolvedAppBundleResourceRoot,
    private readonly bundlePlistAvailable = true,
  ) {}

  private get target(): BinaryTarget {
    if (this.activeTarget === undefined)
      throw new Error("This provider client has no executable target");
    return this.activeTarget;
  }

  async execute(
    operation: AnalysisOperation,
    parameters: Readonly<Record<string, JsonValue>>,
    options?: { readonly signal?: AbortSignal },
  ) {
    if (this.#closed)
      return err(
        new AnalysisCapabilityUnavailableError(
          IDENTITY.id,
          operation,
          "Native provider client is closed",
        ),
      );
    if (options?.signal?.aborted === true)
      return err(
        new AnalysisCancelledError(operation, { cause: options.signal.reason }),
      );
    if (operation === "health")
      return ok(createAnalysisExecution(null, IDENTITY));
    if (this.activeTarget === undefined && operation !== "inspect_plist")
      return err(
        new AnalysisCapabilityUnavailableError(
          IDENTITY.id,
          operation,
          "This client is bound to app resource access only.",
        ),
      );
    if (this.bundleResourceRoot !== undefined && !this.bundlePlistAvailable)
      return err(
        new AnalysisCapabilityUnavailableError(
          IDENTITY.id,
          "inspect_plist",
          "Property list inspection requires a macOS host.",
        ),
      );
    if (operation === "inspect_native_dispatch_metadata") {
      const input = toolContract(operation).inputSchema.safeParse(parameters);
      if (!input.success)
        return err(
          analysisInputErrorFromIssues(
            operation,
            input.error.issues,
            parameters,
            {
              cause: input.error,
            },
          ),
        );
      if (!isAppleDispatchMetadataTarget(this.target))
        return err(
          new AnalysisCapabilityUnavailableError(
            IDENTITY.id,
            operation,
            "Binary Apple metadata requires Mach-O; other providers can report symbol-only metadata",
          ),
        );
      try {
        const result = await this.#dispatchResources.run(() =>
          inspectAppleDispatchMetadata(
            this.target,
            input.data.max_records,
            this.#dispatchResources,
            options?.signal,
            input.data.objc_class_import_addresses,
            input.data.objc_class_import_addresses_complete ?? true,
          ),
        );
        return ok(
          createAnalysisExecution(result, result.provider, {
            analysisProfile: APPLE_DISPATCH_METADATA_ANALYSIS_PROFILE,
            locations: [{ kind: "artifact-path", path: this.target.path }],
            limitations: result.result.coverage.flatMap(({ reason }) =>
              reason === null ? [] : [reason],
            ),
          }),
        );
      } catch (cause) {
        return err(appleDispatchMetadataFailure(cause, this.target.path));
      }
    }
    if (!isNativeOperation(operation))
      return err(
        new AnalysisCapabilityUnavailableError(
          IDENTITY.id,
          operation,
          "Operation is not implemented by native macOS tools.",
        ),
      );
    if (operation === "observe_native_calls") {
      const result = await observeNativeCalls(
        this.target,
        parameters,
        this.tracer,
        this.#callResources,
        options?.signal,
      );
      return result.ok
        ? ok(
            createAnalysisExecution(result.value, IDENTITY, {
              limitations: result.value.limitations,
              locations: [{ kind: "artifact-path", path: this.target.path }],
            }),
          )
        : result;
    }
    if (
      operation === "observe_native_ui" ||
      operation === "capture_native_ui_scenario"
    ) {
      return this.#observeNativeUi(operation, parameters, options?.signal);
    }
    try {
      const observation = await this.#dispatch(
        operation,
        parameters,
        options?.signal,
      );
      return observation.ok
        ? ok(
            createAnalysisExecution(observation.value.result, IDENTITY, {
              limitations: observation.value.limitations,
              locations: observation.value.locations,
            }),
          )
        : err(resolvedAnalysisError(observation.error));
    } catch (cause: unknown) {
      return err(nativeOutputFailure(operation, cause));
    }
  }

  async close(): Promise<Result<null, AnalysisError>> {
    this.#closed = true;
    await Promise.allSettled(this.#pendingCommands);
    const uiCleanupFailures = await this.#serializeNativeUi(() =>
      this.#retryNativeUiCleanup(),
    );
    const signatureCleanup = await closeNativeFileScope(
      this.#signatureResources,
      "signature-snapshot",
    );
    const plistCleanup = await closeNativeFileScope(
      this.#plistResources,
      "plist-file",
    );
    const callCleanup = await closeNativeFileScope(
      this.#callResources,
      "native-call-target",
    );
    const dispatchCleanup = await closeNativeFileScope(
      this.#dispatchResources,
      "native-dispatch-metadata-target",
    );
    const commandCleanup = await this.#retryNativeCommandCleanup();
    let result = await this.tracer.close();
    const cleanupErrors = [
      ...(uiCleanupFailures.length === 0
        ? []
        : [this.#nativeUiCleanupFailure(uiCleanupFailures, "close_binary")]),
      ...(commandCleanup === undefined ? [] : [commandCleanup]),
      ...(signatureCleanup === undefined ? [] : [signatureCleanup]),
      ...(plistCleanup === undefined ? [] : [plistCleanup]),
      ...(callCleanup === undefined ? [] : [callCleanup]),
      ...(dispatchCleanup === undefined ? [] : [dispatchCleanup]),
    ];
    for (const cleanupError of cleanupErrors)
      result = result.ok
        ? err(cleanupError)
        : err(
            analysisErrorWithCleanupFailure(
              result.error,
              cleanupError,
            ).bindCleanupDependencies([result.error, cleanupError]),
          );
    return result;
  }

  #observeNativeUi(
    operation: "observe_native_ui" | "capture_native_ui_scenario",
    parameters: Readonly<Record<string, JsonValue>>,
    signal?: AbortSignal,
  ) {
    return this.#serializeNativeUi(async () => {
      if (this.#closed)
        return err(
          new AnalysisCapabilityUnavailableError(
            IDENTITY.id,
            operation,
            "Native provider client is closed",
          ),
        );
      const earlierCleanupFailures = await this.#retryNativeUiCleanup();
      if (earlierCleanupFailures.length > 0)
        return err(
          this.#nativeUiCleanupFailure(earlierCleanupFailures, operation),
        );
      const deadline = readNativeDeadline(
        parameters.native_ui_deadline_ms,
        DEFAULT_NATIVE_UI_DEADLINE_MS,
      );
      if (!deadline.ok)
        return err(
          new AnalysisInputError(operation, { userMessage: deadline.message }, [
            {
              path: ["native_ui_deadline_ms"],
              reason: deadline.reason,
              message: deadline.message,
              minimum: 1,
              maximum: MAX_NATIVE_TIMER_MS,
            },
          ]),
        );
      const runtime = createNativeUiHelperRuntime(
        this.environment,
        deadline.timeoutMs,
      );
      const interruption = new NativeUiInterruptionControl(
        signal,
        runtime.signal,
        deadline.timeoutMs,
      );
      try {
        this.#pendingNativeUiRuntimes.add(runtime);
        let result: Awaited<ReturnType<typeof observeNativeUi>>;
        try {
          result = await observeNativeUi(this.target, operation, parameters, {
            environment: this.environment,
            runtime,
            interruption,
          });
        } catch (cause: unknown) {
          result = err(
            cause instanceof AnalysisError
              ? cause
              : new ProviderAdapterError(IDENTITY.id, operation, { cause }),
          );
        }
        try {
          await runtime.close();
          this.#pendingNativeUiRuntimes.delete(runtime);
        } catch (cause: unknown) {
          result = finishNativeUiObservation(result, operation, interruption);
          const cleanup = this.#nativeUiCleanupFailure(
            [{ runtime, cause }],
            operation,
            result.ok ? result.value : undefined,
          );
          return err(
            result.ok
              ? cleanup
              : analysisErrorWithCleanupFailure(
                  result.error,
                  cleanup,
                  operation,
                ).bindCleanupDependencies([result.error, cleanup]),
          );
        }
        result = finishNativeUiObservation(result, operation, interruption);
        return result.ok
          ? ok(
              createAnalysisExecution(result.value, IDENTITY, {
                limitations: result.value.limitations,
              }),
            )
          : result;
      } finally {
        interruption.dispose();
      }
    });
  }

  #serializeNativeUi<Value>(operation: () => Promise<Value>): Promise<Value> {
    const call = this.#nativeUiTail.then(operation, operation);
    this.#nativeUiTail = call.then(
      () => undefined,
      () => undefined,
    );
    return call;
  }

  async #retryNativeUiCleanup(): Promise<
    Array<{ readonly runtime: NativeUiHelperRuntime; readonly cause: unknown }>
  > {
    const failures: Array<{
      readonly runtime: NativeUiHelperRuntime;
      readonly cause: unknown;
    }> = [];
    for (const runtime of this.#pendingNativeUiRuntimes) {
      try {
        await runtime.close();
        this.#pendingNativeUiRuntimes.delete(runtime);
      } catch (cause: unknown) {
        failures.push({ runtime, cause });
      }
    }
    return failures;
  }

  async #retryNativeCommandCleanup(): Promise<AnalysisError | undefined> {
    if (this.runner.retryCleanup === undefined) return undefined;
    try {
      const failures = await this.runner.retryCleanup();
      return failures.length === 0
        ? undefined
        : nativeCommandCleanupFailure(failures);
    } catch (cause: unknown) {
      return new ProviderCleanupError(
        IDENTITY.id,
        ["native-command-process-cleanup"],
        {
          reason:
            cause instanceof Error
              ? cause.message || cause.name
              : String(cause) || "native command cleanup failed unexpectedly",
        },
        { cause },
      );
    }
  }

  #nativeUiCleanupFailure(
    failures: readonly {
      readonly runtime: NativeUiHelperRuntime;
      readonly cause: unknown;
    }[],
    operation: string,
    partialObservation?: NativeUiObservationResult,
  ): ProviderCleanupError {
    return new NativeUiCleanupError(failures, operation, partialObservation);
  }

  #dispatch(
    operation: NativeToolName,
    parameters: Readonly<Record<string, JsonValue>>,
    signal?: AbortSignal,
  ): Promise<Result<NativeObservation, AnalysisError>> {
    switch (operation) {
      case "observe_native_ui":
      case "capture_native_ui_scenario":
      case "observe_native_calls":
        return Promise.resolve(
          err(
            new AnalysisCapabilityUnavailableError(
              IDENTITY.id,
              operation,
              "UI observation uses its explicit authority boundary",
            ),
          ),
        );
      case "inspect_macho":
      case "inspect_signature":
      case "inspect_plist":
      case "list_architectures":
      case "demangle_swift":
        return this.#dispatchCommand(operation, parameters, signal);
    }
  }

  #dispatchCommand(
    operation:
      | "inspect_macho"
      | "inspect_signature"
      | "inspect_plist"
      | "list_architectures"
      | "demangle_swift",
    parameters: Readonly<Record<string, JsonValue>>,
    signal: AbortSignal | undefined,
  ): Promise<Result<NativeObservation, AnalysisError>> {
    const timeout = readNativeDeadline(
      parameters.native_command_timeout_ms,
      DEFAULT_NATIVE_COMMAND_TIMEOUT_MS,
    );
    if (!timeout.ok)
      return Promise.resolve(
        err(
          new AnalysisInputError(operation, { userMessage: timeout.message }, [
            {
              path: ["native_command_timeout_ms"],
              reason: timeout.reason,
              message: timeout.message,
              minimum: 1,
              maximum: MAX_NATIVE_TIMER_MS,
            },
          ]),
        ),
      );
    const timeoutMs = timeout.timeoutMs;
    switch (operation) {
      case "inspect_macho":
        return this.#inspectMacho(signal, timeoutMs);
      case "inspect_signature":
        return this.#inspectSignature(signal, timeoutMs);
      case "inspect_plist":
        return this.#inspectPlist(parameters, signal, timeoutMs);
      case "list_architectures":
        return this.#listArchitectures(signal, timeoutMs);
      case "demangle_swift":
        return this.#demangle(parameters, signal, timeoutMs);
    }
  }

  async #listArchitectures(
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<Result<NativeObservation, AnalysisError>> {
    // lipo reads only Mach-O; its refusal of a PE, ELF, or plist target is not
    // a tool failure that a retry or `rea doctor` could repair.
    if (!isMachOFormat(this.target.format))
      return err(
        new AnalysisCapabilityUnavailableError(
          IDENTITY.id,
          "list_architectures",
          "Active artifact is not Mach-O.",
        ),
      );
    const capture = await this.#run(
      "list_architectures",
      "lipo",
      ["-detailed_info", this.target.path],
      { signal, timeoutMs },
    );
    if (!capture.ok) return capture;
    const provenance = [invocation(capture.value, this.target.path)];
    const { architectures } = parseLipoOutput(
      capture.value.stdout,
      this.target.path,
    );
    const result = listArchitecturesSchema.parse({
      architectures: {
        items: architectures,
        total: architectures.length,
        exhaustive: true,
        limitations: [],
      },
      provenance,
      limitations: [],
    });
    return ok({
      result: jsonValueSchema.parse(result),
      limitations: [],
      locations: architectureLocations(result.architectures.items),
    });
  }

  async #demangle(
    parameters: Readonly<Record<string, JsonValue>>,
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<Result<NativeObservation, AnalysisError>> {
    const symbols = z.array(z.string()).safeParse(parameters.symbols);
    if (!symbols.success)
      return err(
        new AnalysisOutputError(
          "demangle_swift",
          "symbols were not parsed strings",
        ),
      );
    const capture = await this.#run(
      "demangle_swift",
      "swift-demangle",
      // `--` keeps symbols that begin with `-` from selecting demangler options.
      ["--compact", "--", ...symbols.data],
      { signal, timeoutMs },
    );
    if (!capture.ok) return capture;
    const provenance = [invocation(capture.value, this.target.path)];
    const result = demangleSwiftSchema.parse({
      symbols: parseDemangledSymbols(symbols.data, capture.value.stdout),
      provenance,
      limitations: [],
    });
    return ok({
      result: jsonValueSchema.parse(result),
      limitations: [],
      locations: [],
    });
  }

  async #inspectSignature(
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<Result<NativeObservation, AnalysisError>> {
    // This provider's signature inspection covers Mach-O code signatures
    // only. On another container, codesign's "not signed" verdict cannot
    // see a format-level signature such as a xar pkg signature, so
    // reporting it would claim unsigned for a layer that was never
    // evaluated.
    if (this.target.kind !== "executable" || !isMachOFormat(this.target.format))
      return err(
        new AnalysisCapabilityUnavailableError(
          IDENTITY.id,
          "inspect_signature",
          "Active artifact is not Mach-O; its container-level signature layer is not evaluated by codesign.",
        ),
      );
    const inspected = await withSignatureTarget(
      this.target,
      this.#signatureResources,
      (binding) => this.#inspectBoundSignature(binding, signal, timeoutMs),
      signal,
      this.privateRuntimeRootFactory,
    );
    return inspected.ok
      ? ok({
          result: inspected.value,
          limitations: inspected.value.limitations,
          locations: [],
        })
      : inspected;
  }

  async #inspectBoundSignature(
    binding: SignatureTargetBinding,
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<Result<InspectSignature, AnalysisError>> {
    const executablePaths = [
      binding.snapshotPath,
      ...(await canonicalPath(binding.snapshotPath)),
    ];
    const display = await this.#captureSignature(
      binding,
      ["-d", "--verbose=4"],
      signal,
      timeoutMs,
    );
    if (!display.ok) return display;
    const unsigned = isNonzeroUnsignedObservation(
      display.value,
      binding.snapshotPath,
      executablePaths,
    );
    const displayFailure = codeSignCaptureFailure(
      display.value,
      binding.snapshotPath,
      executablePaths,
    );
    if (displayFailure !== null) return err(displayFailure);
    const requirements = await this.#captureSignature(
      binding,
      ["-d", "-r-"],
      signal,
      timeoutMs,
    );
    if (!requirements.ok) return requirements;
    const requirementsFailure = codeSignCaptureFailure(
      requirements.value,
      binding.snapshotPath,
      executablePaths,
    );
    if (requirementsFailure !== null) return err(requirementsFailure);
    const entitlements = await this.#captureSignature(
      binding,
      ["-d", "--entitlements", ":-"],
      signal,
      timeoutMs,
    );
    if (!entitlements.ok) return entitlements;
    const entitlementsFailure = codeSignCaptureFailure(
      entitlements.value,
      binding.snapshotPath,
      executablePaths,
    );
    if (entitlementsFailure !== null) return err(entitlementsFailure);
    // codesign echoes the resolved executable path in its diagnostics.
    const parsed = parseCodeSignature(
      display.value.stderr,
      unsigned,
      executablePaths,
    );
    // The requirement is printed to stdout; stderr echoes the path.
    const requirementText =
      /designated\s*=>\s*(.+)$/mu.exec(requirements.value.stdout)?.[1] ?? null;
    // Entitlements XML is printed to stdout; stderr echoes the path.
    const entitlementValue = parseEntitlements(entitlements.value.stdout);
    const captures = [display.value, requirements.value, entitlements.value];
    const limitations = [
      ...parsed.limitations,
      ...entitlementValue.limitations.map((note) => `Entitlements: ${note}`),
      "Inspected a digest-verified Mach-O byte snapshot; filesystem-bound signing context and trust validation are not examined.",
      ...(entitlementValue.omittedPrototypeKeys === 0
        ? []
        : [
            `Entitlements: ${omittedPrototypeKeysLimitation(entitlementValue.omittedPrototypeKeys)}`,
          ]),
    ];
    const mixedSigning =
      !unsigned &&
      (isNonzeroUnsignedObservation(
        requirements.value,
        binding.snapshotPath,
        executablePaths,
      ) ||
        isNonzeroUnsignedObservation(
          entitlements.value,
          binding.snapshotPath,
          executablePaths,
        ));
    const observation = () =>
      inspectSignatureSchema.parse({
        ...parsed,
        designated_requirement: requirementText,
        entitlements: entitlementValue.value,
        provenance: captures.map((capture) =>
          invocation(capture, binding.snapshotPath),
        ),
        limitations,
      });
    if (mixedSigning) {
      limitations.push(
        "Partial signature coverage: aggregate signing metadata describes codesign’s default slice; Mach-O slices have mixed signing states.",
      );
      const slices = await this.#inspectMixedSignatureSlices(
        binding,
        parsed.format,
        executablePaths,
        { captures, limitations },
        {
          requirements: requirements.value.exitCode,
          entitlements: entitlements.value.exitCode,
        },
        signal,
        timeoutMs,
      );
      if (!slices.ok) {
        limitations.push(
          "Architecture-specific signature inspection did not complete; remaining slice signing states are unknown.",
        );
        return err(slices.error.retainPartialObservation(observation()));
      }
    }
    const version = await verifySignatureTarget(this.target, binding, signal);
    if (!version.ok)
      return err(version.error.retainPartialObservation(observation()));
    return ok(observation());
  }

  async #inspectMixedSignatureSlices(
    binding: SignatureTargetBinding,
    format: string | null,
    executablePaths: readonly string[],
    observation: { captures: NativeCommandCapture[]; limitations: string[] },
    aggregateExits: Readonly<{
      requirements: number | null;
      entitlements: number | null;
    }>,
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<Result<void, AnalysisError>> {
    const { captures, limitations } = observation;
    const unsigned: string[] = [];
    const unsignedNote = limitations.length;
    limitations.push(
      "One or more Mach-O slices are unsigned, but their architectures could not be classified.",
    );
    if (aggregateExits.requirements !== 0)
      limitations.push(
        "The aggregate designated requirement is unavailable because Mach-O slices have mixed signing states.",
      );
    if (aggregateExits.entitlements !== 0)
      limitations.push(
        "The aggregate entitlements are unavailable because Mach-O slices have mixed signing states.",
      );
    for (const architecture of codeSignArchitectures(format, this.target)) {
      const slice = await this.#captureSignature(
        binding,
        ["-d", "-a", architecture, "--verbose=4"],
        signal,
        timeoutMs,
      );
      if (!slice.ok) return slice;
      captures.push(slice.value);
      if (slice.value.exitCode === 0) continue;
      const failure = codeSignCaptureFailure(
        slice.value,
        binding.snapshotPath,
        executablePaths,
      );
      if (failure !== null) return err(failure);
      unsigned.push(architecture);
      limitations[unsignedNote] =
        `Unsigned Mach-O slices: ${unsigned.join(", ")}.`;
    }
    return ok(undefined);
  }

  async #captureSignature(
    binding: SignatureTargetBinding,
    args: readonly string[],
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<Result<NativeCommandCapture, AnalysisError>> {
    const before = await verifySignatureTarget(this.target, binding, signal);
    if (!before.ok) return before;
    let capture: Result<NativeCommandCapture, AnalysisError>;
    try {
      capture = await this.#run(
        "inspect_signature",
        "codesign",
        [...args, binding.snapshotPath],
        {
          signal,
          acceptNonZero: true,
          timeoutMs,
        },
      );
    } catch (cause: unknown) {
      capture = err(
        new ProviderAdapterError(IDENTITY.id, "inspect_signature", {
          cause,
          diagnostics: {
            phase: "codesign-capture",
            path: this.target.path,
            reason: cause instanceof Error ? cause.message : String(cause),
          },
        }),
      );
    }
    // Verify failed captures too: a disappearing target is not a codesign
    // execution failure, and later captures must never use another version.
    const after = await verifySignatureTarget(this.target, binding, signal);
    return after.ok ? capture : after;
  }

  async #inspectPlist(
    parameters: Readonly<Record<string, JsonValue>>,
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<Result<NativeObservation, AnalysisError>> {
    const requested = parameters.path;
    if (requested !== undefined && typeof requested !== "string")
      return err(
        new AnalysisOutputError("inspect_plist", "path was not a string"),
      );
    try {
      return await this.#plistResources.run(async () => {
        try {
          const plist =
            this.bundleResourceRoot === undefined
              ? await resolveNativePlistSelection(this.target, requested)
              : resolveBundleResourcePlistSelection(
                  this.bundleResourceRoot,
                  requested,
                );
          if (!plist.ok) return plist;
          const fileInput: NativePlistReadContext = {
            selection: plist.value,
            resources: this.#plistResources,
            signal,
            timeoutMs,
          };
          const selected = await requireRegularPlist(fileInput);
          if (!selected.ok) return selected;
          const classified = await this.#run(
            "inspect_plist",
            "file",
            ["-b", plist.value.path],
            { signal, timeoutMs },
          );
          if (!classified.ok) return classified;
          const binary = await this.#inspectBinaryPlist(
            fileInput,
            classified.value,
          );
          if (binary !== undefined) return binary;
          return await this.#inspectConvertedPlist(fileInput, classified.value);
        } catch (cause: unknown) {
          // Producer failures stay opaque; only scope admission failures reach the file mapper.
          return err(nativeOutputFailure("inspect_plist", cause));
        }
      });
    } catch (cause: unknown) {
      return err(nativePlistFailure(cause, undefined));
    }
  }

  async #inspectBinaryPlist(
    fileInput: NativePlistReadContext,
    classified: NativeCommandCapture,
  ): Promise<Result<NativeObservation, AnalysisError> | undefined> {
    if (!isBinaryPlistDescription(classified.stdout)) return undefined;
    const source = await readNativePlistBytes(fileInput);
    if (!source.ok) return source;
    const parsed = parsePlistBinary(source.value);
    if (!parsed.ok) {
      return parsed.error instanceof AnalysisOutputError
        ? err(
            unreadablePlist(
              fileInput.selection,
              "binary property list could not be decoded",
              { cause: parsed.error },
            ),
          )
        : parsed;
    }
    return ok(
      nativePlistObservation({
        parsed: parsed.value,
        format: "binary",
        path: fileInput.selection.path,
        resourceRoot: this.bundleResourceRoot,
        provenance: [
          invocation(classified, fileInput.selection.path, "$PLIST"),
        ],
      }),
    );
  }

  async #inspectConvertedPlist(
    fileInput: NativePlistReadContext,
    classified: NativeCommandCapture,
  ): Promise<Result<NativeObservation, AnalysisError>> {
    const { path } = fileInput.selection;
    const { signal, timeoutMs } = fileInput;
    const json = await this.#run(
      "inspect_plist",
      "plutil",
      ["-convert", "json", "-o", "-", "--", path],
      { signal, acceptNonZero: true, timeoutMs },
    );
    if (!json.ok) return json;
    // JSON cannot express data, dates, or non-finite reals; plutil rejects
    // such plists, so decode its XML conversion instead. JSON also prints an
    // integral <real> like an <integer>, so XML identifies unsafe number types.
    const jsonDecoded = json.value.exitCode === 0;
    const xml =
      jsonDecoded && !plistJsonNeedsNumberTypes(json.value.stdout)
        ? undefined
        : await this.#run(
            "inspect_plist",
            "plutil",
            ["-convert", "xml1", "-o", "-", "--", path],
            { signal, acceptNonZero: !jsonDecoded, timeoutMs },
          );
    if (xml !== undefined && !xml.ok) return xml;
    if (xml !== undefined && xml.value.exitCode !== 0) {
      const capture = failureCapture(xml.value, false);
      return err(
        unreadablePlist(
          fileInput.selection,
          `plutil could not decode it as a property list (${plutilDiagnostic(capture, path)})`,
          {
            capturedOutput: {
              stdout: capture.stdout,
              stderr: capture.stderr,
              truncated: capture.truncated,
              stdout_bytes: capture.stdoutBytes,
              stderr_bytes: capture.stderrBytes,
              exit_code: capture.exitCode,
              signal: capture.signal,
            },
          },
        ),
      );
    }
    const parsed =
      xml === undefined
        ? parsePlistJson(json.value.stdout)
        : jsonDecoded
          ? parsePlistJson(json.value.stdout, xml.value.stdout)
          : parsePlistXml(xml.value.stdout);
    if (!parsed.ok) return parsed;
    const provenance = [
      classified,
      json.value,
      ...(xml === undefined ? [] : [xml.value]),
    ].map((item) => invocation(item, path, "$PLIST"));
    const converted = xml?.value ?? json.value;
    const format = await plistSourceFormat(classified.stdout, {
      ...fileInput,
      capturedOutput: {
        stdout: converted.stdout,
        stderr: converted.stderr,
        truncated: false,
        stdout_bytes: converted.stdoutBytes,
        stderr_bytes: converted.stderrBytes,
        exit_code: converted.exitCode,
        signal: converted.signal,
      },
    });
    if (!format.ok) return format;
    return ok(
      nativePlistObservation({
        parsed: parsed.value,
        format: format.value,
        path,
        resourceRoot: this.bundleResourceRoot,
        provenance,
      }),
    );
  }

  async #inspectMacho(
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<Result<NativeObservation, AnalysisError>> {
    if (!isMachOFormat(this.target.format))
      return err(
        new AnalysisCapabilityUnavailableError(
          IDENTITY.id,
          "inspect_macho",
          "Active artifact is not Mach-O.",
        ),
      );
    return inspectNativeMacho({
      target: this.target,
      ...(signal === undefined ? {} : { signal }),
      run: (tool, arguments_, commandSignal, acceptNonZeroIf) =>
        this.#run("inspect_macho", tool, arguments_, {
          signal: commandSignal,
          timeoutMs,
          ...(acceptNonZeroIf === undefined ? {} : { acceptNonZeroIf }),
        }),
      invocation: (capture) => invocation(capture, this.target.path),
    });
  }

  async #run(
    operation: NativeToolName,
    tool: string,
    arguments_: readonly string[],
    options: {
      readonly signal?: AbortSignal | undefined;
      readonly timeoutMs: number;
      readonly acceptNonZero?: boolean;
      readonly acceptNonZeroIf?:
        | ((capture: NativeCommandCapture) => boolean)
        | undefined;
    },
  ): Promise<Result<NativeCommandCapture, AnalysisError>> {
    if (this.#closed)
      return err(
        new AnalysisCapabilityUnavailableError(
          IDENTITY.id,
          operation,
          "Native provider client is closed",
        ),
      );
    const command = this.runner.run(tool, arguments_, {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      timeoutMs: options.timeoutMs,
      acceptNonZero:
        options.acceptNonZero ?? options.acceptNonZeroIf !== undefined,
    });
    this.#pendingCommands.add(command);
    let captured: Awaited<typeof command>;
    try {
      captured = await command;
    } finally {
      this.#pendingCommands.delete(command);
    }
    if (captured.ok) {
      const hasFailedExit =
        captured.value.exitCode !== 0 || captured.value.signal !== null;
      if (
        hasFailedExit &&
        options.acceptNonZeroIf !== undefined &&
        !options.acceptNonZeroIf(captured.value)
      )
        return err(
          translateCommandFailure(
            operation,
            new NativeCommandFailure(
              tool,
              captured.value.signal !== null ||
                (captured.value.exitCode !== null &&
                  captured.value.exitCode !== 0)
                ? "nonzero-exit"
                : "io",
              captured.value.exitCode,
              undefined,
              {
                stdout: captured.value.stdout,
                stderr: captured.value.stderr,
                stdoutBytes: captured.value.stdoutBytes,
                stderrBytes: captured.value.stderrBytes,
                exitCode: captured.value.exitCode,
                signal: captured.value.signal,
                truncated: false,
              },
            ),
          ),
        );
      return captured;
    }
    return err(
      translateCommandFailure(operation, captured.error, options.timeoutMs),
    );
  }
}

const nativeCommandCleanupFailure = (
  failures: readonly NativeCommandCleanupFailure[],
): ProviderCleanupError => {
  const failure = new ProviderCleanupError(
    IDENTITY.id,
    [...new Set(failures.flatMap(({ resources }) => resources))],
    {
      reason: "Native command process cleanup remains incomplete",
      failures: failures.map(({ reason, resources }) => ({
        reason,
        resources: [...resources],
      })),
    },
  );
  if (
    failures.length === 0 ||
    failures.some(({ marker }) => marker === undefined)
  )
    return failure;
  const markers = failures.flatMap(({ marker }) =>
    marker === undefined ? [] : [marker],
  );
  return markers.length === 0
    ? failure
    : failure.bindCleanupDependencies(markers);
};

/** Each file workflow retains its own exact resource set through client close. */
const closeNativeFileScope = async (
  scope: ArtifactResourceScope,
  resource: string,
): Promise<AnalysisError | undefined> => {
  try {
    await scope.close();
    return undefined;
  } catch (cause: unknown) {
    const observation = ArtifactReaderFailure.cleanupObservation(
      cause,
      resource,
    );
    const failure = new ProviderCleanupError(
      IDENTITY.id,
      observation.resources,
      { reason: observation.reason },
      { operation: "close_binary", cause },
    );
    bindArtifactFileCleanup(cause, failure);
    return failure;
  }
};

const nativeOutputFailure = (
  operation: AnalysisOperation,
  cause: unknown,
): AnalysisError =>
  new AnalysisOutputError(operation, "Native output parsing failed", { cause });

interface NativeObservation {
  readonly result: JsonValue;
  readonly limitations: readonly string[];
  readonly locations: readonly EvidenceLocation[];
}

const isNativeOperation = (
  operation: AnalysisOperation,
): operation is NativeToolName =>
  NATIVE_TOOL_CONTRACTS.some(({ name }) => name === operation);

const translateCommandFailure = (
  operation: NativeToolName,
  failure: NativeCommandFailure,
  timeoutMs = DEFAULT_NATIVE_COMMAND_TIMEOUT_MS,
): AnalysisError => {
  const cleanupOwners = [
    ...failure.cleanupFailures,
    ...(failure.cleanupOwner === undefined
      ? []
      : [
          {
            owner: failure.cleanupOwner,
            marker: failure.cleanupMarker,
            reason:
              failure.cleanupFailure ??
              "native command cleanup remains incomplete",
            resources: failure.cleanupResources,
          },
        ]),
  ];
  const markers = cleanupOwners.flatMap(({ marker }) =>
    marker === undefined ? [] : [marker],
  );
  const bindCleanup = (error: AnalysisError): AnalysisError =>
    cleanupOwners.length === 0 ||
    cleanupOwners.some(({ marker }) => marker === undefined)
      ? error
      : error.bindCleanupDependencies([...new Set(markers)]);
  const preparation = failure.preparationFailure;
  if (preparation !== undefined) {
    const marker = preparation.cleanupFailure;
    const compiler = preparation.compilerOutcome;
    const options = {
      cause: failure,
      ...(preparation.capturedOutput === undefined
        ? {}
        : { capturedOutput: preparation.capturedOutput }),
      ...(marker === undefined
        ? {}
        : {
            cleanup: {
              reason: marker.message,
              resources: marker.cleanupResources,
            },
          }),
      diagnostics: {
        phase: "process-preparation",
        tool: failure.tool,
        reason: failure.reason,
        detail: preparation.message,
        ...(compiler === undefined
          ? {}
          : {
              compiler_outcome: {
                outcome: compiler.outcome,
                code: compiler.code,
                signal: compiler.signal,
                ...(compiler.timeoutMs === undefined
                  ? {}
                  : { timeout_ms: compiler.timeoutMs }),
              },
            }),
      },
    };
    const error =
      preparation.cancellation === undefined
        ? new ProviderAdapterError(IDENTITY.id, operation, options)
        : failure.reason === "timeout"
          ? new AnalysisTimeoutError(operation, timeoutMs, {
              ...options,
              cause: preparation.cancellation.reason,
              ...nativeDeadlineRecovery({
                timeoutMs,
                setting: "native_command_timeout_ms",
                cliFlag: "--native-command-timeout-ms",
                defaultMs: DEFAULT_NATIVE_COMMAND_TIMEOUT_MS,
                phase: "macOS native command deadline",
                unchanged: `The ${String(NATIVE_COMMAND_OUTPUT_BUDGET_BYTES)}-byte command output allowance and the ${String(NATIVE_FAILURE_DIAGNOSTIC_BYTES)}-byte failure-diagnostic excerpt have no runtime override.`,
              }),
            })
          : new AnalysisCancelledError(operation, {
              ...options,
              cause: preparation.cancellation.reason,
            });
    return bindCleanup(
      marker === undefined ? error : error.bindCleanupDependencies([marker]),
    );
  }
  const capturedOutput =
    failure.capture === null
      ? undefined
      : {
          stdout: failure.capture.stdout,
          stderr: failure.capture.stderr,
          truncated: failure.capture.truncated,
          stdout_bytes: failure.capture.stdoutBytes,
          stderr_bytes: failure.capture.stderrBytes,
          exit_code: failure.capture.exitCode,
          signal: failure.capture.signal,
        };
  const cleanup =
    failure.cleanupFailure === null
      ? undefined
      : {
          reason: failure.cleanupFailure,
          resources: [...failure.cleanupResources],
        };
  const errorOptions = {
    ...(capturedOutput === undefined ? {} : { capturedOutput }),
    ...(cleanup === undefined ? {} : { cleanup }),
  };
  if (failure.reason === "unavailable") {
    const reason = `${failure.tool} is unavailable through xcrun.`;
    return bindCleanup(
      new AnalysisCapabilityUnavailableError(IDENTITY.id, operation, reason, {
        ...errorOptions,
        userMessage: reason,
      }),
    );
  }
  if (failure.reason === "cancelled")
    return bindCleanup(
      new AnalysisCancelledError(operation, {
        ...errorOptions,
        ...(failure.cancellation === undefined
          ? {}
          : { cause: failure.cancellation.reason }),
      }),
    );
  if (failure.reason === "timeout")
    return bindCleanup(
      new AnalysisTimeoutError(operation, timeoutMs, {
        ...errorOptions,
        ...nativeDeadlineRecovery({
          timeoutMs,
          setting: "native_command_timeout_ms",
          cliFlag: "--native-command-timeout-ms",
          defaultMs: DEFAULT_NATIVE_COMMAND_TIMEOUT_MS,
          phase: "macOS native command deadline",
          unchanged: `The ${String(NATIVE_COMMAND_OUTPUT_BUDGET_BYTES)}-byte command output allowance and the ${String(NATIVE_FAILURE_DIAGNOSTIC_BYTES)}-byte failure-diagnostic excerpt have no runtime override.`,
        }),
      }),
    );
  if (failure.reason === "output-limit")
    return bindCleanup(
      new AnalysisResourceConstraintError(
        operation,
        "memory",
        `Native command output exceeded ${String(NATIVE_COMMAND_OUTPUT_BUDGET_BYTES)} bytes. Complete output is required for analysis. This release has no runtime override. native_command_timeout_ms does not raise this allowance.`,
        { max_output_bytes: NATIVE_COMMAND_OUTPUT_BUDGET_BYTES },
        {
          ...errorOptions,
          ...fixedNativeAllowance(
            "The native command output capture allowance",
            "capture",
            `${String(NATIVE_COMMAND_OUTPUT_BUDGET_BYTES)} bytes`,
          ),
        },
      ),
    );
  return bindCleanup(
    new ProviderAdapterError(IDENTITY.id, operation, {
      cause: failure,
      ...errorOptions,
      diagnostics: {
        tool: failure.tool,
        reason: failure.reason,
        exit_code: failure.capture?.exitCode ?? failure.exitCode,
        signal: failure.capture?.signal ?? null,
        stdout_bytes: failure.capture?.stdoutBytes ?? 0,
        stderr_bytes: failure.capture?.stderrBytes ?? 0,
        ...(failure.detail === null ? {} : { detail: failure.detail }),
      },
    }),
  );
};

const translateCodeSignExitFailure = (
  capture: NativeCommandCapture,
): AnalysisError =>
  translateCommandFailure(
    "inspect_signature",
    new NativeCommandFailure(
      "codesign",
      "nonzero-exit",
      capture.exitCode,
      undefined,
      // Accepted output stays complete until the provider decides it failed.
      failureCapture(capture, false),
    ),
  );

/**
 * Accept only codesign's exact unsigned diagnostic for the bound snapshot,
 * optionally preceded by its verified Executable path echo.
 * The operand is framed byte-for-byte so caller-controlled path text cannot
 * supply the phrase that determines signature state.
 */
const isNonzeroUnsignedObservation = (
  capture: NativeCommandCapture,
  snapshotPath: string,
  executablePaths: readonly string[],
): boolean => {
  if (
    capture.exitCode === null ||
    capture.exitCode === 0 ||
    capture.signal !== null ||
    capture.arguments.at(-1) !== snapshotPath ||
    capture.stdout !== ""
  )
    return false;
  const diagnostic = `${snapshotPath}: code object is not signed at all`;
  return [
    "",
    ...executablePaths.flatMap((path) => [
      `Executable=${path}\n`,
      `Executable=${path}\r\n`,
    ]),
  ].some((prefix) =>
    [diagnostic, `${diagnostic}\n`, `${diagnostic}\r\n`].some(
      (body) => capture.stderr === `${prefix}${body}`,
    ),
  );
};

const canonicalPath = async (path: string): Promise<string[]> => {
  try {
    return [await realpath(path)];
  } catch {
    return [];
  }
};

const codeSignCaptureFailure = (
  capture: NativeCommandCapture,
  snapshotPath: string,
  executablePaths: readonly string[],
): AnalysisError | null =>
  capture.exitCode === 0 ||
  isNonzeroUnsignedObservation(capture, snapshotPath, executablePaths)
    ? null
    : translateCodeSignExitFailure(capture);

const codeSignArchitectures = (
  format: string | null,
  target: BinaryTarget,
): string[] => {
  const universal = /^Mach-O universal \(([^)\r\n]+)\)$/u.exec(
    format ?? "",
  )?.[1];
  if (universal !== undefined) {
    const architectures = universal
      .split(/\s+/u)
      .filter((architecture) =>
        /^(?:i386|x86_64|armv7|arm64|arm64e)$/u.test(architecture),
      );
    if (architectures.length > 0) return [...new Set(architectures)];
  }
  if (target.kind !== "executable" || !isMachOFormat(target.format)) return [];
  return target.availableArchitectures.map((architecture) =>
    architecture === "x86" ? "i386" : architecture,
  );
};

const invocation = (
  capture: NativeCommandCapture,
  artifactPath: string,
  alias = "$ARTIFACT",
): NativeCommandInvocation => ({
  tool: capture.tool,
  command: [
    capture.executable,
    ...capture.arguments.map((argument) =>
      argument === artifactPath ? alias : argument,
    ),
  ],
  tool_version: capture.toolVersion,
  version_reason: capture.versionReason,
  executable_sha256: capture.executableSha256,
  exit: { code: capture.exitCode, signal: capture.signal },
  stdout_bytes: capture.stdoutBytes,
  stderr_bytes: capture.stderrBytes,
});

const nativePlistObservation = (input: {
  readonly parsed: ParsedPlist;
  readonly format: z.infer<typeof inspectPlistSchema>["format"];
  readonly path: string;
  readonly resourceRoot: ResolvedAppBundleResourceRoot | undefined;
  readonly provenance: readonly NativeCommandInvocation[];
}): NativeObservation => {
  const { parsed, format, path, resourceRoot, provenance } = input;
  const result = inspectPlistSchema.parse({
    format,
    value: parsed.value,
    bundle: parsed.bundle,
    source_path: path,
    ...(resourceRoot === undefined
      ? {}
      : {
          resource_root: {
            caller_path: resourceRoot.callerPath,
            canonical_path: resourceRoot.canonicalPath,
            info_plist_path: resourceRoot.infoPlistPath,
            layout: resourceRoot.layout,
            executable_sha256: resourceRoot.executableSha256,
          },
        }),
    provenance,
    limitations: parsed.limitations,
  });
  return {
    result: jsonValueSchema.parse(result),
    limitations: parsed.limitations,
    locations: [{ kind: "artifact-path", path }],
  };
};

const parseEntitlements = (
  output: string,
): {
  readonly value: JsonValue;
  readonly omittedPrototypeKeys: number;
  readonly limitations: readonly string[];
} => {
  const start = output.indexOf("<?xml");
  const end = output.lastIndexOf("</plist>");
  if (start < 0 || end < start)
    return { value: null, omittedPrototypeKeys: 0, limitations: [] };
  const decoded = parseXmlPropertyList(
    output.slice(start, end + "</plist>".length),
  );
  const projected = projectPlistValue(decoded.value);
  const numbers = createPlistNumberProjection(decoded.numberLiterals);
  const value = numbers.project(projected.value);
  return {
    value,
    omittedPrototypeKeys: decoded.omittedPrototypeKeys,
    limitations: [
      ...numbers.limitations(),
      ...(projected.nonFiniteRealCount === 0
        ? []
        : [nonFiniteRealLimitation(projected.nonFiniteRealCount)]),
      ...(projected.negativeZeroRealCount === 0
        ? []
        : [negativeZeroRealLimitation(projected.negativeZeroRealCount)]),
      ...(projected.unknownDateCount === 0
        ? []
        : [unknownDateLimitation(projected.unknownDateCount)]),
      ...(projected.unknownScalarCount === 0
        ? []
        : [unknownScalarLimitation(projected.unknownScalarCount)]),
    ],
  };
};

/** Failed plutil conversions can report on either stream; preserve both. */
const plutilDiagnostic = (
  capture: Pick<NativeCommandCapture, "stdout" | "stderr">,
  path: string,
): string => {
  const diagnostics = [capture.stderr, capture.stdout]
    .map((stream) => {
      const text = stream.trim();
      return text.startsWith(`${path}: `) ? text.slice(path.length + 2) : text;
    })
    .filter((text) => text.length > 0);
  return diagnostics.length === 0
    ? "plutil printed no diagnostic"
    : diagnostics.join("\n");
};
