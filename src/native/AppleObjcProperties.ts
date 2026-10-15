import type { z } from "zod";

import type { objcPropertySchema } from "../domain/native/objcSwiftMetadata.js";
import { issue, type DecodeIssue } from "./AppleDispatchDecodeFacts.js";

type ObjcProperty = z.infer<typeof objcPropertySchema>;

/** Byte readers needed to decode an Objective-C `property_list_t`. */
export interface ObjcPropertyReaders {
  u32(address: bigint): number;
  pointer(address: bigint): bigint;
  string(address: bigint): string;
}

/**
 * Parse an `@property` attribute string such as `T@"NSString",C,N,V_name`.
 * Each comma-separated token is one attribute; `T` is the type encoding.
 */
export const parsePropertyAttributes = (
  name: string,
  attributes: string,
): ObjcProperty => decodePropertyAttributes(name, attributes).property;

/**
 * Decode one attribute string. A quoted class name that never closes leaves
 * the string incomplete: later attributes may be inside the unfinished type,
 * so a missing `N` or `R` does not establish the Objective-C defaults.
 */
const decodePropertyAttributes = (
  name: string,
  attributes: string,
): { readonly property: ObjcProperty; readonly complete: boolean } => {
  const { tokens, complete } =
    attributes.length === 0
      ? { tokens: [], complete: true }
      : splitAttributes(attributes);
  const typeAttributes = tokens.filter((token) => token[0] === "T");
  const typeAttribute =
    typeAttributes.length === 1 ? typeAttributes[0] : undefined;
  const typeEncoding =
    typeAttribute !== undefined && typeAttribute.length > 1
      ? typeAttribute.slice(1)
      : null;
  const value = (code: string): string | null =>
    tokens.find((token) => token[0] === code)?.slice(1) ?? null;
  const defaultsEstablished = typeEncoding !== null && complete;
  const property: ObjcProperty = {
    name,
    type_encoding: typeEncoding,
    attributes: tokens.map((token) => ({
      name: token.slice(0, 1),
      value: token.slice(1),
    })),
    atomicity: tokens.includes("N")
      ? "nonatomic"
      : defaultsEstablished
        ? "atomic"
        : null,
    is_readonly: tokens.includes("R")
      ? true
      : defaultsEstablished
        ? false
        : null,
    getter: value("G"),
    setter: value("S"),
  };
  return { property, complete };
};

/**
 * Split on commas that are outside a quoted class name in the type encoding,
 * and report whether every quote closed.
 */
const splitAttributes = (
  attributes: string,
): { readonly tokens: string[]; readonly complete: boolean } => {
  const tokens: string[] = [];
  let current = "";
  let quoted = false;
  for (const character of attributes) {
    if (character === '"') quoted = !quoted;
    if (character === "," && !quoted) {
      tokens.push(current);
      current = "";
    } else current += character;
  }
  tokens.push(current);
  return {
    tokens: tokens.filter((token) => token.length > 0),
    complete: !quoted,
  };
};

/** Decode `property_list_t { entsize_and_flags, count, property_t[] }`. */
export const readObjcPropertyList = (
  read: ObjcPropertyReaders,
  list: bigint,
  admit: () => boolean,
): {
  readonly properties: ObjcProperty[];
  /** Names of properties whose attribute string is incomplete. */
  readonly incomplete: string[];
} => {
  const incomplete: string[] = [];
  if (list === 0n) return { properties: [], incomplete };
  const entrySize = read.u32(list) & ~3;
  const count = read.u32(list + 4n);
  if (entrySize !== 16)
    throw new TypeError(
      `Unsupported Objective-C property entry size ${entrySize}`,
    );
  const properties: ObjcProperty[] = [];
  for (let index = 0; index < count; index++) {
    if (!admit()) break;
    const entry = list + 8n + BigInt(index * entrySize);
    const decoded = decodePropertyAttributes(
      read.string(read.pointer(entry)),
      read.string(read.pointer(entry + 8n)),
    );
    properties.push(decoded.property);
    if (!decoded.complete) incomplete.push(decoded.property.name);
  }
  return { properties, incomplete };
};

/** Decode a property list, recording a failure for `owner` instead of throwing. */
export const readObjcPropertiesOf = (
  read: ObjcPropertyReaders,
  list: bigint,
  context: {
    readonly owner: string;
    readonly admit: () => boolean;
    readonly issues: DecodeIssue[];
    readonly location?: string;
  },
): ObjcProperty[] => {
  try {
    const { properties, incomplete } = readObjcPropertyList(
      read,
      list,
      context.admit,
    );
    for (const name of incomplete)
      context.issues.push(
        issue(
          "objc_properties_categories",
          "property_attributes_incomplete",
          `${context.owner}.${name}: the type attribute has an unterminated quoted class name, so atomicity and unestablished read-only state are unknown`,
          context.location,
        ),
      );
    return properties;
  } catch (cause: unknown) {
    context.issues.push(
      issue(
        "objc_properties_categories",
        "property_decode_failed",
        `${context.owner}: ${cause instanceof Error ? cause.message : String(cause)}`,
        context.location,
      ),
    );
    return [];
  }
};
