import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { AnalysisResourceConstraintError } from "../domain/analysisErrorCore.js";
import {
  MAX_INSPECT_ERLANG_BEAM_TABLE_ROWS,
  inspectErlangBeamInputSchema,
} from "../domain/erlang/beam.js";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import {
  erlangBeamDeclaredRowsFixture,
  erlangBeamFixture,
  erlangBeamManyAtomsFixture,
  erlangBeamOtp29Fixture,
} from "./Beam.fixture.js";
import { BeamCapacityFailure, parseErlangBeam } from "./BeamParser.js";
import { BeamProvider } from "./BeamProvider.js";
import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";

const defaults = inspectErlangBeamInputSchema.parse({
  path: "/artifacts/app.beam",
});

const parse = (bytes: Buffer, input = defaults) =>
  parseErlangBeam(
    bytes,
    {
      path: input.path,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
    },
    input,
  );

it("reads atoms, exports, imports, lambdas and the Code header", () => {
  const report = parse(erlangBeamFixture("demo"));
  expect(report.atom_encoding).toBe("utf8");
  expect(report.module).toBe("demo");
  expect(report.atoms?.map((atom) => atom.name)).toEqual([
    "demo",
    "module_info",
    "start",
    "erlang",
    "get_module_info",
  ]);
  expect(report.exports).toEqual([
    { function_index: 3, function: "start", arity: 0, label: 2 },
    { function_index: 2, function: "module_info", arity: 0, label: 1 },
    { function_index: 2, function: "module_info", arity: 1, label: 3 },
  ]);
  expect(report.imports).toEqual([
    {
      module_index: 4,
      module: "erlang",
      function_index: 5,
      function: "get_module_info",
      arity: 1,
    },
  ]);
  expect(report.lambdas?.[0]).toMatchObject({
    function: "start",
    arity: 1,
    label: 4,
    old_unique: 42,
  });
  expect(report.code).toMatchObject({
    instruction_set: 0,
    opcode_max: 169,
    labels: 4,
    functions: 2,
    extra_header_bytes: 0,
    instructions: { bytes: 4 },
  });
  expect(report.chunks.map((chunk) => chunk.name)).toEqual([
    "AtU8",
    "Code",
    "ExpT",
    "ImpT",
    "FunT",
  ]);
});

// Expected values come from beam_lib:chunks/2 on the same file under OTP 29.
it("reads a compiler-produced OTP 29 BEAM with the compact atom table", () => {
  const report = parse(erlangBeamOtp29Fixture());
  expect(report.module).toBe("rea_beam_fixture");
  expect(report.atoms?.map((atom) => atom.name)).toEqual([
    "rea_beam_fixture",
    "hello",
    "lists",
    "reverse",
    "module_info",
    "erlang",
    "get_module_info",
  ]);
  expect(report.exports).toEqual([
    { function_index: 5, function: "module_info", arity: 1, label: 6 },
    { function_index: 5, function: "module_info", arity: 0, label: 4 },
    { function_index: 2, function: "hello", arity: 1, label: 2 },
  ]);
  expect(
    report.imports?.map((row) => [row.module, row.function, row.arity]),
  ).toEqual([
    ["lists", "reverse", 1],
    ["erlang", "get_module_info", 1],
    ["erlang", "get_module_info", 2],
  ]);
  expect(report.code).toMatchObject({
    instruction_set: 0,
    opcode_max: 181,
    labels: 7,
    functions: 3,
    extra_header_bytes: 0,
    instructions: { bytes: 49 },
  });
});

it("fails a truncated FOR1 container without partial success", () => {
  expect(() => parse(Buffer.from("FOR1"))).toThrow(ArtifactReaderFailure);
});

it("fails a FOR1 form that is not BEAM", () => {
  const bytes = Buffer.alloc(16);
  bytes.write("FOR1");
  bytes.writeUInt32BE(8, 4);
  bytes.write("WAVE", 8);
  expect(() => parse(bytes)).toThrow(ArtifactReaderFailure);
});

const singleChunkBeam = (name: string, payload: Buffer): Buffer => {
  const header = Buffer.alloc(8);
  header.write(name, 0, "latin1");
  header.writeUInt32BE(payload.length, 4);
  const pad = (4 - (payload.length % 4)) % 4;
  const form = Buffer.concat([
    Buffer.from("BEAM"),
    header,
    payload,
    Buffer.alloc(pad),
  ]);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(form.length);
  return Buffer.concat([Buffer.from("FOR1"), size, form]);
};

it("rejects a short remainder inside the BEAM form", () => {
  const bytes = Buffer.alloc(16);
  bytes.write("FOR1");
  bytes.writeUInt32BE(8, 4);
  bytes.write("BEAM", 8);
  expect(() => parse(bytes)).toThrow(/BEAM chunk header is truncated/);
});

it("rejects an AtU8 atom name that is not UTF-8", () => {
  expect(() =>
    parse(singleChunkBeam("AtU8", Buffer.from([0, 0, 0, 1, 1, 0xff]))),
  ).toThrow(/BEAM atom name is not valid UTF-8/);
});

it("keeps a latin1 atom byte unchanged", () => {
  const report = parse(
    singleChunkBeam("Atom", Buffer.from([0, 0, 0, 1, 1, 0xff])),
  );
  expect(report.atom_encoding).toBe("latin1");
  expect(report.module).toBe("ÿ");
});

it("rejects combined table rows before allocating them", () => {
  const below = Math.floor(MAX_INSPECT_ERLANG_BEAM_TABLE_ROWS / 2);
  const overflow = MAX_INSPECT_ERLANG_BEAM_TABLE_ROWS - below * 2 + 1;
  expect(() =>
    parse(
      erlangBeamDeclaredRowsFixture([
        ["ExpT", below],
        ["ImpT", below],
        ["FunT", overflow],
      ]),
    ),
  ).toThrow(
    expect.objectContaining({
      reason: "limit",
      boundary: "capacity",
      message: expect.stringContaining("row budget"),
    }),
  );
  const count = Buffer.alloc(4);
  count.writeUInt32BE(MAX_INSPECT_ERLANG_BEAM_TABLE_ROWS + 1);
  expect(() => parse(singleChunkBeam("ExpT", count))).toThrow(/row budget/);
  count.writeUInt32BE(MAX_INSPECT_ERLANG_BEAM_TABLE_ROWS);
  expect(() => parse(singleChunkBeam("ExpT", count))).toThrow(/truncated/);
});

it("fails when the atom budget is exhausted", () => {
  const bytes = erlangBeamManyAtomsFixture(3);
  expect(() =>
    parse(
      bytes,
      inspectErlangBeamInputSchema.parse({
        path: defaults.path,
        max_atoms: 1,
      }),
    ),
  ).toThrow(ArtifactReaderFailure);
});

it("does not infer a BEAM budget from diagnostic prose", async () => {
  const provider = new BeamProvider();
  const injection = vi
    .spyOn(ArtifactResourceScope.prototype, "run")
    .mockRejectedValueOnce(
      new ArtifactReaderFailure(
        "limit",
        "atom row budget wording from another boundary",
        { boundary: "capacity" },
      ),
    );
  try {
    const result = await provider.inspect(defaults);
    if (result.ok) throw new Error("Expected unknown capacity failure");
    expect(result.error).toBeInstanceOf(AnalysisResourceConstraintError);
    if (!(result.error instanceof AnalysisResourceConstraintError))
      throw new Error("Missing resource error");
    expect(result.error.retryable).toBeUndefined();
    expect(result.error.remediationAction).toBeUndefined();
  } finally {
    injection.mockRestore();
    await provider.close();
  }
});

it.each([
  {
    resource: "atoms",
    bytes: erlangBeamManyAtomsFixture(3),
    settings: { max_atoms: 1 },
    maximum: 1,
    remediation: "Raise max_atoms above 1",
  },
  {
    resource: "chunks",
    bytes: erlangBeamFixture(),
    settings: { max_chunks: 1 },
    maximum: 1,
    remediation: "Raise max_chunks above 1",
  },
  {
    resource: "table-rows",
    bytes: erlangBeamDeclaredRowsFixture([
      ["ExpT", MAX_INSPECT_ERLANG_BEAM_TABLE_ROWS + 1],
    ]),
    settings: {},
    maximum: MAX_INSPECT_ERLANG_BEAM_TABLE_ROWS,
    remediation: `${String(MAX_INSPECT_ERLANG_BEAM_TABLE_ROWS)}-row ceiling`,
  },
])(
  "retains the producing $resource allowance when diagnostic wording changes",
  async ({ resource, bytes, settings, maximum, remediation }) => {
    const input = inspectErlangBeamInputSchema.parse({
      path: defaults.path,
      ...settings,
    });
    let cause: unknown;
    try {
      parse(bytes, input);
    } catch (failure) {
      cause = failure;
    }
    expect(cause).toBeInstanceOf(BeamCapacityFailure);
    if (!(cause instanceof BeamCapacityFailure))
      throw new Error("Missing named parser allowance");
    expect(cause).toMatchObject({
      resource,
      maximum,
      reason: "limit",
      boundary: "capacity",
    });
    cause.message = "BEAM parser allowance exhausted.";
    const provider = new BeamProvider();
    const injection = vi
      .spyOn(ArtifactResourceScope.prototype, "run")
      .mockRejectedValueOnce(cause);
    try {
      const result = await provider.inspect(input);
      if (result.ok) throw new Error("Expected named capacity failure");
      expect(result.error).toMatchObject({
        _tag: "AnalysisResourceConstraintError",
        retryable: false,
        remediationAction: expect.stringContaining(remediation),
      });
    } finally {
      injection.mockRestore();
      await provider.close();
    }
  },
);
