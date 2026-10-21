import type { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { setImmediate } from "node:timers/promises";
import { jsonValueByteLength } from "../domain/jsonValueByteLength.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { normalizeArtifactPath } from "./ArtifactPaths.js";
import { lstat, type FileHandle } from "node:fs/promises";

import type { PyInstallerMetadata } from "../domain/artifactFormatMetadata.js";
import {
  cookieMetadata,
  scriptPythonMagic,
} from "./pyinstaller/PyInstallerMetadata.js";
import { artifactExpansionBudgetBytes } from "../domain/artifactExpansionBudget.js";
import { OwnedFileHandle } from "../filesystem/OwnedFileHandle.js";
import {
  RegularFileAdmissionFailure,
  openRegularFile,
  sameRegularFileState,
  type StableRegularFileDescriptor,
} from "../filesystem/RegularFile.js";
import {
  ArtifactReaderFailure,
  sameArtifactEntry,
  type ArtifactEntry,
  type ArtifactReader,
  type ArtifactReaderTraversal,
  type ArtifactTraversalOptions,
} from "./ArtifactReader.js";
import { abortIfNeeded, hashReadable } from "./ArtifactHash.js";
import { readArtifactFileChunks } from "./readArtifactFileChunks.js";
import { ArtifactResourceScope } from "./ArtifactResourceScope.js";
import { artifactIntegrityDetails } from "../domain/artifactIntegrity.js";
import { PyInstallerPyzStore } from "./pyinstaller/PyInstallerPyzStore.js";
import { pyInstallerMemberStream } from "./pyinstaller/PyInstallerMemberStream.js";
import {
  findPyInstallerCookie,
  readCArchiveToc,
  type CArchiveEntry,
  type PyInstallerCookie,
} from "./pyinstaller/CArchiveLayout.js";
import {
  hasEncryptionMarker,
  projectPyzContainer,
  projectPyzMember,
  projectStoredMember,
  sealMember,
  type PyInstallerMember,
  type PyzImage,
} from "./pyinstaller/CArchiveMembers.js";
import { readPyzArchive } from "./pyinstaller/PyzArchive.js";
import type { PyInstallerFailure } from "./pyinstaller/PyInstallerFailure.js";
import { pyInstallerFileAdmissionFailure } from "./pyinstaller/PyInstallerFileAdmission.js";

const MAX_PARSED_FACT_BYTES = 32 * 1024 * 1024;
const MAX_RETAINED_ENTRY_BYTES = 64 * 1024 * 1024;
const RECORD_OWNERSHIP_RESERVATION = 256;
// Conservative allowance for registry/case trie nodes, maps and traversal state.
// Repeated prefixes are charged again rather than underestimating retained work.
const PATH_COMPONENT_RESERVATION = 1024;

interface LoadedArchive {
  readonly members: readonly PyInstallerMember[];
  readonly traversal: ArtifactReaderTraversal;
}

/**
 * Read-only inventory of a PyInstaller CArchive appended to a native executable.
 * Encrypted PYZ entries are reported and not decoded. Code members are not decompiled.
 */
export class PyInstallerArtifactReader implements ArtifactReader {
  readonly format = "pyinstaller" as const;
  #source: StableRegularFileDescriptor | undefined;
  #opening: Promise<FileHandle> | undefined;
  #closed = false;
  readonly #scope = new ArtifactResourceScope();
  readonly #cleanup = new ArtifactResourceScope();
  readonly #lifecycle = new AbortController();
  #boundSha256: string | undefined;
  #loaded: Promise<LoadedArchive> | undefined;
  #budget = 0;
  #charged = 0;
  #parsedFactBytes = 0;
  #retainedEntryBytes = 0;
  #metadata: PyInstallerMetadata | undefined;
  readonly #pyzStore = new PyInstallerPyzStore();
  readonly #members = new Map<string, PyInstallerMember>();
  readonly #openedPyzSizes = new Map<string, number>();

  constructor(
    private readonly path: string,
    source?: StableRegularFileDescriptor,
  ) {
    this.#source = source;
    this.#cleanup.retain({
      kind: "lease",
      resource: "PyInstaller private PYZ images",
      lease: { release: () => this.#pyzStore.close() },
    });
  }

  formatMetadata(): PyInstallerMetadata | undefined {
    return this.#metadata === undefined ? undefined : { ...this.#metadata };
  }

  async prepareContainer(
    expectedSha256: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const active = this.#signal(signal);
    await this.#scope.run(async () => {
      const handle = await this.#openHandle(active);
      await this.#verifySource();
      const observed =
        this.#boundSha256 ??
        (
          await hashReadable(
            readArtifactFileChunks(handle, { signal: active }),
            active,
          )
        ).sha256;
      await this.#verifySource();
      abortIfNeeded(active);
      if (observed !== expectedSha256)
        throw new ArtifactReaderFailure(
          "integrity",
          "PyInstaller carrier changed after inventory",
          undefined,
          artifactIntegrityDetails(
            ".",
            { algorithm: "sha256", digest: expectedSha256 },
            observed,
            false,
          ),
        );
      this.#boundSha256 = observed;
    });
  }

  async *entries(
    signal?: AbortSignal,
    options?: ArtifactTraversalOptions,
  ): AsyncIterable<ArtifactEntry> {
    const active = this.#signal(signal);
    const loaded = await this.#scope.run(async () => {
      const value = await this.#load(active);
      await this.#verifySource();
      this.#members.clear();
      return value;
    });
    options?.onCoverage?.(loaded.traversal);
    for (const member of loaded.members) {
      abortIfNeeded(active);
      const sealed = sealMember(member);
      this.#members.set(sealed.entry.adapterKey, sealed);
      yield sealed.entry;
    }
  }

  async open(entry: ArtifactEntry, signal?: AbortSignal): Promise<Readable> {
    const active = this.#signal(signal);
    return this.#scope.run(async () => {
      const stored = this.#members.get(entry.adapterKey);
      if (stored === undefined || !sameArtifactEntry(entry, stored.entry))
        throw new ArtifactReaderFailure(
          "integrity",
          `PyInstaller entry was not produced by this reader: ${entry.path}`,
        );
      if (entry.kind !== "file")
        throw new ArtifactReaderFailure(
          "format",
          `PyInstaller entry is not a regular file: ${entry.path}`,
        );
      if (entry.encrypted)
        throw new ArtifactReaderFailure(
          "unavailable",
          `PYZ entry is encrypted and was not decoded: ${entry.path}`,
        );
      const read = stored.read;
      if (read === undefined)
        throw new ArtifactReaderFailure(
          "format",
          `PyInstaller entry has no readable bytes: ${entry.path}`,
        );
      await this.#verifySource();
      const knownSize =
        read.kind === "pyz"
          ? (read.uncompressedSize ??
            this.#openedPyzSizes.get(entry.adapterKey))
          : undefined;
      if (read.kind === "pyz" && knownSize === undefined)
        this.#charge(read.header?.length ?? 0);
      const parts = await this.#pyzStore.memberSource(
        read,
        this.#source?.handle,
        active,
      );
      if (active.aborted) {
        parts.source.destroy();
        await finished(parts.source, { cleanup: true }).catch(() => undefined);
        abortIfNeeded(active);
      }
      // Keep one close attempt in this read. Failed owners stay in the store
      // for reader.close() to retry, without losing the original failure.
      let closeAttempt: Promise<void> | undefined;
      const closeSource = (primary?: unknown) =>
        (closeAttempt ??= parts.close?.(primary));
      const stream = pyInstallerMemberStream(parts.source, {
        sourceBytes:
          read.kind === "carchive" ? read.source.compressedSize : read.length,
        compressed:
          read.kind === "pyz"
            ? read.compressed
            : read.source.compressionFlag === 1,
        header: read.header,
        expectedBytes:
          read.kind === "carchive" ? read.source.uncompressedSize : knownSize,
        maxBytes:
          read.kind === "carchive"
            ? read.source.uncompressedSize
            : (knownSize ?? this.#budget - this.#charged),
        signal: active,
        ...(read.kind === "pyz" && knownSize === undefined
          ? { charge: (bytes: number) => this.#charge(bytes) }
          : {}),
        complete: async (bytes) => {
          try {
            await parts.verify?.();
            await this.#verifySource();
            abortIfNeeded(active);
          } catch (cause: unknown) {
            await closeSource(cause);
            throw cause;
          }
          await closeSource();
          abortIfNeeded(active);
          if (read.kind === "pyz" && knownSize === undefined)
            this.#openedPyzSizes.set(entry.adapterKey, bytes);
        },
      });
      void this.#scope
        .run(async () => {
          let primary: unknown;
          try {
            await stream.completion;
          } catch (cause: unknown) {
            primary = cause;
          }
          await closeSource(primary);
          if (primary !== undefined) throw primary;
        })
        .catch((cause: unknown) =>
          stream.output.destroy(
            cause instanceof Error
              ? cause
              : new Error("PyInstaller stream failed", { cause }),
          ),
        );
      return stream.output;
    });
  }

  provenance(): readonly [] {
    return [];
  }

  async close(): Promise<void> {
    this.#closed = true;
    const closing = new ArtifactReaderFailure(
      "unavailable",
      "PyInstaller reader closed",
    );
    this.#lifecycle.abort(closing);
    await this.#scope.close();
    await this.#cleanup.close();
    this.#source = undefined;
    this.#closed = true;
    this.#loaded = undefined;
    this.#members.clear();
    this.#openedPyzSizes.clear();
  }

  #signal(signal?: AbortSignal): AbortSignal {
    abortIfNeeded(signal);
    if (this.#closed)
      throw new ArtifactReaderFailure(
        "unavailable",
        "PyInstaller archive is closed",
      );
    return signal === undefined
      ? this.#lifecycle.signal
      : AbortSignal.any([signal, this.#lifecycle.signal]);
  }

  async #load(signal?: AbortSignal): Promise<LoadedArchive> {
    this.#loaded ??= this.#parse(signal);
    return this.#loaded;
  }

  async #parse(signal?: AbortSignal): Promise<LoadedArchive> {
    const handle = await this.#openHandle(signal);
    await this.#verifySource();
    const size = (await handle.stat()).size;
    const cookie = await this.#cookie(handle, size, signal);
    this.#budget = artifactExpansionBudgetBytes(cookie.packageLength);
    const toc = await this.#toc(handle, cookie, signal);
    for (const entry of toc) {
      this.#charge(entry.uncompressedSize);
      this.#reserveMetadata({ ...entry }, false);
    }
    const images = await this.#pyzImages(handle, cookie, toc, signal);
    const magic = scriptPythonMagic(
      cookie,
      [...images.values()].map((image) => image.archive),
    );
    const encrypted = hasEncryptionMarker(toc);
    const members = await this.#project(
      toc,
      cookie,
      images,
      magic,
      encrypted,
      signal,
    );
    for (const member of members)
      if (member.read?.kind === "carchive")
        this.#charge(member.read.header?.length ?? 0);
    await this.#verifySource();
    this.#metadata = cookieMetadata(cookie, toc, encrypted);
    let opaqueImages = 0;
    for (const image of images.values())
      if (image.archive.kind === "opaque") opaqueImages++;
    return {
      members,
      traversal: {
        status: opaqueImages === 0 ? "complete" : "unknown",
        limitations:
          opaqueImages === 0
            ? []
            : [
                `${String(opaqueImages)} PYZ archives remain opaque; module traversal is unknown. See opaque PYZ occurrences for source magic and per-archive limitations.`,
              ],
      },
    };
  }

  async #openHandle(signal?: AbortSignal): Promise<FileHandle> {
    abortIfNeeded(signal);
    if (this.#closed)
      throw new ArtifactReaderFailure(
        "unavailable",
        "PyInstaller archive is closed",
      );
    if (this.#source !== undefined) return this.#source.handle;
    // Admission belongs to the reader. A departing caller cannot cancel a peer
    // or replace a late descriptor owner; every caller joins the same admission.
    this.#opening ??= this.#admit();
    let handle: FileHandle;
    try {
      handle = await this.#opening;
    } catch (cause: unknown) {
      if (
        cause instanceof ArtifactReaderFailure &&
        cause.reason === "cancelled" &&
        signal?.aborted
      )
        throw new ArtifactReaderFailure("cancelled", cause.message, {
          cause: signal.reason,
          cleanup: cause.cleanup,
          cleanupLeases: cause.cleanupLeases,
        });
      throw cause;
    }
    abortIfNeeded(signal);
    return handle;
  }

  async #admit(): Promise<FileHandle> {
    try {
      const handle = await openRegularFile(this.path, {
        symlinks: "reject",
        signal: this.#lifecycle.signal,
      });
      this.#retainCarrier(new OwnedFileHandle(handle));
      this.#source = { handle, initial: await handle.stat() };
      return handle;
    } catch (cause: unknown) {
      if (cause instanceof RegularFileAdmissionFailure)
        this.#retainCarrier(cause.owner);
      throw pyInstallerFileAdmissionFailure(this.path, cause);
    }
  }

  #retainCarrier(handle: OwnedFileHandle): void {
    this.#cleanup.retain({ kind: "file-handle", resource: this.path, handle });
  }

  async #cookie(
    handle: FileHandle,
    size: number,
    signal?: AbortSignal,
  ): Promise<PyInstallerCookie> {
    const found = await findPyInstallerCookie(handle, size, signal);
    if (found === undefined)
      throw new ArtifactReaderFailure(
        "format",
        "PyInstaller CArchive cookie was not found",
      );
    if (!found.ok) throw failure(found.error);
    return found.value;
  }

  async #toc(
    handle: FileHandle,
    cookie: PyInstallerCookie,
    signal?: AbortSignal,
  ): Promise<readonly CArchiveEntry[]> {
    const toc = await readCArchiveToc(handle, cookie, signal);
    if (!toc.ok) throw failure(toc.error);
    return toc.value;
  }

  async #pyzImages(
    handle: FileHandle,
    cookie: PyInstallerCookie,
    toc: readonly CArchiveEntry[],
    signal: AbortSignal | undefined,
  ): Promise<ReadonlyMap<CArchiveEntry, PyzImage>> {
    const images = new Map<CArchiveEntry, PyzImage>();
    // Admit the complete filesystem footprint before the first private write.
    this.#pyzStore.reserveImages(
      toc.reduce(
        (count, entry) =>
          count +
          (entry.typeCode === "z" && entry.compressionFlag === 1 ? 1 : 0),
        0,
      ),
    );
    for (const entry of toc) {
      if (entry.typeCode !== "z") continue;
      abortIfNeeded(signal);
      const spooled =
        entry.compressionFlag === 0
          ? undefined
          : await this.#pyzStore.spool(
              handle,
              cookie.archiveStart,
              entry,
              signal,
            );
      const source = spooled ?? {
        handle,
        start: cookie.archiveStart + entry.offset,
      };
      const parsed = await readPyzArchive(
        source.handle,
        source.start,
        entry.uncompressedSize,
        signal,
      );
      if (!parsed.ok) throw failure(parsed.error);
      if (parsed.value.kind === "entries")
        for (const item of parsed.value.entries)
          this.#reserveMetadata({ ...item, container: entry.name }, false);
      if (spooled !== undefined) await this.#pyzStore.release(spooled.handle);
      images.set(entry, {
        archive: parsed.value,
        handle: source.handle,
        start: source.start,
      });
    }
    return images;
  }

  async #project(
    toc: readonly CArchiveEntry[],
    cookie: PyInstallerCookie,
    images: ReadonlyMap<CArchiveEntry, PyzImage>,
    magic: Buffer | undefined,
    encrypted: boolean,
    signal: AbortSignal | undefined,
  ): Promise<PyInstallerMember[]> {
    const members: PyInstallerMember[] = [];
    const append = (member: PyInstallerMember): void => {
      this.#reservePathComponents(member.entry.path);
      const entry = {
        ...member.entry,
        path: normalizeArtifactPath(member.entry.path),
      };
      this.#reserveMetadata(
        {
          path: entry.path,
          adapter_key: entry.adapterKey,
          format_metadata: entry.formatMetadata ?? null,
          limitations: [...entry.limitations],
        },
        true,
      );
      members.push({ ...member, entry });
    };
    for (const entry of toc) {
      if (members.length % 256 === 0) await setImmediate();
      abortIfNeeded(signal);
      const image = entry.typeCode === "z" ? images.get(entry) : undefined;
      if (image === undefined) {
        append(projectStoredMember(entry, cookie.archiveStart, magic));
        continue;
      }
      append(projectPyzContainer(entry, cookie.archiveStart, image, encrypted));
      if (image.archive.kind !== "entries") continue;
      for (const item of image.archive.entries) {
        if (members.length % 256 === 0) await setImmediate();
        abortIfNeeded(signal);
        append(
          projectPyzMember(
            entry,
            item,
            encrypted,
            image.archive.pythonMagic,
            item.namespace || encrypted
              ? undefined
              : {
                  handle: image.handle,
                  offset: image.start + item.offset,
                  length: item.length,
                },
          ),
        );
      }
    }
    return members;
  }

  async #verifySource(): Promise<void> {
    const source = this.#source;
    if (source === undefined)
      throw new ArtifactReaderFailure(
        "unavailable",
        "PyInstaller archive is closed",
      );
    const [opened, currentPath] = await Promise.all([
      source.handle.stat(),
      lstat(this.path),
    ]);
    if (
      !sameRegularFileState(source.initial, opened) ||
      !sameRegularFileState(source.initial, currentPath)
    )
      throw new ArtifactReaderFailure(
        "integrity",
        `PyInstaller source changed during reading: ${this.path}`,
      );
  }

  #reservePathComponents(path: string): void {
    const remaining = MAX_RETAINED_ENTRY_BYTES - this.#retainedEntryBytes;
    // Case annotations can carry the path and two prefixes at every component.
    // Reserve escaped text growth as well as registry/case trie nodes and maps.
    const componentCost =
      PATH_COMPONENT_RESERVATION + 6 * jsonValueByteLength(path);
    let reservation = componentCost;
    for (
      let index = 0;
      index < path.length && reservation <= remaining;
      index++
    )
      if (path.charCodeAt(index) === 47) reservation += componentCost;
    if (reservation > remaining)
      throw new ArtifactReaderFailure(
        "limit",
        "PyInstaller paths exceed their retained namespace budget",
        { boundary: "memory" },
      );
    this.#retainedEntryBytes += reservation;
  }

  #reserveMetadata(value: JsonValue, projected: boolean): void {
    const used = projected ? this.#retainedEntryBytes : this.#parsedFactBytes;
    const limit = projected ? MAX_RETAINED_ENTRY_BYTES : MAX_PARSED_FACT_BYTES;
    const remaining = limit - used - RECORD_OWNERSHIP_RESERVATION;
    const bytes = remaining < 0 ? 0 : jsonValueByteLength(value, remaining);
    if (remaining < 0 || bytes > remaining)
      throw new ArtifactReaderFailure(
        "limit",
        "PyInstaller directory facts exceed their retained metadata budget",
        { boundary: "memory" },
      );
    if (projected)
      this.#retainedEntryBytes += bytes + RECORD_OWNERSHIP_RESERVATION;
    else this.#parsedFactBytes += bytes + RECORD_OWNERSHIP_RESERVATION;
  }

  #charge(bytes: number): void {
    if (
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      this.#charged + bytes > this.#budget
    )
      throw new ArtifactReaderFailure(
        "limit",
        `PyInstaller members declare ${String(this.#charged + Math.max(0, bytes))} uncompressed bytes, exceeding the decompression budget`,
      );
    this.#charged += bytes;
  }
}

const failure = (error: PyInstallerFailure): ArtifactReaderFailure =>
  new ArtifactReaderFailure(error.reason, error.message);
