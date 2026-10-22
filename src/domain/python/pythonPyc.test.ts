import { expect, it } from "vitest";
import {
  inspectPythonPycInputSchema,
  pythonPycMagicEntry,
  PYTHON_PYC_MAGIC_TABLE,
} from "./pythonPyc.js";

it("maps pinned CPython 3.7–3.13 magics and leaves gaps unknown", () => {
  expect(pythonPycMagicEntry(3394)).toEqual({
    python_version: "3.7",
    code_layout: "py37",
  });
  expect(pythonPycMagicEntry(3413)).toEqual({
    python_version: "3.8",
    code_layout: "py38",
  });
  expect(pythonPycMagicEntry(3531)).toEqual({
    python_version: "3.12",
    code_layout: "py311",
  });
  expect(pythonPycMagicEntry(3571)).toEqual({
    python_version: "3.13",
    code_layout: "py311",
  });
  expect(pythonPycMagicEntry(3450)).toBeNull();
  expect(pythonPycMagicEntry(62171)).toBeNull();
  expect(PYTHON_PYC_MAGIC_TABLE.size).toBeGreaterThan(80);
});

it("rejects extra inspect arguments", () => {
  expect(
    inspectPythonPycInputSchema.safeParse({
      path: "/artifacts/module.pyc",
      detail: "complete",
    }).success,
  ).toBe(false);
});
