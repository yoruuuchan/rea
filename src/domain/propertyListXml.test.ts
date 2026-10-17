import { expect, it } from "vitest";

import { parseXmlPropertyList } from "./propertyListKeys.js";

it.each([
  ["0x2A", 42],
  ["0X2a", 42],
  ["+0x2A", 42],
  ["-0x2A", -42],
  ["&#48;x2A", 42],
  ["\n0x2A\n", 42],
  ["42", 42],
])(
  "decodes exact integer text %s at the shared boundary",
  (literal, expected) => {
    const parsed = parseXmlPropertyList(
      `<plist><integer>${literal}</integer></plist>`,
    );
    expect(parsed.value).toBe(expected);
    expect(parsed.numberLiterals.incomplete).toBe(false);
    expect(parsed.numberLiterals.unsafeIntegerLiterals).toBe(0);
  },
);

it("collects source integers and CDATA reals before rounding and duplicate assignment", () => {
  const parsed = parseXmlPropertyList(
    "<plist><dict><key>a</key><integer>0x20000000000001</integer><key>a</key><integer>9007199254740992</integer><key>b</key><real>9007199254<![CDATA[740992]]></real></dict></plist>",
  );
  expect(parsed.value).toEqual({ a: 9007199254740992, b: 9007199254740992 });
  expect(parsed.numberLiterals.integers.get(9007199254740992)).toEqual(
    new Set(["9007199254740993", "9007199254740992"]),
  );
  expect(parsed.numberLiterals.reals).toEqual(new Set([9007199254740992]));
  expect(parsed.numberLiterals.unsafeIntegerLiterals).toBe(2);
  expect(parsed.numberLiterals.incomplete).toBe(false);
});

it("does not invent numeric facts from ignored scalar markup", () => {
  const parsed = parseXmlPropertyList(
    "<plist><array><string>text<integer>9007199254740993</integer></string><dict><key><real>9007199254740992</real></key><integer>7</integer></dict></array></plist>",
  );
  expect(parsed.value).toEqual(["text", { null: 7 }]);
  expect(parsed.numberLiterals.integers.size).toBe(0);
  expect(parsed.numberLiterals.reals.size).toBe(0);
  expect(parsed.numberLiterals.incomplete).toBe(false);
});

it("retains partial numeric values with explicit incomplete metadata for unsupported markup", () => {
  const parsed = parseXmlPropertyList(
    "<plist><array><integer>0x2A<!-- unsupported --></integer><real>1<string>ignored</string>.25</real></array></plist>",
  );
  expect(parsed.value).toEqual([0, 1.25]);
  expect(parsed.numberLiterals.incomplete).toBe(true);
});

it("interprets failures in omitted entries before reporting partial evidence", () => {
  expect(() =>
    parseXmlPropertyList(
      "<plist><dict><key>__proto__</key><unsupported/></dict></plist>",
    ),
  ).toThrow("Invalid PLIST tag");
});

it("retains native decoder null and nested-envelope behavior", () => {
  expect(
    parseXmlPropertyList(
      "<plist><array><null/><dict><key>value</key><null/></dict><plist><null/></plist></array></plist>",
    ).value,
  ).toEqual([{ value: null }, [null]]);
});
