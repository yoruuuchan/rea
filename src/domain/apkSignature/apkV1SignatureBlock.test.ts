import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  indefinite,
  LEAF_CERTIFICATE,
  LEAF_SHA256,
  OID_ECDSA_SHA256,
  OID_SHA256,
  OPENSSL_BLOCK_ISSUER_SERIAL,
  OPENSSL_BLOCK_KEY_ID,
  ROOT_CERTIFICATE,
  ROOT_SHA256,
  signedDataBlock,
  signerInfo,
  tlv,
} from "../../../tests/fixtures/apkSignature/v1SignatureBlock.js";
import {
  decodeV1SignatureBlock,
  MAX_DER_ELEMENTS,
  MAX_V1_BLOCK_CERTIFICATES,
  MAX_V1_SIGNER_INFOS,
} from "./apkV1SignatureBlock.js";

const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

const decoded = (bytes: Uint8Array) => {
  const result = decodeV1SignatureBlock(bytes);
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
};

const errorOf = (bytes: Uint8Array) => {
  const result = decodeV1SignatureBlock(bytes);
  if (result.ok) throw new Error("expected a decode error");
  return result.error;
};

it.each([
  new Uint8Array(),
  tlv(0x02, Uint8Array.of(1)),
  Uint8Array.of(0x04, 0x02, 1),
])(
  "refuses an absent, mistagged or truncated SignerInfo signature",
  (signature) => {
    expect(
      decodeV1SignatureBlock(
        signedDataBlock({
          certificates: [LEAF_CERTIFICATE],
          signerInfos: [signerInfo({ names: LEAF_CERTIFICATE, signature })],
        }),
      ),
    ).toMatchObject({ ok: false, error: { kind: "malformed-pkcs7" } });
  },
);

describe("v1 signature block (PKCS#7 SignedData)", () => {
  it("names the leaf an OpenSSL SignerInfo identifies by issuer and serial", () => {
    const block = decoded(OPENSSL_BLOCK_ISSUER_SERIAL);
    expect(block.certificates.map(sha256)).toEqual([LEAF_SHA256, ROOT_SHA256]);
    expect(block.signerInfos).toEqual([
      {
        identifiedBy: "issuer-and-serial",
        certificateIndex: 0,
        digestAlgorithmOid: OID_SHA256,
        signatureAlgorithmOid: OID_ECDSA_SHA256,
      },
    ]);
  });

  it("names the leaf a SignerInfo identifies by subjectKeyIdentifier", () => {
    const block = decoded(OPENSSL_BLOCK_KEY_ID);
    expect(block.signerInfos).toEqual([
      {
        identifiedBy: "subject-key-identifier",
        certificateIndex: 0,
        digestAlgorithmOid: OID_SHA256,
        signatureAlgorithmOid: OID_ECDSA_SHA256,
      },
    ]);
  });

  it("identifies the leaf by its identifier, not by its position", () => {
    const block = decoded(
      signedDataBlock({
        certificates: [ROOT_CERTIFICATE, LEAF_CERTIFICATE],
        signerInfos: [signerInfo({ names: LEAF_CERTIFICATE })],
      }),
    );
    expect(block.signerInfos[0]?.certificateIndex).toBe(1);
  });

  it("keeps a SignerInfo whose certificate the block lacks as unidentified", () => {
    const block = decoded(
      signedDataBlock({
        certificates: [ROOT_CERTIFICATE],
        signerInfos: [signerInfo({ names: LEAF_CERTIFICATE })],
      }),
    );
    expect(block.signerInfos[0]?.certificateIndex).toBeNull();
    expect(block.certificates.map(sha256)).toEqual([ROOT_SHA256]);
  });

  it("accepts BER indefinite lengths on constructed elements", () => {
    const inner = signedDataBlock({
      certificates: [LEAF_CERTIFICATE],
      signerInfos: [signerInfo({ names: LEAF_CERTIFICATE })],
    });
    // Re-wrap the outer ContentInfo with an indefinite length.
    const definite = decoded(inner);
    const header = inner[1]! > 0x80 ? 2 + (inner[1]! & 0x7f) : 2;
    const ber = indefinite(0x30, inner.subarray(header));
    const block = decoded(ber);
    expect(block.signerInfos).toEqual(definite.signerInfos);
    expect(block.certificates.map(sha256)).toEqual([LEAF_SHA256]);
  });

  it("reads the ContentInfo and counts trailing bytes, as apksig ignores them", () => {
    expect(decoded(OPENSSL_BLOCK_ISSUER_SERIAL).trailingBytes).toBe(0);
    const block = decoded(
      Uint8Array.from([...OPENSSL_BLOCK_ISSUER_SERIAL, 0, 0xff, 7]),
    );
    expect(block.trailingBytes).toBe(3);
    expect(block.signerInfos[0]?.certificateIndex).toBe(0);
    expect(block.certificates.map(sha256)).toEqual([LEAF_SHA256, ROOT_SHA256]);
  });

  it("reports malformed structure instead of an empty signer", () => {
    expect(errorOf(OPENSSL_BLOCK_ISSUER_SERIAL.subarray(0, 200)).kind).toBe(
      "malformed-pkcs7",
    );
    expect(errorOf(Uint8Array.from([0x78])).kind).toBe("malformed-pkcs7");
    expect(
      errorOf(
        signedDataBlock({
          certificates: [LEAF_CERTIFICATE],
          signerInfos: [],
          contentType: "1.2.840.113549.1.7.1",
        }),
      ),
    ).toEqual({
      kind: "malformed-pkcs7",
      detail: "contentType 1.2.840.113549.1.7.1 is not SignedData",
    });
    expect(
      errorOf(
        signedDataBlock({
          certificates: [tlv(0xa1, Uint8Array.from([0x05, 0x00]))],
          signerInfos: [],
        }),
      ).kind,
    ).toBe("malformed-pkcs7");
    // An unterminated indefinite length must not be read as complete.
    expect(errorOf(Uint8Array.from([0x30, 0x80, 0x05, 0x00])).kind).toBe(
      "malformed-pkcs7",
    );
  });

  it("refuses certificate sets, SignerInfos and element counts past their bounds", () => {
    const many = Array.from(
      { length: MAX_V1_BLOCK_CERTIFICATES + 1 },
      () => LEAF_CERTIFICATE,
    );
    expect(
      errorOf(signedDataBlock({ certificates: many, signerInfos: [] })),
    ).toEqual({
      kind: "budget-exceeded",
      resource: "v1-block-certificates",
      limit: MAX_V1_BLOCK_CERTIFICATES,
    });
    const infos = Array.from({ length: MAX_V1_SIGNER_INFOS + 1 }, () =>
      signerInfo({ names: LEAF_CERTIFICATE }),
    );
    expect(
      errorOf(
        signedDataBlock({
          certificates: [LEAF_CERTIFICATE],
          signerInfos: infos,
        }),
      ).kind,
    ).toBe("budget-exceeded");
    const flood = new Uint8Array(2 * (MAX_DER_ELEMENTS + 1)).fill(0);
    for (let i = 0; i < flood.length; i += 2) flood[i] = 0x05;
    expect(
      errorOf(
        signedDataBlock({
          certificates: [],
          signerInfos: [tlv(0x30, flood)],
        }),
      ),
    ).toEqual({
      kind: "budget-exceeded",
      resource: "der-elements",
      limit: MAX_DER_ELEMENTS,
    });
    // Deep nesting is bounded before recursion can exhaust the stack.
    let nested: Uint8Array = Uint8Array.from([0x05, 0x00]);
    for (let i = 0; i < 64; i += 1) nested = indefinite(0x30, nested);
    expect(errorOf(nested)).toEqual({
      kind: "malformed-pkcs7",
      detail: "nesting deeper than 32",
    });
  });
});
