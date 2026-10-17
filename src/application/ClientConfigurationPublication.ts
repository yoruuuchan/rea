import { constants } from "node:fs";
import { lstat, open, writeFile, type FileHandle } from "node:fs/promises";
import writeFileAtomic from "write-file-atomic";

import { OwnedFileHandle } from "../filesystem/OwnedFileHandle.js";
import { withOwnedFileHandle } from "../filesystem/OwnedRegularFile.js";
import {
  RegularFileChangedError,
  sameRegularFileState,
} from "../filesystem/RegularFile.js";

/** The exact staged file retained through publication, verification and recovery. */
export class ClientConfigurationPublication {
  private constructor(
    readonly path: string,
    private readonly contents: string,
    private readonly owner: OwnedFileHandle,
  ) {}

  static async write(
    path: string,
    contents: string,
    mode?: number,
  ): Promise<ClientConfigurationPublication> {
    let owner: OwnedFileHandle | undefined;
    try {
      await writeFileAtomic(path, contents, {
        encoding: "utf8",
        ...(mode === undefined ? {} : { mode }),
        tmpfileCreated: async (stagedPath) => {
          const writableFlags =
            constants.O_RDWR |
            (constants.O_NONBLOCK ?? 0) |
            (constants.O_NOFOLLOW ?? 0);
          if (((await lstat(stagedPath)).mode & 0o200) !== 0) {
            owner = new OwnedFileHandle(await open(stagedPath, writableFlags));
          } else {
            // The atomic writer already owns a writable creation descriptor.
            // Retain ours before restoring the staged file's final read-only mode.
            const readable = new StagedConfigurationPermissions(
              await open(
                stagedPath,
                constants.O_RDONLY |
                  (constants.O_NONBLOCK ?? 0) |
                  (constants.O_NOFOLLOW ?? 0),
              ),
            );
            await withOwnedFileHandle(
              stagedPath,
              readable,
              {},
              async (handle) => {
                const staged = await handle.stat();
                if (!staged.isFile())
                  throw new Error("Staged configuration is not a regular file");
                readable.restoreMode(staged.mode & 0o7777);
                await handle.chmod((staged.mode & 0o7777) | 0o600);
                owner = new OwnedFileHandle(
                  await open(stagedPath, writableFlags),
                );
                const writable = await owner.handle.stat();
                if (
                  staged.ino === 0 ||
                  !writable.isFile() ||
                  writable.dev !== staged.dev ||
                  writable.ino !== staged.ino
                )
                  throw new RegularFileChangedError(stagedPath);
              },
            );
          }
          if (owner === undefined)
            throw new Error("Staged configuration has no file owner");
          if (!(await owner.handle.stat()).isFile())
            throw new Error("Staged configuration is not a regular file");
        },
      });
      if (owner === undefined)
        throw new Error("Atomic configuration publication has no file owner");
      return new ClientConfigurationPublication(path, contents, owner);
    } catch (cause: unknown) {
      if (owner === undefined) throw cause;
      return withOwnedFileHandle(path, owner, {}, async () => {
        throw cause;
      });
    }
  }

  /** Keep the publication descriptor owned until the complete transaction ends. */
  verify<Value>(operation: () => Promise<Value>): Promise<Value> {
    return withOwnedFileHandle(this.path, this.owner, {}, operation);
  }

  /** Readback cannot establish a successful transaction through a replaced name. */
  async assertCurrent(): Promise<void> {
    const owned = await this.owner.handle.stat();
    const named = await lstat(this.path);
    if (
      owned.ino === 0 ||
      named.isSymbolicLink() ||
      !sameRegularFileState(owned, named)
    )
      throw new Error(
        "Published configuration path no longer names its owned file",
      );
  }

  /** Require observed published bytes and restore through the owned descriptor.
   * State checks do not exclude a concurrent writer to the same inode.
   */
  async restore(original: string | undefined): Promise<void> {
    if (original === undefined)
      throw new Error(
        "First-run configuration recovery requires manual removal; pathname deletion cannot prove ownership",
      );
    const handle = this.owner.handle;
    const before = await handle.stat();
    const named = await lstat(this.path);
    if (
      before.ino === 0 ||
      !before.isFile() ||
      named.isSymbolicLink() ||
      !sameRegularFileState(before, named) ||
      !(await this.#hasPublishedBytes(handle)) ||
      !sameRegularFileState(before, await handle.stat())
    )
      throw new Error(
        "Published configuration changed; recovery requires the retained backup",
      );
    // Recovery writes through the retained descriptor, never through the name.
    if (!sameRegularFileState(before, await lstat(this.path)))
      throw new Error("Published configuration path changed before recovery");
    await writeFile(handle, original, { encoding: "utf8" });
    await handle.truncate(Buffer.byteLength(original, "utf8"));
    if (!sameRegularFileState(await handle.stat(), await lstat(this.path)))
      throw new Error("Configuration path changed during recovery");
  }

  async #hasPublishedBytes(handle: FileHandle): Promise<boolean> {
    const expected = Buffer.from(this.contents, "utf8");
    if ((await handle.stat()).size !== expected.length) return false;
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, expected.length));
    for (let position = 0; position < expected.length;) {
      const { bytesRead } = await handle.read(
        chunk,
        0,
        Math.min(chunk.length, expected.length - position),
        position,
      );
      if (
        bytesRead === 0 ||
        !chunk
          .subarray(0, bytesRead)
          .equals(expected.subarray(position, position + bytesRead))
      )
        return false;
      position += bytesRead;
    }
    return true;
  }
}

/** Restore temporary staging permissions before releasing their exact descriptor. */
class StagedConfigurationPermissions extends OwnedFileHandle {
  #mode: number | undefined;
  #restoring: Promise<void> | undefined;

  restoreMode(mode: number): void {
    this.#mode = mode;
  }

  override async close(): Promise<void> {
    if (this.#mode !== undefined) {
      this.#restoring ??= this.handle
        .chmod(this.#mode)
        .then(() => {
          this.#mode = undefined;
        })
        .finally(() => {
          this.#restoring = undefined;
        });
      await this.#restoring;
    }
    await super.close();
  }
}
