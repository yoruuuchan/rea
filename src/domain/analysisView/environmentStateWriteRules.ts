import type { JsonValue } from "../jsonValue.js";
import {
  isParam,
  normalizedPath,
  segmentsOf,
  type JsonObject,
} from "./environmentStateRules.js";
import type { ClockFormat } from "./environmentStateWriteValues.js";

/** What a write tool does to the state, by method and the target its path names. */
export type WriteEffect = "create" | "update" | "delete" | "document" | "none";

/** Why a write tool is not served. */
export type WriteReason =
  | "no-state-target"
  | "no-call"
  | "body-unusable"
  | "no-observation"
  | "unexplained-change"
  | "contradicted"
  | "side-effect"
  | "unconfirmed"
  | "incomplete-entities";

/** Rules that generate a value when served; the gate takes the recorded value instead. */
export type GeneratedRule =
  | {
      readonly field: string;
      readonly rule: "identity";
      readonly generator: "sequence" | "uuid" | "token";
    }
  | {
      readonly field: string;
      readonly rule: "sequence";
      readonly scope: "collection" | "type";
    }
  | { readonly field: string; readonly rule: "unique" }
  | {
      readonly field: string;
      readonly rule: "clock";
      readonly format: ClockFormat;
    };

/** How one field of a written entity gets its value; fields no rule names keep the observed value. */
export type FieldRule =
  | GeneratedRule
  | { readonly field: string; readonly rule: "echo" }
  | { readonly field: string; readonly rule: "copy"; readonly from: string }
  | { readonly field: string; readonly rule: "path"; readonly from: string }
  | { readonly field: string; readonly rule: "slug"; readonly from: string }
  | { readonly field: string; readonly rule: "template"; readonly from: string }
  | { readonly field: string; readonly rule: "increment" }
  /** An update stores `value` whenever the call sends the member, as the call that showed it did. */
  | {
      readonly field: string;
      readonly rule: "constant";
      readonly value: JsonValue;
    };

/** Where a create places its entity in its collection's order. */
export type InsertRule =
  | { readonly rule: "first" | "last" }
  | {
      readonly rule: "sorted";
      readonly field: string;
      readonly direction: "ascending" | "descending";
    };

/** The JSON type of a stored value that is not null. */
export type JsonKind = "array" | "boolean" | "number" | "object" | "string";

/** The body members a write accepts: echoed ones with any value, fixed ones only with the value they were sent. */
export interface WriteBody {
  readonly accepted: string[];
  readonly fixed: { readonly member: string; readonly sent: JsonValue }[];
  readonly required: string[];
  /** The member that may repeat the target's identity, which must then equal the path's. */
  readonly identity: string | null;
  /** The JSON type a later call stored an accepted member as, for members the observation does not show. */
  readonly kinds: { readonly member: string; readonly kind: JsonKind }[];
}

/** What a write answers: the written entity or its identity rendered into a recorded body, no body, or the recorded body. */
export interface WriteResponse {
  readonly ordinal: number;
  readonly shape: "entity" | "identity" | "empty" | "recorded";
  readonly pointer: string | null;
}

/** One write tool's modelled effect and whether the capture confirmed it. */
export interface StateWritePlan {
  readonly tool: string;
  readonly effect: WriteEffect;
  /** The entity type for entity effects; the document tool for a document write. */
  readonly target: string | null;
  readonly served: boolean;
  readonly reason: WriteReason | null;
  readonly exemplar_ordinal: number | null;
  /** The record whose response showed the written entity or document, and where. */
  readonly observation: {
    readonly ordinal: number;
    readonly pointer: string;
  } | null;
  readonly response: WriteResponse | null;
  readonly body: WriteBody | null;
  readonly rules: FieldRule[];
  /** A create tied to the exemplar's collection writes only there. */
  readonly collection: string | null;
  readonly insert: InsertRule | null;
  readonly merge: "merge" | "replace" | null;
  readonly checked_record_ordinals: number[];
  readonly contradicted_by: number | null;
}

/** The tool facts classification reads. */
interface WriteToolFacts {
  readonly method: string;
  readonly path_template: string;
}

/** The effect a state-changing tool has and its target: a state type, or a document tool by template. */
export const classifyWrite = (
  tool: WriteToolFacts,
  types: ReadonlySet<string>,
  documents: ReadonlyMap<string, string>,
): { readonly effect: WriteEffect; readonly target: string | null } => {
  const segments = segmentsOf(tool.path_template);
  const path = normalizedPath(tool.path_template);
  const parent = `/${segments.slice(0, -1).join("/")}`;
  const item = segments.length > 0 && isParam(segments.at(-1)!);
  if (tool.method === "POST" && types.has(path))
    return { effect: "create", target: path };
  if (item && types.has(parent)) {
    if (tool.method === "DELETE") return { effect: "delete", target: parent };
    if (["PUT", "PATCH", "POST"].includes(tool.method))
      return { effect: "update", target: parent };
  }
  const document = documents.get(path);
  if (document !== undefined && ["PUT", "PATCH", "POST"].includes(tool.method))
    return { effect: "document", target: document };
  return { effect: "none", target: null };
};

/** A plan for a tool whose effect is not modelled or cannot be built. */
export const unservedPlan = (
  tool: string,
  effect: WriteEffect,
  target: string | null,
  reason: WriteReason,
): StateWritePlan => ({
  tool,
  effect,
  target,
  served: false,
  reason,
  exemplar_ordinal: null,
  observation: null,
  response: null,
  body: null,
  rules: [],
  collection: null,
  insert: null,
  merge: null,
  checked_record_ordinals: [],
  contradicted_by: null,
});

/** One write call: its concrete path, the values its path parameters took and its body. */
export interface WriteCall {
  readonly path: string;
  readonly pathValues: ReadonlyMap<string, string>;
  readonly body: JsonObject | undefined;
}

/** The value each template parameter takes in a concrete path, decoded; undefined when the path does not instantiate it. */
export const pathValuesOf = (
  template: string,
  path: string,
): Map<string, string> | undefined => {
  const pattern = segmentsOf(template);
  const concrete = segmentsOf(path);
  if (pattern.length !== concrete.length) return undefined;
  const values = new Map<string, string>();
  for (const [index, segment] of pattern.entries()) {
    const value = concrete[index]!;
    if (!isParam(segment)) {
      if (segment !== value) return undefined;
      continue;
    }
    let decoded = value;
    try {
      decoded = decodeURIComponent(value);
    } catch {
      decoded = value;
    }
    values.set(segment.slice(1, -1), decoded);
  }
  return values;
};

/** Whether two paths are segment prefixes of one another, a parameter on either side matching any segment. */
export const prefixRelated = (left: string, right: string): boolean => {
  const a = segmentsOf(left);
  const b = segmentsOf(right);
  const shared = Math.min(a.length, b.length);
  for (let index = 0; index < shared; index += 1)
    if (!isParam(a[index]!) && !isParam(b[index]!) && a[index] !== b[index])
      return false;
  return true;
};
