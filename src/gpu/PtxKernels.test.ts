import { expect, it } from "vitest";
import { readPtxKernels, readPtxTarget } from "./PtxKernels.js";
it("recognizes directives outside comments and strings and preserves UTF-8 byte coordinates", () => {
  expect(readPtxTarget('".version 8.8\n.target sm_80\n"')).toBeNull();
  const prefix = "// 雪 .entry fake() {}\n.version 8.8\n.target sm_80\n";
  const text =
    prefix + ".visible .entry real(.param .u64 x) { .reg .b32 %r<3>; ret; }";
  expect(readPtxTarget(text)).toBe("sm_80");
  const rows = [...readPtxKernels(text, "object")];
  expect(rows).toHaveLength(1);
  expect(rows[0]!.coverage).toBe("complete");
  expect(rows[0]!.kernel.location.offset).toBe(
    Buffer.byteLength(prefix + ".visible "),
  );
  expect(rows[0]!.kernel.registers.virtual).toEqual([
    { type: ".b32", count: 3 },
  ]);
});
it("derives vector/array parameter declarations and leaves unknown qualifiers unresolved", () => {
  const rows = [
    ...readPtxKernels(
      ".entry k(.param .v2 .u32 x, .param .align 16 .b8 a[32], .param .u64 .ptr .global y) {ret;}",
      "object",
    ),
  ];
  expect(
    rows[0]!.kernel.parameters.map(({ offset, size }) => [offset, size]),
  ).toEqual([
    [0, 8],
    [16, 32],
    [null, null],
  ]);
  expect(rows[0]!.kernel.parameter_bytes).toBeNull();
  expect(rows[0]!.coverage).toBe("partial");
  expect(rows[0]!.kernel.limitations.join(" ")).toContain(
    "parameter declarations",
  );
  expect(rows[0]!.kernel.parameter_count).toBe(3);
});
it("keeps dynamic and compound shared declarations unknown", () => {
  const [row] = [
    ...readPtxKernels(
      ".entry k() {.shared .u32 a,b; .shared .b8 dynamic[]; ret;}",
      "object",
    ),
  ];
  expect(row!.kernel.shared_bytes).toBeNull();
  expect(row!.coverage).toBe("partial");
  expect(row!.kernel.representation).toBe("ptx-declarations");
});
it("sums bare names and every register range while preserving unsupported totals as unknown", () => {
  const [row] = [
    ...readPtxKernels(
      ".entry k() { .reg .b32 r0, r1; .reg .b32 %r<4>, %s<8>; .reg .u32 %x; .reg .u32 unsupported[2]; .reg .u32 %y; .reg .pred p, %p<2>; ret; }",
      "object",
    ),
  ];
  expect(row!.kernel.registers.virtual).toEqual([
    { type: ".b32", count: 14 },
    { type: ".u32", count: null },
    { type: ".pred", count: 3 },
  ]);
  expect(row!.kernel.limitations.join(" ")).toContain("count unknown");
});
it("does not round overflowing register totals or accept truncated ranges", () => {
  for (const declaration of [
    "%r<9007199254740991>, %s",
    "%r<4",
    "%r<0>",
    "%r,",
  ]) {
    const [row] = [
      ...readPtxKernels(
        `.entry k() { .reg .b32 ${declaration}; ret; }`,
        "object",
      ),
    ];
    expect(row!.kernel.registers.virtual).toEqual([
      { type: ".b32", count: null },
    ]);
  }
});
it.each([
  "/* unfinished",
  ".entry broken(",
  ".entry k() {",
  ".entry k() {.reg .u32 %x}",
  ".entry k() {.reg %x;}",
])("rejects incomplete PTX %s", (text) => {
  expect(() => [...readPtxKernels(text, "object")]).toThrow();
});

it("does not label unrelated malformed quoted text as a recognized PTX artifact", () => {
  expect(readPtxTarget('unrelated "unterminated')).toBeNull();
  expect(readPtxTarget("/* unrelated unterminated")).toBeNull();
});
