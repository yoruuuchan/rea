import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";

import {
  OwnedRegularFileCleanupFailure,
  openRegularFile,
  RegularFileChangedError,
  sameRegularFileState,
} from "./RegularFile.js";
import { OwnedFileHandle } from "./OwnedFileHandle.js";

export type StableFileHashResult = {
  readonly sha256: string;
  readonly bytes: number;
};

/** Hashing finished or failed, but the owned descriptor close was rejected. */
export class StableFileHashCleanupFailure extends OwnedRegularFileCleanupFailure {
  constructor(
    path: string,
    primaryCause: unknown,
    readonly hasPrimaryCause: boolean,
    cleanupCause: unknown,
    owner: OwnedFileHandle,
    readonly completedHash: StableFileHashResult | undefined,
  ) {
    super(
      path,
      hasPrimaryCause ? primaryCause : cleanupCause,
      cleanupCause,
      owner,
      `Stable file hashing could not confirm descriptor close: ${path}`,
    );
    this.name = "StableFileHashCleanupFailure";
  }
}

/** Hash one regular file from its admitted descriptor and verify its path state. */
export const hashStableFile = async (
  path: string,
  signal?: AbortSignal,
): Promise<StableFileHashResult> => {
  const handle = await openRegularFile(path, {
    symlinks: "follow",
    signal,
  });
  const owner = new OwnedFileHandle(handle);
  let primaryCause: unknown;
  let hasPrimaryCause = false;
  let completedHash: StableFileHashResult | undefined;
  try {
    const initial = await handle.stat();
    if (!Number.isSafeInteger(initial.size) || initial.size < 0)
      throw new RangeError(
        `Regular file size cannot be represented safely: ${path}`,
      );
    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (position <= initial.size) {
      signal?.throwIfAborted();
      const length = Math.min(chunk.length, initial.size - position + 1);
      if (length <= 0) break;
      const read = await handle.read(chunk, 0, length, position);
      signal?.throwIfAborted();
      if (read.bytesRead === 0) break;
      hash.update(chunk.subarray(0, read.bytesRead));
      position += read.bytesRead;
      if (position > initial.size) throw new RegularFileChangedError(path);
    }
    signal?.throwIfAborted();
    const [opened, currentPath] = await Promise.all([
      handle.stat(),
      stat(path),
    ]);
    signal?.throwIfAborted();
    if (
      position !== initial.size ||
      !sameRegularFileState(initial, opened) ||
      !sameRegularFileState(initial, currentPath)
    )
      throw new RegularFileChangedError(path);
    completedHash = { sha256: hash.digest("hex"), bytes: position };
  } catch (cause: unknown) {
    primaryCause = cause;
    hasPrimaryCause = true;
  }
  try {
    await owner.close();
  } catch (cleanupCause: unknown) {
    throw new StableFileHashCleanupFailure(
      path,
      primaryCause,
      hasPrimaryCause,
      cleanupCause,
      owner,
      completedHash,
    );
  }
  if (hasPrimaryCause) throw primaryCause;
  if (completedHash === undefined)
    throw new Error("Stable file hashing completed without a digest");
  return completedHash;
};
