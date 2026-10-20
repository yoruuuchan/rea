import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { ArtifactResourceScope } from "../../../artifacts/ArtifactResourceScope.js";
import {
  inspectWebNetworkCaptureInputSchema,
  type WebNetworkCapture,
} from "../../../domain/webNetworkCapture.js";
import {
  prepareCaptureProtobuf,
  decodeCaptureProtobuf,
} from "./ProtobufCapture.js";

it("restricts framing overrides to native body facts while preserving header bytes", async () => {
  const binary = (pointer: string, bytes: Buffer) => ({
    pointer,
    representation: "producer-bytes" as const,
    state: "retained" as const,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    content_base64: bytes.toString("base64"),
  });
  const headers = [
    binary("/response/headers/0/0", Buffer.from("content-type")),
    binary("/response/headers/0/1", Buffer.from("application/grpc")),
  ];
  const report: WebNetworkCapture = {
    artifact: { path: "/fixture.mitm", bytes: 100, sha256: "a".repeat(64) },
    decoder: { id: "fixture", name: "Native producer facts", version: "1" },
    container: {
      reported: null,
      numeric_literals: [],
      redactions: [],
      records_pointer: "/flows",
    },
    format: "mitmproxy",
    total_records: 1,
    runtime_attribution: "unknown",
    limitations: [],
    records: [
      {
        ordinal: 0,
        location: { kind: "byte-range", offset: 0, bytes: 100 },
        reported: { response: { headers: [[null, null]], content: null } },
        binary_fields: [
          ...headers,
          binary("/response/content", Buffer.from([0, 0, 0, 0, 2, 8, 1])),
        ],
        numeric_literals: [],
        redactions: [],
        limitations: [],
      },
    ],
  };
  const input = inspectWebNetworkCaptureInputSchema.parse({
    capture_path: report.artifact.path,
    format: report.format,
    record_ordinals: [0],
    protobuf: { framing: "grpc" },
  });
  const resources = new ArtifactResourceScope();
  try {
    const prepared = await prepareCaptureProtobuf(report, input);
    await decodeCaptureProtobuf(report, input, resources, prepared);
  } finally {
    await resources.close();
  }
  expect(report.records[0]?.protobuf).toMatchObject([
    {
      pointer: "/response/content",
      status: "complete",
      fields: [{ number: 1, value: "1" }],
    },
  ]);
  expect(report.records[0]?.protobuf).toHaveLength(1);
  expect(report.records[0]?.binary_fields.slice(0, 2)).toEqual(headers);
  expect(report.protobuf_coverage?.status).toBe("complete");
});
