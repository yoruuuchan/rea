import { describe, expect, it } from "vitest";

import type { PlistNumberLiterals } from "../../domain/apple/plistNumbers.js";
import {
  decodeBinaryPlistNumbers,
  scanBinaryPlistNumberLiterals,
} from "./PlistNumberLiterals.js";

const dataObjectWithUnusedOverlappingInteger = (): Buffer => {
  const bytes = Buffer.alloc(66);
  Buffer.from("bplist00", "ascii").copy(bytes);
  bytes[8] = 0xa1; // One-element array referencing data object 1.
  bytes[9] = 1;
  bytes[10] = 0x4f; // Data object with an extended length of 18 bytes.
  bytes[11] = 0x10;
  bytes[12] = 18;
  bytes[13] = 0x14; // An unused object-table entry points into this data.
  bytes.fill(0xff, 14, 30);
  bytes[30] = 0;
  bytes.set([8, 10, 13], 31); // object offsets, including the overlapping entry
  bytes[40] = 1; // offset width
  bytes[41] = 1; // reference width
  bytes.writeBigUInt64BE(3n, 42);
  bytes.writeBigUInt64BE(0n, 50);
  bytes.writeBigUInt64BE(31n, 58);
  return bytes;
};

describe("binary plist number rewriting", () => {
  it("does not rewrite an integer marker inside another object's data", () => {
    const bytes = dataObjectWithUnusedOverlappingInteger();
    const metadata = scanBinaryPlistNumberLiterals(bytes);

    expect(metadata.literals.incomplete).toBe(true);
    expect(metadata.wideIntegers).toEqual([]);
    expect(decodeBinaryPlistNumbers(bytes, metadata)).toBe(bytes);
    expect(bytes.subarray(13, 30)).toEqual(
      Buffer.from([0x14, ...Array<number>(16).fill(0xff)]),
    );
  });

  it("applies wide-integer and date rewrites on one copy", () => {
    const bytes = Buffer.alloc(34);
    bytes[0] = 0x14;
    bytes.writeBigUInt64BE(1n, 1);
    bytes.writeBigUInt64BE(2n, 9);
    bytes.writeDoubleBE(0.1, 18);
    bytes.writeDoubleBE(0.1005, 26);
    const original = Buffer.from(bytes);
    const literals: PlistNumberLiterals = {
      integers: new Map(),
      reals: new Set(),
      unsafeIntegerLiterals: 1,
      incomplete: false,
    };
    const value = (1n << 64n) | 2n;
    const decoded = decodeBinaryPlistNumbers(
      bytes,
      { literals, wideIntegers: [{ offset: 0, value }] },
      [18, 26],
    );
    expect(decoded).not.toBe(bytes);
    expect(bytes).toEqual(original);
    expect(decoded[0]).toBe(0x23);
    expect(decoded.readDoubleBE(1)).toBe(Number(value));
    expect(decoded.readDoubleBE(18)).toBe(0.1);
    expect(Number.isNaN(decoded.readDoubleBE(26))).toBe(true);
    const representableOnly = {
      literals: { ...literals, unsafeIntegerLiterals: 0 },
      wideIntegers: [],
    };
    expect(decodeBinaryPlistNumbers(bytes, representableOnly, [18])).toBe(
      bytes,
    );
    expect(decodeBinaryPlistNumbers(bytes, representableOnly, [])).toBe(bytes);
  });
});
