import { expect, it } from "vitest";
import { buildBinary } from "plist";
import {
  decodeBinaryPlistScalars,
  scanBinaryPlistScalars,
} from "../../artifacts/apple/PlistScalars.js";

import {
  parsePlistBinary,
  parsePlistJson,
  parsePlistXml,
  plistJsonNeedsNumberTypes,
} from "./plist.js";
import { estimateBinaryPlistExpansion } from "../../artifacts/apple/PropertyListDecodeBudget.js";
import {
  binaryPlistObjectTable,
  binaryPlistWithOverlappingDateAndData,
} from "../../../tests/fixtures/binaryPlistObjectTable.js";

const parseWithoutMutatingSource = (bytes: Buffer) => {
  const original = Buffer.from(bytes);
  const parsed = parsePlistBinary(bytes);
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw parsed.error;
  expect(bytes).toEqual(original);
  return parsed.value;
};

const binaryPlistWithNegativeZero = (): Buffer => {
  const bytes = Buffer.from(
    buildBinary({
      negative: -1.25,
      positive: 0,
      note: "a\u0001b",
      payload: Buffer.from([0]),
      fraction: new Date("2020-05-05T01:02:03.100Z"),
      whole: new Date("2020-05-05T01:02:03.000Z"),
      nel: "a\u0085b",
      ls: "a\u2028b",
      ps: "a\u2029b",
      largeInteger: 9007199254740992,
    }),
  );
  const negativeOneAndQuarter = Buffer.from([
    0x23, 0xbf, 0xf4, 0, 0, 0, 0, 0, 0,
  ]);
  const offset = bytes.indexOf(negativeOneAndQuarter);
  if (offset < 0) throw new Error("binary plist fixture lost its real");
  bytes.fill(0, offset + 1, offset + 9);
  bytes[offset + 1] = 0x80;
  const largeReal = Buffer.alloc(9);
  largeReal[0] = 0x23;
  largeReal.writeDoubleBE(9007199254740992, 1);
  const largeOffset = bytes.indexOf(largeReal);
  if (largeOffset < 0) throw new Error("binary plist fixture lost its integer");
  bytes[largeOffset] = 0x13;
  bytes.writeBigInt64BE(9007199254740992n, largeOffset + 1);
  return bytes;
};

const binaryDate = (secondsSince2001: number): Buffer => {
  const bytes = Buffer.from(
    buildBinary({ date: new Date("2001-01-01T00:00:00.000Z") }),
  );
  const metadata = scanBinaryPlistScalars(bytes);
  const date = metadata.dates[0];
  if (date === undefined) throw new Error("binary plist fixture lost its date");
  bytes.writeDoubleBE(secondsSince2001, date.payloadOffset);
  return bytes;
};

const binarySharedSubmillisecondDate = (): Buffer => {
  // Array object 0 references the same date object 1 twice.
  const bytes = Buffer.alloc(66);
  bytes[8] = 0xa2;
  bytes[9] = 1;
  bytes[10] = 1;
  bytes[11] = 0x33;
  bytes.writeDoubleBE(0.1005, 12);
  return binaryPlistObjectTable(bytes, [8, 11], 20);
};

const binaryWithUnreachableMalformedDate = (): Buffer => {
  const bytes = Buffer.alloc(54);
  bytes.set([0x52, 0x6f, 0x6b, 0x30], 8); // Root "ok"; unused malformed date.
  return binaryPlistObjectTable(bytes, [8, 11], 20);
};

const binaryWithReachableAndUnreachableDate = (): Buffer => {
  const bytes = Buffer.alloc(67);
  bytes.set([0xa1, 1, 0x33], 8);
  bytes.writeDoubleBE(0.1005, 11);
  bytes[19] = 0x30; // Unreachable malformed date marker.
  return binaryPlistObjectTable(bytes, [8, 10, 19], 20);
};

const binaryWithExactOverlappingDateAndNull = (): Buffer => {
  const bytes = Buffer.alloc(55);
  bytes.set([0xa2, 1, 2, 0x33], 8);
  bytes.writeDoubleBE(0, 12);
  return binaryPlistObjectTable(bytes, [8, 11, 18], 20);
};

const binaryWithDateInsideData = (): Buffer =>
  Buffer.from(
    "62706c6973743030a201024a00333fb9ba5e353f7cee080b0d0000000000000101000000000000000300000000000000000000000000000016",
    "hex",
  );

const binaryWithOverlappingAndIndependentDates = (): Buffer => {
  const bytes = Buffer.alloc(68);
  bytes.set([0xa3, 1, 2, 3, 0x4a, 0, 0x33], 8);
  bytes.writeDoubleBE(0.1005, 15);
  bytes.set([0x33], 23);
  bytes.writeDoubleBE(0.1, 24);
  return binaryPlistObjectTable(bytes, [8, 12, 14, 23], 32);
};

const binaryWithOverlappingIntegerDate = (): Buffer =>
  Buffer.from(
    "62706c6973743030a20102333fb999999999102a080b120000000000000101000000000000000300000000000000000000000000000014",
    "hex",
  );

const binaryWithSharedOverlappingDate = (): Buffer => {
  const bytes = Buffer.alloc(57);
  bytes.set([0xa3, 1, 2, 3, 0x33], 8);
  bytes.writeDoubleBE(0.1005, 13);
  bytes[20] = 0x40;
  return binaryPlistObjectTable(bytes, [8, 12, 12, 20], 21);
};

const binaryInt128 = (marker = 0x14): Buffer => {
  const bytes = Buffer.alloc(58);
  bytes[8] = marker;
  bytes.writeBigUInt64BE(0n, 9);
  bytes.writeBigUInt64BE(9007199254740993n, 17);
  bytes[25] = 8;
  return binaryPlistObjectTable(bytes, [8], 25);
};

const dateProjection = (secondsSince2001: number) => {
  const source = binaryDate(secondsSince2001);
  const metadata = scanBinaryPlistScalars(source);
  const datePlan = estimateBinaryPlistExpansion(source, 1024 * 1024, {
    numberProjection: true,
  });
  const decodedInput = decodeBinaryPlistScalars(source, metadata, datePlan);
  const parsed = parsePlistBinary(source);
  if (!parsed.ok) throw parsed.error;
  return { source, decodedInput, metadata, parsed: parsed.value };
};

it.each([
  [0, "2001-01-01T00:00:00.000Z"],
  [0.1, "2001-01-01T00:00:00.100Z"],
  [-0.1, "2000-12-31T23:59:59.900Z"],
  [
    (Date.parse("1900-01-01T00:00:00.900Z") -
      Date.parse("2001-01-01T00:00:00.000Z")) /
      1000,
    "1900-01-01T00:00:00.900Z",
  ],
])(
  "preserves binary dates exactly representable in milliseconds: %s",
  (seconds, iso) => {
    const result = dateProjection(seconds);
    expect(result.parsed.value).toEqual({
      date: { $plist_type: "date", iso8601: iso },
    });
    expect(result.decodedInput).toBe(result.source);
  },
);

it.each([0.1005, -0.1005, 0.0005])(
  "marks binary sub-millisecond source seconds unknown rather than rounding: %s",
  (seconds) => {
    const result = dateProjection(seconds);
    expect(result.metadata.dates[0]?.secondsSince2001).toBe(seconds);
    expect(result.decodedInput).not.toBe(result.source);
    expect(
      result.source.readDoubleBE(result.metadata.dates[0]!.payloadOffset),
    ).toBe(seconds);
    expect(result.parsed.value).toEqual({
      date: { $plist_type: "date", iso8601: null },
    });
    expect(result.parsed.limitations).toContainEqual(
      expect.stringContaining("date value(s)"),
    );
  },
);

it("keeps distinct source dates separate when they round to the same millisecond", () => {
  const bytes = Buffer.from(
    buildBinary([
      new Date("2001-01-01T00:00:00.100Z"),
      new Date("2001-01-01T00:00:00.100Z"),
    ]),
  );
  const metadata = scanBinaryPlistScalars(bytes);
  expect(metadata.dates).toHaveLength(2);
  bytes.writeDoubleBE(0.1005, metadata.dates[1]!.payloadOffset);
  const parsed = parsePlistBinary(bytes);
  if (!parsed.ok) throw parsed.error;
  expect(parsed.value.value).toEqual([
    { $plist_type: "date", iso8601: "2001-01-01T00:00:00.100Z" },
    { $plist_type: "date", iso8601: null },
  ]);
});

it("projects a shared sub-millisecond date reference as unknown at each use", () => {
  const source = binarySharedSubmillisecondDate();
  const metadata = scanBinaryPlistScalars(source);
  expect(metadata.dates).toHaveLength(1);
  expect(metadata.dates[0]?.secondsSince2001).toBe(0.1005);
  const parsed = parsePlistBinary(source);
  if (!parsed.ok) throw parsed.error;
  expect(parsed.value.value).toEqual([
    { $plist_type: "date", iso8601: null },
    { $plist_type: "date", iso8601: null },
  ]);
});

it("retains out-of-range date source seconds without rewriting them", () => {
  const result = dateProjection(1e20);
  expect(result.metadata.dates[0]?.secondsSince2001).toBe(1e20);
  expect(result.decodedInput).toBe(result.source);
  expect(result.parsed.value).toEqual({
    date: { $plist_type: "date", iso8601: null },
  });
});

it("does not treat a malformed date marker as a valid date scalar", () => {
  const bytes = binaryDate(0.1005);
  const valid = scanBinaryPlistScalars(bytes);
  bytes[valid.dates[0]!.offset] = 0x30;
  const metadata = scanBinaryPlistScalars(bytes);
  expect(metadata.literals.incomplete).toBe(true);
  expect(metadata.dates).toEqual([]);
  expect(
    decodeBinaryPlistScalars(bytes, metadata, {
      reachableDateOffsets: [],
      overlappingDateOffsets: [],
      reachableWideIntegerOffsets: [],
      overlappingWideIntegerOffsets: [],
      reachableNumericOffsets: [],
    }),
  ).toBe(bytes);
});

it("rejects a reachable date with a malformed marker", () => {
  const bytes = binaryDate(0.1);
  const date = scanBinaryPlistScalars(bytes).dates[0];
  if (date === undefined) throw new Error("binary plist fixture lost its date");
  bytes[date.offset] = 0x30;

  const parsed = parsePlistBinary(bytes);

  expect(parsed.ok).toBe(false);
  if (parsed.ok) throw new Error("Expected malformed reachable date rejection");
  expect(parsed.error.message).toContain("date marker 0x30 is invalid");
});

it("does not reject an unreachable malformed date object as a decoded value", () => {
  const parsed = parsePlistBinary(binaryWithUnreachableMalformedDate());

  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw parsed.error;
  expect(parsed.value.value).toBe("ok");
  expect(parsed.value.limitations).toContainEqual(
    expect.stringContaining("number metadata could not be completely observed"),
  );
});

it("keeps reachable date uncertainty when another object is malformed", () => {
  const parsed = parsePlistBinary(binaryWithReachableAndUnreachableDate());

  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw parsed.error;
  expect(parsed.value.value).toEqual([{ $plist_type: "date", iso8601: null }]);
  expect(parsed.value.limitations).toContainEqual(
    expect.stringContaining("number metadata could not be completely observed"),
  );
});

it("retains reachable date source facts when an unreachable offset is invalid", () => {
  const bytes = binaryWithReachableAndUnreachableDate();
  bytes[22] = 0xff;
  const metadata = scanBinaryPlistScalars(bytes);
  const parsed = parsePlistBinary(bytes);

  expect(metadata.dates).toHaveLength(1);
  expect(metadata.dates[0]?.secondsSince2001).toBe(0.1005);
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw parsed.error;
  expect(parsed.value.value).toEqual([{ $plist_type: "date", iso8601: null }]);
  expect(parsed.value.limitations).toContainEqual(
    expect.stringContaining("number metadata could not be completely observed"),
  );
});

it("does not rewrite shared bytes when a reachable date overlaps another object", () => {
  const bytes = binaryPlistWithOverlappingDateAndData();
  const parsed = parseWithoutMutatingSource(bytes);

  expect(parsed.value).toEqual([
    { $plist_type: "date", iso8601: null },
    { $plist_type: "data", base64: "" },
  ]);
  expect(parsed.limitations).toContainEqual(
    expect.stringContaining("sub-millisecond source records overlap"),
  );
});

it("keeps an exactly millisecond-representable overlapping date known", () => {
  const parsed = parsePlistBinary(binaryWithExactOverlappingDateAndNull());

  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw parsed.error;
  expect(parsed.value.value).toEqual([
    { $plist_type: "date", iso8601: "2001-01-01T00:00:00.000Z" },
    null,
  ]);
  expect(parsed.value.limitations).not.toContainEqual(
    expect.stringContaining("sub-millisecond source records overlap"),
  );
});

it("keeps a date unknown when its start is inside another reachable payload", () => {
  const bytes = binaryWithDateInsideData();
  const parsed = parseWithoutMutatingSource(bytes);

  expect(parsed.value).toEqual([
    { $plist_type: "data", base64: "ADM/ubpeNT987g==" },
    { $plist_type: "date", iso8601: null },
  ]);
  expect(parsed.limitations).toContainEqual(
    expect.stringContaining("sub-millisecond source records overlap"),
  );
});

it("isolates an overlapping date without losing an independent date", () => {
  const parsed = parsePlistBinary(binaryWithOverlappingAndIndependentDates());

  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw parsed.error;
  expect(parsed.value.value).toEqual([
    { $plist_type: "data", base64: "ADM/ubpeNT987g==" },
    { $plist_type: "date", iso8601: null },
    { $plist_type: "date", iso8601: "2001-01-01T00:00:00.100Z" },
  ]);
  expect(parsed.value.limitations).toContainEqual(
    expect.stringContaining("sub-millisecond source records overlap"),
  );
});

it("retains the integer sibling of a sub-millisecond overlapping date", () => {
  const bytes = binaryWithOverlappingIntegerDate();
  const parsed = parseWithoutMutatingSource(bytes);

  expect(parsed.value).toEqual([{ $plist_type: "date", iso8601: null }, 42]);
  expect(parsed.limitations).toContainEqual(
    expect.stringContaining("sub-millisecond source records overlap"),
  );
});

it("isolates a shared overlapping date once while preserving both references", () => {
  const parsed = parsePlistBinary(binaryWithSharedOverlappingDate());

  if (!parsed.ok) throw parsed.error;
  expect(parsed.value.value).toEqual([
    { $plist_type: "date", iso8601: null },
    { $plist_type: "date", iso8601: null },
    { $plist_type: "data", base64: "" },
  ]);
  expect(parsed.value.limitations).toContainEqual(
    expect.stringContaining(
      "2 date value(s) are reported with unknown timestamps",
    ),
  );
});

it("preserves valid 16-byte integers while rejecting unsupported numeric markers", () => {
  const parsed = parsePlistBinary(binaryInt128());
  if (!parsed.ok) throw parsed.error;
  expect(parsed.value.value).toEqual({
    $plist_type: "integer",
    decimal: "9007199254740993",
  });

  for (const [marker, message] of [
    [0x15, "integer width is invalid"],
    [0x20, "real width is invalid"],
    [0x24, "real width is invalid"],
  ] as const) {
    const rejected = parsePlistBinary(binaryInt128(marker));
    expect(rejected.ok).toBe(false);
    if (rejected.ok)
      throw new Error("Expected unsupported numeric marker rejection");
    expect(rejected.error.message).toContain(message);
  }
});

it("keeps binary plist source values lost by XML conversion", () => {
  const parsed = parsePlistBinary(binaryPlistWithNegativeZero());
  if (!parsed.ok) throw parsed.error;
  expect(parsed.value.value).toEqual({
    negative: { $plist_type: "real", value: "-0" },
    positive: 0,
    note: "a\u0001b",
    payload: { $plist_type: "data", base64: "AA==" },
    fraction: { $plist_type: "date", iso8601: "2020-05-05T01:02:03.100Z" },
    whole: { $plist_type: "date", iso8601: "2020-05-05T01:02:03.000Z" },
    nel: "a\u0085b",
    ls: "a\u2028b",
    ps: "a\u2029b",
    largeInteger: { $plist_type: "integer", decimal: "9007199254740992" },
  });
  expect(parsed.value.limitations).toContain(
    '1 negative-zero real value(s) are reported as { "$plist_type": "real", "value": "-0" } because a JSON number cannot carry the sign of zero.',
  );
  expect(parsed.value.limitations).toContainEqual(
    expect.stringContaining("1 observed integer literal(s)"),
  );
  expect(parsed.value.limitations).toContainEqual(
    expect.stringContaining("1 unambiguous integer value(s)"),
  );
});

it("rejects a truncated binary plist source", () => {
  const parsed = parsePlistBinary(Buffer.from("bplist00bad"));
  expect(parsed.ok).toBe(false);
  if (parsed.ok) throw new Error("Expected malformed binary plist");
  expect(parsed.error.message).toContain("trailer is truncated");
});

it("retains complete segmented XML keys in native plist fallback evidence", () => {
  const parsed = parsePlistXml(
    "<plist><dict><key>user<![CDATA[ID]]></key><integer>42</integer><key>__pro<![CDATA[to__]]></key><string>omitted</string><key>Blob</key><data>AA==</data></dict></plist>",
  );
  if (!parsed.ok) throw parsed.error;
  expect(parsed.value.value).toEqual({
    userID: 42,
    Blob: { $plist_type: "data", base64: "AA==" },
  });
  expect(parsed.value.limitations).toContain(
    "1 dictionary entry keyed __proto__ was omitted because REA results cannot represent that key.",
  );
});

it("does not relabel integral CDATA reals as integers in native JSON or XML evidence", () => {
  const xml =
    "<plist><dict><key>integer</key><integer>9007199254740992</integer><key>real</key><real>9007199254<![CDATA[740992]]></real></dict></plist>";
  for (const parsed of [
    parsePlistJson('{"integer":9007199254740992,"real":9007199254740992}', xml),
    parsePlistXml(xml),
  ]) {
    if (!parsed.ok) throw parsed.error;
    expect(parsed.value.value).toEqual({
      integer: 9007199254740992,
      real: 9007199254740992,
    });
    expect(parsed.value.limitations).toContainEqual(
      expect.stringContaining("2 number(s)"),
    );
  }
});

it("keeps exact decimal text for JSON integers that XML shows are integers", () => {
  const parsed = parsePlistJson(
    '{"Max":18446744073709551615,"Min":-9223372036854775808,"Near":9007199254740993,"Edge":9007199254740992,"Safe":9007199254740991,"Real":1e21,"Ratio":0.5}',
    [
      "<plist><dict>",
      "<key>Max</key><integer>18446744073709551615</integer>",
      "<key>Min</key><integer>-9223372036854775808</integer>",
      "<key>Near</key><integer>9007199254740993</integer>",
      "<key>Edge</key><integer>9007199254740992</integer>",
      "<key>Safe</key><integer>9007199254740991</integer>",
      "<key>Real</key><real>1e+21</real>",
      "<key>Ratio</key><real>0.5</real>",
      "</dict></plist>",
    ].join(""),
  );
  if (!parsed.ok) throw new Error("expected plist JSON to parse");
  // JSON keeps each literal's digits, so integers that round to the same
  // number stay distinct.
  expect(parsed.value.value).toEqual({
    Max: { $plist_type: "integer", decimal: "18446744073709551615" },
    Min: { $plist_type: "integer", decimal: "-9223372036854775808" },
    Near: { $plist_type: "integer", decimal: "9007199254740993" },
    Edge: { $plist_type: "integer", decimal: "9007199254740992" },
    Safe: 9007199254740991,
    Real: 1e21,
    Ratio: 0.5,
  });
  expect(parsed.value.limitations).toEqual([
    expect.stringContaining("4 integer value(s)"),
  ]);
});

it("keeps integral JSON reals beyond the safe range as reals", () => {
  const output = '{"Real":9007199254740992,"Large":100000000000000000000}';
  expect(plistJsonNeedsNumberTypes(output)).toBe(true);
  const parsed = parsePlistJson(
    output,
    "<plist><dict><key>Real</key><real>9007199254740992</real><key>Large</key><real>1e+20</real></dict></plist>",
  );
  if (!parsed.ok) throw new Error("expected plist JSON to parse");
  expect(parsed.value.value).toEqual({ Real: 9007199254740992, Large: 1e20 });
  expect(parsed.value.limitations).toEqual([]);
});

it.each([
  ["without element types", undefined],
  [
    "when an integer and a real decode alike",
    "<plist><array><integer>9007199254740992</integer><real>9007199254740992</real></array></plist>",
  ],
])("does not label an unsafe JSON number an integer %s", (_case, xml) => {
  const parsed = parsePlistJson("[9007199254740992,9007199254740992]", xml);
  if (!parsed.ok) throw new Error("expected plist JSON to parse");
  expect(parsed.value.value).toEqual([9007199254740992, 9007199254740992]);
  expect(parsed.value.limitations).toEqual([
    expect.stringContaining("2 number(s)"),
  ]);
});

it("requests element types only for unsafe integral JSON numbers", () => {
  expect(
    plistJsonNeedsNumberTypes(
      '{"Safe":9007199254740991,"Real":1e21,"Text":"9007199254740993"}',
    ),
  ).toBe(false);
  expect(plistJsonNeedsNumberTypes("{")).toBe(false);
});

it("reports no limitation when every JSON integer is exact", () => {
  const parsed = parsePlistJson('{"Count":42,"Nested":[-1,0]}');
  if (!parsed.ok) throw new Error("expected plist JSON to parse");
  expect(parsed.value.value).toEqual({ Count: 42, Nested: [-1, 0] });
  expect(parsed.value.limitations).toEqual([]);
});

it("recovers exact XML integers from their element literals", () => {
  const parsed = parsePlistXml(
    "<plist><dict><key>Max</key><integer>18446744073709551615</integer><key>Safe</key><integer>7</integer><key>Blob</key><data>AA==</data></dict></plist>",
  );
  if (!parsed.ok) throw new Error("expected plist XML to parse");
  expect(parsed.value.value).toEqual({
    Max: { $plist_type: "integer", decimal: "18446744073709551615" },
    Safe: 7,
    Blob: { $plist_type: "data", base64: "AA==" },
  });
  expect(parsed.value.limitations).toEqual([
    expect.stringContaining("XML conversion"),
    expect.stringContaining("1 integer value(s)"),
  ]);
});

it("keeps integral XML reals beyond the safe range as reals", () => {
  const parsed = parsePlistXml(
    "<plist><dict><key>Real</key><real>9007199254740992</real><key>Blob</key><data>AA==</data></dict></plist>",
  );
  if (!parsed.ok) throw new Error("expected plist XML to parse");
  expect(parsed.value.value).toEqual({
    Real: 9007199254740992,
    Blob: { $plist_type: "data", base64: "AA==" },
  });
  expect(parsed.value.limitations).toEqual([
    expect.stringContaining("XML conversion"),
  ]);
});

it("keeps negative-zero reals distinct in native JSON and XML evidence", () => {
  for (const parsed of [
    parsePlistJson(
      '{"Negative":-0.0,"Spelled":-0,"Positive":0.0,"Integer":0,"Ratio":1.25}',
    ),
    parsePlistXml(
      "<plist><dict><key>Negative</key><real>-0.0</real><key>Spelled</key><real>-0</real><key>Positive</key><real>0.0</real><key>Integer</key><integer>-0</integer><key>Ratio</key><real>1.25</real></dict></plist>",
    ),
  ]) {
    if (!parsed.ok) throw parsed.error;
    expect(JSON.stringify(parsed.value.value)).toBe(
      '{"Negative":{"$plist_type":"real","value":"-0"},"Spelled":{"$plist_type":"real","value":"-0"},"Positive":0,"Integer":0,"Ratio":1.25}',
    );
    expect(parsed.value.limitations).toContain(
      '2 negative-zero real value(s) are reported as { "$plist_type": "real", "value": "-0" } because a JSON number cannot carry the sign of zero.',
    );
  }
});

it("reports no negative-zero limitation for positive zero", () => {
  const parsed = parsePlistJson('{"Positive":0.0,"Integer":0}');
  if (!parsed.ok) throw parsed.error;
  expect(parsed.value.limitations).toEqual([]);
});

it("reports XML numbers whose integer or real origin is ambiguous", () => {
  const parsed = parsePlistXml(
    "<plist><array><integer>9007199254740993</integer><real>9007199254740992</real><data>AA==</data></array></plist>",
  );
  if (!parsed.ok) throw new Error("expected plist XML to parse");
  expect(parsed.value.value).toEqual([
    9007199254740992,
    9007199254740992,
    { $plist_type: "data", base64: "AA==" },
  ]);
  expect(parsed.value.limitations).toEqual([
    expect.stringContaining("XML conversion"),
    expect.stringContaining("2 number(s)"),
  ]);
});

it("keeps CFPropertyList's non-finite real spellings in XML evidence", () => {
  const parsed = parsePlistXml(
    "<plist><dict><key>Up</key><real>+infinity</real><key>Down</key><real>-INFINITY</real><key>Missing</key><real>nan</real><key>Overflow</key><real>1e999</real><key>Ratio</key><real>1.25</real></dict></plist>",
  );
  if (!parsed.ok) throw parsed.error;
  expect(JSON.stringify(parsed.value.value)).toBe(
    '{"Up":{"$plist_type":"real","value":"+infinity"},"Down":{"$plist_type":"real","value":"-infinity"},"Missing":{"$plist_type":"real","value":"nan"},"Overflow":{"$plist_type":"unknown","element":"real","literal":"1e999","reason":"unrepresentable"},"Ratio":1.25}',
  );
  expect(parsed.value.limitations).toEqual([
    expect.stringContaining("XML conversion"),
    '3 non-finite real value(s) are reported as { "$plist_type": "real", "value": "<spelling>" } using canonical numeric labels nan, +infinity or -infinity because a JSON number cannot carry them.',
    expect.stringContaining("1 XML scalar value(s) could not be established"),
  ]);
});
