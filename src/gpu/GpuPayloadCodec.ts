import { constants, inflate, zstdDecompress } from "node:zlib";
import { promisify } from "node:util";
import { assertArtifactReadActive } from "../artifacts/ArtifactFileOperation.js";
import { decodeLz4Block } from "./Lz4Block.js";
import { rejectGpu } from "./GpuSource.js";
const unzip = promisify(inflate);
const unzstd = promisify(zstdDecompress);
export const decodeGpuPayload = async (
  bytes: Buffer,
  compression: "zlib" | "zstd" | "lz4",
  expected: number,
  signal?: AbortSignal,
): Promise<Buffer> => {
  assertArtifactReadActive(signal);
  if (compression === "lz4") return decodeLz4Block(bytes, expected, signal);
  let result: unknown;
  try {
    const maxOutputLength = Math.max(1, expected);
    result = await (compression === "zstd"
      ? unzstd(bytes, {
          maxOutputLength,
          info: true,
          params: { [constants.ZSTD_d_windowLogMax]: 27 },
        })
      : unzip(bytes, { maxOutputLength, info: true }));
  } catch {
    assertArtifactReadActive(signal);
    return rejectGpu(
      "GPU payload decompression failed or exceeded its declared length",
    );
  }
  assertArtifactReadActive(signal);
  if (
    typeof result !== "object" ||
    result === null ||
    !("buffer" in result) ||
    !Buffer.isBuffer(result.buffer) ||
    !("engine" in result) ||
    typeof result.engine !== "object" ||
    result.engine === null ||
    !("bytesWritten" in result.engine) ||
    typeof result.engine.bytesWritten !== "number"
  )
    throw new Error(
      "Built-in GPU decoder omitted its buffer or consumed-input accounting",
    );
  const decoded = result.buffer;
  if (result.engine.bytesWritten !== bytes.length)
    rejectGpu(
      "GPU compressed payload contains bytes outside its complete codec stream",
    );
  if (decoded.length !== expected)
    rejectGpu("GPU decompressed length disagrees with its declaration");
  return decoded;
};
