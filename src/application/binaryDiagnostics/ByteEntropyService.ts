import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { ExecutionOptions } from "../AnalysisProvider.js";
import { BYTE_ENTROPY_PROVIDER } from "../InvestigationProviders.js";
import { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisOutputError,
  AnalysisAccessDeniedError,
  AnalysisArtifactChangedError,
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisResourceConstraintError,
} from "../../domain/analysisErrorCore.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import { analysisInputErrorFromIssues } from "../../domain/inputIssueProjection.js";
import {
  computeBlockEntropy,
  entropyFromCounts,
  inspectByteEntropyInputSchema,
  mergeEntropyRuns,
  type ByteEntropy,
} from "../../domain/native/byteEntropy.js";
import { err, ok, type Result } from "../../domain/result.js";
import { ArtifactResourceScope } from "../../artifacts/ArtifactResourceScope.js";
import {
  withArtifactFileHandle,
  bindArtifactFileCleanup,
  ArtifactFileCleanupFailure,
  artifactFileCancellationCause,
} from "../../artifacts/ArtifactFileOperation.js";
import { analysisErrorWithCleanupFailure } from "../../domain/analysisErrorCleanup.js";
import { ArtifactReaderFailure } from "../../artifacts/ArtifactReader.js";

/** Bound retained result rows before constructing the Evidence representation. */
export const MAX_BYTE_ENTROPY_BLOCKS = 32_768;

/** Generated files such as Linux /proc entries report size 0 but still hold bytes. */
const ZERO_SIZE_LIMITATION =
  "The file reports a size of 0, so no bytes were read. Generated files such as Linux /proc entries can report 0 while holding content; this result does not show that the file is empty.";

const OPERATION = "inspect_byte_entropy";
const invalid = (field: string, message: string) =>
  new AnalysisInputError(OPERATION, undefined, [
    { path: [field], reason: "invalid_value", message },
  ]);

/** Offline byte observations shared by CLI and MCP, with one file-wide read. */
export class ByteEntropyService {
  readonly #resources: ArtifactResourceScope;

  constructor(
    private readonly files: Pick<
      typeof import("node:fs/promises"),
      "open" | "stat"
    > = { open, stat },
    resources: ArtifactResourceScope = new ArtifactResourceScope(),
  ) {
    this.#resources = resources;
  }

  async inspect(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    try {
      return await this.#resources.run(() => this.#inspect(rawInput, options));
    } catch (cause: unknown) {
      const failure = new AnalysisOutputError(
        OPERATION,
        "A retained byte-entropy file descriptor could not be released before inspection.",
        {
          cause,
          ...(cause instanceof ArtifactReaderFailure &&
          cause.cleanup !== undefined
            ? { cleanup: cause.cleanup }
            : {}),
        },
      );
      bindArtifactFileCleanup(cause, failure);
      return err(failure);
    }
  }

  close(): Promise<void> {
    return this.#resources.close();
  }

  async #inspect(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    if (options?.signal?.aborted)
      return err(new AnalysisCancelledError(OPERATION));
    const parsed = inspectByteEntropyInputSchema.safeParse(rawInput);
    if (!parsed.success)
      return err(
        analysisInputErrorFromIssues(OPERATION, parsed.error.issues, rawInput, {
          cause: parsed.error,
        }),
      );
    const input = parsed.data;
    if (!isAbsolute(input.path))
      return err(
        invalid("path", "Expected an absolute filesystem path on this host."),
      );
    let admitted = false;
    try {
      const before = await this.files.stat(input.path, { bigint: true });
      if (!before.isFile()) throw invalid("path", "Expected a regular file.");
      admitted = true;
      const file = await this.files.open(
        input.path,
        constants.O_RDONLY | constants.O_NONBLOCK,
      );
      const report = await withArtifactFileHandle(
        input.path,
        file,
        this.#resources,
        options?.signal,
        async (file) => {
          const initial = await file.stat({ bigint: true });
          const changed = () =>
            new AnalysisArtifactChangedError(
              OPERATION,
              input.path,
              "File identity, size or timestamps changed during entropy inspection.",
            );
          const same = (value: typeof initial) =>
            value.isFile() &&
            value.dev === initial.dev &&
            value.ino === initial.ino &&
            value.size === initial.size &&
            value.mtimeNs === initial.mtimeNs &&
            value.ctimeNs === initial.ctimeNs;
          if (!same(before)) throw changed();
          const size = Number(initial.size);
          if (!Number.isSafeInteger(size))
            throw invalid(
              "path",
              "File size exceeds exact numeric offset representation.",
            );
          const length = input.length ?? size - input.offset;
          if (input.offset > size || length > size - input.offset)
            throw invalid(
              "length",
              "Selected byte window extends beyond the end of the file.",
            );
          const selectedBlocks = Math.ceil(length / input.block_size);
          if (selectedBlocks > MAX_BYTE_ENTROPY_BLOCKS)
            throw new AnalysisResourceConstraintError(
              OPERATION,
              "capacity",
              `Selected window would produce ${String(selectedBlocks)} blocks; the limit is ${String(MAX_BYTE_ENTROPY_BLOCKS)}. Choose a shorter window or a larger block size.`,
              {
                max_blocks: MAX_BYTE_ENTROPY_BLOCKS,
                requested_blocks: selectedBlocks,
                block_size: input.block_size,
                window_length: length,
              },
              {
                retryable: false,
                remediationAction:
                  "Reduce the selected window length or increase block_size so the selected window contains at most 32768 blocks.",
              },
            );
          const end = input.offset + length;
          const blocks: ByteEntropy["blocks"] = [];
          const buffer = Buffer.alloc(input.block_size);
          const counts = new Float64Array(256);
          const hash = createHash("sha256");
          let position = 0;
          while (position < size) {
            options?.signal?.throwIfAborted();
            const selected = position >= input.offset && position < end;
            const boundary =
              position < input.offset ? input.offset : selected ? end : size;
            const wanted = Math.min(input.block_size, boundary - position);
            let filled = 0;
            while (filled < wanted) {
              options?.signal?.throwIfAborted();
              const { bytesRead } = await file.read(
                buffer,
                filled,
                wanted - filled,
                position + filled,
              );
              if (bytesRead === 0) throw changed();
              filled += bytesRead;
            }
            const bytes = buffer.subarray(0, filled);
            hash.update(bytes);
            for (const byte of bytes) counts[byte] = (counts[byte] ?? 0) + 1;
            if (selected)
              blocks.push({
                offset: position,
                length: filled,
                entropy: computeBlockEntropy(bytes),
              });
            position += filled;
          }
          if (
            !same(await file.stat({ bigint: true })) ||
            !same(await this.files.stat(input.path, { bigint: true }))
          )
            throw changed();
          options?.signal?.throwIfAborted();
          const thresholds = { high: 7.2, low: 1.0 };
          return {
            artifact: {
              path: input.path,
              bytes: size,
              sha256: hash.digest("hex"),
            },
            block_size: input.block_size,
            window: { offset: input.offset, length },
            file_entropy: entropyFromCounts(counts, size),
            thresholds,
            blocks,
            runs: mergeEntropyRuns(blocks, thresholds),
            limitations: [
              "Entropy does not prove encryption; compressed and encrypted bytes cannot be distinguished by this measure.",
              "Entropy is rounded to four decimal places; thresholds classify those reported values. Small blocks can underestimate entropy.",
              "The file-wide hash and entropy cover the entire file; blocks and runs cover only the selected window. Empty input has entropy 0 by convention.",
              ...(size === 0 ? [ZERO_SIZE_LIMITATION] : []),
            ],
          };
        },
      );
      if (options?.signal?.aborted)
        return err(new AnalysisCancelledError(OPERATION));
      return ok(
        createEvidence(
          { path: input.path, format: "file", sha256: report.artifact.sha256 },
          BYTE_ENTROPY_PROVIDER,
          {
            operation: OPERATION,
            parameters: {
              path: input.path,
              block_size: input.block_size,
              offset: input.offset,
              ...(input.length === undefined ? {} : { length: input.length }),
            },
            result: report,
            rawResult: null,
            confidence: "observed",
            limitations: report.limitations,
            locations: [{ kind: "artifact-path", path: input.path }],
          },
        ),
      );
    } catch (cause) {
      if (cause instanceof ArtifactFileCleanupFailure) {
        const cleanup = new AnalysisOutputError(
          OPERATION,
          "Could not confirm closing the selected file.",
          { cause, cleanup: cause.cleanup },
        );
        bindArtifactFileCleanup(cause, cleanup);
        const outcome = cause.fileCleanupFailure.outcome;
        if (
          outcome.kind === "failed" &&
          outcome.cause instanceof ArtifactReaderFailure &&
          outcome.cause.reason === "cancelled"
        ) {
          const cancelled = new AnalysisCancelledError(OPERATION, {
            cause: outcome.cause.cancellation?.reason,
            cleanup: cause.cleanup,
          }).retainSecondaryFailure(cleanup);
          bindArtifactFileCleanup(cause, cancelled);
          return err(cancelled);
        }
        if (options?.signal?.aborted && outcome.kind === "completed") {
          const cancelled = new AnalysisCancelledError(OPERATION, {
            cause: options.signal.reason,
            cleanup: cause.cleanup,
          }).retainSecondaryFailure(cleanup);
          bindArtifactFileCleanup(cause, cancelled);
          return err(cancelled);
        }
        if (outcome.kind === "failed") {
          const primary =
            outcome.cause instanceof AnalysisError
              ? outcome.cause
              : outcome.cause instanceof ArtifactReaderFailure
                ? new AnalysisOutputError(OPERATION, outcome.cause.message, {
                    cause: outcome.cause,
                  })
                : new AnalysisOutputError(
                    OPERATION,
                    "Could not read complete byte entropy evidence.",
                    { cause: outcome.cause },
                  );
          return err(
            analysisErrorWithCleanupFailure(
              primary,
              cleanup,
              OPERATION,
            ).bindCleanupDependencies([primary, cleanup]),
          );
        }
        return err(cleanup);
      }
      if (cause instanceof ArtifactReaderFailure) {
        if (cause.reason === "cancelled") {
          const cancelled = new AnalysisCancelledError(OPERATION, {
            cause: artifactFileCancellationCause(cause),
          });
          bindArtifactFileCleanup(cause, cancelled);
          return err(cancelled);
        }
        const retry = new AnalysisOutputError(
          OPERATION,
          "A previous byte-entropy file descriptor is still owned; cleanup must succeed before another file can be inspected.",
          {
            cause,
            ...(cause.cleanup === undefined ? {} : { cleanup: cause.cleanup }),
          },
        );
        bindArtifactFileCleanup(cause, retry);
        return err(retry);
      }
      if (options?.signal?.aborted)
        return err(new AnalysisCancelledError(OPERATION, { cause }));
      if (cause instanceof AnalysisError) return err(cause);
      if (cause instanceof Error && "code" in cause) {
        if (cause.code === "EACCES" || cause.code === "EPERM")
          return err(
            new AnalysisAccessDeniedError(OPERATION, input.path, cause.code, {
              cause,
            }),
          );
        if (cause.code === "ENOENT" || cause.code === "ENOTDIR")
          return err(
            admitted
              ? new AnalysisArtifactChangedError(
                  OPERATION,
                  input.path,
                  "Selected file path changed during entropy inspection.",
                  { cause },
                )
              : invalid("path", "Selected file could not be found."),
          );
      }
      return err(
        new AnalysisOutputError(
          OPERATION,
          "Could not read complete byte entropy evidence.",
          { cause },
        ),
      );
    }
  }
}
