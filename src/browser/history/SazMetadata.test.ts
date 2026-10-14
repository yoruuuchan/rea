import { expect, it } from "vitest";
import { CaptureFormatError } from "./CaptureFormatError.js";
import { decodeSazMetadata } from "./SazMetadata.js";

it("retains U+FFFD in well-formed metadata as an ordinary XML character", () => {
  const decoded = JSON.stringify(
    decodeSazMetadata(
      Buffer.from(
        '<Session><SessionFlag N="ui-comments" V="caf�"/>�</Session>',
      ),
    ),
  );
  expect(decoded).toContain('{"name":"V","value":"caf�"}');
  expect(decoded).toContain('"value":"�"');
});

it.each([
  "<Session>a & b</Session>",
  "<Session>a\u0000b</Session>",
  "<Session>&#xD800;</Session>",
  "<Session a=1>�</Session>",
  '<Session a="x"b="�"/>',
  "<Session><Broken>�</Session>",
])("still rejects malformed metadata that also contains U+FFFD: %j", (xml) => {
  expect(() => decodeSazMetadata(Buffer.from(xml))).toThrow(
    "SAZ metadata is not well-formed XML.",
  );
});

it("preserves valid comments, CDATA, declarations, and predefined entities", () => {
  const xml =
    '<?xml version="1.0"?><Session><!-- note & literal --><Value>A &amp; B</Value><C><![CDATA[C & D]]></C></Session>';
  const decoded = JSON.stringify(decodeSazMetadata(Buffer.from(xml)));
  expect(decoded).toContain("note & literal");
  expect(decoded).toContain("A & B");
  expect(decoded).toContain("C & D");
});

it("rejects DTDs without resolving entities", () => {
  expect(() =>
    decodeSazMetadata(
      Buffer.from('<!DOCTYPE Session [<!ENTITY value "external">]><Session/>'),
    ),
  ).toThrow(
    expect.objectContaining({
      reason: "unsupported",
    } satisfies Partial<CaptureFormatError>),
  );
});
