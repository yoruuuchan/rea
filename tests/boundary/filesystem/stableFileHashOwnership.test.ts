import {
  mkdtemp,
  open,
  rm,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import { openRegularFile } from "../../../src/filesystem/RegularFile.js";
import { hashStableFile } from "../../../src/filesystem/StableFileHash.js";

vi.mock("../../../src/filesystem/RegularFile.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../src/filesystem/RegularFile.js")
  >()),
  openRegularFile: vi.fn(),
}));

interface TestOwner {
  readonly handle: FileHandle;
  close(): Promise<void>;
}

interface OwnedHashFailure extends Error {
  readonly cause?: unknown;
  readonly cleanupCause?: unknown;
  readonly owner: TestOwner;
}

const roots: string[] = [];
const rawHandles: FileHandle[] = [];

afterEach(async () => {
  vi.mocked(openRegularFile).mockReset();
  for (const handle of rawHandles.splice(0)) {
    if (handle.fd >= 0) await handle.close();
  }
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

const makeFile = async (options: {
  readonly closeFailure?: Error;
  readonly invalidateFdOnCloseFailure?: boolean;
  readonly readFailure?: Error;
  readonly abortAfterRead?: AbortController;
  readonly abortReason?: unknown;
}) => {
  const root = await mkdtemp(join(tmpdir(), "rea-stable-hash-"));
  roots.push(root);
  const path = join(root, "input.bin");
  await writeFile(path, "stable hash input");
  const raw = await open(path, "r");
  rawHandles.push(raw);

  let failedClose = false;
  let invalidated = false;
  const close = vi.fn(async () => {
    if (options.closeFailure !== undefined && !failedClose) {
      failedClose = true;
      invalidated = options.invalidateFdOnCloseFailure === true;
      throw options.closeFailure;
    }
    await raw.close();
  });
  const handle = {
    get fd() {
      return invalidated ? -1 : raw.fd;
    },
    stat: () => raw.stat(),
    read: async (
      buffer: Buffer,
      offset: number,
      length: number,
      position: number | null,
    ) => {
      if (options.readFailure !== undefined) throw options.readFailure;
      const result = await raw.read(buffer, offset, length, position);
      options.abortAfterRead?.abort(options.abortReason);
      return result;
    },
    close,
  } as unknown as FileHandle;

  vi.mocked(openRegularFile).mockResolvedValueOnce(handle);
  return { path, handle, close };
};

const rejectHash = async (
  path: string,
  signal?: AbortSignal,
): Promise<OwnedHashFailure> => {
  const result = await hashStableFile(path, signal).then(
    () => undefined,
    (cause: unknown) => cause,
  );
  expect(result).toBeInstanceOf(Error);
  expect(result).toHaveProperty("owner");
  expect(result).toHaveProperty("cleanupCause");
  return result as OwnedHashFailure;
};

it("hashes and closes normally when close succeeds", async () => {
  const { path, close } = await makeFile({});

  const result = await hashStableFile(path);

  expect(result.bytes).toBe(Buffer.byteLength("stable hash input"));
  expect(result.sha256).toMatch(/^[a-f0-9]{64}$/u);
  expect(close).toHaveBeenCalledTimes(1);
});

it("retains a completed hash's live file owner after close fails and retries it", async () => {
  const closeFailure = new Error("injected close failure");
  const { path, handle, close } = await makeFile({ closeFailure });

  const failure = await rejectHash(path);

  expect(failure.cleanupCause).toBe(closeFailure);
  expect(failure.owner.handle).toBe(handle);
  expect(failure).toHaveProperty(
    "completedHash.bytes",
    Buffer.byteLength("stable hash input"),
  );
  await expect(failure.owner.close()).resolves.toBeUndefined();
  expect(close).toHaveBeenCalledTimes(2);
});

it("preserves a read failure as primary when closing the owned file also fails", async () => {
  const readFailure = new Error("injected read failure");
  const closeFailure = new Error("injected close failure");
  const { path, handle } = await makeFile({ closeFailure, readFailure });

  const failure = await rejectHash(path);

  expect(failure.cause).toBe(readFailure);
  expect(failure.cleanupCause).toBe(closeFailure);
  expect(failure.owner.handle).toBe(handle);
});

it("preserves cancellation as primary when closing the owned file also fails", async () => {
  const cancellation = new AbortController();
  const cancelCause = new Error("injected cancellation");
  const closeFailure = new Error("injected close failure");
  const { path, handle } = await makeFile({
    closeFailure,
    abortAfterRead: cancellation,
    abortReason: cancelCause,
  });

  const failure = await rejectHash(path, cancellation.signal);

  expect(failure.cause).toBe(cancelCause);
  expect(failure.cleanupCause).toBe(closeFailure);
  expect(failure.owner.handle).toBe(handle);
});

it("keeps an invalidated descriptor's close failure sticky without retrying raw close", async () => {
  const closeFailure = new Error(
    "injected close failure after fd invalidation",
  );
  const { path, handle, close } = await makeFile({
    closeFailure,
    invalidateFdOnCloseFailure: true,
  });

  const failure = await rejectHash(path);

  expect(failure.cleanupCause).toBe(closeFailure);
  expect(failure.owner.handle).toBe(handle);
  await expect(failure.owner.close()).rejects.toBe(closeFailure);
  expect(close).toHaveBeenCalledTimes(1);
});
