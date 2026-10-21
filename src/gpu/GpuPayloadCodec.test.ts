import { expect, it } from "vitest";
import { deflateSync, zstdCompressSync } from "node:zlib";
import { decodeGpuPayload } from "./GpuPayloadCodec.js";
it.each(["zlib", "zstd"] as const)(
  "requires all declared %s input bytes to belong to the codec stream",
  async (codec) => {
    const source = Buffer.from("kernel"),
      encode = codec === "zstd" ? zstdCompressSync : deflateSync,
      compressed = encode(source);
    expect(await decodeGpuPayload(compressed, codec, source.length)).toEqual(
      source,
    );
    await expect(
      decodeGpuPayload(
        Buffer.concat([compressed, Buffer.from("junk")]),
        codec,
        source.length,
      ),
    ).rejects.toMatchObject({ kind: "malformed" });
  },
);
