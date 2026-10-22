/**
 * Decode the PKCS#7 / CMS `SignedData` inside a v1 (JAR) signature block
 * (`META-INF/*.RSA|DSA|EC`) far enough to name its signers: the raw DER of
 * every certificate it carries and, per `SignerInfo`, which of those
 * certificates it identifies (by `issuerAndSerialNumber` or
 * `subjectKeyIdentifier`) and its digest and signature algorithm OIDs.
 *
 * This owns the DER structure only. Certificate facts (fingerprint, subject)
 * stay with the adapter's X.509 owner, and no signature is verified: a
 * `SignerInfo` naming a certificate is what the block declares.
 *
 * Dependency-free and bounded. Every tag and length is checked against its
 * enclosing element; BER indefinite lengths (which some JAR signers emit) are
 * accepted for constructed elements, within a nesting depth and a total
 * element budget, so a hostile block cannot drive unbounded work. Counts past
 * format-justified caps are a distinct `budget-exceeded` error, never
 * conflated with malformed input.
 */
import { type Result, err, ok } from "../result.js";

export type ApkV1BlockError =
  | { readonly kind: "malformed-pkcs7"; readonly detail: string }
  | {
      readonly kind: "budget-exceeded";
      readonly resource:
        | "v1-block-certificates"
        | "v1-signer-infos"
        | "der-elements";
      readonly limit: number;
    };

/** Certificates in one block: a signer leaf plus a short chain is the norm. */
export const MAX_V1_BLOCK_CERTIFICATES = 32;
/** SignerInfos in one block; apksig verifies one, more is pathological. */
export const MAX_V1_SIGNER_INFOS = 32;
/** Nesting depth; SignedData → X.509 extensions is under 12 levels deep. */
const MAX_DER_DEPTH = 32;
/** Elements read while decoding one block; bounds work for any byte length. */
export const MAX_DER_ELEMENTS = 65_536;

export interface ApkV1SignerInfo {
  readonly identifiedBy: "issuer-and-serial" | "subject-key-identifier";
  /** Index into `certificates` of the certificate the SignerInfo names; null when none matches. */
  readonly certificateIndex: number | null;
  readonly digestAlgorithmOid: string;
  readonly signatureAlgorithmOid: string;
}

export interface ApkV1SignedData {
  /** Raw DER of each certificate in `SignedData.certificates`, in block order. */
  readonly certificates: readonly Uint8Array[];
  readonly signerInfos: readonly ApkV1SignerInfo[];
  /**
   * Bytes after the ContentInfo. apksig's BER parser reads one top-level value
   * and ignores what follows, so they do not make the block unreadable.
   */
  readonly trailingBytes: number;
}

const OID_SIGNED_DATA = "1.2.840.113549.1.7.2";
const OID_SUBJECT_KEY_IDENTIFIER = "2.5.29.14";

const TAG = {
  integer: 0x02,
  octetString: 0x04,
  oid: 0x06,
  sequence: 0x30,
  set: 0x31,
  context0: 0xa0,
  context1: 0xa1,
  context3: 0xa3,
  /** `[0] IMPLICIT SubjectKeyIdentifier` (primitive). */
  context0Primitive: 0x80,
} as const;

interface Tlv {
  readonly tag: number;
  readonly start: number;
  readonly contentStart: number;
  readonly contentEnd: number;
  readonly end: number;
  readonly depth: number;
}

/** Expected failures inside one decode; converted to a Result at the boundary. */
class BlockFailure {
  constructor(readonly error: ApkV1BlockError) {}
}
const malformed = (detail: string): BlockFailure =>
  new BlockFailure({ kind: "malformed-pkcs7", detail });

class DerReader {
  #elements = 0;
  constructor(readonly bytes: Uint8Array) {}

  /** One TLV starting at `at`, which must end at or before `limit`. */
  read(at: number, limit: number, depth: number): Tlv {
    if (depth > MAX_DER_DEPTH)
      throw malformed(`nesting deeper than ${String(MAX_DER_DEPTH)}`);
    this.#elements += 1;
    if (this.#elements > MAX_DER_ELEMENTS)
      throw new BlockFailure({
        kind: "budget-exceeded",
        resource: "der-elements",
        limit: MAX_DER_ELEMENTS,
      });
    if (at + 2 > limit)
      throw malformed(`element at byte ${String(at)} is truncated`);
    const tag = this.bytes[at] ?? 0;
    if ((tag & 0x1f) === 0x1f)
      throw malformed(`high-tag-number form at byte ${String(at)}`);
    const first = this.bytes[at + 1] ?? 0;
    let contentStart = at + 2;
    if (first === 0x80) {
      if ((tag & 0x20) === 0)
        throw malformed(
          `indefinite length on a primitive at byte ${String(at)}`,
        );
      // BER indefinite length: children run to an end-of-contents marker.
      let child = contentStart;
      for (;;) {
        if (child + 2 > limit)
          throw malformed(
            `indefinite element at byte ${String(at)} has no end-of-contents`,
          );
        if (this.bytes[child] === 0 && this.bytes[child + 1] === 0)
          return {
            tag,
            start: at,
            contentStart,
            contentEnd: child,
            end: child + 2,
            depth,
          };
        child = this.read(child, limit, depth + 1).end;
      }
    }
    let length = first;
    if (first > 0x80) {
      const count = first & 0x7f;
      if (count > 4)
        throw malformed(
          `length of ${String(count)} bytes at byte ${String(at)}`,
        );
      if (contentStart + count > limit)
        throw malformed(`length at byte ${String(at)} is truncated`);
      length = 0;
      for (let i = 0; i < count; i += 1)
        length = length * 256 + (this.bytes[contentStart + i] ?? 0);
      contentStart += count;
    }
    const end = contentStart + length;
    if (end > limit)
      throw malformed(
        `element at byte ${String(at)} runs past its enclosing element`,
      );
    return { tag, start: at, contentStart, contentEnd: end, end, depth };
  }

  children(parent: Tlv): Tlv[] {
    const out: Tlv[] = [];
    for (let at = parent.contentStart; at < parent.contentEnd;) {
      const child = this.read(at, parent.contentEnd, parent.depth + 1);
      out.push(child);
      at = child.end;
    }
    return out;
  }

  content(tlv: Tlv): Uint8Array {
    return this.bytes.subarray(tlv.contentStart, tlv.contentEnd);
  }

  raw(tlv: Tlv): Uint8Array {
    return this.bytes.subarray(tlv.start, tlv.end);
  }
}

const expectTag = (tlv: Tlv | undefined, tag: number, what: string): Tlv => {
  if (tlv === undefined) throw malformed(`${what} is missing`);
  if (tlv.tag !== tag)
    throw malformed(
      `${what} has tag 0x${tlv.tag.toString(16)}, expected 0x${tag.toString(16)}`,
    );
  return tlv;
};

/** Dotted OID text; arcs are accumulated as BigInt so no arc overflows. */
const oidText = (content: Uint8Array): string => {
  if (content.length === 0 || content.length > 64)
    throw malformed(`object identifier of ${String(content.length)} bytes`);
  const arcs: bigint[] = [];
  let value = 0n;
  for (const [index, byte] of content.entries()) {
    value = (value << 7n) | BigInt(byte & 0x7f);
    if ((byte & 0x80) !== 0) {
      if (index === content.length - 1)
        throw malformed("object identifier is truncated");
      continue;
    }
    if (arcs.length === 0) {
      const first = value < 80n ? value / 40n : 2n;
      arcs.push(first, value - first * 40n);
    } else arcs.push(value);
    value = 0n;
  }
  return arcs.join(".");
};

const algorithmOid = (reader: DerReader, tlv: Tlv | undefined, what: string) =>
  oidText(
    reader.content(
      expectTag(
        reader.children(expectTag(tlv, TAG.sequence, what))[0],
        TAG.oid,
        `${what} algorithm`,
      ),
    ),
  );

const equalBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((byte, i) => byte === b[i]);

/** The X.509 facts a SignerInfo can name: issuer Name DER, serial and SKI. */
interface CertificateIdentity {
  readonly issuer: Uint8Array;
  readonly serial: Uint8Array;
  readonly subjectKeyIdentifier: Uint8Array | null;
}

/**
 * Read issuer, serial and subjectKeyIdentifier from a certificate's
 * tbsCertificate. A certificate that does not have this shape cannot be named
 * by a SignerInfo (null) but is still reported by the adapter's X.509 owner.
 */
const certificateIdentity = (
  reader: DerReader,
  certificate: Tlv,
): CertificateIdentity | null => {
  try {
    const tbs = expectTag(
      reader.children(certificate)[0],
      TAG.sequence,
      "tbsCertificate",
    );
    const fields = reader.children(tbs);
    const offset = fields[0]?.tag === TAG.context0 ? 1 : 0;
    const serial = expectTag(fields[offset], TAG.integer, "serialNumber");
    const issuer = expectTag(fields[offset + 2], TAG.sequence, "issuer");
    let subjectKeyIdentifier: Uint8Array | null = null;
    const extensions = fields.find((field) => field.tag === TAG.context3);
    if (extensions !== undefined) {
      const list = expectTag(
        reader.children(extensions)[0],
        TAG.sequence,
        "extensions",
      );
      for (const extension of reader.children(list)) {
        const parts = reader.children(extension);
        const id = expectTag(parts[0], TAG.oid, "extension id");
        if (oidText(reader.content(id)) !== OID_SUBJECT_KEY_IDENTIFIER)
          continue;
        const value = expectTag(parts.at(-1), TAG.octetString, "extnValue");
        const inner = reader.read(value.contentStart, value.contentEnd, 0);
        subjectKeyIdentifier = reader.content(
          expectTag(inner, TAG.octetString, "keyIdentifier"),
        );
      }
    }
    return {
      issuer: reader.raw(issuer),
      serial: reader.content(serial),
      subjectKeyIdentifier,
    };
  } catch (cause: unknown) {
    if (cause instanceof BlockFailure && cause.error.kind === "malformed-pkcs7")
      return null;
    throw cause;
  }
};

const signerInfo = (
  reader: DerReader,
  tlv: Tlv,
  identities: readonly (CertificateIdentity | null)[],
  index: number,
): ApkV1SignerInfo => {
  const what = `signerInfo ${String(index)}`;
  const fields = reader.children(expectTag(tlv, TAG.sequence, what));
  expectTag(fields[0], TAG.integer, `${what} version`);
  const sid = fields[1];
  let identifiedBy: ApkV1SignerInfo["identifiedBy"];
  let certificateIndex: number;
  if (sid?.tag === TAG.sequence) {
    const parts = reader.children(sid);
    const issuer = reader.raw(
      expectTag(parts[0], TAG.sequence, `${what} issuer`),
    );
    const serial = reader.content(
      expectTag(parts[1], TAG.integer, `${what} serialNumber`),
    );
    identifiedBy = "issuer-and-serial";
    certificateIndex = identities.findIndex(
      (identity) =>
        identity !== null &&
        equalBytes(identity.issuer, issuer) &&
        equalBytes(identity.serial, serial),
    );
  } else if (sid?.tag === TAG.context0Primitive) {
    const keyId = reader.content(sid);
    identifiedBy = "subject-key-identifier";
    certificateIndex = identities.findIndex(
      (identity) =>
        identity?.subjectKeyIdentifier != null &&
        equalBytes(identity.subjectKeyIdentifier, keyId),
    );
  } else throw malformed(`${what} has no supported signer identifier`);
  const digestAlgorithmOid = algorithmOid(
    reader,
    fields[2],
    `${what} digestAlgorithm`,
  );
  // signedAttrs ([0] IMPLICIT) is optional before signatureAlgorithm.
  const next = fields[3]?.tag === TAG.context0 ? 4 : 3;
  const signatureAlgorithmOid = algorithmOid(
    reader,
    fields[next],
    `${what} signatureAlgorithm`,
  );
  expectTag(fields[next + 1], TAG.octetString, `${what} signature`);
  return {
    identifiedBy,
    certificateIndex: certificateIndex < 0 ? null : certificateIndex,
    digestAlgorithmOid,
    signatureAlgorithmOid,
  };
};

const decode = (bytes: Uint8Array): ApkV1SignedData => {
  const reader = new DerReader(bytes);
  const contentInfo = expectTag(
    reader.read(0, bytes.length, 0),
    TAG.sequence,
    "ContentInfo",
  );
  const [contentType, explicit] = reader.children(contentInfo);
  const type = oidText(
    reader.content(expectTag(contentType, TAG.oid, "contentType")),
  );
  if (type !== OID_SIGNED_DATA)
    throw malformed(`contentType ${type} is not SignedData`);
  const signedData = expectTag(
    reader.children(expectTag(explicit, TAG.context0, "content"))[0],
    TAG.sequence,
    "SignedData",
  );
  const fields = reader.children(signedData);
  expectTag(fields[0], TAG.integer, "SignedData version");
  expectTag(fields[1], TAG.set, "digestAlgorithms");
  expectTag(fields[2], TAG.sequence, "encapContentInfo");
  let at = 3;
  const certificates: Tlv[] = [];
  if (fields[at]?.tag === TAG.context0) {
    for (const choice of reader.children(fields[at] as Tlv)) {
      // Other CertificateChoices (extended, attribute, other) carry no X.509 signer.
      if (choice.tag !== TAG.sequence)
        throw malformed(
          `certificate choice with tag 0x${choice.tag.toString(16)} is not an X.509 certificate`,
        );
      if (certificates.length >= MAX_V1_BLOCK_CERTIFICATES)
        throw new BlockFailure({
          kind: "budget-exceeded",
          resource: "v1-block-certificates",
          limit: MAX_V1_BLOCK_CERTIFICATES,
        });
      certificates.push(choice);
    }
    at += 1;
  }
  if (fields[at]?.tag === TAG.context1) at += 1;
  const infos = reader.children(expectTag(fields[at], TAG.set, "signerInfos"));
  if (infos.length > MAX_V1_SIGNER_INFOS)
    throw new BlockFailure({
      kind: "budget-exceeded",
      resource: "v1-signer-infos",
      limit: MAX_V1_SIGNER_INFOS,
    });
  const identities = certificates.map((certificate) =>
    certificateIdentity(reader, certificate),
  );
  return {
    certificates: certificates.map((certificate) => reader.raw(certificate)),
    signerInfos: infos.map((info, index) =>
      signerInfo(reader, info, identities, index),
    ),
    trailingBytes: bytes.length - contentInfo.end,
  };
};

/** Decode one v1 signature block's PKCS#7 SignedData. Nothing is verified. */
export const decodeV1SignatureBlock = (
  bytes: Uint8Array,
): Result<ApkV1SignedData, ApkV1BlockError> => {
  try {
    return ok(decode(bytes));
  } catch (cause: unknown) {
    if (cause instanceof BlockFailure) return err(cause.error);
    throw cause;
  }
};
