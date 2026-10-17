import { describe, expect, it } from "vitest";
import { MAX_PLIST_DEPTH } from "./plistValue.js";
import { projectKeyedArchive } from "./keyedArchive.js";

const deepValue = (depth: number): unknown => {
  let value: unknown = 1;
  for (let index = 0; index < depth; index += 1) value = { nested: value };
  return value;
};

describe("projectKeyedArchive input bound", () => {
  it("rejects over-deep decoded input at the plist projection limit", () => {
    expect(() =>
      projectKeyedArchive(deepValue(MAX_PLIST_DEPTH + 1), {
        offset: 0,
        limit: 1,
      }),
    ).toThrow(`Plist exceeds ${String(MAX_PLIST_DEPTH)} nesting levels`);
  });
});

describe("projectKeyedArchive root reference projection", () => {
  it.each(["UID", "CF$UID"])(
    "preserves a sole scalar root named %s as a scalar with or without selection",
    (rootName) => {
      const archive = {
        $archiver: "NSKeyedArchiver",
        $objects: ["$null"],
        $top: { [rootName]: 1 },
      };

      for (const selection of [
        { offset: 0, limit: 1 },
        { root: rootName, offset: 0, limit: 1 },
      ]) {
        const result = projectKeyedArchive(archive, selection);
        expect(result.roots).toEqual({ [rootName]: 1 });
        expect(result.references).toEqual([]);
        expect(result.total_references).toBe(0);
      }
    },
  );

  it("retains real UID references under UID-shaped root names and paths", () => {
    const result = projectKeyedArchive(
      {
        $archiver: "NSKeyedArchiver",
        $objects: ["$null", "target"],
        $top: {
          UID: { CF$UID: 1 },
          CF$UID: { UID: 1 },
        },
      },
      { offset: 0, limit: 2 },
    );

    expect(result.references).toEqual([
      {
        source: null,
        path: ["CF$UID"],
        target: 1,
        raw: { UID: 1 },
        status: "resolved",
      },
      {
        source: null,
        path: ["UID"],
        target: 1,
        raw: { CF$UID: 1 },
        status: "resolved",
      },
    ]);
  });

  it("enforces one traversal budget across root values", () => {
    const values = Array.from({ length: 150_000 }, () => 0);
    expect(() =>
      projectKeyedArchive(
        {
          $archiver: "NSKeyedArchiver",
          $objects: ["$null"],
          $top: { first: values, second: values },
        },
        { offset: 0, limit: 1 },
      ),
    ).toThrow(RangeError);
  });
});
