import { createHash } from "node:crypto";
import { open as openFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { OwnedFileHandle } from "../../../src/filesystem/OwnedFileHandle.js";
import * as regularFile from "../../../src/filesystem/RegularFile.js";
import { RegularFileAdmissionFailure } from "../../../src/filesystem/RegularFile.js";
import { hashStableFile } from "../../../src/filesystem/StableFileHash.js";
import { LinuxHopperPublisher } from "../../../src/application/LinuxHopperPublisher.js";
import { RegularFileCleanupFailure } from "../../../src/filesystem/OwnedRegularFile.js";
import { PrivateRuntimeRoot } from "../../../src/process/PrivateRuntimeRoot.js";
import type { VerifiedLinuxHopperPackage } from "../../../src/application/LinuxHopperPublisher.js";

it("adopts and retries the descriptor when hashing succeeded but close failed", async () => {
  const root = await createTestTempDirectory("rea-stable-hash-close-");
  const path = join(root, "input.bin");
  await writeFile(path, "owned bytes");
  const closeCause = new Error("injected descriptor close failure");
  const originalClose = OwnedFileHandle.prototype.close;
  const close = vi
    .spyOn(OwnedFileHandle.prototype, "close")
    .mockImplementationOnce(async () => {
      throw closeCause;
    });
  const retained: OwnedFileHandle[] = [];
  try {
    let failure: unknown;
    try {
      await hashStableFile(path, {
        retainFailedClose: (owner) => retained.push(owner),
      });
    } catch (cause: unknown) {
      failure = cause;
    }
    expect(failure).toBeInstanceOf(RegularFileCleanupFailure);
    expect(retained).toHaveLength(1);
    if (!(failure instanceof RegularFileCleanupFailure))
      throw new Error("Expected a typed hash cleanup failure");
    expect(failure.outcome).toMatchObject({
      kind: "completed",
      value: { bytes: 11 },
    });
    expect(failure.cleanupCause).toBe(closeCause);
    expect(failure.retention).toEqual({ kind: "callback_returned" });
    expect(failure.owner).toBe(retained[0]);
    expect(retained[0]!.handle.fd).toBeGreaterThanOrEqual(0);
    close.mockRestore();
    await retained[0]!.close();
    expect(retained[0]!.handle.fd).toBe(-1);
  } finally {
    close.mockRestore();
    if (retained[0] !== undefined && retained[0]!.handle.fd >= 0)
      await originalClose.call(retained[0]);
  }
});

it("preserves a read cancellation cause when close also fails", async () => {
  const root = await createTestTempDirectory("rea-stable-hash-primary-");
  const path = join(root, "input.bin");
  await writeFile(path, "owned bytes");
  const primary = new Error("injected cancellation after read");
  const closeCause = new Error("injected close failure after cancellation");
  const controller = new AbortController();
  const nativeOpen = regularFile.openRegularFile;
  const open = vi
    .spyOn(regularFile, "openRegularFile")
    .mockImplementation(async (selectedPath, options) => {
      const handle = await nativeOpen(selectedPath, options);
      vi.spyOn(handle, "stat").mockImplementationOnce(async () => {
        controller.abort(primary);
        throw primary;
      });
      return handle;
    });
  const originalClose = OwnedFileHandle.prototype.close;
  const close = vi
    .spyOn(OwnedFileHandle.prototype, "close")
    .mockImplementationOnce(async () => {
      throw closeCause;
    });
  const retained: OwnedFileHandle[] = [];
  try {
    let failure: unknown;
    try {
      await hashStableFile(path, {
        signal: controller.signal,
        retainFailedClose: (owner) => retained.push(owner),
      });
    } catch (cause: unknown) {
      failure = cause;
    }
    expect(failure).toBeInstanceOf(RegularFileCleanupFailure);
    if (!(failure instanceof RegularFileCleanupFailure))
      throw new Error("Expected a typed hash cleanup failure");
    expect(failure.outcome).toEqual({ kind: "failed", cause: primary });
    expect(failure.cleanupCause).toBe(closeCause);
    expect(failure.cause).toBeInstanceOf(AggregateError);
    expect((failure.cause as AggregateError).errors).toEqual([
      primary,
      closeCause,
    ]);
    expect(retained).toEqual([failure.owner]);
    close.mockRestore();
    await failure.owner.close();
    expect(failure.owner.handle.fd).toBe(-1);
  } finally {
    close.mockRestore();
    open.mockRestore();
    if (retained[0] !== undefined && retained[0]!.handle.fd >= 0)
      await originalClose.call(retained[0]);
  }
});

it("closes a normally hashed file without adopting an owner", async () => {
  const root = await createTestTempDirectory("rea-stable-hash-control-");
  const path = join(root, "input.bin");
  await writeFile(path, "owned bytes");
  const retainFailedClose = vi.fn();
  await expect(
    hashStableFile(path, { retainFailedClose }),
  ).resolves.toMatchObject({ bytes: 11 });
  expect(retainFailedClose).not.toHaveBeenCalled();
});

it("adopts a descriptor from an admission failure and preserves both causes", async () => {
  const root = await createTestTempDirectory("rea-stable-hash-admission-");
  const path = join(root, "input.bin");
  await writeFile(path, "owned bytes");
  const owner = new OwnedFileHandle(await openFile(path, "r"));
  const primary = new Error("injected file admission failure");
  const cleanupCause = new Error("injected admission descriptor close failure");
  const open = vi
    .spyOn(regularFile, "openRegularFile")
    .mockRejectedValueOnce(
      new RegularFileAdmissionFailure(path, primary, cleanupCause, owner),
    );
  const retained: OwnedFileHandle[] = [];
  try {
    let failure: unknown;
    try {
      await hashStableFile(path, {
        retainFailedClose: (retainedOwner) => retained.push(retainedOwner),
      });
    } catch (cause: unknown) {
      failure = cause;
    }
    expect(failure).toBeInstanceOf(RegularFileCleanupFailure);
    if (!(failure instanceof RegularFileCleanupFailure))
      throw new Error("Expected a typed admission cleanup failure");
    expect(failure.outcome).toEqual({ kind: "failed", cause: primary });
    expect(failure.cleanupCause).toBe(cleanupCause);
    expect(failure.retention).toEqual({ kind: "callback_returned" });
    expect((failure.cause as AggregateError).errors).toEqual([
      primary,
      cleanupCause,
    ]);
    expect(retained).toEqual([owner]);
  } finally {
    open.mockRestore();
    await owner.close();
  }
});

it("distinguishes a thrown undefined primary failure from a clean hash", async () => {
  const root = await createTestTempDirectory("rea-stable-hash-undefined-");
  const path = join(root, "input.bin");
  await writeFile(path, "owned bytes");
  const openFileAtBoundary = regularFile.openRegularFile;
  const open = vi
    .spyOn(regularFile, "openRegularFile")
    .mockImplementation(async (selectedPath, options) => {
      const handle = await openFileAtBoundary(selectedPath, options);
      const originalStat = handle.stat.bind(handle);
      let calls = 0;
      vi.spyOn(handle, "stat").mockImplementation(async () => {
        calls += 1;
        if (calls === 2) throw undefined;
        return originalStat();
      });
      return handle;
    });
  const closeCause = new Error("injected close failure after undefined");
  const close = vi
    .spyOn(OwnedFileHandle.prototype, "close")
    .mockRejectedValueOnce(closeCause);
  const retained: OwnedFileHandle[] = [];
  try {
    let failure: unknown;
    try {
      await hashStableFile(path, {
        retainFailedClose: (owner) => retained.push(owner),
      });
    } catch (cause: unknown) {
      failure = cause;
    }
    expect(failure).toBeInstanceOf(RegularFileCleanupFailure);
    if (!(failure instanceof RegularFileCleanupFailure))
      throw new Error("Expected a typed hash cleanup failure");
    expect(failure.outcome).toEqual({ kind: "failed", cause: undefined });
    expect(failure.cleanupCause).toBe(closeCause);
    expect((failure.cause as AggregateError).errors).toEqual([
      undefined,
      closeCause,
    ]);
    expect(retained).toEqual([failure.owner]);
  } finally {
    close.mockRestore();
    open.mockRestore();
    if (retained[0] !== undefined) await retained[0].close();
  }
});

it("retries a publisher-owned launcher hash close before returning its digest", async () => {
  const root = await createTestTempDirectory("rea-publisher-hash-owner-");
  const path = join(root, "launcher");
  await writeFile(path, "fixture launcher bytes");
  const publisher = new LinuxHopperPublisher({}, async () => undefined);
  const close = vi
    .spyOn(OwnedFileHandle.prototype, "close")
    .mockRejectedValueOnce(new Error("fixture launcher close failure"));
  try {
    await expect(publisher.hashLauncher(path)).resolves.toMatch(
      /^[a-f0-9]{64}$/u,
    );
    expect(close).toHaveBeenCalledTimes(2);
    close.mockRestore();
    await publisher.close();
  } finally {
    close.mockRestore();
    await publisher.close();
  }
});

it("retries pending cleanup before acquiring a publisher temporary root", async () => {
  const root = await createTestTempDirectory("rea-publisher-admission-");
  const path = join(root, "launcher");
  const launcherBytes = "fixture launcher bytes";
  await writeFile(path, launcherBytes);
  const publisher = new LinuxHopperPublisher(
    { ...process.env, XDG_CACHE_HOME: join(root, "cache") },
    async () => undefined,
  );
  const originalClose = OwnedFileHandle.prototype.close;
  const closeOwners: OwnedFileHandle[] = [];
  let allowClose = false;
  const close = vi
    .spyOn(OwnedFileHandle.prototype, "close")
    .mockImplementation(async function (this: OwnedFileHandle) {
      closeOwners.push(this);
      if (!allowClose) throw new Error("fixture close remains unavailable");
      return originalClose.call(this);
    });
  const createRoot = vi.spyOn(PrivateRuntimeRoot, "create");
  try {
    await expect(publisher.hashLauncher(path)).rejects.toMatchObject({
      reason: "cleanup_failed",
    });
    const retainedOwner = closeOwners[0];
    if (retainedOwner === undefined)
      throw new Error("Expected a retained launcher descriptor");
    const attemptsBeforeAdmission = closeOwners.length;
    await expect(
      publisher.retainVerifiedArchive({} as VerifiedLinuxHopperPackage, path),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        reason: "cleanup_failed",
        cause: { cleanup: { resources: [path] } },
      },
    });
    expect(createRoot).not.toHaveBeenCalled();
    expect(closeOwners.length).toBeGreaterThan(attemptsBeforeAdmission);
    expect(closeOwners.every((owner) => owner === retainedOwner)).toBe(true);

    const attemptsBeforeRecovery = closeOwners.length;
    allowClose = true;
    await expect(publisher.hashLauncher(path)).resolves.toBe(
      createHash("sha256").update(launcherBytes).digest("hex"),
    );
    const recoveryOwners = closeOwners.slice(attemptsBeforeRecovery);
    expect(recoveryOwners[0]).toBe(retainedOwner);
    expect(recoveryOwners.some((owner) => owner !== retainedOwner)).toBe(true);
    expect(closeOwners.every((owner) => owner.handle.fd === -1)).toBe(true);
    expect(createRoot).not.toHaveBeenCalled();
    const attemptsAfterRecovery = closeOwners.length;
    await publisher.close();
    expect(closeOwners).toHaveLength(attemptsAfterRecovery);
  } finally {
    close.mockRestore();
    createRoot.mockRestore();
    await publisher.close();
  }
});
