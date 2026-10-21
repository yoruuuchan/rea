import type { ObjcSwiftMetadata } from "../domain/native/objcSwiftMetadata.js";
import type { PointerResolution } from "./AppleMachoFixups.js";
import type { Segment, Section } from "./AppleMachoSelection.js";
import { issue, type FacetDecodeFacts } from "./AppleDispatchDecodeFacts.js";

/** Resolved file-backed metadata location from the Mach-O layout. */
export interface ResolvedMetadataLocation {
  address: string;
  file_offset: number;
}

/** Binary-metadata evidence produced by the Apple dispatch readers. */
export type BinaryMetadataEvidence = {
  kind: "binary_metadata";
  description: string;
  location: ResolvedMetadataLocation;
  artifact_path: string;
  artifact_sha256: string;
}[];

/** Shared admission budget for max_records truncation across decode facets. */
export interface DispatchRecordBudget {
  truncated: boolean;
  isFull(): boolean;
  markTruncated(): void;
  admit(): boolean;
}

/** Field-owned Swift ABI pointer encodings used by the readers below. */
export type SwiftRelativeField =
  | "conformanceRecord"
  | "conformanceProtocol"
  | "protocolName"
  | "conformanceType"
  | "typeName"
  | "witnessTablePattern"
  | "typeMetadataRecord"
  | "classDescriptorName"
  | "methodImplementation";

type SwiftRelativeFieldContract = {
  encoding: "direct" | "indirectable" | "taggedDirect" | "compactFunction";
  nullability: "nullable" | "nonnull";
};

/** Nullability and storage encoding follow the owning fields in Swift ABI. */
const relativeFieldContracts = {
  conformanceRecord: { encoding: "direct", nullability: "nonnull" },
  conformanceProtocol: {
    encoding: "indirectable",
    nullability: "nullable",
  },
  protocolName: { encoding: "direct", nullability: "nonnull" },
  conformanceType: { encoding: "direct", nullability: "nullable" },
  typeName: { encoding: "direct", nullability: "nonnull" },
  witnessTablePattern: { encoding: "direct", nullability: "nullable" },
  typeMetadataRecord: { encoding: "taggedDirect", nullability: "nonnull" },
  classDescriptorName: { encoding: "direct", nullability: "nonnull" },
  methodImplementation: {
    encoding: "compactFunction",
    nullability: "nullable",
  },
} as const satisfies Record<SwiftRelativeField, SwiftRelativeFieldContract>;

/** Resolved address or a null encoding permitted by its Swift ABI field. */
export type SwiftRelativeTarget = bigint | null;
export type SwiftRelativeValue =
  | { readonly kind: "target"; readonly target: bigint }
  | { readonly kind: "null" }
  | {
      readonly kind: "binding";
      readonly binding: Extract<PointerResolution, { readonly kind: "bind" }>;
      readonly requestedAddress: bigint;
    }
  | { readonly kind: "unknown"; readonly reason: string };

/** Keep ABI null, unavailable values, and unresolved imports distinct. */
export const unresolvedSwiftRelativeReason = (
  value: Exclude<SwiftRelativeValue, { readonly kind: "target" }>,
  field: SwiftRelativeField,
): string => {
  if (value.kind === "null") return `Null Swift relative pointer for ${field}`;
  if (value.kind === "unknown") return value.reason;
  return `Swift relative pointer for ${field} has an unresolved external binding at ${hex(value.requestedAddress)}`;
};

/** Byte readers for Swift relative-pointer and conformance decode facets. */
export interface SwiftDispatchReaders {
  u32(address: bigint): number;
  pointer(address: bigint): bigint;
  resolvePointer(address: bigint): PointerResolution;
  string(address: bigint): string;
  location(address: bigint): ResolvedMetadataLocation;
  evidence(address: bigint, description: string): BinaryMetadataEvidence;
  offset(address: bigint, size?: number): number;
}

const hex = (value: bigint) => `0x${value.toString(16)}`;
const decoded = { status: "decoded" as const, reason: null };
const importBinding = (
  requestedAddress: bigint,
  binding: Extract<PointerResolution, { readonly kind: "bind" }>,
) => ({
  requested_address: hex(requestedAddress),
  symbol: binding.symbol,
  binding_source: binding.binding_source,
  library_ordinal: binding.library_ordinal,
  library: binding.library,
  weak: binding.weak,
  addend: binding.addend.toString(),
});

/** Create a Swift ABI signed-relative pointer decoder that records relative_pointers. */
export const createSwiftRelativeReader = (input: {
  bytes: Buffer;
  readers: SwiftDispatchReaders;
  budget: DispatchRecordBudget;
  result: ObjcSwiftMetadata;
}) => {
  const { bytes, readers: read, budget, result } = input;
  return (field: bigint, kind: SwiftRelativeField): SwiftRelativeValue => {
    const contract = relativeFieldContracts[kind];
    const indirectable = contract.encoding === "indirectable";
    const taggedDirect = contract.encoding === "taggedDirect";
    const nullable = contract.nullability === "nullable";
    const displacement = bytes.readInt32LE(read.offset(field, 4));
    const encodingTag = taggedDirect ? displacement & 3 : undefined;
    if (encodingTag !== undefined && encodingTag !== 0) {
      const reason = `Unsupported Swift type metadata record tag ${encodingTag}`;
      if (budget.admit())
        result.relative_pointers.push({
          field: read.location(field),
          target: { address: null, file_offset: null },
          displacement,
          indirectable,
          indirect: false,
          encoding_tag: encodingTag,
          decode: { status: "unsupported", reason },
          evidence: read.evidence(
            field,
            "Swift ABI tagged type metadata record",
          ),
        });
      return { kind: "unknown", reason };
    }
    const indirect = indirectable && (displacement & 1) !== 0;
    let target: SwiftRelativeTarget =
      nullable && displacement === 0
        ? null
        : field +
          BigInt(
            taggedDirect
              ? displacement & ~3
              : indirectable
                ? displacement & ~1
                : displacement,
          );
    let fileOffset: number | null = null;
    let reason: string | null = null;
    try {
      if (indirect && target !== null) {
        const pointer = read.resolvePointer(target);
        if (pointer.kind === "bind") {
          if (budget.admit())
            result.relative_pointers.push({
              field: read.location(field),
              target: { address: null, file_offset: null },
              displacement,
              indirectable,
              indirect,
              binding: importBinding(target, pointer),
              decode: { status: "partial", reason: "External pointer binding" },
              evidence: read.evidence(
                field,
                "Swift ABI indirect relative pointer and Mach-O import binding",
              ),
            });
          return {
            kind: "binding",
            binding: pointer,
            requestedAddress: target,
          };
        }
        if (pointer.kind === "unknown" || pointer.kind === "unsupported") {
          const unresolved = pointer.reason;
          if (budget.admit())
            result.relative_pointers.push({
              field: read.location(field),
              target: { address: null, file_offset: null },
              displacement,
              indirectable,
              indirect,
              decode: { status: "partial", reason: unresolved },
              evidence: read.evidence(
                field,
                "Swift ABI indirect relative pointer",
              ),
            });
          return { kind: "unknown", reason: unresolved };
        }
        const indirectTarget = pointer.target;
        target =
          pointer.kind === "raw" && indirectTarget === 0n
            ? null
            : indirectTarget;
      }
      if (target !== null) fileOffset = read.offset(target);
    } catch (cause) {
      reason = cause instanceof Error ? cause.message : String(cause);
    }
    if (budget.admit())
      result.relative_pointers.push({
        field: read.location(field),
        target: {
          address: target === null ? null : hex(target),
          file_offset: fileOffset,
        },
        displacement,
        indirectable,
        indirect,
        ...(encodingTag === undefined ? {} : { encoding_tag: encodingTag }),
        decode: reason === null ? decoded : { status: "partial", reason },
        evidence: read.evidence(
          field,
          "Swift ABI signed-relative metadata pointer",
        ),
      });
    return target === null ? { kind: "null" } : { kind: "target", target };
  };
};

/** Decode `__swift5_proto` conformances and static witness slots into `result`. */
export const decodeSwiftDispatchFacets = (input: {
  sections: readonly Section[];
  segments: readonly Segment[];
  readers: SwiftDispatchReaders;
  relative: (field: bigint, kind: SwiftRelativeField) => SwiftRelativeValue;
  budget: DispatchRecordBudget;
  result: ObjcSwiftMetadata;
}): FacetDecodeFacts => {
  const { sections, segments, readers: read, relative, budget, result } = input;
  const swiftFailures: string[] = [];
  const issues = [] as ReturnType<typeof issue>[];
  const requiredRelative = (
    field: bigint,
    kind: SwiftRelativeField,
  ): bigint => {
    const value = relative(field, kind);
    if (value.kind !== "target")
      throw new RangeError(unresolvedSwiftRelativeReason(value, kind));
    return value.target;
  };
  let swiftExamined = 0;
  let decodedRecords = 0;
  for (const section of sections.filter(
    ({ name }) => name === "__swift5_proto",
  )) {
    if (section.size % 4 !== 0)
      throw new RangeError("Misaligned Swift conformance section");
    for (let index = 0; index < section.size / 4; index++) {
      if (!budget.admit()) break;
      swiftExamined++;
      const field = section.address + BigInt(index * 4);
      try {
        const descriptor = requiredRelative(field, "conformanceRecord");
        const flags = read.u32(descriptor + 12n);
        const protocolValue = relative(descriptor, "conformanceProtocol");
        const protocol =
          protocolValue.kind === "target" ? protocolValue.target : null;
        const unresolvedProtocolReason =
          protocolValue.kind === "unknown" || protocolValue.kind === "binding"
            ? unresolvedSwiftRelativeReason(
                protocolValue,
                "conformanceProtocol",
              )
            : null;
        if (protocol !== null && (read.u32(protocol) & 31) !== 3)
          throw new TypeError("Unsupported Swift protocol descriptor kind");
        const protocolName =
          protocol === null
            ? null
            : read.string(requiredRelative(protocol + 8n, "protocolName"));
        const protocolBinding =
          protocolValue.kind === "binding"
            ? importBinding(
                protocolValue.requestedAddress,
                protocolValue.binding,
              )
            : null;
        const typeKind = (flags >>> 3) & 7;
        if (typeKind !== 0 && typeKind !== 1)
          throw new TypeError(
            "Unsupported Swift conformance type-reference kind",
          );
        const typeValue = relative(descriptor + 4n, "conformanceType");
        let type = typeValue.kind === "target" ? typeValue.target : null;
        let typeBinding =
          typeValue.kind === "binding"
            ? importBinding(typeValue.requestedAddress, typeValue.binding)
            : null;
        let unresolvedTypeReason =
          typeValue.kind === "unknown" ? typeValue.reason : null;
        if (typeKind === 1 && type !== null) {
          const pointer = read.resolvePointer(type);
          if (pointer.kind === "bind") {
            typeBinding = importBinding(type, pointer);
            type = null;
          } else if (pointer.kind === "raw" && pointer.target === 0n) {
            type = null;
            unresolvedTypeReason =
              "Null indirect Swift conformance type reference";
          } else if (pointer.kind === "rebase" || pointer.kind === "raw") {
            type = pointer.target;
          } else {
            type = null;
            unresolvedTypeReason = pointer.reason;
          }
        }
        if (type !== null && ![16, 17, 18].includes(read.u32(type) & 31))
          throw new TypeError("Unsupported Swift type descriptor kind");
        const typeName =
          type === null
            ? null
            : read.string(requiredRelative(type + 8n, "typeName"));
        const witnessValue =
          protocol !== null && type !== null
            ? relative(descriptor + 8n, "witnessTablePattern")
            : { kind: "null" as const };
        const witness =
          witnessValue.kind === "target" ? witnessValue.target : null;
        const unresolvedWitnessReason =
          witnessValue.kind === "unknown" || witnessValue.kind === "binding"
            ? unresolvedSwiftRelativeReason(witnessValue, "witnessTablePattern")
            : null;
        const staticWitness =
          witness !== null &&
          protocol !== null &&
          type !== null &&
          (flags & ~0x38) === 0 &&
          (read.u32(type) & 0x80) === 0;
        let witnessReason: string | null = staticWitness
          ? null
          : (unresolvedProtocolReason ??
            unresolvedTypeReason ??
            unresolvedWitnessReason ??
            (protocolBinding !== null || typeBinding !== null
              ? "Conformance references an external Mach-O binding"
              : "Conditional, generic, resilient or missing static witness table is not decoded"));
        if (staticWitness) {
          const header = read.resolvePointer(witness);
          if (header.kind !== "raw" && header.kind !== "rebase")
            witnessReason =
              header.kind === "unknown" || header.kind === "unsupported"
                ? header.reason
                : "Witness-table conformance header is an external binding";
          else if (header.target !== descriptor)
            witnessReason =
              "Witness-table conformance header is unresolved or encoded";
        }
        const conformanceDecode =
          witnessReason === null
            ? { status: "decoded" as const, reason: null }
            : { status: "partial" as const, reason: witnessReason };
        result.swift_conformances.push({
          type_name: typeName,
          type_binding: typeBinding,
          protocol_name: protocolName,
          protocol_binding: protocolBinding,
          module: null,
          witness_table:
            witness === null
              ? { address: null, file_offset: null }
              : read.location(witness),
          location: read.location(descriptor),
          decode: conformanceDecode,
          evidence: read.evidence(
            descriptor,
            "Swift protocol conformance descriptor and directly encoded type/protocol names",
          ),
        });
        if (conformanceDecode.status === "decoded") decodedRecords++;
        if (
          witnessReason !== null ||
          witness === null ||
          typeName === null ||
          protocolName === null
        ) {
          const reason =
            witnessReason ?? "Missing static witness table is not decoded";
          swiftFailures.push(`${typeName ?? "<unknown type>"}: ${reason}`);
          issues.push(
            issue(
              "swift_conformances_static_witness_slots",
              "conformance_decode_partial",
              reason,
              hex(descriptor),
            ),
          );
          continue;
        }
        const count = read.u32(protocol! + 16n);
        const signatureCount = read.u32(protocol! + 12n);
        if (count > 20_000 || signatureCount > 20_000)
          throw new RangeError("Swift witness requirement count exceeds 20000");
        for (let slot = 0; slot < count; slot++) {
          if (!budget.admit()) break;
          const entry = witness + BigInt((slot + 1) * 8);
          const implementationResolution = read.resolvePointer(entry);
          const implementation =
            implementationResolution.kind === "raw" ||
            implementationResolution.kind === "rebase"
              ? implementationResolution.target
              : null;
          const requirementFlags = read.u32(
            protocol! + 24n + BigInt(signatureCount * 12 + slot * 8),
          );
          const kind = requirementFlags & 15;
          const synchronousFunction =
            kind >= 1 && kind <= 4 && (requirementFlags & 0x20) === 0;
          const executable =
            implementation !== null &&
            synchronousFunction &&
            segments.some(
              (segment) =>
                segment.executable &&
                implementation >= segment.address &&
                implementation < segment.address + segment.size,
            );
          const slotDecode = executable
            ? { status: "decoded" as const, reason: null }
            : {
                status: "partial" as const,
                reason:
                  implementationResolution.kind === "bind"
                    ? "Witness implementation is an external Mach-O binding"
                    : implementationResolution.kind === "unknown" ||
                        implementationResolution.kind === "unsupported"
                      ? implementationResolution.reason
                      : "Witness slot is non-function, async, nil, external, authenticated or encoded; implementation target is unresolved",
              };
          result.swift_dispatch_slots.push({
            owner: `${typeName}: ${protocolName}`,
            table_kind: "witness_table",
            slot_index: slot + 1,
            requirement: null,
            implementation: null,
            implementation_address: executable ? hex(implementation) : null,
            ...(implementationResolution.kind === "bind"
              ? {
                  implementation_binding: importBinding(
                    entry,
                    implementationResolution,
                  ),
                }
              : {}),
            thunk_address: null,
            location: read.location(entry),
            decode: slotDecode,
            evidence: read.evidence(
              entry,
              "Static Swift witness slot, indexed after the conformance-descriptor header",
            ),
          });
          if (slotDecode.status !== "decoded")
            issues.push(
              issue(
                "swift_conformances_static_witness_slots",
                "witness_slot_unresolved",
                slotDecode.reason,
                hex(entry),
              ),
            );
        }
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        swiftFailures.push(`${hex(field)}: ${message}`);
        issues.push(
          issue(
            "swift_conformances_static_witness_slots",
            "conformance_decode_failed",
            message,
            hex(field),
          ),
        );
      }
    }
  }
  return {
    facet: "swift_conformances_static_witness_slots",
    examined: swiftExamined,
    decoded: decodedRecords,
    exhaustive: !budget.truncated && issues.length === 0,
    issues,
  };
};
