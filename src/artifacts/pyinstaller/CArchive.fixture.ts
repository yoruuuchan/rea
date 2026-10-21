import { deflateSync } from "node:zlib";

import { PYINSTALLER_COOKIE_MAGIC } from "./CArchiveLayout.js";

/** Final CPython 3.9 bytecode magic, little-endian with the CR LF trailer. */
export const PYTHON_39_MAGIC = Buffer.from("610d0d0a", "hex");

const ELF_PREFIX = (() => {
  const bytes = Buffer.alloc(64);
  bytes.writeUInt32LE(0x464c457f, 0);
  bytes[4] = 2;
  bytes[5] = 1;
  bytes[6] = 1;
  bytes.writeUInt16LE(2, 16);
  bytes.writeUInt16LE(62, 18);
  bytes.writeUInt32LE(1, 20);
  bytes.writeUInt16LE(64, 52);
  return bytes;
})();

/** One CArchive member supplied as uncompressed bytes. */
export interface CArchiveFixtureMember {
  readonly name: string;
  readonly typeCode: string;
  readonly payload: Buffer;
  readonly compress: boolean;
  readonly compressedSuffix?: Buffer;
  readonly declaredUncompressedSize?: number;
}

/** Build a tiny ELF with an appended CArchive, optionally followed by a trailer. */
export const cArchiveExecutable = (input: {
  readonly layout: "2.0" | "2.1";
  readonly pythonVersion: number;
  readonly pythonLibrary?: string;
  readonly members: readonly CArchiveFixtureMember[];
  readonly trailer?: Buffer;
  readonly tocBytes?: Buffer;
}): Buffer => {
  const payloads: Buffer[] = [];
  const entries: Buffer[] = [];
  let dataLength = 0;
  for (const member of input.members) {
    const stored = member.compress
      ? Buffer.concat([
          deflateSync(member.payload),
          member.compressedSuffix ?? Buffer.alloc(0),
        ])
      : member.payload;
    entries.push(
      tocEntry({
        name: member.name,
        typeCode: member.typeCode,
        offset: dataLength,
        compressedSize: stored.length,
        uncompressedSize:
          member.declaredUncompressedSize ?? member.payload.length,
        flag: member.compress ? 1 : 0,
      }),
    );
    payloads.push(stored);
    dataLength += stored.length;
  }
  const toc = input.tocBytes ?? Buffer.concat(entries);
  const cookie = cookieBytes({
    layout: input.layout,
    pythonVersion: input.pythonVersion,
    pythonLibrary: input.pythonLibrary,
    tocOffset: dataLength,
    tocLength: toc.length,
  });
  return Buffer.concat([
    ELF_PREFIX,
    ...payloads,
    toc,
    cookie,
    input.trailer ?? Buffer.alloc(0),
  ]);
};

/** Cookie whose package range starts before the file. */
export const cookieRangeOutsideFile = (): Buffer => {
  const cookie = Buffer.alloc(88);
  PYINSTALLER_COOKIE_MAGIC.copy(cookie, 0);
  cookie.writeUInt32BE(200, 8);
  cookie.writeUInt32BE(80, 12);
  cookie.writeUInt32BE(32, 16);
  cookie.writeUInt32BE(314, 20);
  return Buffer.concat([ELF_PREFIX, cookie]);
};

/** PYZ image. Module bodies are zlib-compressed. Namespace entries have no body. */
export const pyzArchive = (input: {
  readonly magic: Buffer;
  readonly modules: readonly PyzFixtureModule[];
  readonly toc?: Buffer;
}): Buffer => {
  const blobs: Buffer[] = [];
  const entries: Buffer[] = [];
  let offset = 12;
  for (const module of input.modules) {
    const compressed =
      module.typeCode === 3 && module.legacyNamespacePayload !== true
        ? Buffer.alloc(0)
        : Buffer.concat([
            deflateSync(module.body),
            module.compressedSuffix ?? Buffer.alloc(0),
          ]);
    entries.push(
      marshalPair(module.name, module.typeCode, offset, compressed.length),
    );
    if (compressed.length > 0) {
      blobs.push(compressed);
      offset += compressed.length;
    }
  }
  const toc = input.toc ?? marshalList(entries);
  const header = Buffer.alloc(12);
  Buffer.from("PYZ\0").copy(header, 0);
  input.magic.copy(header, 4, 0, 4);
  header.writeUInt32BE(
    12 + blobs.reduce((sum, blob) => sum + blob.length, 0),
    8,
  );
  return Buffer.concat([header, ...blobs, toc]);
};

/** Type 3 normally stores no body; older producers can write a namespace payload. */
export interface PyzFixtureModule {
  readonly legacyNamespacePayload?: boolean;
  readonly compressedSuffix?: Buffer;
  readonly name: string;
  readonly typeCode: number;
  readonly body: Buffer;
}

const tocEntry = (input: {
  readonly name: string;
  readonly typeCode: string;
  readonly offset: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly flag: number;
}): Buffer => {
  const name = Buffer.from(input.name, "utf8");
  const length = Math.ceil((18 + name.length + 1) / 16) * 16;
  const bytes = Buffer.alloc(length);
  bytes.writeUInt32BE(length, 0);
  bytes.writeUInt32BE(input.offset, 4);
  bytes.writeUInt32BE(input.compressedSize, 8);
  bytes.writeUInt32BE(input.uncompressedSize, 12);
  bytes[16] = input.flag;
  bytes[17] = input.typeCode.charCodeAt(0);
  name.copy(bytes, 18);
  return bytes;
};

const cookieBytes = (input: {
  readonly layout: "2.0" | "2.1";
  readonly pythonVersion: number;
  readonly pythonLibrary: string | undefined;
  readonly tocOffset: number;
  readonly tocLength: number;
}): Buffer => {
  const size = input.layout === "2.1" ? 88 : 24;
  const bytes = Buffer.alloc(size);
  PYINSTALLER_COOKIE_MAGIC.copy(bytes, 0);
  bytes.writeUInt32BE(input.tocOffset + input.tocLength + size, 8);
  bytes.writeUInt32BE(input.tocOffset, 12);
  bytes.writeUInt32BE(input.tocLength, 16);
  bytes.writeUInt32BE(input.pythonVersion, 20);
  if (input.pythonLibrary !== undefined)
    Buffer.from(input.pythonLibrary, "utf8").copy(bytes, 24);
  return bytes;
};

const marshalList = (items: readonly Buffer[]): Buffer => {
  const count = Buffer.alloc(4);
  count.writeInt32LE(items.length, 0);
  return Buffer.concat([Buffer.from([0x5b]), count, ...items]);
};

const marshalPair = (
  name: string,
  typeCode: number,
  offset: number,
  length: number,
): Buffer =>
  smallTuple([
    marshalString(name),
    smallTuple([int32(typeCode), int32(offset), int32(length)]),
  ]);

const smallTuple = (items: readonly Buffer[]): Buffer =>
  Buffer.concat([Buffer.from([0x29, items.length]), ...items]);

const marshalString = (text: string): Buffer => {
  const body = Buffer.from(text, "utf8");
  if (body.length <= 255 && body.every((byte) => byte < 0x80))
    return Buffer.concat([Buffer.from([0x7a, body.length]), body]);
  const length = Buffer.alloc(4);
  length.writeUInt32LE(body.length);
  return Buffer.concat([Buffer.from([0x75]), length, body]);
};

const int32 = (value: number): Buffer => {
  const bytes = Buffer.alloc(5);
  bytes[0] = 0x69;
  bytes.writeInt32LE(value, 1);
  return bytes;
};
