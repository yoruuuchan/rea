import {
  CLANG_BUNDLE_MAGIC,
  readClangBundleDirectory,
  readCcobHeader,
} from "./ClangOffloadBundle.js";
import { gpuObject, gpuLocation, type GpuPayloadTarget } from "./GpuObject.js";
import { readCudaTarget } from "./CudaTarget.js";
import { readCudaFatbinary } from "./CudaFatbinary.js";
import { decodeGpuPayload } from "./GpuPayloadCodec.js";
import { createHash } from "node:crypto";
import { scheduler } from "node:timers/promises";
import type {
  GpuCodeObjectsInput,
  GpuCodeObjects,
  GpuObject,
  GpuKernel,
} from "../domain/gpu/gpuCodeObjects.js";
import {
  BinaryFormatFailure,
  BinaryResourceFailure,
} from "../native/metadata/BinaryContainer.js";
import {
  readElfSectionDirectory,
  readPeSectionDirectory,
  type NativeSectionDirectory,
} from "../native/metadata/NativeSectionDirectory.js";
import { assertArtifactReadActive } from "../artifacts/ArtifactFileOperation.js";
import { jsonValueByteLength } from "../domain/jsonValueByteLength.js";
import type { JsonValue } from "../domain/jsonValue.js";
import {
  GpuBufferSource,
  checkGpuRange,
  GPU_OBJECT_BYTES,
  GPU_REPORT_BYTES,
  GpuReportCapacityFailure,
  gpuCount,
  nextGpuContainerOffset,
  gpuSha256,
  readGpuNativeDirectory,
  rejectGpu,
  type GpuSource,
} from "./GpuSource.js";
import {
  readGpuElfKernels,
  readAmdElfMetadata,
  type AmdElfMetadata,
} from "./GpuElfKernels.js";
import { readPtxKernels, readPtxTarget } from "./PtxKernels.js";

/** File declarations only. Every child range stays in its named parent coordinate space. */
export class GpuInventory {
  readonly objects: GpuObject[] = [];
  readonly kernels: GpuKernel[] = [];
  readonly ptx_artifacts: GpuCodeObjects["ptx_artifacts"] = [];
  readonly limitations = [
    "Static declarations only; no GPU execution, SASS disassembly, host launch correlation or runtime compatibility was verified.",
    "Object IDs are positional identities scoped to artifact.sha256. Locations inside decoded objects name their containing object; they are not file offsets.",
  ];
  discovery: "complete" | "partial" = "complete";
  examined_sections = 0;
  unknown_section_names = 0;
  #factBytes = 0;
  #workBytes = 0;
  readonly #outerTargets = new WeakMap<GpuObject, string | null>();
  readonly #selectedObjects: ReadonlySet<string> | undefined;
  readonly #selectedTargets: ReadonlySet<string> | undefined;
  constructor(
    readonly input: GpuCodeObjectsInput,
    readonly signal?: AbortSignal,
  ) {
    this.#selectedObjects =
      input.object_ids === undefined ? undefined : new Set(input.object_ids);
    this.#selectedTargets =
      input.targets === undefined ? undefined : new Set(input.targets);
    this.#retain({ path: input.path, limitations: this.limitations });
    this.#factBytes += 1024;
  }
  #retain(value: JsonValue): void {
    const bytes = jsonValueByteLength(value, GPU_REPORT_BYTES);
    if (bytes + 2 > GPU_REPORT_BYTES - this.#factBytes)
      throw new GpuReportCapacityFailure();
    this.#factBytes += bytes + 2;
  }
  #add(row: GpuObject): void {
    if (row.raw_flags !== null || row.bundle_id !== null)
      this.#outerTargets.set(row, row.target);
    this.#retain(row);
    this.#retain(" ".repeat(32)); // Reserve all later inspection-state changes.
    this.objects.push(row);
  }
  #decoded(row: GpuObject, sha256: string, size: number): void {
    this.#retain({ sha256, decoded_size: size });
    row.sha256 = sha256;
    row.decoded_size = size;
  }
  #objectLimitations(row: GpuObject, messages: string[]): void {
    this.#retain(messages);
    row.limitations.push(...messages);
  }
  /** Reserve input/output work atomically, before any payload allocation or read. */
  #budgetWork(...sizes: number[]): void {
    const total = sizes.reduce((sum, size) => sum + size, 0);
    if (
      sizes.some((size) => size > GPU_OBJECT_BYTES) ||
      total > 512 * 1024 * 1024 - this.#workBytes
    )
      throw new BinaryResourceFailure(
        "structure",
        GPU_OBJECT_BYTES,
        "GPU reads/decoding exceed 128 MiB per buffer or 512 MiB per inspection",
      );
    this.#workBytes += total;
  }
  #selected(row: GpuObject): boolean {
    return (
      (this.#selectedObjects === undefined ||
        this.#selectedObjects.has(row.id)) &&
      (this.#selectedTargets === undefined ||
        (row.target !== null && this.#selectedTargets.has(row.target)))
    );
  }
  async inspect(
    source: GpuSource,
    depth = 0,
  ): Promise<GpuCodeObjects["format"]> {
    assertArtifactReadActive(this.signal);
    if (depth > 8)
      throw new BinaryResourceFailure(
        "structure",
        8,
        "GPU container nesting exceeds eight levels",
      );
    const prefix = await source.read(0, Math.min(32, source.size));
    if (prefix.subarray(0, 4).equals(Buffer.from([0x50, 0xed, 0x55, 0xba]))) {
      await this.#cuda(source);
      return "cuda-fatbin";
    }
    if (
      prefix.subarray(0, CLANG_BUNDLE_MAGIC.length).equals(CLANG_BUNDLE_MAGIC)
    ) {
      await this.#hip(source, depth);
      return "hip-bundle";
    }
    if (prefix.subarray(0, 4).toString("ascii") === "CCOB") {
      await this.#hip(source, depth);
      return "hip-bundle";
    }
    if (
      prefix.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
      prefix.subarray(0, 2).toString("ascii") === "MZ"
    ) {
      const elf = prefix[0] === 0x7f;
      const directory = await readGpuNativeDirectory(
        source,
        elf
          ? readElfSectionDirectory(source.size)
          : readPeSectionDirectory(source.size),
      );
      if (elf && (directory.machine === 190 || directory.machine === 224)) {
        const row = gpuObject(source, {
          offset: 0,
          size: source.size,
          kind: directory.machine === 190 ? "cubin" : "amdgpu",
        });
        this.#add(row);
        if (directory.machine === 190) {
          this.#target(row, readCudaTarget(source, directory));
        }
        if (directory.machine === 224)
          await this.#amdPayload(source, row, directory);
        else await this.#payload(source, row);
      } else {
        for (const section of directory.sections) {
          this.examined_sections++;
          if (section.name === null) {
            this.unknown_section_names++;
            this.discovery = "partial";
            continue;
          }
          if (!isGpuSection(section.name)) continue;
          if (
            !section.file_backed ||
            (directory.format === "elf" && (section.flags & 0x800n) !== 0n)
          ) {
            this.discovery = "partial";
            const message = `GPU section ${section.index} has no supported uncompressed file range`;
            this.#retain(message);
            this.limitations.push(message);
            continue;
          }
          const offset = gpuCount(section.offset),
            size = gpuCount(section.size);
          const borrowed: GpuSource = {
            size,
            containerId: source.containerId,
            read: (start, length) => source.read(offset + start, length),
          };
          // A section is a coordinate space with an explicit physical backing, including PE short names.
          const row = gpuObject(source, {
            offset: offset,
            size: size,
            kind: "native-section",
            metadata: {
              offset: section.header_offset,
              size:
                directory.format === "elf"
                  ? directory.bits === 64
                    ? 64
                    : 40
                  : 40,
            },
          });
          row.location.section_index = section.index;
          row.location.section_name = section.name;
          this.#add(row);
          const sectionSource: GpuSource = { ...borrowed, containerId: row.id };
          try {
            await this.inspect(sectionSource, depth + 1);
            row.inspection = "complete";
          } catch (cause) {
            this.#retainFailure(row, cause);
            this.discovery = "partial";
          }
        }
      }
      return directory.format;
    }
    // PTX is positively identified by its directives, never by extension or arbitrary embedded text.
    let probe = await source.read(0, Math.min(source.size, 64 * 1024));
    let target = readPtxTarget(probe.toString("utf8"));
    if (
      target === null &&
      probe.length < Math.min(source.size, GPU_REPORT_BYTES)
    ) {
      probe = await source.read(0, Math.min(source.size, GPU_REPORT_BYTES));
      target = readPtxTarget(probe.toString("utf8"));
    }
    if (target !== null) {
      const row = gpuObject(source, {
        offset: 0,
        size: source.size,
        kind: "ptx",
      });
      row.target = target;
      this.#add(row);
      await this.#payload(
        probe.length === source.size
          ? new GpuBufferSource(probe, source.containerId)
          : source,
        row,
      );
      return "ptx";
    }
    if (probe.length < source.size)
      throw new BinaryResourceFailure(
        "structure",
        GPU_REPORT_BYTES,
        "Standalone text recognition exceeds the 16 MiB PTX budget before a target was established",
      );
    throw new BinaryFormatFailure(
      "unsupported",
      "No supported CUDA/HIP container or PTX declarations were identified",
    );
  }
  #retainFailure(row: GpuObject, cause: unknown): void {
    if (cause instanceof GpuReportCapacityFailure) throw cause;
    if (
      !(cause instanceof BinaryFormatFailure) &&
      !(cause instanceof BinaryResourceFailure)
    )
      throw cause;
    row.inspection =
      cause instanceof BinaryResourceFailure
        ? "capacity"
        : cause.kind === "unsupported"
          ? "unsupported"
          : "malformed";
    this.#objectLimitations(row, [cause.message]);
  }
  async #payload(
    source: GpuSource,
    row: GpuObject,
    preparedAmd?: AmdElfMetadata,
  ): Promise<void> {
    if (this.input.analysis !== "kernels") return;
    if (!this.#selected(row)) {
      row.inspection = "not-selected";
      return;
    }
    if (row.compression === "unsupported") {
      row.inspection = "unsupported";
      return;
    }
    try {
      let coverage: "complete" | "partial" = "complete";
      if (
        row.kind === "ptx" &&
        (row.decoded_size === null || row.decoded_size > GPU_REPORT_BYTES)
      )
        throw new BinaryResourceFailure(
          "structure",
          GPU_REPORT_BYTES,
          "PTX text exceeds the 16 MiB retained report budget",
        );
      const compression = row.compression;
      const compressed =
        compression === "zstd" ||
        compression === "zlib" ||
        compression === "lz4";
      if (compressed && row.decoded_size === null)
        rejectGpu("Compressed GPU object has no decoded length");
      this.#budgetWork(
        row.location.size,
        ...(compressed ? [row.decoded_size!] : []),
      );
      let bytes = await source.read(row.location.offset, row.location.size);
      if (compressed) {
        try {
          bytes = await decodeGpuPayload(
            bytes,
            compression,
            row.decoded_size!,
            this.signal,
          );
        } catch (cause) {
          if (cause instanceof BinaryResourceFailure) throw cause;
          assertArtifactReadActive(this.signal);
          throw new BinaryFormatFailure(
            "malformed",
            "GPU payload decompression failed",
          );
        }
      }
      this.#decoded(row, gpuSha256(bytes), bytes.length);
      const decoded = new GpuBufferSource(bytes, row.id);
      if (row.kind === "ptx") {
        // NVIDIA appends NUL alignment padding to an uncompressed PTX entry.
        let length = bytes.length;
        if (row.raw_flags !== null)
          while (length > 0 && bytes[length - 1] === 0) length--;
        const content = bytes.subarray(0, length);
        let text: string;
        try {
          text = new TextDecoder("utf-8", {
            fatal: true,
            ignoreBOM: true,
          }).decode(content);
        } catch {
          return rejectGpu("PTX is not valid UTF-8 text");
        }
        const target = readPtxTarget(text);
        const conflict = this.#target(row, {
          value: target,
          key: target,
          scope: "exact",
        });
        if (conflict !== undefined) coverage = "partial";
        const parsed = readPtxKernels(text, row.id);
        const artifact = {
          id: `${row.id}/ptx`,
          object_id: row.id,
          sha256: gpuSha256(content),
          media_type: "text/x-ptx" as const,
          encoding: "utf-8" as const,
          byte_length: content.length,
          text,
          location: gpuLocation(decoded, 0, content.length),
        };
        this.#retain(artifact);
        this.ptx_artifacts.push(artifact);
        for (const { kernel, coverage: kernelCoverage } of parsed) {
          if (conflict !== undefined) kernel.limitations.push(conflict);
          if (kernelCoverage === "partial") coverage = "partial";
          this.#retain(kernel);
          this.kernels.push(kernel);
        }
      } else if (row.kind === "cubin" || row.kind === "amdgpu") {
        coverage = await this.#elfFacts(decoded, row, row.kind, preparedAmd);
      } else {
        row.inspection = "unsupported";
        this.#objectLimitations(row, [
          "Payload kind is outside kernel metadata coverage",
        ]);
        return;
      }
      row.inspection = coverage;
    } catch (cause) {
      this.#retainFailure(row, cause);
    }
  }
  #target(row: GpuObject, payload: GpuPayloadTarget): string | undefined {
    const selectedTarget = row.target;
    const outer = this.#outerTargets.get(row) ?? null;
    const hasOuter = outer !== null;
    let state: GpuObject["target_consistency"] = "unknown";
    if (payload.value !== null && !hasOuter) state = "single-source";
    else if (outer !== null && payload.key !== null) {
      if (payload.scope === "cuda-base") {
        const base = /^sm_([0-9]+)[a-z]*$/u.exec(outer)?.[1];
        const inner = /^sm_([0-9]+)$/u.exec(payload.key)?.[1];
        if (base !== undefined && inner !== undefined)
          state = base === inner ? "base-only" : "conflict";
      } else if (outer === payload.key) state = "consistent";
      else if (
        row.kind === "amdgpu" &&
        outer.split(":")[0] === payload.key.split(":")[0]
      )
        state = "unknown";
      else state = "conflict";
    }
    this.#retain({
      payload_target: payload.value,
      cuda_target_header: payload.cudaHeader ?? null,
      target_consistency: state,
      target: selectedTarget ?? payload.value,
    });
    row.payload_target = payload.value;
    row.cuda_target_header = payload.cudaHeader ?? null;
    row.target_consistency = state;
    if (selectedTarget === null) row.target = payload.value;
    if (row.target === null) this.discovery = "partial";
    if (state !== "conflict" && payload.limitation === undefined) return;
    const message =
      state === "conflict"
        ? `Conflicting target declarations: inventory ${outer}; payload ${payload.value}. Target agreement is not established.`
        : payload.limitation!;
    this.#objectLimitations(row, [message]);
    return message;
  }
  async #amdPayload(
    source: GpuSource,
    row: GpuObject,
    directory?: NativeSectionDirectory,
  ): Promise<void> {
    const child: GpuSource = {
      size: row.location.size,
      containerId: row.id,
      read: (offset, size) => {
        checkGpuRange(row.location.size, offset, size);
        this.#budgetWork(size);
        return source.read(row.location.offset + offset, size);
      },
    };
    try {
      const native =
        directory ??
        (await readGpuNativeDirectory(
          child,
          readElfSectionDirectory(child.size),
        ));
      const inspected = await readAmdElfMetadata(child, native);
      const prepared = inspected.ok ? inspected.value : inspected.error.partial;
      this.#target(row, {
        value: prepared.target,
        key: prepared.target_key,
        scope: "exact",
      });
      if (!inspected.ok) {
        this.discovery = "partial";
        if (this.input.analysis === "kernels" && this.#selected(row))
          await this.#elfFacts(child, row, "amdgpu", prepared);
        this.#retainFailure(row, inspected.error.cause);
        return;
      }
      await this.#payload(source, row, prepared);
    } catch (cause) {
      this.discovery = "partial";
      this.#retainFailure(row, cause);
    }
  }
  async #elfFacts(
    source: GpuSource,
    row: GpuObject,
    kind: "cubin" | "amdgpu",
    preparedAmd?: AmdElfMetadata,
  ): Promise<"complete" | "partial"> {
    let conflict: string | undefined;
    const parsed = await readGpuElfKernels(
      source,
      kind,
      (kernel) => {
        if (conflict !== undefined) kernel.limitations.push(conflict);
        this.#retain(kernel);
        this.kernels.push(kernel);
      },
      preparedAmd,
      (target) => {
        conflict = this.#target(row, target);
      },
    );
    this.#objectLimitations(row, parsed.limitations);
    return conflict !== undefined ? "partial" : parsed.coverage;
  }
  async #cuda(source: GpuSource): Promise<void> {
    for await (const row of readCudaFatbinary(source, this.signal)) {
      this.#add(row);
      await this.#payload(source, row);
    }
  }
  async #hip(source: GpuSource, depth: number): Promise<void> {
    let base = 0;
    let bundles = 0;
    while (base < source.size) {
      if (++bundles % 128 === 0) {
        await scheduler.yield();
        assertArtifactReadActive(this.signal);
      }
      const prefix = await source.read(base, Math.min(32, source.size - base));
      if (prefix.subarray(0, 24).equals(CLANG_BUNDLE_MAGIC)) {
        const directory = await readClangBundleDirectory(
          source,
          base,
          this.signal,
        );
        for (const row of directory.objects) {
          this.#add(row);
          if (row.kind === "host") row.inspection = "complete";
          else if (row.kind === "amdgpu" && row.target === null)
            await this.#amdPayload(source, row);
          else await this.#payload(source, row);
        }
        base = await nextGpuContainerOffset(source, directory.end);
        continue;
      }
      if (prefix.subarray(0, 4).toString("ascii") !== "CCOB")
        rejectGpu("Unexpected bytes between Clang offload bundles");
      const header = readCcobHeader(prefix, source.size - base),
        { width, total, decoded, hash, version, method } = header;
      const row = gpuObject(source, {
        offset: base + width,
        size: total - width,
        kind: "hip-bundle",
        metadata: { offset: base, size: width },
      });
      row.compression =
        method === 0 ? "zlib" : method === 1 ? "zstd" : "unsupported";
      row.compression_id = `ccob:${version}:${method}`;
      row.decoded_size = decoded;
      this.#add(row);
      if (row.compression === "unsupported") {
        row.inspection = "unsupported";
        this.#objectLimitations(row, ["Unsupported CCOB compression method"]);
        this.discovery = "partial";
      } else
        try {
          this.#budgetWork(total - width, decoded);
          const data = await decodeGpuPayload(
            await source.read(base + width, total - width),
            row.compression,
            decoded,
            this.signal,
          );
          if (
            createHash("md5").update(data).digest().readBigUInt64LE(0) !== hash
          )
            rejectGpu("CCOB truncated MD5 does not match decoded bytes");
          this.#decoded(row, gpuSha256(data), data.length);
          await this.inspect(new GpuBufferSource(data, row.id), depth + 1);
          row.inspection = "complete";
        } catch (cause) {
          this.#retainFailure(row, cause);
          this.discovery = "partial";
        }
      base = await nextGpuContainerOffset(source, base + total);
    }
  }
}
const isGpuSection = (name: string): boolean =>
  [
    ".nv_fatbin",
    ".nv_fatb",
    ".hip_fatbin",
    ".hip_fat",
    ".llvm.offloading",
  ].includes(name);
