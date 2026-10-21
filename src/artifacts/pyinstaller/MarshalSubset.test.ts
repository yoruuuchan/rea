import { expect, it } from "vitest";

import { readMarshalSubset } from "./MarshalSubset.js";

const bytes = (hex: string): Buffer => Buffer.from(hex, "hex");

it("reads a Python 3.9 reference-flagged PYZ table", () => {
  const parsed = readMarshalSubset(
    bytes(
      "db04000000a902da0568656c6c6fa903e900000000e90a000000e914000000a902da03706b67a903e901000000e91e000000e928000000a902fa0c6a736f6e2e6465636f646572a9037204000000e964000000e932000000a902da026e73a903e90300000072040000007204000000",
    ),
  );
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  expect(parsed.value).toEqual([
    ["hello", [0, 10, 20]],
    ["pkg", [1, 30, 40]],
    ["json.decoder", [0, 100, 50]],
    ["ns", [3, 0, 0]],
  ]);
});

it("resolves a shared string through a reference reserved before the tuple", () => {
  const parsed = readMarshalSubset(
    bytes(
      "db020000002902da06736861726564a903e900000000e901000000e90200000029027201000000a9037204000000e903000000e904000000",
    ),
  );
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  expect(parsed.value).toEqual([
    ["shared", [0, 1, 2]],
    ["shared", [1, 3, 4]],
  ]);
});

it("reads a long integer that fits in a safe integer", () => {
  const parsed = readMarshalSubset(
    bytes(
      "5b01000000a902da03626967a903e900000000ec03000000000000000004e905000000",
    ),
  );
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  expect(parsed.value).toEqual([["big", [0, 2 ** 40, 5]]]);
});

it("reads a negative 32-bit integer", () => {
  const parsed = readMarshalSubset(
    bytes("5b01000000a902da016ea903e900000000e9ffffffffe901000000"),
  );
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  expect(parsed.value).toEqual([["n", [0, -1, 1]]]);
});

it("rejects a marshal type outside the subset", () => {
  const parsed = readMarshalSubset(Buffer.from([0x4e]));
  expect(parsed.ok).toBe(false);
  if (parsed.ok) return;
  expect(parsed.error.reason).toBe("format");
});
