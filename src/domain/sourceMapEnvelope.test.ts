import { describe, expect, it } from "vitest";

import { flattenSourceMapLeaves } from "./sourceMapEnvelope.js";

const leaf = {
  version: 3,
  mappings: "AAAA",
  sources: ["app.ts"],
  names: [],
};

describe("source-map envelope walk", () => {
  it("collects indexed section leaves without interpreting generated offsets", () => {
    const root = {
      version: 3,
      sections: [
        { offset: { line: 0, column: 0 }, map: leaf },
        { offset: { line: 10, column: 0 }, map: { ...leaf, sources: [] } },
      ],
    };
    expect(flattenSourceMapLeaves(root)).toHaveLength(2);
  });

  it("rejects sections without embedded maps", () => {
    const missing = {
      version: 3,
      sections: [{ offset: { line: 0, column: 0 } }],
    };
    expect(flattenSourceMapLeaves(missing)).toBeUndefined();
  });

  it("rejects non-version-3 roots and nested maps", () => {
    expect(flattenSourceMapLeaves({ version: 3 })).toHaveLength(1);
    expect(flattenSourceMapLeaves(null)).toBeUndefined();
    expect(flattenSourceMapLeaves([{ version: 3 }])).toBeUndefined();
    expect(
      flattenSourceMapLeaves({ version: 2, mappings: "AAAA" }),
    ).toBeUndefined();
    expect(flattenSourceMapLeaves({ mappings: "AAAA" })).toBeUndefined();
    expect(
      flattenSourceMapLeaves({
        version: 3,
        sections: [{ offset: { line: 0, column: 0 }, map: { version: 2 } }],
      }),
    ).toBeUndefined();
  });
});
