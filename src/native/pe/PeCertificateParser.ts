import { createHash } from "node:crypto";
import { ArtifactReaderFailure } from "../../artifacts/ArtifactReader.js";
import type {
  InspectPeCertificatesInput,
  PeCertificates,
} from "../../domain/native/peCertificates.js";
import { peCertificateTypeName } from "../../domain/native/peCertificates.js";
import {
  oidName,
  parsePkcs7SignedData,
  PeCertificateDerFailure,
} from "./PeCertificateDer.js";
import { readPeHeaders } from "./PeResourceLayout.js";

const fail = (message: string): never => {
  throw new ArtifactReaderFailure("format", message);
};

const requireRange = (bytes: Buffer, offset: number, length: number): void => {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset > bytes.length - length
  )
    fail(
      `PE certificate range ${String(offset)} + ${String(length)} leaves the artifact.`,
    );
};

const align8 = (value: number): number => Math.ceil(value / 8) * 8;

const sha256 = (bytes: Buffer): string =>
  createHash("sha256").update(bytes).digest("hex");

const LIMITATIONS = [
  "This workflow does not verify signatures, certificate chains, timestamps, or Authenticode digest coverage of image bytes.",
  "PKCS#7 fields are decoded structurally; cryptographic validity remains unobserved.",
] as const;

const ABSENT_LIMITATIONS = [
  "IMAGE_DIRECTORY_ENTRY_SECURITY is absent. That is not proof the image is unsigned in every catalog or overlay sense.",
  "This workflow does not verify signatures, certificate chains, timestamps, or Authenticode digest coverage of image bytes.",
] as const;

/** Decode IMAGE_DIRECTORY_ENTRY_SECURITY as a file-offset WIN_CERTIFICATE table. */
export const parsePeCertificates = (
  bytes: Buffer,
  artifact: PeCertificates["artifact"],
  input: InspectPeCertificatesInput,
): PeCertificates => {
  const { pe, optional, magic, directoriesAt, directoryCount, headerSize } =
    readPeHeaders(bytes);
  const machine = bytes.readUInt16LE(pe + 4);
  const format = magic === 0x20b ? "pe32-plus" : "pe32";
  const securityIndex = 4;
  if (directoryCount <= securityIndex) {
    return {
      artifact,
      format,
      machine,
      table: null,
      entries: [],
      coverage: { status: "complete", examined_entries: 0, certificates: 0 },
      limitations: [...ABSENT_LIMITATIONS],
    };
  }
  const directoryAt = optional + directoriesAt + securityIndex * 8;
  requireRange(bytes, directoryAt, 8);
  const tableOffset = bytes.readUInt32LE(directoryAt);
  const tableSize = bytes.readUInt32LE(directoryAt + 4);
  if (tableOffset === 0 && tableSize === 0) {
    return {
      artifact,
      format,
      machine,
      table: null,
      entries: [],
      coverage: { status: "complete", examined_entries: 0, certificates: 0 },
      limitations: [...ABSENT_LIMITATIONS],
    };
  }
  if (tableSize === 0 || tableOffset < headerSize)
    fail("PE certificate table offset overlaps headers or has zero size.");
  requireRange(bytes, tableOffset, tableSize);
  const table = bytes.subarray(tableOffset, tableOffset + tableSize);
  const entries: PeCertificates["entries"] = [];
  let at = 0;
  let examined = 0;
  while (at < table.length) {
    // Alignment padding sits inside the gap before the next 8-byte boundary.
    // Bytes that remain after that boundary are a short header, including
    // zeros at the start of the table.
    if (table.length - at < 8) fail("WIN_CERTIFICATE header is truncated.");
    examined += 1;
    if (examined > input.max_entries)
      throw new ArtifactReaderFailure(
        "limit",
        `PE certificate table exceeds the ${String(input.max_entries)}-entry budget.`,
        { boundary: "capacity" },
      );
    const length = table.readUInt32LE(at);
    const revision = table.readUInt16LE(at + 4);
    const certificateType = table.readUInt16LE(at + 6);
    if (length < 8)
      fail("WIN_CERTIFICATE dwLength is shorter than its header.");
    if (at + length > table.length)
      fail("WIN_CERTIFICATE dwLength exceeds the certificate table.");
    const payload = table.subarray(at + 8, at + length);
    let pkcs7: PeCertificates["entries"][number]["pkcs7"] = null;
    if (peCertificateTypeName(certificateType) === "pkcs7") {
      try {
        const parsed = parsePkcs7SignedData(payload);
        pkcs7 = {
          content_type_oid: parsed.content_type_oid,
          content_type_name: oidName(parsed.content_type_oid),
          digest_algorithm_oids: [...parsed.digest_algorithm_oids],
          certificates: parsed.certificates.map((certificate) => ({
            location: {
              offset: tableOffset + at + 8 + certificate.start,
              bytes: certificate.end - certificate.start,
            },
            der_sha256: sha256(
              payload.subarray(certificate.start, certificate.end),
            ),
            serial_hex: certificate.serial_hex,
            issuer: {
              text: certificate.issuer.text,
              attributes: [...certificate.issuer.attributes],
            },
            subject: {
              text: certificate.subject.text,
              attributes: [...certificate.subject.attributes],
            },
            not_before: certificate.not_before,
            not_after: certificate.not_after,
            signature_algorithm_oid: certificate.signature_algorithm_oid,
            signature_algorithm_name: oidName(
              certificate.signature_algorithm_oid,
            ),
          })),
          signers: parsed.signers.map((signer) => ({
            digest_algorithm_oid: signer.digest_algorithm_oid,
            digest_algorithm_name: oidName(signer.digest_algorithm_oid),
            signature_algorithm_oid: signer.signature_algorithm_oid,
            signature_algorithm_name: oidName(signer.signature_algorithm_oid),
            issuer:
              signer.issuer === null
                ? null
                : {
                    text: signer.issuer.text,
                    attributes: [...signer.issuer.attributes],
                  },
            serial_hex: signer.serial_hex,
            subject_key_identifier_hex: signer.subject_key_identifier_hex,
            authenticated_attributes: signer.authenticated_attributes,
          })),
        };
      } catch (cause) {
        if (cause instanceof PeCertificateDerFailure)
          fail(`PKCS#7 signedData is malformed: ${cause.message}`);
        throw cause;
      }
    }
    entries.push({
      index: entries.length,
      location: { offset: tableOffset + at, bytes: length },
      length,
      revision,
      certificate_type: certificateType,
      certificate_type_name: peCertificateTypeName(certificateType),
      payload: {
        location: { offset: tableOffset + at + 8, bytes: payload.length },
        bytes: payload.length,
        sha256: sha256(payload),
      },
      pkcs7,
    });
    const next = align8(at + length);
    if (next <= at) fail("WIN_CERTIFICATE alignment did not advance.");
    at = next;
  }
  const certificates = entries.reduce(
    (count, entry) => count + (entry.pkcs7?.certificates.length ?? 0),
    0,
  );
  return {
    artifact,
    format,
    machine,
    table: {
      location: { offset: tableOffset, bytes: tableSize },
      data_directory_location: { offset: directoryAt, bytes: 8 },
    },
    entries,
    coverage: {
      status: "complete",
      examined_entries: examined,
      certificates,
    },
    limitations: [...LIMITATIONS],
  };
};
