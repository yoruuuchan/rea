import { expect, it } from "vitest";

import { projectPlistValue } from "./apple/plistValue.js";
import { UnknownPlistReal } from "./apple/plistNumbers.js";
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

it("decodes a signed integer zero as zero and a negative-zero real with its sign", () => {
  const parsed = parseXmlPropertyList(
    "<plist><array><integer>-0</integer><integer>-0<!-- partial --></integer><real>-0.0</real><real>0.0</real></array></plist>",
  );
  expect(Array.isArray(parsed.value)).toBe(true);
  if (!Array.isArray(parsed.value)) throw new Error("Expected array");
  expect(parsed.value.map((item) => Object.is(item, -0))).toEqual([
    false,
    false,
    true,
    false,
  ]);
  expect(parsed.value).toEqual([0, 0, -0, 0]);
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

it.each([
  ["nan", NaN],
  ["NaN", NaN],
  ["+infinity", Infinity],
  ["infinity", Infinity],
  ["INFINITY", Infinity],
  ["inf", Infinity],
  ["+inf", Infinity],
  ["-infinity", -Infinity],
  ["-Infinity", -Infinity],
  ["-inf", -Infinity],
  ["<![CDATA[-inf]]>", -Infinity],
] as const)(
  "retains the canonical non-finite real value for %s",
  (literal, expected) => {
    const parsed = parseXmlPropertyList(
      `<plist><real>${literal}</real></plist>`,
    );
    expect(parsed.value).toBe(expected);
    expect(parsed.numberLiterals.reals).toEqual(new Set([expected]));
    expect(parsed.numberLiterals.incomplete).toBe(false);
  },
);

it("keeps XML numeric overflow and unreadable text explicitly unknown", () => {
  const parsed = parseXmlPropertyList(
    "<plist><array><real>1e999</real><real>-1e999</real><real> nan </real><real>-nan</real><real>infinite</real></array></plist>",
  );
  expect(parsed.value).toEqual(
    Array.from({ length: 5 }, () => new UnknownPlistReal()),
  );
  expect(parsed.numberLiterals.incomplete).toBe(false);
});

it("does not infer a spelled real from incomplete numeric markup", () => {
  const parsed = parseXmlPropertyList(
    "<plist><real>-inf<!-- unsupported --></real></plist>",
  );
  expect(parsed.value).toBeInstanceOf(UnknownPlistReal);
  expect(parsed.numberLiterals.incomplete).toBe(true);
});

it.each([
  ["integer", "unreadable"],
  ["integer", `${"9".repeat(400)}invalid`],
  ["real", "1e999"],
  ["real", "-1e999"],
  ["real", "Infinitysuffix"],
  ["real", "nan<!-- unsupported -->"],
])("keeps unresolved <%s> numeric identity explicit", (tag, text) => {
  const parsed = parseXmlPropertyList(
    `<plist><${tag}>${text}</${tag}></plist>`,
  );
  expect(parsed.value).toBeInstanceOf(UnknownPlistReal);
  const projected = projectPlistValue(parsed.value);
  expect(projected.value).toEqual({ $plist_type: "real", value: null });
  expect(projected.unknownRealCount).toBe(1);
  expect(projected.nonFiniteRealCount).toBe(0);
});
