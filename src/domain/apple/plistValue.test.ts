import { expect, it } from "vitest";

import { projectPlistValue } from "./plistValue.js";

// Binary decoders build dates from seconds; beyond the Date range they are invalid.
it("projects an unrepresentable date as unknown and counts it", () => {
  expect(
    projectPlistValue({ far: new Date(Number.NaN), near: new Date(0) }),
  ).toEqual({
    value: {
      far: { $plist_type: "date", iso8601: null },
      near: { $plist_type: "date", iso8601: "1970-01-01T00:00:00.000Z" },
    },
    unknownRealCount: 0,
    negativeZeroRealCount: 0,
    unknownDateCount: 1,
  });
});

it("keeps a negative-zero real distinct from positive zero and counts it", () => {
  const observed: object[] = [];
  const projected = projectPlistValue(
    [-0, 0, 1.25, { $plist_type: "real", value: "-0" }],
    (wrapper) => observed.push(wrapper),
  );
  expect(projected.negativeZeroRealCount).toBe(1);
  expect(projected.unknownRealCount).toBe(0);
  expect(Array.isArray(projected.value)).toBe(true);
  if (!Array.isArray(projected.value)) throw new Error("Expected array");
  expect(projected.value[0]).toEqual({ $plist_type: "real", value: "-0" });
  expect(Object.is(projected.value[1], 0)).toBe(true);
  expect(projected.value[2]).toBe(1.25);
  // Only the generated wrapper is reported; the lookalike stays a dictionary.
  expect(projected.value[3]).toEqual(projected.value[0]);
  expect(observed).toHaveLength(1);
  expect(observed[0]).toBe(projected.value[0]);
  expect(JSON.stringify(projected.value)).toBe(
    '[{"$plist_type":"real","value":"-0"},0,1.25,{"$plist_type":"real","value":"-0"}]',
  );
});

it("rejects excessive plist nesting without exhausting the stack", () => {
  const deep: unknown[] = [];
  let cursor = deep;
  for (let depth = 0; depth < 200; depth += 1) {
    const next: unknown[] = [];
    cursor.push(next);
    cursor = next;
  }
  expect(() => projectPlistValue(deep)).toThrow(RangeError);
});

it("reports only generated scalar wrappers and keeps lookalike dictionaries distinct", () => {
  const observed: object[] = [];
  const value = projectPlistValue(
    [
      new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
      new Date(0),
      new Date(Number.NaN),
      Number.POSITIVE_INFINITY,
      { $plist_type: "data", base64: "3q2+7w==" },
    ],
    (wrapper) => observed.push(wrapper),
  ).value;
  expect(Array.isArray(value)).toBe(true);
  if (!Array.isArray(value)) throw new Error("Expected projected array");
  expect(observed).toEqual(value.slice(0, 4));
  expect(observed[0]).toBe(value[0]);
  expect(value[0]).toEqual(value[4]);
  expect(observed).not.toContain(value[4]);
});

it("rejects accessors, proxies, holes and symbol keys without invoking user code", () => {
  let accessed = 0;
  const dictionary = Object.defineProperty({}, "value", {
    enumerable: true,
    get() {
      accessed++;
      return "unexpected";
    },
  });
  const array = Object.defineProperty([], "0", {
    enumerable: true,
    get() {
      accessed++;
      return "unexpected";
    },
  });
  const proxy = new Proxy(
    {},
    {
      ownKeys() {
        accessed++;
        return [];
      },
      getPrototypeOf() {
        accessed++;
        return Object.prototype;
      },
    },
  );
  for (const value of [
    dictionary,
    array,
    proxy,
    Array(1),
    { [Symbol("key")]: "value" },
  ])
    expect(() => projectPlistValue(value)).toThrow(TypeError);
  expect(accessed).toBe(0);
});

it("keeps retained integer scalars distinct from lookalike dictionaries", () => {
  const decimal = `1${"0".repeat(400)}`;
  const observed: object[] = [];
  const projected = projectPlistValue(
    [BigInt(decimal), { $plist_type: "integer", decimal }],
    (value) => observed.push(value),
  );
  expect(projected.unknownRealCount).toBe(0);
  expect(projected.unknownDateCount).toBe(0);
  expect(Array.isArray(projected.value)).toBe(true);
  if (!Array.isArray(projected.value)) throw new Error("Expected array");
  expect(projected.value[0]).toEqual(projected.value[1]);
  expect(observed).toHaveLength(1);
  expect(observed[0]).toBe(projected.value[0]);
  expect(observed[0]).not.toBe(projected.value[1]);
});
