import {
  createAsarHeaderSignatureProbe,
  type FinalAsarHeaderProbeObservation,
} from "./AsarHeader.js";
import {
  createXmlPlistSignatureProbe,
  MAX_XML_PLIST_PROBE_BYTES,
} from "../domain/apple/appleArchiveFormat.js";

/** Initial bytes required by the other bounded format classifiers. */
export const ARTIFACT_CLASSIFICATION_PREFIX_BYTES = 8_192;

/** Retained bytes and independently parsed ASAR signature facts. */
export interface ArtifactClassificationEvidence {
  readonly prefix: Buffer;
  readonly asarHeader: FinalAsarHeaderProbeObservation;
}

/** Share acquisition bounds and signature observations across files and streams. */
export const createArtifactClassificationProbe = () => {
  const xml = createXmlPlistSignatureProbe();
  const asar = createAsarHeaderSignatureProbe();
  const blocks: Buffer[] = [];
  let retainedBytes = 0;
  let observedBytes = 0;
  const retain = (bytes: Uint8Array): void => {
    let offset = 0;
    while (offset < bytes.length) {
      const blockOffset = retainedBytes % ARTIFACT_CLASSIFICATION_PREFIX_BYTES;
      if (blockOffset === 0)
        blocks.push(Buffer.allocUnsafe(ARTIFACT_CLASSIFICATION_PREFIX_BYTES));
      const count = Math.min(
        ARTIFACT_CLASSIFICATION_PREFIX_BYTES - blockOffset,
        bytes.length - offset,
      );
      blocks[blocks.length - 1]!.set(
        bytes.subarray(offset, offset + count),
        blockOffset,
      );
      retainedBytes += count;
      offset += count;
    }
  };
  return {
    get length(): number {
      return observedBytes;
    },
    get limit(): number {
      if (observedBytes < ARTIFACT_CLASSIFICATION_PREFIX_BYTES)
        return ARTIFACT_CLASSIFICATION_PREFIX_BYTES;
      return Math.max(
        ARTIFACT_CLASSIFICATION_PREFIX_BYTES,
        xml.state === "pending" ? MAX_XML_PLIST_PROBE_BYTES : 0,
        asar.observation.state === "pending" ? asar.limit : 0,
      );
    },
    write(bytes: Uint8Array): void {
      asar.write(bytes);
      let offset = 0;
      while (offset < bytes.length) {
        const limit =
          retainedBytes < ARTIFACT_CLASSIFICATION_PREFIX_BYTES
            ? ARTIFACT_CLASSIFICATION_PREFIX_BYTES
            : xml.state === "pending"
              ? MAX_XML_PLIST_PROBE_BYTES
              : retainedBytes;
        if (retainedBytes >= limit) break;
        const selected = bytes.subarray(
          offset,
          offset + Math.min(limit - retainedBytes, bytes.length - offset),
        );
        retain(selected);
        xml.write(selected);
        offset += selected.length;
      }
      observedBytes += bytes.length;
    },
    finish(archiveBytes: number): ArtifactClassificationEvidence {
      const prefix = Buffer.allocUnsafe(retainedBytes);
      let copied = 0;
      for (const block of blocks) {
        const count = Math.min(block.length, retainedBytes - copied);
        prefix.set(block.subarray(0, count), copied);
        copied += count;
      }
      return { prefix, asarHeader: asar.finish(archiveBytes) };
    },
  };
};
