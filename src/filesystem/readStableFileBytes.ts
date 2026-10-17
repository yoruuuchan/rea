import { lstat, stat, type FileHandle } from "node:fs/promises";
import {
  assertRegularFileActive,
  RegularFileChangedError,
  sameRegularFileState,
} from "./RegularFile.js";

/** Resource refusal carries the observed extent before allocating file bytes. */
export class RegularFileCapacityError extends Error {
  readonly _tag = "RegularFileCapacityError";
  constructor(
    readonly path: string,
    readonly maximumBytes: number,
    readonly observedBytes: bigint,
  ) {
    super(`Selected file must be at most ${maximumBytes} bytes: ${path}`);
    this.name = this._tag;
  }
}

/** Read an admitted descriptor completely, checking its extent and selected name. */
export const readStableFileBytes = async (
  file: FileHandle,
  path: string,
  maximumBytes: number,
  options: {
    readonly signal?: AbortSignal;
    readonly symlinks: "follow" | "reject";
  },
): Promise<Buffer> => {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0)
    throw new RangeError(
      "Maximum file bytes must be a nonnegative safe integer",
    );
  assertRegularFileActive(options.signal);
  const before = await file.stat({ bigint: true });
  if (before.size > BigInt(maximumBytes))
    throw new RegularFileCapacityError(path, maximumBytes, before.size);
  assertRegularFileActive(options.signal);
  const bytes = Buffer.alloc(Number(before.size));
  let offset = 0;
  while (offset < bytes.length) {
    assertRegularFileActive(options.signal);
    const read = await file.read(bytes, offset, bytes.length - offset, offset);
    if (read.bytesRead === 0) throw new RegularFileChangedError(path);
    offset += read.bytesRead;
  }
  assertRegularFileActive(options.signal);
  const extra = Buffer.alloc(1);
  const named = async () => {
    try {
      return await (options.symlinks === "follow" ? stat : lstat)(path, {
        bigint: true,
      });
    } catch (cause: unknown) {
      if (
        cause instanceof Error &&
        "code" in cause &&
        (cause.code === "ENOENT" ||
          cause.code === "ENOTDIR" ||
          cause.code === "ELOOP")
      )
        throw new RegularFileChangedError(path, { cause });
      throw cause;
    }
  };
  if (
    (await file.read(extra, 0, 1, offset)).bytesRead !== 0 ||
    !sameRegularFileState(before, await file.stat({ bigint: true })) ||
    !sameRegularFileState(before, await named())
  )
    throw new RegularFileChangedError(path);
  assertRegularFileActive(options.signal);
  return bytes;
};
