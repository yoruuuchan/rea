import { createHash } from "node:crypto";
import { open, type FileHandle } from "node:fs/promises";
import { z } from "zod";

import type { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import {
  AnalysisCleanupLease,
  AnalysisCleanupLeaseGroup,
} from "../artifacts/AnalysisCleanupLease.js";
import type { RetainedResourceScope } from "../application/AnalysisProvider.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import type { BinaryTarget } from "../domain/binaryTargetTypes.js";
import { BinaryTargetError } from "../domain/configurationErrors.js";
import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import {
  readFatSliceDeclarations,
  validateFatSlice,
  type FatSliceDeclaration,
} from "../domain/apple/machoContainer.js";
import { machoCpuSubtypeBase } from "../domain/apple/machoCpuIdentity.js";
import type { HeaderArchitecture } from "../domain/binaryTargetTypes.js";
import {
  HopperCancelledError,
  HopperStartError,
} from "../domain/hopperErrors.js";
import { err, ok, type Result } from "../domain/result.js";
import { OwnedFileHandle } from "../filesystem/OwnedFileHandle.js";
import { readFileHandleChunks } from "../filesystem/readFileHandleChunks.js";

/** Narrow file-opening dependency for the owned prepared-image copy. */
export interface HopperMachOImageFileSystem {
  readonly open: typeof open;
}

export interface HopperMachOImageCopyDependencies {
  /** Persistent owner that can retry any retained descriptor cleanup. */
  readonly resourceScope: ArtifactResourceScope;
  readonly fileSystem?: HopperMachOImageFileSystem;
}

export interface HopperMachOImagePreparationOptions extends HopperMachOImageCopyDependencies {
  readonly signal?: AbortSignal;
  readonly observer?: HopperMachOImageCopyObserver;
}

const defaultHopperMachOImageFileSystem: HopperMachOImageFileSystem = { open };

const hopperFatMachOImageSchema = z.strictObject({
  method: z.enum(["fat32_thin_slice", "fat64_thin_slice"]),
  architecture_count: z.number().int().min(1).max(128),
  container_table_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  source_offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  byte_length: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  cpu_type: z.number().int().nonnegative(),
  cpu_subtype: z.number().int().nonnegative(),
});

const hopperThinMachOImageSchema = z.strictObject({
  method: z.literal("thin_verified_copy"),
  byte_length: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  cpu_type: z.number().int().nonnegative(),
  cpu_subtype: z.number().int().nonnegative(),
});

/** Stable source coordinates committed before preparing an owned thin image. */
export const hopperMachOImageSchema = z.discriminatedUnion("method", [
  hopperFatMachOImageSchema,
  hopperThinMachOImageSchema,
]);

export type HopperMachOImage = z.infer<typeof hopperMachOImageSchema>;
type HopperMachOImageResolutionError =
  | BinaryTargetError
  | AnalysisCancelledError;

/** Controlled checkpoint for deterministic interruption of a real copy. */
export interface HopperMachOImageCopyObserver {
  readonly afterChunkWritten?: (copiedBytes: number) => Promise<void>;
}

/** Filesystem access used by the admitted Mach-O preflight. */
export interface HopperMachOImageResolutionFileSystem {
  readonly open: typeof open;
}

export interface HopperMachOImageResolutionOptions {
  readonly resourceScope: RetainedResourceScope;
  readonly signal?: AbortSignal;
  readonly fileSystem?: HopperMachOImageResolutionFileSystem;
}

const defaultHopperMachOImageResolutionFileSystem: HopperMachOImageResolutionFileSystem =
  {
    open,
  };

/** Validate the selected Mach-O image without depending on Apple's lipo tool. */
export const resolveHopperMachOImage = async (
  target: BinaryTarget & { readonly kind: "executable" },
  options: HopperMachOImageResolutionOptions,
): Promise<Result<HopperMachOImage, AnalysisError>> => {
  const invalid = (reason: string, cause?: unknown) =>
    err(
      new BinaryTargetError(
        target.path,
        reason,
        cause === undefined ? undefined : { cause },
      ),
    );
  if (options.signal?.aborted)
    return err(
      new AnalysisCancelledError("open_binary", {
        cause: options.signal.reason,
      }),
    );
  if (target.format !== "mach-o" && target.format !== "mach-o-universal")
    return invalid("Hopper image preparation requires a Mach-O target");
  let opened: FileHandle;
  try {
    opened = await (
      options.fileSystem ?? defaultHopperMachOImageResolutionFileSystem
    ).open(target.path, "r");
  } catch (cause: unknown) {
    // Keep the OS error so a read-permission denial reports access_denied.
    return invalid(
      `Cannot read Mach-O source for Hopper image preparation: ${cause instanceof Error ? cause.message : String(cause)}`,
      cause,
    );
  }
  return inspectAndFinalizeHopperMachOImage(
    target,
    new OwnedFileHandle(opened),
    options,
  );
};

const inspectAndFinalizeHopperMachOImage = async (
  target: BinaryTarget & { readonly kind: "executable" },
  owner: OwnedFileHandle,
  options: HopperMachOImageResolutionOptions,
): Promise<Result<HopperMachOImage, AnalysisError>> => {
  let result: Result<HopperMachOImage, HopperMachOImageResolutionError>;
  try {
    result = await inspectHopperMachOImage(
      target,
      owner.handle,
      options.signal,
    );
  } catch (cause: unknown) {
    result =
      cause instanceof BinaryTargetError ||
      cause instanceof AnalysisCancelledError
        ? err(cause)
        : err(
            new BinaryTargetError(
              target.path,
              `Cannot validate Mach-O image: ${cause instanceof Error ? cause.message : String(cause)}`,
              { cause },
            ),
          );
  }
  const cancellationBeforeClose = options.signal?.aborted === true;
  let closeOutcome:
    | { readonly kind: "closed" }
    | { readonly kind: "failed"; readonly cause: unknown };
  try {
    await owner.close();
    closeOutcome = { kind: "closed" };
  } catch (cause: unknown) {
    closeOutcome = { kind: "failed", cause };
  }
  if (closeOutcome.kind === "closed") {
    if (result.ok && options.signal?.aborted)
      return err(
        new AnalysisCancelledError("open_binary", {
          cause: options.signal.reason,
        }),
      );
    return result;
  }
  return retainHopperPreflightCloseFailure({
    target,
    owner,
    resourceScope: options.resourceScope,
    result,
    cancellationBeforeClose,
    signal: options.signal,
    closeFailure: closeOutcome.cause,
  });
};

const retainHopperPreflightCloseFailure = (options: {
  readonly target: BinaryTarget & { readonly kind: "executable" };
  readonly owner: OwnedFileHandle;
  readonly resourceScope: RetainedResourceScope;
  readonly result: Result<HopperMachOImage, HopperMachOImageResolutionError>;
  readonly cancellationBeforeClose: boolean;
  readonly signal: AbortSignal | undefined;
  readonly closeFailure: unknown;
}): Result<HopperMachOImage, AnalysisError> => {
  const resource = `hopper-macho-preflight:${options.target.path}`;
  const lease = AnalysisCleanupLease.forCloseOwner(options.owner, resource);
  options.resourceScope.retain(
    {
      close: () => lease.release(),
      get cleanupResources() {
        return lease.cleanupResources;
      },
    },
    resource,
  );
  const cleanup = {
    reason:
      options.closeFailure instanceof Error
        ? options.closeFailure.message
        : String(options.closeFailure),
    resources: [resource],
  };
  const cancellationIsPrimary =
    (!options.result.ok &&
      options.result.error instanceof AnalysisCancelledError) ||
    (options.result.ok && options.cancellationBeforeClose);
  let failure: AnalysisError;
  let closeIsPrimary = false;
  if (!options.result.ok) {
    failure =
      options.result.error instanceof BinaryTargetError
        ? new BinaryTargetError(
            options.result.error.path,
            options.result.error.reason,
            {
              ...(options.result.error.cause === undefined
                ? {}
                : { cause: options.result.error.cause }),
              ...(options.result.error.constraint === undefined
                ? {}
                : { constraint: options.result.error.constraint }),
              cleanup,
            },
          )
        : new AnalysisCancelledError("open_binary", {
            cause: options.result.error.cause,
            cleanup,
          });
  } else if (options.cancellationBeforeClose) {
    failure = new AnalysisCancelledError("open_binary", {
      cause: options.signal?.reason,
      cleanup,
    });
  } else {
    failure = new BinaryTargetError(
      options.target.path,
      "Could not confirm closure of the Mach-O preflight handle",
      { cause: options.closeFailure, cleanup },
    );
    closeIsPrimary = true;
  }
  const cleanupError = new ProviderCleanupError(
    "hopper",
    [resource],
    { reason: cleanup.reason },
    {
      cause: options.closeFailure,
      operation: "resolve_analysis_profile",
    },
  );
  if (!closeIsPrimary) {
    lease.bindCleanupError(cleanupError);
    failure.retainSecondaryFailure(cleanupError);
  }
  if (options.signal?.aborted && !cancellationIsPrimary)
    failure.retainSecondaryFailure(
      new AnalysisCancelledError("open_binary", {
        cause: options.signal.reason,
      }),
    );
  new AnalysisCleanupLeaseGroup(failure, [lease]);
  return err(failure);
};

const inspectHopperMachOImage = async (
  target: BinaryTarget & { readonly kind: "executable" },
  file: FileHandle,
  signal: AbortSignal | undefined,
): Promise<Result<HopperMachOImage, HopperMachOImageResolutionError>> => {
  const invalid = (reason: string, cause?: unknown) =>
    err(
      new BinaryTargetError(
        target.path,
        reason,
        cause === undefined ? undefined : { cause },
      ),
    );
  const read = async (offset: number, length: number): Promise<Buffer> => {
    const bytes = Buffer.alloc(length);
    const { bytesRead } = await file.read(bytes, 0, length, offset);
    return bytes.subarray(0, bytesRead);
  };
  const header = await read(0, 8);
  const magic = header.length === 8 ? header.readUInt32BE(0) : 0;
  if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe].includes(magic)) {
    if (target.format !== "mach-o")
      return invalid("Thin Mach-O source disagrees with its admitted format");
    const prefix = Buffer.alloc(12);
    const hash = createHash("sha256");
    let prefixLength = 0;
    let size = 0;
    for await (const chunk of readFileHandleChunks(file, {
      ...(signal === undefined ? {} : { signal }),
      cancellationFailure: (reason) =>
        new AnalysisCancelledError("open_binary", { cause: reason }),
    })) {
      if (signal?.aborted)
        return err(
          new AnalysisCancelledError("open_binary", {
            cause: signal.reason,
          }),
        );
      const bytes = Buffer.from(chunk);
      hash.update(bytes);
      size += bytes.length;
      if (!Number.isSafeInteger(size))
        return invalid("Thin Mach-O exceeds exact selection coordinates");
      const copied = Math.min(prefix.length - prefixLength, bytes.length);
      if (copied > 0) {
        bytes.copy(prefix, prefixLength, 0, copied);
        prefixLength += copied;
      }
    }
    if (signal?.aborted)
      return err(
        new AnalysisCancelledError("open_binary", { cause: signal.reason }),
      );
    if (prefixLength !== prefix.length)
      return invalid("Thin Mach-O header is truncated");
    const observedSha256 = hash.digest("hex");
    if (observedSha256 !== target.sha256)
      return invalid(
        `Thin Mach-O source changed after target admission: expected SHA-256 ${target.sha256}, observed ${observedSha256}`,
      );
    const little = magic === 0xcefaedfe || magic === 0xcffaedfe;
    const headerMagic = prefix.readUInt32BE(0);
    if (headerMagic !== magic)
      return invalid("Thin Mach-O header changed during profile resolution");
    return ok({
      method: "thin_verified_copy",
      byte_length: size,
      cpu_type: little ? prefix.readUInt32LE(4) : prefix.readUInt32BE(4),
      cpu_subtype: little ? prefix.readUInt32LE(8) : prefix.readUInt32BE(8),
    });
  }
  const isFatMagic = [0xcafebabe, 0xcafebabf, 0xbebafeca, 0xbfbafeca].includes(
    magic,
  );
  if (!isFatMagic)
    return invalid(
      "Mach-O source header changed before Hopper image preparation",
    );
  const wide = magic === 0xcafebabf || magic === 0xbfbafeca;
  const littleEndian = magic === 0xbebafeca || magic === 0xbfbafeca;
  const entrySize = wide ? 32 : 20;
  const count = littleEndian ? header.readUInt32LE(4) : header.readUInt32BE(4);
  const size = (await file.stat()).size;
  const tableEnd = 8 + count * entrySize;
  if (count === 0 || count > 128 || tableEnd > size)
    return invalid(
      "FAT architecture table is truncated or exceeds the supported 128 entries",
    );
  const table = await read(8, count * entrySize);
  const parsed = readFatSliceDeclarations(table, {
    count,
    wide,
    littleEndian,
  });
  if (parsed.status === "malformed") return invalid(parsed.reason);
  if (
    target.architecture !== "x86" &&
    target.architecture !== "x86_64" &&
    target.architecture !== "arm" &&
    target.architecture !== "arm64"
  )
    return invalid("Hopper cannot select the admitted Mach-O architecture");
  const architecture = target.architecture;
  const cpuTypes = { x86: 7, x86_64: 0x1000007, arm: 12, arm64: 0x100000c };
  const matches = [];
  const ranges = [];
  for (const slice of parsed.slices) {
    if (signal?.aborted)
      return err(
        new AnalysisCancelledError("open_binary", { cause: signal.reason }),
      );
    const rangeError = validateFatSlice(slice, size, tableEnd);
    if (rangeError !== null) return invalid(rangeError);
    if (wide) {
      const reserved = littleEndian
        ? table.readUInt32LE(slice.index * 32 + 28)
        : table.readUInt32BE(slice.index * 32 + 28);
      if (reserved !== 0)
        return invalid(
          `FAT64 architecture ${slice.index} has a nonzero reserved field`,
        );
    }
    if (slice.size < 12)
      return invalid(
        `FAT architecture ${slice.index} has a truncated Mach-O header`,
      );
    const embedded = await read(slice.offset, 12);
    if (embedded.length !== 12)
      return invalid(`FAT architecture ${slice.index} became truncated`);
    const thinMagic = embedded.readUInt32BE(0);
    if (![0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe].includes(thinMagic))
      return invalid(
        `FAT architecture ${slice.index} does not contain a Mach-O image`,
      );
    const little = thinMagic === 0xcefaedfe || thinMagic === 0xcffaedfe;
    const identity = {
      cpuType: little ? embedded.readUInt32LE(4) : embedded.readUInt32BE(4),
      cpuSubtype: little ? embedded.readUInt32LE(8) : embedded.readUInt32BE(8),
    };
    const identityError = validateFatSlice(slice, size, tableEnd, identity);
    if (identityError !== null) return invalid(identityError);
    ranges.push(slice);
    if (slice.cpuType === cpuTypes[architecture]) matches.push(slice);
  }
  ranges.sort((a, b) => a.offset - b.offset);
  for (let index = 1; index < ranges.length; index++) {
    const previous = ranges[index - 1];
    const current = ranges[index];
    if (
      previous !== undefined &&
      current !== undefined &&
      current.offset < previous.offset + previous.size
    )
      return invalid("FAT slices overlap");
  }
  const selected = selectHopperSlice(matches, architecture);
  if (selected === undefined)
    return invalid(
      `FAT selection for ${architecture} is ${matches.length === 0 ? "missing" : "ambiguous"}; extract the exact architecture into a thin image before opening it`,
    );
  return ok({
    method: wide ? "fat64_thin_slice" : "fat32_thin_slice",
    architecture_count: count,
    container_table_sha256: createHash("sha256")
      .update(header)
      .update(table)
      .digest("hex"),
    source_offset: selected.offset,
    byte_length: selected.size,
    cpu_type: selected.cpuType,
    cpu_subtype: selected.cpuSubtype,
  });
};

/**
 * Plain arm64 (cpusubtype 0) and arm64e (cpusubtype 2) function-entry encodings
 * decode under Hopper's --aarch64; Apple's arm64e.x1 variant (cpusubtype 12)
 * does not, so it is selected only when it is the arm64 family's only candidate.
 * Every other ambiguity stays fail-closed.
 */
const selectHopperSlice = (
  matches: readonly FatSliceDeclaration[],
  architecture: HeaderArchitecture,
): FatSliceDeclaration | undefined => {
  if (matches.length === 1) return matches[0];
  if (architecture !== "arm64") return undefined;
  for (const cpuSubtype of [0, 2]) {
    const preferred = matches.filter(
      (slice) => machoCpuSubtypeBase(slice.cpuSubtype) === cpuSubtype,
    );
    if (preferred.length === 1) return preferred[0];
    if (preferred.length > 1) return undefined;
  }
  return undefined;
};

/** Copy a selected slice and verify the entire original source in the same pass. */
export const prepareHopperMachOImage = async (
  sourcePath: string,
  sourceSha256: string,
  image: HopperMachOImage,
  destination: string,
  options: HopperMachOImagePreparationOptions,
): Promise<Result<string, HopperStartError | HopperCancelledError>> => {
  const copyDependencies = {
    resourceScope: options.resourceScope,
    fileSystem: options.fileSystem ?? defaultHopperMachOImageFileSystem,
  };
  const { signal, observer } = options;
  if (signal?.aborted) return err(new HopperCancelledError(signal.reason));
  if (image.method === "thin_verified_copy") {
    const prepared = await prepareThinHopperMachOImage(
      sourcePath,
      sourceSha256,
      image,
      destination,
      { signal, observer, ...copyDependencies },
    );
    return signal?.aborted && prepared.ok
      ? err(new HopperCancelledError(signal.reason))
      : prepared;
  }
  const tableEntrySize = image.method === "fat64_thin_slice" ? 32 : 20;
  const hash = createHash("sha256");
  const tableHash = createHash("sha256");
  const tableEnd = 8 + image.architecture_count * tableEntrySize;
  const thinHeader: Buffer[] = [];
  let copied = 0;
  const copiedResult = await copyHopperSource({
    sourcePath,
    destination,
    signal,
    observer,
    ...copyDependencies,
    selectBytes: (bytes, position) => {
      hash.update(bytes);
      if (position < tableEnd)
        tableHash.update(
          bytes.subarray(0, Math.min(bytes.length, tableEnd - position)),
        );
      const start = Math.max(0, image.source_offset - position);
      const end = Math.min(
        bytes.length,
        image.source_offset + image.byte_length - position,
      );
      if (end <= start) return undefined;
      if (copied < 12)
        thinHeader.push(
          bytes.subarray(start, Math.min(end, start + 12 - copied)),
        );
      copied += end - start;
      return bytes.subarray(start, end);
    },
    failureContext: `Cannot prepare the selected FAT image from ${sourcePath}`,
  });
  if (!copiedResult.ok) return copiedResult;
  const observed = hash.digest("hex");
  const header = Buffer.concat(thinHeader);
  const magic = header.length === 12 ? header.readUInt32BE(0) : 0;
  const little = magic === 0xcefaedfe || magic === 0xcffaedfe;
  const headerMatches =
    header.length === 12 &&
    [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe].includes(magic) &&
    (little ? header.readUInt32LE(4) : header.readUInt32BE(4)) ===
      image.cpu_type &&
    (little ? header.readUInt32LE(8) : header.readUInt32BE(8)) ===
      image.cpu_subtype;
  if (
    tableHash.digest("hex") !== image.container_table_sha256 ||
    !headerMatches
  )
    return err(
      new HopperStartError({
        userMessage: `FAT source ${sourcePath} no longer agrees with its committed architecture table or selected Mach-O header. Open the stable source again.`,
      }),
    );
  if (observed !== sourceSha256 || copied !== image.byte_length)
    return err(
      new HopperStartError({
        userMessage: `FAT source ${sourcePath} changed before launch: expected SHA-256 ${sourceSha256}, observed ${observed}; copied ${copied} of ${image.byte_length} selected bytes. Open the stable source again.`,
      }),
    );
  return signal?.aborted
    ? err(new HopperCancelledError(signal.reason))
    : ok(destination);
};

const prepareThinHopperMachOImage = async (
  sourcePath: string,
  sourceSha256: string,
  image: Extract<HopperMachOImage, { method: "thin_verified_copy" }>,
  destination: string,
  options: {
    readonly signal: AbortSignal | undefined;
    readonly observer: HopperMachOImageCopyObserver | undefined;
    readonly resourceScope: ArtifactResourceScope;
    readonly fileSystem: HopperMachOImageFileSystem;
  },
): Promise<Result<string, HopperStartError | HopperCancelledError>> => {
  const { signal, observer, resourceScope, fileSystem } = options;
  const hash = createHash("sha256");
  const prefix = Buffer.alloc(12);
  let prefixLength = 0;
  const copiedResult = await copyHopperSource({
    sourcePath,
    destination,
    signal,
    observer,
    resourceScope,
    fileSystem,
    selectBytes: (bytes) => {
      hash.update(bytes);
      const prefixBytes = Math.min(prefix.length - prefixLength, bytes.length);
      if (prefixBytes > 0) {
        bytes.copy(prefix, prefixLength, 0, prefixBytes);
        prefixLength += prefixBytes;
      }
      return bytes;
    },
    failureContext: `Cannot prepare the verified thin image from ${sourcePath}`,
  });
  if (!copiedResult.ok) return copiedResult;
  const copied = copiedResult.value;
  if (!Number.isSafeInteger(copied))
    return err(
      new HopperStartError({
        userMessage: `Thin Mach-O source ${sourcePath} exceeds exact copy coordinates.`,
      }),
    );
  const observed = hash.digest("hex");
  const magic = prefixLength === prefix.length ? prefix.readUInt32BE(0) : 0;
  const little = magic === 0xcefaedfe || magic === 0xcffaedfe;
  const headerMatches =
    prefixLength === prefix.length &&
    [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe].includes(magic) &&
    (little ? prefix.readUInt32LE(4) : prefix.readUInt32BE(4)) ===
      image.cpu_type &&
    (little ? prefix.readUInt32LE(8) : prefix.readUInt32BE(8)) ===
      image.cpu_subtype;
  if (
    observed !== sourceSha256 ||
    copied !== image.byte_length ||
    !headerMatches
  )
    return err(
      new HopperStartError({
        userMessage: `Thin Mach-O source ${sourcePath} no longer agrees with its admitted digest, size, or selected header. Open the stable source again.`,
      }),
    );
  return signal?.aborted
    ? err(new HopperCancelledError(signal.reason))
    : ok(destination);
};

type HopperImageHandle = OwnedFileHandle | undefined;
type HopperImageCloseFailure = {
  readonly resource: string;
  readonly cause: unknown;
};
type HopperImageCleanupAttempt = Extract<
  Awaited<ReturnType<ArtifactResourceScope["release"]>>,
  { readonly kind: "failed" }
>;

interface HopperImageCopyOperation {
  readonly copied: number;
  readonly operationFailure:
    | { readonly failed: false }
    | {
        readonly failed: true;
        readonly cause: unknown;
      };
  readonly cancelled:
    | { readonly cancelled: false }
    | {
        readonly cancelled: true;
        readonly reason: unknown;
      };
  readonly source: HopperImageHandle;
  readonly output: HopperImageHandle;
}

interface HopperImageCopyFinalization {
  readonly closeFailures: readonly HopperImageCloseFailure[];
  readonly retained: readonly HopperImageCleanupAttempt[];
}

/** Own source/output handles and copy finalization for both Mach-O layouts. */
const copyHopperSource = async (options: {
  readonly sourcePath: string;
  readonly destination: string;
  readonly signal: AbortSignal | undefined;
  readonly observer: HopperMachOImageCopyObserver | undefined;
  readonly resourceScope: ArtifactResourceScope;
  readonly fileSystem: HopperMachOImageFileSystem;
  readonly selectBytes: (chunk: Buffer, position: number) => Buffer | undefined;
  readonly failureContext: string;
}): Promise<Result<number, HopperStartError | HopperCancelledError>> => {
  if (options.signal?.aborted)
    return err(new HopperCancelledError(options.signal.reason));
  const operation = await performHopperImageCopy(options);
  const cancellationBeforeFinalization = operation.cancelled.cancelled
    ? operation.cancelled
    : options.signal?.aborted === true
      ? { cancelled: true as const, reason: options.signal.reason }
      : { cancelled: false as const };
  const finalization = await closeHopperImageHandles(operation, options);
  const cancelled =
    cancellationBeforeFinalization.cancelled ||
    (finalization.closeFailures.length === 0 &&
      options.signal?.aborted === true);
  const cancelReason = cancellationBeforeFinalization.cancelled
    ? cancellationBeforeFinalization.reason
    : options.signal?.reason;
  if (
    !operation.operationFailure.failed &&
    !cancelled &&
    finalization.closeFailures.length === 0
  )
    return ok(operation.copied);
  return hopperImageCopyFailure({
    operation,
    finalization,
    failureContext: options.failureContext,
    cancelled,
    cancelReason,
  });
};

const performHopperImageCopy = async (options: {
  readonly sourcePath: string;
  readonly destination: string;
  readonly signal: AbortSignal | undefined;
  readonly observer: HopperMachOImageCopyObserver | undefined;
  readonly fileSystem: HopperMachOImageFileSystem;
  readonly selectBytes: (chunk: Buffer, position: number) => Buffer | undefined;
}): Promise<HopperImageCopyOperation> => {
  let copied = 0;
  let source: HopperImageHandle;
  let output: HopperImageHandle;
  try {
    source = new OwnedFileHandle(
      await options.fileSystem.open(options.sourcePath, "r"),
    );
    output = new OwnedFileHandle(
      await options.fileSystem.open(options.destination, "wx", 0o600),
    );
  } catch (cause: unknown) {
    return {
      copied,
      operationFailure: { failed: true, cause },
      cancelled: { cancelled: false },
      source,
      output,
    };
  }

  try {
    let position = 0;
    for await (const bytes of readFileHandleChunks(source.handle)) {
      if (options.signal?.aborted)
        return {
          copied,
          operationFailure: { failed: false },
          cancelled: { cancelled: true, reason: options.signal.reason },
          source,
          output,
        };
      const selected = options.selectBytes(bytes, position);
      if (selected !== undefined && selected.length > 0) {
        await output.handle.writeFile(selected);
        copied += selected.length;
        await options.observer?.afterChunkWritten?.(copied);
      }
      position += bytes.length;
    }
    return {
      copied,
      operationFailure: { failed: false },
      cancelled: { cancelled: false },
      source,
      output,
    };
  } catch (cause: unknown) {
    return {
      copied,
      operationFailure: { failed: true, cause },
      cancelled: { cancelled: false },
      source,
      output,
    };
  }
};

const closeHopperImageHandles = async (
  operation: HopperImageCopyOperation,
  options: {
    readonly sourcePath: string;
    readonly destination: string;
    readonly resourceScope: ArtifactResourceScope;
  },
): Promise<HopperImageCopyFinalization> => {
  const closeFailures: HopperImageCloseFailure[] = [];
  const retained: HopperImageCleanupAttempt[] = [];
  const close = async (
    owner: HopperImageHandle,
    resource: string,
  ): Promise<void> => {
    if (owner === undefined) return;
    try {
      await owner.close();
    } catch (cause: unknown) {
      closeFailures.push({ resource, cause });
      const attempt = await options.resourceScope.release({
        kind: "file-handle",
        resource,
        handle: owner,
      });
      if (attempt.kind === "failed") retained.push(attempt);
    }
  };
  await close(operation.output, `hopper-prepared-image:${options.destination}`);
  await close(operation.source, `hopper-image-source:${options.sourcePath}`);
  return { closeFailures, retained };
};

const hopperImageCopyFailure = (options: {
  readonly operation: HopperImageCopyOperation;
  readonly finalization: HopperImageCopyFinalization;
  readonly failureContext: string;
  readonly cancelled: boolean;
  readonly cancelReason: unknown;
}): Result<number, HopperStartError | HopperCancelledError> => {
  const { operation, finalization } = options;
  const cleanupErrors = finalization.retained.map((attempt) => {
    const cleanupError = new ProviderCleanupError(
      "hopper",
      [attempt.owner.resource],
      {
        reason:
          attempt.cause instanceof Error
            ? attempt.cause.message
            : String(attempt.cause),
      },
      { cause: attempt.cause },
    );
    attempt.lease.bindCleanupError(cleanupError);
    return cleanupError;
  });
  const cleanup =
    cleanupErrors.length === 0
      ? undefined
      : {
          reason: cleanupErrors.map((failure) => failure.message).join("; "),
          resources: [
            ...new Set(
              cleanupErrors.flatMap((failure) => failure.cleanupResources),
            ),
          ],
        };
  const primaryFailure = operation.operationFailure.failed
    ? operation.operationFailure.cause
    : finalization.closeFailures[0]?.cause;
  const resultError =
    options.cancelled && !operation.operationFailure.failed
      ? new HopperCancelledError(
          options.cancelReason,
          cleanup === undefined ? {} : { cleanup },
        )
      : new HopperStartError({
          ...(operation.operationFailure.failed ||
          finalization.closeFailures.length > 0
            ? { cause: primaryFailure }
            : {}),
          userMessage: `${options.failureContext}: ${primaryFailure instanceof Error ? primaryFailure.message : String(primaryFailure ?? "caller cancellation")}`,
          ...(cleanup === undefined ? {} : { cleanup }),
        });
  for (const closeFailure of finalization.closeFailures) {
    if (
      !operation.operationFailure.failed &&
      !options.cancelled &&
      closeFailure === finalization.closeFailures[0]
    )
      continue;
    resultError.retainSecondaryFailure(
      new HopperStartError({
        cause: closeFailure.cause,
        userMessage: `Could not confirm closure of ${closeFailure.resource}.`,
      }),
    );
  }
  for (const cleanupError of cleanupErrors)
    resultError.retainSecondaryFailure(cleanupError);
  if (cleanupErrors.length > 0)
    resultError.bindCleanupDependencies(cleanupErrors);
  return err(resultError);
};
