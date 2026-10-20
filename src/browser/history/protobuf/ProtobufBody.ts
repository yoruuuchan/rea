import {
  readGrpcFrame,
  prepareProtobufBody,
  type PreparedProtobufBody,
} from "./ProtobufFraming.js";
import { CaptureFormatError } from "../CaptureFormatError.js";
import type {
  ProtobufDecoding,
  ProtobufFrame,
} from "../../../domain/protobufWire.js";
import {
  decodeProtobufWire,
  ProtobufBudget,
  type WireSchema,
} from "./ProtobufWire.js";

/** Framing is protocol-specific: native gRPC has no in-body trailer frames. */
export const PROTOBUF_FRAMING = {
  "application/grpc": "grpc",
  "application/grpc+proto": "grpc",
  "application/grpc-web": "grpc-web",
  "application/grpc-web+proto": "grpc-web",
  "application/grpc-web-text": "grpc-web-text",
  "application/grpc-web-text+proto": "grpc-web-text",
  "application/x-protobuf": "raw",
  "application/protobuf": "raw",
  "application/vnd.google.protobuf": "raw",
} as const;

export const PROTOBUF_LIMITATIONS = [
  "Wire numbers and ranges are observations. Length-delimited string, nested-message and packed readings are candidates without a supplied schema. Raw decoding does not infer field names, signedness or business meaning; nested candidate bytes remain accessible through their ranges.",
  "Schema values are interpretations of the caller-supplied descriptor, not proof that the sender used that schema. Map semantics, extensions, required-field validation and unknown schema fields are not reconstructed.",
] as const;

export const decodeProtobufBody = async (
  body: Uint8Array,
  framing: ProtobufDecoding["framing"],
  source: Pick<ProtobufDecoding, "pointer" | "content_type" | "body_sha256">,
  redact: (value: string) => string,
  budget: ProtobufBudget,
  schema?: WireSchema,
  prepared?: PreparedProtobufBody,
): Promise<ProtobufDecoding> => {
  const result: ProtobufDecoding = {
    ...source,
    decoder: "rea-protobuf-wire-v1",
    framing,
    offset_basis:
      framing === "grpc-web-text" ? "base64-decoded-body" : "retained-body",
    decoded_bytes: body.length,
    status: "complete",
    examined_bytes: 0,
    frames: [],
    fields: [],
    limitations: [],
  };
  const stop = (offset: number, reason: string): ProtobufDecoding => {
    result.status = "partial";
    result.error = { offset, reason: redact(reason) };
    return result;
  };
  // The production source pass already decoded text. Charge representation expansion
  // here only after that pass made the retained source safe on failure.
  if (framing === "grpc-web-text") budget.charge(body.length * 6);
  const data =
    prepared === undefined
      ? (
          await prepareProtobufBody(
            body,
            framing,
            { decoded: () => false, header: () => false },
            budget.signal,
          )
        ).data
      : prepared.data;
  if (data === undefined)
    return stop(
      0,
      "gRPC-web text is not canonical base64 or independently padded base64 chunks",
    );
  result.decoded_bytes = data.length;
  let at = 0;
  const addMessage = async (frame: ProtobufFrame) => {
    if (frame.compressed) {
      frame.status = "unknown";
      frame.error = {
        offset: frame.payload_offset,
        reason:
          "Compressed gRPC payload requires its negotiated codec; source bytes remain retained",
      };
      return;
    }
    const decoded = await decodeProtobufWire(
      data,
      frame.payload_offset,
      frame.payload_offset + frame.bytes,
      frame.index,
      budget,
      redact,
      schema,
      result.fields.length,
    );
    for (const field of decoded.fields) result.fields.push(field);
    frame.examined_bytes = decoded.examined_bytes;
    if (decoded.error !== undefined) {
      frame.status = "partial";
      frame.error = decoded.error;
    }
  };
  if (framing === "raw") {
    const frame: ProtobufFrame = {
      index: 0,
      kind: "data",
      offset: 0,
      payload_offset: 0,
      bytes: data.length,
      compressed: false,
      status: "complete",
      examined_bytes: 0,
    };
    result.frames.push(frame);
    await addMessage(frame);
    result.status = frame.status;
    result.examined_bytes = frame.examined_bytes;
    return result;
  }
  let trailerSeen = false;
  while (at < data.length) {
    await budget.checkpoint();
    if (trailerSeen)
      return stop(at, "A gRPC-web trailer frame must terminate the body");
    const parsed = readGrpcFrame(data, at, framing);
    if (!parsed.ok) return stop(parsed.error.offset, parsed.error.reason);
    const { flags, bytes: length } = parsed.value;
    budget.charge(1024);
    const frame: ProtobufFrame = {
      index: result.frames.length,
      kind: flags & 128 ? "trailer" : "data",
      offset: at,
      payload_offset: at + 5,
      bytes: length,
      compressed: (flags & 1) !== 0,
      status: "complete",
      examined_bytes: 0,
    };
    result.frames.push(frame);
    if (frame.kind === "data") await addMessage(frame);
    else {
      trailerSeen = true;
      if (frame.compressed) {
        frame.status = "unknown";
        frame.error = {
          offset: at + 5,
          reason: "Compressed gRPC-web trailers remain opaque",
        };
      } else {
        budget.charge(length * 8);
        try {
          const text = new TextDecoder("utf-8", {
            fatal: true,
            ignoreBOM: true,
          }).decode(data.subarray(at + 5, at + 5 + length));
          frame.trailers = [];
          for (const line of text.split("\r\n")) {
            if (line === "") continue;
            const colon = line.indexOf(":");
            if (
              colon <= 0 ||
              !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(line.slice(0, colon))
            )
              throw new Error("Malformed trailer header");
            budget.charge(512);
            frame.trailers.push({
              name: redact(line.slice(0, colon)),
              value: redact(line.slice(colon + 1).replace(/^[ \t]+/, "")),
            });
          }
          frame.examined_bytes = length;
        } catch (cause) {
          if (cause instanceof CaptureFormatError) throw cause;
          frame.status = "partial";
          frame.error = {
            offset: at + 5,
            reason: "Invalid gRPC-web trailer header block",
          };
        }
      }
    }
    if (frame.status !== "complete") result.status = "partial";
    result.examined_bytes += 5 + frame.examined_bytes;
    at += 5 + length;
  }
  return result;
};
