import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";

import { withOwnedRegularFile } from "./OwnedRegularFile.js";
import {
  RegularFileChangedError,
  sameRegularFileState,
} from "./RegularFile.js";
import type { OwnedFileHandle } from "./OwnedFileHandle.js";

export interface StableFileHashOptions {
  readonly signal?: AbortSignal;
  readonly retainFailedClose: (owner: OwnedFileHandle) => void;
}

/** Hash one regular file from its admitted descriptor and verify its path state. */
export const hashStableFile = async (
  path: string,
  options: StableFileHashOptions,
): Promise<{ readonly sha256: string; readonly bytes: number }> =>
  withOwnedRegularFile(path, options, async (handle) => {
    const initial = await handle.stat();
    if (!Number.isSafeInteger(initial.size) || initial.size < 0)
      throw new RangeError(
        `Regular file size cannot be represented safely: ${path}`,
      );
    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (position <= initial.size) {
      options.signal?.throwIfAborted();
      const length = Math.min(chunk.length, initial.size - position + 1);
      if (length <= 0) break;
      const read = await handle.read(chunk, 0, length, position);
      options.signal?.throwIfAborted();
      if (read.bytesRead === 0) break;
      hash.update(chunk.subarray(0, read.bytesRead));
      position += read.bytesRead;
      if (position > initial.size) throw new RegularFileChangedError(path);
    }
    options.signal?.throwIfAborted();
    const [opened, currentPath] = await Promise.all([
      handle.stat(),
      stat(path),
    ]);
    options.signal?.throwIfAborted();
    if (
      position !== initial.size ||
      !sameRegularFileState(initial, opened) ||
      !sameRegularFileState(initial, currentPath)
    )
      throw new RegularFileChangedError(path);
    return { sha256: hash.digest("hex"), bytes: position };
  });
