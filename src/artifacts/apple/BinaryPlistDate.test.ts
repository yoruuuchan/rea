import { describe, expect, it } from "vitest";

import { binaryPlistDateRepresentable } from "./BinaryPlistDate.js";

describe("binary plist date instants", () => {
  it("keeps canonical millisecond encodings and rejects nearby floats", () => {
    expect(binaryPlistDateRepresentable(0.1)).toBe(true);
    expect(binaryPlistDateRepresentable(0)).toBe(true);
    expect(binaryPlistDateRepresentable(0.001)).toBe(true);
    expect(binaryPlistDateRepresentable(-0)).toBe(true);
    expect(binaryPlistDateRepresentable(0.1005)).toBe(false);
    expect(binaryPlistDateRepresentable(0.1004)).toBe(false);
    const next = Buffer.alloc(8);
    next.writeDoubleBE(0.1);
    next.writeBigUInt64BE(next.readBigUInt64BE(0) + 1n);
    expect(binaryPlistDateRepresentable(next.readDoubleBE(0))).toBe(false);
    expect(binaryPlistDateRepresentable(Number.NaN)).toBe(false);
    expect(binaryPlistDateRepresentable(Number.POSITIVE_INFINITY)).toBe(false);
  });
});
