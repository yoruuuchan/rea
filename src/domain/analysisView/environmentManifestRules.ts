import {
  compareUnicodeCodePoints as compare,
  compositeKey,
} from "../unicodeCodePointOrder.js";
import { ROUTE_RULES, type RouteRule } from "./webNetworkRouteTemplates.js";

/** Opt-in template rules applied after the four exact format rules. */
export const TEMPLATE_RULES = [
  "after-uid-literal",
  "opaque-token",
  "sibling-variance",
] as const;
export type TemplateRule = (typeof TEMPLATE_RULES)[number];
export type ManifestRule = RouteRule | TemplateRule;

export type JsonTypeName =
  | "string"
  | "number"
  | "boolean"
  | "object"
  | "array"
  | "null";

/** Value-free top-level JSON key types of one recorded request body. */
export interface BodyShape {
  readonly type: "object";
  readonly properties: Readonly<Record<string, JsonTypeName>>;
}

export interface LiteralPart {
  readonly kind: "literal";
  readonly value: string;
}
export interface ParamPart {
  readonly kind: "param";
  readonly rule: ManifestRule;
  readonly values: ReadonlySet<string>;
}
export type RoutePart = LiteralPart | ParamPart;

/** One candidate tool: a merged request-line group on the primary origin. */
export interface ToolGroup {
  readonly method: string;
  readonly origin: string;
  readonly api_surface_template: string;
  readonly parts: readonly RoutePart[];
  /** Record positions in admission order; the first is the earliest record. */
  readonly positions: readonly number[];
  readonly statuses: ReadonlySet<number>;
  readonly contentTypes: ReadonlySet<string>;
  readonly queryNames: ReadonlySet<string>;
  readonly bodyShape: BodyShape | null;
}

const OPAQUE_TOKEN = /^(?=.*\d)(?=.*[a-z])[a-z0-9]{12,}$/u;
const VERSION_TOKEN = /^v\d/u;
const STOP_WORDS = new Set([
  "search",
  "settings",
  "errors",
  "list",
  "members",
  "versions",
  "health",
  "merged",
  "usage",
  "checks",
  "dto",
  "markdown",
]);
const DROPPED_NAME_LITERALS = new Set(["api", "apis", "namespaces", "default"]);
const TOOL_NAME_LIMIT = 60;
/** Longest route sibling-variance compares; every position rebuilds a key over the whole route. */
export const SIBLING_VARIANCE_SEGMENT_LIMIT = 32;
const BASE_RULES: ReadonlySet<string> = new Set(ROUTE_RULES);
const OPT_IN_RULES: ReadonlySet<string> = new Set(TEMPLATE_RULES);

const param = (rule: ManifestRule, values: Iterable<string>): ParamPart => ({
  kind: "param",
  rule,
  values: new Set(values),
});

const partKey = (part: RoutePart): unknown =>
  part.kind === "literal" ? part.value : ["param", part.rule];

const withParts = (
  group: ToolGroup,
  parts: readonly RoutePart[],
): ToolGroup => ({
  ...group,
  parts,
});

const earliest = (groups: readonly ToolGroup[]): ToolGroup =>
  groups.reduce((best, group) =>
    (group.positions[0] ?? Infinity) < (best.positions[0] ?? Infinity)
      ? group
      : best,
  );

/** Merge groups around `shape`; literal siblings of its templated positions become observed values. */
const mergeGroups = (
  groups: readonly ToolGroup[],
  shape = earliest(groups),
): ToolGroup => {
  if (groups.length === 1) return groups[0]!;
  const primary = earliest(groups);
  return {
    method: primary.method,
    origin: primary.origin,
    api_surface_template: primary.api_surface_template,
    parts: shape.parts.map((part, index) =>
      part.kind === "literal"
        ? part
        : param(
            part.rule,
            groups.flatMap((group) => {
              const sibling = group.parts[index];
              if (sibling === undefined) return [];
              return sibling.kind === "param"
                ? [...sibling.values]
                : [sibling.value];
            }),
          ),
    ),
    positions: groups
      .flatMap((group) => group.positions)
      .sort((left, right) => left - right),
    statuses: new Set(groups.flatMap((group) => [...group.statuses])),
    contentTypes: new Set(groups.flatMap((group) => [...group.contentTypes])),
    queryNames: new Set(groups.flatMap((group) => [...group.queryNames])),
    bodyShape: primary.bodyShape,
  };
};

const rebucket = (groups: readonly ToolGroup[]): ToolGroup[] => {
  const buckets = new Map<string, ToolGroup[]>();
  for (const group of groups) {
    const key = compositeKey([
      group.method,
      group.origin,
      ...group.parts.map(partKey),
    ]);
    const bucket = buckets.get(key);
    if (bucket === undefined) buckets.set(key, [group]);
    else bucket.push(group);
  }
  return [...buckets.values()].map((bucket) => mergeGroups(bucket));
};

const templateAfterUidLiteral = (parts: readonly RoutePart[]): RoutePart[] =>
  parts.map((part, index) => {
    const previous = parts[index - 1];
    return part.kind === "literal" &&
      previous?.kind === "literal" &&
      previous.value === "uid" &&
      !STOP_WORDS.has(part.value)
      ? param("after-uid-literal", [part.value])
      : part;
  });

const templateOpaqueTokens = (parts: readonly RoutePart[]): RoutePart[] =>
  parts.map((part) =>
    part.kind === "literal" &&
    OPAQUE_TOKEN.test(part.value) &&
    !VERSION_TOKEN.test(part.value)
      ? param("opaque-token", [part.value])
      : part,
  );

const literalAt = (group: ToolGroup, position: number): string => {
  const part = group.parts[position];
  return part?.kind === "literal" ? part.value : "";
};

/** The siblings whose literal looks like an identifier: each carries a digit or colon, or three or more are hyphenated names under a plural literal. Stop words never qualify. */
const identifierLikeSiblings = (
  literal: readonly ToolGroup[],
  position: number,
): ReadonlySet<ToolGroup> => {
  const eligible = new Set<ToolGroup>();
  const previous = literal[0]?.parts[position - 1];
  const plural = previous?.kind === "literal" && previous.value.endsWith("s");
  const hyphenated: ToolGroup[] = [];
  for (const group of literal) {
    const value = literalAt(group, position);
    if (STOP_WORDS.has(value)) continue;
    if (/[\d:]/u.test(value)) eligible.add(group);
    if (plural && value.includes("-")) hyphenated.push(group);
  }
  if (hyphenated.length >= 3)
    for (const group of hyphenated) eligible.add(group);
  return eligible;
};

const optInParamAt = (group: ToolGroup, position: number): boolean => {
  const part = group.parts[position];
  return part?.kind === "param" && OPT_IN_RULES.has(part.rule);
};

/** Merge the identifier-like literal siblings into one sibling-variance parameter; other literals stay their own tools. */
const mergeLiteralSiblings = (
  literal: readonly ToolGroup[],
  position: number,
): ToolGroup[] => {
  const eligible = identifierLikeSiblings(literal, position);
  if (eligible.size < 2) return [...literal];
  const groups = [...eligible];
  const first = earliest(groups);
  const shape = withParts(
    first,
    first.parts.map((part, index) =>
      index === position
        ? param("sibling-variance", [literalAt(first, position)])
        : part,
    ),
  );
  return [
    mergeGroups(
      groups.map((group) => (group === first ? shape : group)),
      shape,
    ),
    ...literal.filter((group) => !eligible.has(group)),
  ];
};

/** Fold literal siblings into an opt-in parameter only; format-rule parameters absorb no literal. */
const mergeSiblings = (
  bucket: readonly ToolGroup[],
  position: number,
): ToolGroup[] => {
  if (bucket.length < 2) return [...bucket];
  const templated = bucket.filter(
    (group) => group.parts[position]?.kind === "param",
  );
  const literal = bucket.filter(
    (group) => group.parts[position]?.kind === "literal",
  );
  const targets = templated.filter((group) => optInParamAt(group, position));
  if (targets.length === 0)
    return [...templated, ...mergeLiteralSiblings(literal, position)];
  const target = earliest(targets);
  const foldable = new Set(
    literal.filter((group) => !STOP_WORDS.has(literalAt(group, position))),
  );
  return [
    mergeGroups([target, ...foldable], target),
    ...templated.filter((group) => group !== target),
    ...literal.filter((group) => !foldable.has(group)),
  ];
};

/** Merge groups that differ in exactly one identifier-like segment at index two or later. */
const mergeSiblingVariance = (groups: readonly ToolGroup[]): ToolGroup[] => {
  const beyondLimit = groups.filter(
    (group) => group.parts.length > SIBLING_VARIANCE_SEGMENT_LIMIT,
  );
  let current = groups.filter(
    (group) => group.parts.length <= SIBLING_VARIANCE_SEGMENT_LIMIT,
  );
  const longest = Math.max(0, ...current.map((group) => group.parts.length));
  for (let position = 2; position < longest; position += 1) {
    const buckets = new Map<string, ToolGroup[]>();
    const output: ToolGroup[] = [];
    for (const group of current) {
      if (position >= group.parts.length) {
        output.push(group);
        continue;
      }
      const key = compositeKey([
        group.method,
        group.origin,
        group.parts.length,
        ...group.parts.map((part, index) =>
          index === position ? null : partKey(part),
        ),
      ]);
      const bucket = buckets.get(key);
      if (bucket === undefined) buckets.set(key, [group]);
      else bucket.push(group);
    }
    for (const bucket of buckets.values())
      output.push(...mergeSiblings(bucket, position));
    current = output;
  }
  return [...current, ...beyondLimit];
};

/** Apply the selected opt-in rules in fixed order; every merge is an inference. */
export const applyTemplateRules = (
  groups: readonly ToolGroup[],
  rules: ReadonlySet<TemplateRule>,
): ToolGroup[] => {
  let current = [...groups];
  if (rules.has("after-uid-literal"))
    current = current.map((group) =>
      withParts(group, templateAfterUidLiteral(group.parts)),
    );
  if (rules.has("opaque-token"))
    current = current.map((group) =>
      withParts(group, templateOpaqueTokens(group.parts)),
    );
  current = rebucket(current);
  if (rules.has("sibling-variance")) current = mergeSiblingVariance(current);
  return current;
};

const sanitizeToken = (text: string): string =>
  text
    .toLowerCase()
    .replaceAll(/[^a-z0-9_]+/gu, "_")
    .replaceAll(/_+/gu, "_")
    .replace(/^_/u, "")
    .replace(/_$/u, "");

const singular = (word: string): string => {
  if (word.endsWith("ies") && word.length > 3) return `${word.slice(0, -3)}y`;
  if (word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
};

const paramBaseName = (parts: readonly RoutePart[], index: number): string => {
  const part = parts[index];
  if (part?.kind !== "param") return "";
  switch (part.rule) {
    case "numeric":
      return "id";
    case "uuid":
      return "uuid";
    case "hex":
      return "hash";
    case "iso-date":
      return "date";
    case "after-uid-literal":
    case "opaque-token":
      return "uid";
    case "sibling-variance": {
      const previous = parts[index - 1];
      const stem =
        previous?.kind === "literal"
          ? sanitizeToken(singular(previous.value))
          : "";
      return stem.length > 0 ? `${stem}_id` : "id";
    }
  }
};

/** Parameter names in segment order; repeated names get numeric suffixes. */
export const parameterNames = (parts: readonly RoutePart[]): string[] => {
  const used = new Map<string, number>();
  return parts.flatMap((part, index) => {
    if (part.kind !== "param") return [];
    const base = paramBaseName(parts, index);
    const count = used.get(base) ?? 0;
    used.set(base, count + 1);
    return [count === 0 ? base : `${base}_${String(count + 1)}`];
  });
};

/** Format-rule placeholders keep their api-surface spelling; opt-in rules use the parameter name. */
export const pathTemplate = (
  parts: readonly RoutePart[],
  names: readonly string[],
): string => {
  let next = 0;
  return `/${parts
    .map((part) => {
      if (part.kind === "literal") return part.value;
      const name = names[next] ?? "";
      next += 1;
      return BASE_RULES.has(part.rule) ? `{${part.rule}}` : `{${name}}`;
    })
    .join("/")}`;
};

/** Names assigned in one manifest and the next suffix to try for each colliding truncated base. */
export interface ToolNameRegistry {
  readonly used: Set<string>;
  readonly nextSuffix: Map<string, number>;
}
export const toolNameRegistry = (): ToolNameRegistry => ({
  used: new Set(),
  nextSuffix: new Map(),
});
/** Deterministic tool name from the method and route literals, unique within a manifest. */
export const toolName = (
  method: string,
  parts: readonly RoutePart[],
  names: readonly string[],
  registry: ToolNameRegistry,
): string => {
  const literals = parts.flatMap((part, index) => {
    if (part.kind !== "literal") return [];
    const value = part.value;
    if (
      value.length === 0 ||
      DROPPED_NAME_LITERALS.has(value) ||
      VERSION_TOKEN.test(value) ||
      (value === "uid" && parts[index + 1]?.kind === "param")
    )
      return [];
    return [value.split(".")[0] ?? ""];
  });
  const base =
    sanitizeToken(
      [
        method.toLowerCase(),
        ...literals,
        ...(names.length > 0 ? ["by", ...names] : []),
      ].join("_"),
    ) || "tool";
  const truncate = (text: string, limit: number): string =>
    text.slice(0, limit).replace(/_+$/u, "");
  let candidate = truncate(base, TOOL_NAME_LIMIT);
  if (registry.used.has(candidate)) {
    let suffix = 2;
    for (;;) {
      const tail = `_${String(suffix)}`;
      const prefix = truncate(base, TOOL_NAME_LIMIT - tail.length);
      // Suffixes can truncate distinct full names to the same prefix. Share
      // progress for that actual candidate family, separately for each width:
      // a longer suffix can change the prefix and must not skip free short names.
      const namespace = compositeKey([prefix, tail.length]);
      const next = registry.nextSuffix.get(namespace) ?? suffix;
      if (next > suffix) {
        suffix = next;
        continue;
      }
      candidate = `${prefix}${tail}`;
      registry.nextSuffix.set(namespace, suffix + 1);
      if (!registry.used.has(candidate)) break;
      suffix += 1;
    }
  }
  registry.used.add(candidate);
  return candidate;
};

/** Sort tools by template then method with locale-independent ordering. */
export const compareTools = (
  left: { readonly template: string; readonly method: string },
  right: { readonly template: string; readonly method: string },
): number =>
  compare(left.template, right.template) || compare(left.method, right.method);
