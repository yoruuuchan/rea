import { decodeXmlPlistText } from "../../domain/propertyListXmlText.js";
import { hasBinaryPlistSignature } from "../../domain/apple/appleArchiveFormat.js";
import {
  binaryDateRequiresExactSeconds,
  binaryPlistObjectEnd,
} from "./PlistScalars.js";

/** Preflight the representation created by the pinned plist decoder. */
export const preflightPropertyListDecode = (
  bytes: Buffer,
  maxBytes: number,
  xmlText?: string,
  options: Pick<
    BinaryPlistExpansionOptions,
    "numberProjection" | "budget" | "fail"
  > = {},
): PlistDecodePreflight => {
  const {
    numberProjection = false,
    budget = "the property list decode budget",
    fail = propertyListDecodeBudgetFailure,
  } = options;
  const expansion = hasBinaryPlistSignature(bytes)
    ? estimateBinaryPlistExpansion(bytes, maxBytes, {
        numberProjection,
        budget,
        fail,
      })
    : {
        estimatedBytes: estimateXmlPlistExpansion(
          bytes,
          maxBytes,
          xmlText,
          numberProjection,
          budget,
          fail,
        ),
        binaryPrototypeKeyObserved: false,
        datePrecisionOverlapCount: 0,
        reachableDateOffsets: [],
        overlappingDateOffsets: [],
        reachableWideIntegerOffsets: [],
        overlappingWideIntegerOffsets: [],
        reachableNumericOffsets: [],
      };
  if (expansion.estimatedBytes > maxBytes)
    throw fail("expansion", `plist representation exceeds ${budget}`);
  return expansion;
};

const estimateXmlPlistExpansion = (
  bytes: Buffer,
  maxBytes: number,
  xmlText?: string,
  numberProjection = false,
  budget = "the property list decode budget",
  fail: (
    kind: BinaryPlistExpansionFailure,
    message: string,
  ) => Error = propertyListDecodeBudgetFailure,
): number => {
  const xml = xmlText ?? decodeXmlPlistText(bytes);
  const decodedSourceBytes = xml.length * 2;
  let elementCount = 0;
  // Reserve room for numeric source metadata and the projected attribute copy.
  const elementBytes = numberProjection ? 256 : 128;
  // Value nesting is bounded by the shared plist parser, which counts plist
  // value depth; raw element depth would also count the envelope and keys.
  for (const token of xmlPreflightTokens(xml)) {
    if (token.doctype) {
      // Only a declaration outside opaque text can introduce an internal
      // subset. Brackets in quoted external identifiers are literal text.
      if (token.internalSubset)
        throw fail(
          "expansion",
          `XML plist internal entity expansion exceeds ${budget}`,
        );
      continue;
    }
    elementCount += 1;
    if (decodedSourceBytes * 2 + elementCount * elementBytes > maxBytes)
      return maxBytes + 1;
  }
  return decodedSourceBytes * 2 + elementCount * elementBytes;
};

/** Consume each XML span once; malformed tokens cannot restart suffix scans. */
function* xmlPreflightTokens(xml: string) {
  let cursor = 0;
  while (cursor < xml.length) {
    const start = xml.indexOf("<", cursor);
    if (start < 0) return;
    const opaqueEnd = xml.startsWith("<!--", start)
      ? "-->"
      : xml.startsWith("<![CDATA[", start)
        ? "]]>"
        : xml.startsWith("<?", start)
          ? "?>"
          : undefined;
    if (opaqueEnd !== undefined) {
      const end = xml.indexOf(opaqueEnd, start + 2);
      if (end < 0) return;
      cursor = end + opaqueEnd.length;
      continue;
    }
    const doctype = /^<!DOCTYPE\b/iu.test(xml.slice(start, start + 10));
    const element = /^<\/?[A-Za-z]/u.test(xml.slice(start, start + 4));
    let quote: string | undefined;
    let internalSubset = false;
    let end = start + 1;
    for (; end < xml.length; end += 1) {
      const character = xml[end];
      if (quote !== undefined) {
        if (character === quote) quote = undefined;
      } else if (character === '"' || character === "'") quote = character;
      else if (character === ">") break;
      else if (doctype && character === "[") internalSubset = true;
    }
    if (end === xml.length) return;
    cursor = end + 1;
    if (doctype || element) yield { doctype, internalSubset };
  }
}

/** Resource or structural failure found while preflighting a plist. */
export type BinaryPlistExpansionFailure = "cycle" | "depth" | "expansion";

/** Typed failure for shared plist preflight resource limits. */
export class PropertyListDecodeBudgetFailure extends Error {
  constructor(
    readonly kind: BinaryPlistExpansionFailure,
    message: string,
  ) {
    super(message);
    this.name = "PropertyListDecodeBudgetFailure";
  }
}

const propertyListDecodeBudgetFailure = (
  kind: BinaryPlistExpansionFailure,
  message: string,
): Error => new PropertyListDecodeBudgetFailure(kind, message);

/** How a caller names and reports binary plist expansion failures. */
export interface BinaryPlistExpansionOptions {
  /** Include original number metadata and exact-integer attribute projection. */
  readonly numberProjection?: boolean;
  /** Budget named in failure messages. */
  readonly budget?: string;
  /** Error for budget, depth, and reference-cycle failures. */
  readonly fail?: (kind: BinaryPlistExpansionFailure, message: string) => Error;
  /**
   * Structural bounds: "strict" keeps objects and the offset table before the
   * trailer; "decoder" follows the decoder's object-table boundary policy
   * while still rejecting structures whose coercion would lose plist facts.
   */
  readonly bounds?: "strict" | "decoder";
}

/** Preflight size and binary-key observations; XML keys are inspected by decode. */
export interface PlistDecodePreflight {
  readonly estimatedBytes: number;
  readonly binaryPrototypeKeyObserved: boolean;
  /** Number of expanded references to precision-unknown overlapping dates. */
  readonly datePrecisionOverlapCount: number;
  /** Unique reachable date records in the selected value graph. */
  readonly reachableDateOffsets: readonly number[];
  /** Precision-unknown date offsets requiring decoder-copy isolation. */
  readonly overlappingDateOffsets: readonly number[];
  /** Unique reachable 16-byte integer records in the selected value graph. */
  readonly reachableWideIntegerOffsets: readonly number[];
  /** Source offsets requiring isolated decoder-compatible scalar records. */
  readonly overlappingWideIntegerOffsets: readonly number[];
  /** Reachable integer and real source records for exact number association. */
  readonly reachableNumericOffsets: readonly number[];
}

const PROTOTYPE_KEY = "__proto__";

type BinaryObjectSpan = { readonly offset: number; readonly end: number };

const findOverlappingScalarOffsets = (
  spans: readonly BinaryObjectSpan[],
  scalarOffsets: ReadonlySet<number>,
): Set<number> => {
  let maxPriorEnd = -1;
  const overlappingOffsets = new Set<number>();
  const activeScalars = new Map<number, number>();
  for (const span of spans) {
    for (const [offset, end] of activeScalars)
      if (end <= span.offset) activeScalars.delete(offset);
    if (scalarOffsets.has(span.offset)) {
      if (maxPriorEnd > span.offset) {
        overlappingOffsets.add(span.offset);
        for (const activeOffset of activeScalars.keys())
          overlappingOffsets.add(activeOffset);
        activeScalars.clear();
      } else activeScalars.set(span.offset, span.end);
    } else {
      for (const activeOffset of activeScalars.keys())
        overlappingOffsets.add(activeOffset);
      activeScalars.clear();
    }
    maxPriorEnd = Math.max(maxPriorEnd, span.end);
  }
  return overlappingOffsets;
};

const findExactScalarCloneOffsetWidth = (
  currentWidth: number,
  firstCloneOffset: number,
  cloneCount: number,
): number | undefined => {
  const lastCloneOffset = firstCloneOffset + cloneCount * 9 - 9;
  return [currentWidth, 2, 4, 8]
    .filter((width) => width >= currentWidth)
    .find((width) =>
      width === 8
        ? lastCloneOffset <= Number.MAX_SAFE_INTEGER
        : lastCloneOffset < 2 ** (width * 8),
    );
};

/**
 * Count every expanded binary-plist reference before calling plist.parseBinary,
 * which recurses on each reference and copies shared containers. Malformed
 * structure throws TypeError; resource and cycle failures use `fail`.
 */
export const estimateBinaryPlistExpansion = (
  bytes: Buffer,
  maxBytes: number,
  {
    budget = "the property list decode budget",
    fail = propertyListDecodeBudgetFailure,
    bounds = "strict",
    numberProjection = false,
  }: BinaryPlistExpansionOptions = {},
): PlistDecodePreflight => {
  if (bytes.length < 40)
    throw new TypeError("binary plist trailer is truncated");
  const trailer = bytes.length - 32;
  const offsetSize = bytes[trailer + 6] ?? 0;
  const referenceSize = bytes[trailer + 7] ?? 0;
  if (
    ![1, 2, 4, 8].includes(offsetSize) ||
    ![1, 2, 4, 8].includes(referenceSize)
  )
    throw new TypeError("binary plist trailer integer sizes are invalid");
  const readInteger = (offset: number, size: number): number => {
    if (offset < 0 || size < 1 || offset + size > bytes.length) return -1;
    let value = 0;
    for (let index = 0; index < size; index += 1)
      value = value * 256 + (bytes[offset + index] ?? 0);
    return Number.isSafeInteger(value) ? value : -1;
  };
  const objectCount = readInteger(trailer + 8, 8);
  const topObject = readInteger(trailer + 16, 8);
  const offsetTable = readInteger(trailer + 24, 8);
  const tableEnd = bounds === "strict" ? trailer : bytes.length;
  const objectsEnd = bounds === "strict" ? offsetTable : bytes.length;
  if (
    objectCount < 1 ||
    topObject < 0 ||
    topObject >= objectCount ||
    offsetTable < 8 ||
    offsetTable + objectCount * offsetSize > tableEnd
  )
    throw new TypeError("binary plist trailer or object table is invalid");
  // Reserve source metadata and reachable-offset indexes for scalar projection.
  // Without projection, the traversal retains only structural validation state.
  const objectBytes = numberProjection ? 320 : 16;
  const expandedNodeBytes = numberProjection ? 224 : 96;
  // Scalar projection may require a same-sized parser-compatible input copy
  // for wide integers and sub-millisecond dates. Reserve before allocation.
  let estimate =
    bytes.length * (numberProjection ? 3 : 2) + objectCount * objectBytes;
  let binaryPrototypeKeyObserved = false;
  if (estimate > maxBytes)
    throw fail("expansion", `binary plist object table exceeds ${budget}`);

  const active = new Set<number>();
  const pending: Array<{
    object: number;
    depth: number;
    exit: boolean;
    dictionaryKey: boolean;
  }> = [{ object: topObject, depth: 0, exit: false, dictionaryKey: false }];
  let pendingObjectCount = 1;
  const reachableObjectOffsets = new Set<number>();
  const reachableDateOffsets = new Set<number>();
  const reachableWideIntegerOffsets = new Set<number>();
  const reachableNumericOffsets = new Set<number>();
  const reachableDateOccurrences: number[] = [];
  while (pending.length > 0) {
    const entry = pending.pop();
    if (entry === undefined) break;
    if (entry.exit) {
      active.delete(entry.object);
      continue;
    }
    pendingObjectCount -= 1;
    if (entry.depth > 128)
      throw fail("depth", `binary plist nesting exceeds ${budget}`);
    if (active.has(entry.object))
      throw fail("cycle", `binary plist reference cycle exceeds ${budget}`);
    estimate += expandedNodeBytes;
    if (estimate > maxBytes)
      throw fail(
        "expansion",
        `binary plist reference expansion exceeds ${budget}`,
      );
    const offset = readInteger(
      offsetTable + entry.object * offsetSize,
      offsetSize,
    );
    if (offset < 8 || offset >= objectsEnd)
      throw new TypeError("binary plist object offset is invalid");
    if (numberProjection) reachableObjectOffsets.add(offset);
    const marker = bytes[offset] ?? 0;
    const type = marker >> 4;
    if (entry.dictionaryKey && type !== 5 && type !== 6)
      throw new TypeError("binary plist dictionary key is not a string");
    if (type === 3) {
      if (marker !== 0x33)
        throw new TypeError(
          `binary plist date marker 0x${marker.toString(16)} is invalid`,
        );
      // The offset table and trailer are not part of an encoded object. Keep
      // this scalar boundary even when compatibility mode follows decoder
      // bounds for other object and reference checks.
      if (offset + 9 > offsetTable)
        throw new TypeError("binary plist date object is truncated");
      if (numberProjection) {
        reachableDateOffsets.add(offset);
        reachableDateOccurrences.push(offset);
      }
      continue;
    }
    if (type === 1 || type === 2) {
      const info = marker & 0x0f;
      if (type === 1 && info > 4)
        throw new TypeError("binary plist integer width is invalid");
      if (type === 2 && info !== 2 && info !== 3)
        throw new TypeError("binary plist real width is invalid");
      const width = 1 << info;
      if (offset + 1 + width > offsetTable)
        throw new TypeError("binary plist numeric scalar is truncated");
      if (numberProjection) {
        reachableNumericOffsets.add(offset);
        if (type === 1 && width === 16) reachableWideIntegerOffsets.add(offset);
      }
      continue;
    }
    let size = marker & 0x0f;
    let cursor = offset + 1;
    if (size === 0x0f && type !== 0 && type !== 8) {
      const extMarker = bytes[cursor] ?? 0;
      if (extMarker >> 4 !== 1 || (extMarker & 0x0f) > 3)
        throw new TypeError("binary plist extended object size is invalid");
      cursor += 1;
      const integerSize = 1 << (extMarker & 0x0f);
      size = readInteger(cursor, integerSize);
      cursor += integerSize;
      if (size < 0 || cursor > objectsEnd)
        throw new TypeError("binary plist extended object size is invalid");
    }
    if (type === 4 || type === 5 || type === 6) {
      const byteLength = type === 6 ? size * 2 : size;
      if (cursor + byteLength > objectsEnd)
        throw new TypeError("binary plist scalar object is truncated");
      if (
        !binaryPrototypeKeyObserved &&
        entry.dictionaryKey &&
        (type === 5 || type === 6) &&
        size === PROTOTYPE_KEY.length
      ) {
        let matches = true;
        for (let index = 0; index < PROTOTYPE_KEY.length; index += 1) {
          const codeUnit =
            type === 5
              ? (bytes[cursor + index] ?? 0)
              : ((bytes[cursor + index * 2] ?? 0) << 8) |
                (bytes[cursor + index * 2 + 1] ?? 0);
          if (codeUnit !== PROTOTYPE_KEY.charCodeAt(index)) {
            matches = false;
            break;
          }
        }
        if (matches) binaryPrototypeKeyObserved = true;
      }
      estimate += type === 4 ? size + 4 * Math.ceil(size / 3) : byteLength * 2;
      if (estimate > maxBytes)
        throw fail(
          "expansion",
          `binary plist scalar expansion exceeds ${budget}`,
        );
      continue;
    }
    if (type !== 10 && type !== 13) continue;
    const childCount = type === 13 ? size * 2 : size;
    const refsEnd = cursor + childCount * referenceSize;
    if (!Number.isSafeInteger(refsEnd) || refsEnd > objectsEnd)
      throw new TypeError("binary plist reference table is truncated");
    const availableNodes = Math.floor(
      (maxBytes - estimate) / expandedNodeBytes,
    );
    if (childCount > availableNodes - pendingObjectCount)
      throw fail(
        "expansion",
        `binary plist reference expansion exceeds ${budget}`,
      );
    active.add(entry.object);
    pending.push({
      object: entry.object,
      depth: entry.depth,
      exit: true,
      dictionaryKey: false,
    });
    for (let index = childCount - 1; index >= 0; index -= 1) {
      const reference = readInteger(
        cursor + index * referenceSize,
        referenceSize,
      );
      if (reference < 0 || reference >= objectCount)
        throw new TypeError("binary plist reference is invalid");
      pending.push({
        object: reference,
        depth: entry.depth + 1,
        exit: false,
        dictionaryKey: type === 13 && index < size,
      });
    }
    pendingObjectCount += childCount;
  }
  if (!numberProjection)
    return {
      estimatedBytes: estimate,
      binaryPrototypeKeyObserved,
      datePrecisionOverlapCount: 0,
      reachableDateOffsets: [],
      overlappingDateOffsets: [],
      reachableWideIntegerOffsets: [],
      overlappingWideIntegerOffsets: [],
      reachableNumericOffsets: [],
    };

  // Distinct objects can legally overlap in binary plists. Rewriting a date or
  // wide integer in place could change another reachable value, so isolate
  // affected scalar records in the decoder copy. Track both overlap directions
  // using the same bounded span parser as scalar collection.
  const reachableSpans = [...reachableObjectOffsets]
    .map((offset) => ({
      offset,
      end: binaryPlistObjectEnd(bytes, offset, objectsEnd, referenceSize),
    }))
    .filter(
      (span): span is { offset: number; end: number } => span.end !== undefined,
    )
    .sort((left, right) => left.offset - right.offset);
  const overlappingDateOffsets = findOverlappingScalarOffsets(
    reachableSpans,
    reachableDateOffsets,
  );
  const overlappingWideIntegerOffsets = findOverlappingScalarOffsets(
    reachableSpans,
    reachableWideIntegerOffsets,
  );
  const precisionUnknownDateOffsets = [...overlappingDateOffsets]
    .filter((offset) => {
      const seconds = new DataView(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength,
      ).getFloat64(offset + 1);
      return binaryDateRequiresExactSeconds(seconds);
    })
    .sort((left, right) => left - right);
  const cloneOffsets = new Set([
    ...precisionUnknownDateOffsets,
    ...overlappingWideIntegerOffsets,
  ]);
  if (cloneOffsets.size > 0) {
    const cloneBytes = cloneOffsets.size * 9;
    const newOffsetSize = findExactScalarCloneOffsetWidth(
      offsetSize,
      offsetTable,
      cloneOffsets.size,
    );
    if (newOffsetSize === undefined)
      throw new TypeError(
        "binary plist cloned scalar offset exceeds supported width",
      );
    estimate += cloneBytes + objectCount * (newOffsetSize - offsetSize);
    if (estimate > maxBytes)
      throw fail(
        "expansion",
        `binary plist scalar-copy expansion exceeds ${budget}`,
      );
  }
  const precisionUnknownOffsets = new Set(precisionUnknownDateOffsets);
  const datePrecisionOverlapCount = reachableDateOccurrences.filter((offset) =>
    precisionUnknownOffsets.has(offset),
  ).length;
  return {
    estimatedBytes: estimate,
    binaryPrototypeKeyObserved,
    datePrecisionOverlapCount,
    reachableDateOffsets: [...reachableDateOffsets].sort(
      (left, right) => left - right,
    ),
    overlappingDateOffsets: precisionUnknownDateOffsets,
    reachableWideIntegerOffsets: [...reachableWideIntegerOffsets].sort(
      (left, right) => left - right,
    ),
    overlappingWideIntegerOffsets: [...overlappingWideIntegerOffsets].sort(
      (left, right) => left - right,
    ),
    reachableNumericOffsets: [...reachableNumericOffsets].sort(
      (left, right) => left - right,
    ),
  };
};
