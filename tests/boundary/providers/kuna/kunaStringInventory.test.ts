import { expect, it } from "vitest";

import { parseKunaStringInventory } from "../../../../src/kuna/KunaStringInventory.js";

const input = "/private/program";
const row = {
  address: "@9007199254740993",
  address_hex: "0x20000000000001",
  text: "a\nΔelta",
  length: 7,
  byte_length: 9,
  nul_terminated: true,
  encoding: "utf8",
  section: ".rodata",
  xrefs_count: 0,
  functions: [],
};
const document = () => ({
  binary: input,
  encoding: "all",
  min_length: 5,
  filter: null,
  section: null,
  termination: "any",
  scanned: "sections",
  xrefs: false,
  count: 1,
  strings: [row],
});
const wire = (value: unknown) =>
  JSON.stringify(value).replace(/"@(\d+)"/gu, "$1");

it("preserves exact u64 string identity, multiline text and typed source facts", () => {
  const result = parseKunaStringInventory(wire(document()), input);
  expect(result).toMatchObject({
    ok: true,
    value: {
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      scanned: "sections",
      items: [
        {
          address: "0x20000000000001",
          value: "a\nΔelta",
          string: {
            encoding: "utf8",
            encoding_status: "observed",
            termination: "present_or_not_required",
            byte_length: 9,
          },
        },
      ],
    },
  });
});

it.each([
  ["input", { binary: "/other/program" }],
  ["count", { count: 2 }],
  ["filter", { filter: "narrowed" }],
  ["xrefs", { xrefs: true }],
  ["encoding", { encoding: "ascii" }],
  ["scan scope", { scanned: "unknown" }],
  [
    "address identity",
    { strings: [{ ...row, address_hex: "0x20000000000000" }] },
  ],
  ["u64 overflow", { strings: [{ ...row, address: "@18446744073709551616" }] }],
  ["partial row", { strings: [{ ...row, byte_length: null }] }],
  ["unexpected references", { strings: [{ ...row, xrefs_count: 1 }] }],
  ["duplicate identity", { count: 2, strings: [row, row] }],
])(
  "rejects inconsistent %s before publishing any strings",
  (_label, changes) => {
    expect(
      parseKunaStringInventory(wire({ ...document(), ...changes }), input).ok,
    ).toBe(false);
  },
);

it.each([
  { encoding: "utf8", text: "😀😀😀😀😀", length: 5, byte_length: 21 },
  { encoding: "utf16", text: "café!", length: 5, byte_length: 12 },
])("counts $encoding source units without losing text", (facts) => {
  const value = { ...document(), strings: [{ ...row, ...facts }] };
  expect(parseKunaStringInventory(wire(value), input)).toMatchObject({
    ok: true,
    value: {
      items: [
        { value: facts.text, string: { byte_length: facts.byte_length } },
      ],
    },
  });
});

it.each([
  { byte_length: 0 },
  { length: 6 },
  { nul_terminated: false },
  { encoding: "ascii" },
  { encoding: "utf16", text: "hello", length: 5, byte_length: 11 },
  { encoding: "utf8", text: "hi", length: 2, byte_length: 3 },
  { encoding: "utf8", text: "hello\u0000", length: 6, byte_length: 7 },
  { encoding: "utf8", text: "hello\ud800", length: 6, byte_length: 9 },
  { encoding: "utf16", text: "Δelta", length: 5, byte_length: 12 },
])("rejects conflicting encoded string facts: %j", (facts) => {
  const value = { ...document(), strings: [{ ...row, ...facts }] };
  expect(parseKunaStringInventory(wire(value), input).ok).toBe(false);
});
