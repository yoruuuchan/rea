import { isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import {
  MAX_INSPECT_ERLANG_BEAM_TABLE_ROWS,
  type ErlangBeam,
  type InspectErlangBeamInput,
} from "../domain/erlang/beam.js";

/** The producing parser names its count allowance independently of diagnostic text. */
export class BeamCapacityFailure extends ArtifactReaderFailure {
  constructor(
    readonly resource: "atoms" | "chunks" | "table-rows",
    readonly maximum: number,
    message: string,
  ) {
    super("limit", message, { boundary: "capacity" });
    this.name = "BeamCapacityFailure";
  }
}

const fail = (message: string): never => {
  throw new ArtifactReaderFailure("format", message);
};

const sha256 = (bytes: Buffer): string =>
  createHash("sha256").update(bytes).digest("hex");

const LIMITATIONS = [
  "This workflow does not execute BEAM bytecode, inflate LitT literals, or decode Attr/CInf external-term payloads.",
  "Atom names are structural table entries; they do not authenticate the originating compiler or module checksum.",
] as const;

const requireRange = (bytes: Buffer, offset: number, length: number): void => {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset > bytes.length - length
  )
    fail(
      `BEAM range ${String(offset)} + ${String(length)} leaves the artifact.`,
    );
};

const u32 = (bytes: Buffer, offset: number): number => {
  requireRange(bytes, offset, 4);
  return bytes.readUInt32BE(offset);
};

const chunkName = (bytes: Buffer, offset: number): string => {
  requireRange(bytes, offset, 4);
  return bytes.subarray(offset, offset + 4).toString("latin1");
};

const atomAt = (
  atoms: readonly { index: number; name: string }[] | null,
  index: number,
): string | null => {
  if (atoms === null || index < 1) return null;
  return atoms[index - 1]?.name ?? null;
};

/** Reads an atom length: one byte, or OTP 28+ compact `u` tag when compact. */
const atomLength = (
  payload: Buffer,
  at: number,
  compact: boolean,
): [length: number, next: number] => {
  if (at >= payload.length) fail("BEAM atom table is truncated.");
  const first = payload[at]!;
  if (!compact) return [first, at + 1];
  if ((first & 0x07) !== 0) fail("BEAM atom length is not a u tag.");
  if ((first & 0x08) === 0) return [first >> 4, at + 1];
  if ((first & 0x10) !== 0) fail("BEAM atom length encoding is unsupported.");
  if (at + 1 >= payload.length) fail("BEAM atom table is truncated.");
  return [((first & 0xe0) << 3) | payload[at + 1]!, at + 2];
};

const parseAtoms = (
  payload: Buffer,
  maxAtoms: number,
  encoding: "latin1" | "utf8",
): ErlangBeam["atoms"] => {
  if (payload.length < 4) fail("BEAM atom table is truncated.");
  // OTP 28+ writes a negated count and compact-encoded name lengths.
  const declared = payload.readInt32BE(0);
  const compact = declared < 0;
  const count = Math.abs(declared);
  if (count > maxAtoms)
    throw new BeamCapacityFailure(
      "atoms",
      maxAtoms,
      `BEAM atom table exceeds the ${String(maxAtoms)}-atom budget.`,
    );
  const atoms: NonNullable<ErlangBeam["atoms"]> = [];
  let at = 4;
  for (let index = 1; index <= count; index += 1) {
    const [length, next] = atomLength(payload, at, compact);
    at = next;
    requireRange(payload, at, length);
    const nameBytes = payload.subarray(at, at + length);
    if (encoding === "utf8" && !isUtf8(nameBytes))
      fail("BEAM atom name is not valid UTF-8.");
    atoms.push({
      index,
      name: nameBytes.toString(encoding),
    });
    at += length;
  }
  if (at > payload.length) fail("BEAM atom table is truncated.");
  return atoms;
};

const parseRows = (
  payload: Buffer,
  width: number,
  label: string,
): number[][] => {
  if (payload.length < 4) fail(`BEAM ${label} table is truncated.`);
  const count = u32(payload, 0);
  const need = 4 + count * width * 4;
  if (payload.length < need) fail(`BEAM ${label} table is truncated.`);
  const rows: number[][] = [];
  for (let index = 0; index < count; index += 1) {
    const row: number[] = [];
    const start = 4 + index * width * 4;
    for (let field = 0; field < width; field += 1)
      row.push(u32(payload, start + field * 4));
    rows.push(row);
  }
  return rows;
};

const parseCode = (
  payload: Buffer,
  chunkOffset: number,
): NonNullable<ErlangBeam["code"]> => {
  if (payload.length < 20) fail("BEAM Code chunk is truncated.");
  const infoSize = u32(payload, 0);
  if (infoSize < 16 || infoSize > payload.length - 4)
    fail("BEAM Code header size is invalid.");
  const instructionsOffset = 4 + infoSize;
  return {
    instruction_set: u32(payload, 4),
    opcode_max: u32(payload, 8),
    labels: u32(payload, 12),
    functions: u32(payload, 16),
    extra_header_bytes: infoSize - 16,
    instructions: {
      offset: chunkOffset + 8 + instructionsOffset,
      bytes: payload.length - instructionsOffset,
    },
  };
};

/** Decode one FOR1/BEAM IFF container into bounded chunk and table facts. */
export const parseErlangBeam = (
  bytes: Buffer,
  artifact: ErlangBeam["artifact"],
  input: InspectErlangBeamInput,
): ErlangBeam => {
  requireRange(bytes, 0, 12);
  if (bytes.subarray(0, 4).toString("latin1") !== "FOR1")
    fail("Expected a FOR1 IFF container.");
  const formSize = u32(bytes, 4);
  if (formSize < 4) fail("BEAM form size is shorter than the BEAM tag.");
  requireRange(bytes, 8, formSize);
  if (bytes.subarray(8, 12).toString("latin1") !== "BEAM")
    fail("Expected a BEAM form type.");
  const formEnd = 8 + formSize;
  if (
    formEnd < bytes.length &&
    bytes.subarray(formEnd).some((byte) => byte !== 0)
  )
    fail("BEAM form does not consume the selected file.");
  const chunks: ErlangBeam["chunks"] = [];
  const payloads = new Map<string, { payload: Buffer; offset: number }>();
  let at = 12;
  while (at < formEnd) {
    if (formEnd - at < 8) fail("BEAM chunk header is truncated.");
    if (chunks.length >= input.max_chunks)
      throw new BeamCapacityFailure(
        "chunks",
        input.max_chunks,
        `BEAM form exceeds the ${String(input.max_chunks)}-chunk budget.`,
      );
    const name = chunkName(bytes, at);
    const size = u32(bytes, at + 4);
    const payloadOffset = at + 8;
    requireRange(bytes, payloadOffset, size);
    const padded = payloadOffset + size + ((4 - (size % 4)) % 4);
    if (padded > formEnd) fail("BEAM chunk padding exceeds the form.");
    const padding = bytes.subarray(payloadOffset + size, padded);
    if (padding.some((byte) => byte !== 0))
      fail("BEAM chunk padding is non-zero.");
    const payload = bytes.subarray(payloadOffset, payloadOffset + size);
    chunks.push({
      index: chunks.length,
      name,
      location: { offset: at, bytes: padded - at },
      payload: {
        location: { offset: payloadOffset, bytes: size },
        bytes: size,
        sha256: sha256(payload),
      },
    });
    if (!payloads.has(name)) payloads.set(name, { payload, offset: at });
    at = padded;
  }
  const atomChunk = payloads.get("AtU8") ?? payloads.get("Atom");
  const atomEncoding = payloads.has("AtU8")
    ? "utf8"
    : payloads.has("Atom")
      ? "latin1"
      : null;
  const atoms =
    atomChunk === undefined || atomEncoding === null
      ? null
      : parseAtoms(atomChunk.payload, input.max_atoms, atomEncoding);
  const declaredRows = (name: string): number => {
    const payload = payloads.get(name)?.payload;
    return payload !== undefined && payload.length >= 4 ? u32(payload, 0) : 0;
  };
  if (
    declaredRows("ExpT") + declaredRows("ImpT") + declaredRows("FunT") >
    MAX_INSPECT_ERLANG_BEAM_TABLE_ROWS
  )
    throw new BeamCapacityFailure(
      "table-rows",
      MAX_INSPECT_ERLANG_BEAM_TABLE_ROWS,
      `BEAM tables exceed the ${String(
        MAX_INSPECT_ERLANG_BEAM_TABLE_ROWS,
      )}-row budget.`,
    );
  const exports =
    payloads.get("ExpT") === undefined
      ? null
      : parseRows(payloads.get("ExpT")!.payload, 3, "export").map((row) => ({
          function_index: row[0]!,
          function: atomAt(atoms, row[0]!),
          arity: row[1]!,
          label: row[2]!,
        }));
  const imports =
    payloads.get("ImpT") === undefined
      ? null
      : parseRows(payloads.get("ImpT")!.payload, 3, "import").map((row) => ({
          module_index: row[0]!,
          module: atomAt(atoms, row[0]!),
          function_index: row[1]!,
          function: atomAt(atoms, row[1]!),
          arity: row[2]!,
        }));
  const lambdas =
    payloads.get("FunT") === undefined
      ? null
      : parseRows(payloads.get("FunT")!.payload, 6, "lambda").map((row) => ({
          function_index: row[0]!,
          function: atomAt(atoms, row[0]!),
          arity: row[1]!,
          label: row[2]!,
          index: row[3]!,
          free_vars: row[4]!,
          old_unique: row[5]!,
        }));
  const codeChunk = payloads.get("Code");
  const code =
    codeChunk === undefined
      ? null
      : parseCode(codeChunk.payload, codeChunk.offset);
  return {
    artifact,
    form: { location: { offset: 0, bytes: formEnd }, size: formSize },
    chunks,
    atoms,
    atom_encoding: atomEncoding,
    exports,
    imports,
    lambdas,
    code,
    module: atoms?.[0]?.name ?? null,
    coverage: {
      status: "complete",
      examined_chunks: chunks.length,
      atoms: atoms?.length ?? 0,
    },
    limitations: [...LIMITATIONS],
  };
};
