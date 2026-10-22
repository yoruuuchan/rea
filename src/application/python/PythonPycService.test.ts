import { expect, it } from "vitest";
import {
  AnalysisInputError,
  AnalysisCancelledError,
} from "../../domain/analysisErrorCore.js";
import type { PythonPyc } from "../../domain/python/pythonPyc.js";
import { ok } from "../../domain/result.js";
import { PythonPycService } from "./PythonPycService.js";

const identity = {
  id: "fixture-python-pyc",
  name: "Source-owned pyc reader seam",
  version: "1",
};

const report: PythonPyc = {
  artifact: {
    path: "/artifacts/sample.pyc",
    sha256: "a".repeat(64),
    bytes: 64,
  },
  header: {
    magic: 3531,
    python_version: "3.12",
    code_layout: "py311",
    flags: 0,
    hash_based: false,
    check_source: false,
    source_hash_hex: null,
    source_mtime: 1,
    source_size: 10,
  },
  code_objects: [
    {
      name: "<module>",
      qualname: "<module>",
      filename: "sample.py",
      firstlineno: 1,
      argcount: 0,
      posonlyargcount: 0,
      kwonlyargcount: 0,
      nlocals: null,
      stacksize: 1,
      flags: 0,
      names: [],
      varnames: null,
      freevars: null,
      cellvars: null,
      localsplusnames: [],
      localspluskinds_hex: "",
      bytecode: { bytes: 2, sha256: "b".repeat(64) },
      consts: [{ kind: "none" }],
      nested_code: [],
    },
  ],
  coverage: {
    status: "complete",
    objects: 4,
    code_objects: 1,
    marshal_bytes: 48,
    marshal_depth: 1,
  },
  limitations: [
    "Bytecode is retained as length and SHA-256 only; this workflow does not decompile, disassemble, or recover source.",
  ],
};

it("rejects a relative path and extra arguments before reading", async () => {
  let calls = 0;
  const service = new PythonPycService({
    identity,
    inspect: () => {
      calls += 1;
      return Promise.resolve(ok(report));
    },
  });
  const relative = await service.inspect({ path: "sample.pyc" });
  const extra = await service.inspect({
    path: report.artifact.path,
    detail: "complete",
  });
  expect(relative.ok).toBe(false);
  expect(extra.ok).toBe(false);
  if (!relative.ok) expect(relative.error).toBeInstanceOf(AnalysisInputError);
  if (!extra.ok) expect(extra.error).toBeInstanceOf(AnalysisInputError);
  expect(calls).toBe(0);
});

it("records the selected artifact and the header plus marshal ranges", async () => {
  const result = await new PythonPycService({
    identity,
    inspect: () => Promise.resolve(ok(report)),
  }).inspect({ path: report.artifact.path });
  expect(result.ok).toBe(true);
  if (!result.ok) throw result.error;
  expect(result.value).toMatchObject({
    confidence: "observed",
    subject: { format: "file" },
    normalized_result: report,
  });
  expect(result.value.locations).toEqual([
    { kind: "artifact-path", path: report.artifact.path },
    { kind: "file-offset-range", start: 0, end: 16 },
    { kind: "file-offset-range", start: 16, end: report.artifact.bytes },
  ]);
});

it("discards an observation if the caller cancels while the provider completes", async () => {
  const controller = new AbortController();
  const service = new PythonPycService({
    identity,
    inspect: () => {
      controller.abort();
      return Promise.resolve(ok(report));
    },
  });
  const result = await service.inspect(
    { path: report.artifact.path },
    { signal: controller.signal },
  );
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toBeInstanceOf(AnalysisCancelledError);
});
