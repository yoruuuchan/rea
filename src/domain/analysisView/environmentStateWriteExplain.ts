import type { JsonValue } from "../jsonValue.js";
import { compareUnicodeCodePoints as compare } from "../unicodeCodePointOrder.js";
import { storedKinds } from "./environmentStateWriteApply.js";
import {
  isObject,
  locateItem,
  pointerTo,
  same,
  scalarText,
  type JsonObject,
} from "./environmentStateRules.js";
import type {
  FieldRule,
  InsertRule,
  StateWritePlan,
  WriteBody,
  WriteCall,
  WriteResponse,
} from "./environmentStateWriteRules.js";
import {
  containsDelimited,
  delimitedOffsets,
  integerOf,
  isUuid,
  readClock,
  slugOf,
} from "./environmentStateWriteValues.js";

/** A clock value counts as written by the request when it lies this close to the request's start. */
const CLOCK_WINDOW_MS = 10 * 60_000;
/** Shorter body strings are too common to show that a field copied one. */
const COPY_MIN_LENGTH = 8;

/** What explaining a create reads: the observed entity, the call that wrote it and the entities it joined. */
export interface CreateEvidence {
  readonly entity: JsonObject;
  readonly call: WriteCall & { readonly body: JsonObject };
  readonly idField: string;
  /** The request's start in epoch milliseconds, when the timeline is timed. */
  readonly startMs: number | undefined;
  readonly collection: readonly JsonObject[];
  readonly type: readonly JsonObject[];
}

/** What explaining a create looks values up in, built once per request body. */
interface BodyIndex {
  /** Each body string long enough to show a copy, at its shallowest pointer (breadth-first, members in order). */
  readonly copies: ReadonlyMap<string, string>;
  /** Each slug a top-level string member slugs to, other than its own value, from the first such member. */
  readonly slugs: ReadonlyMap<string, string>;
}

/** Index a request body once, so explaining each field looks values up rather than walking the body again. */
const indexBody = (body: JsonObject): BodyIndex => {
  const copies = new Map<string, string>();
  const pending: { readonly value: JsonValue; readonly pointer: string }[] = [
    { value: body, pointer: "" },
  ];
  // An index walks the queue: shifting a wide body's values one by one would take quadratic time.
  for (let at = 0; at < pending.length; at += 1) {
    const next = pending[at]!;
    if (typeof next.value === "string") {
      if (next.value.length >= COPY_MIN_LENGTH && !copies.has(next.value))
        copies.set(next.value, next.pointer);
      continue;
    }
    const children: [string, JsonValue][] = Array.isArray(next.value)
      ? next.value.map((item, index) => [String(index), item])
      : isObject(next.value)
        ? Object.entries(next.value)
        : [];
    for (const [key, item] of children)
      pending.push({
        value: item,
        pointer: `${next.pointer}${pointerTo(key)}`,
      });
  }
  const slugs = new Map<string, string>();
  for (const [member, sent] of Object.entries(body))
    if (typeof sent === "string") {
      const slug = slugOf(sent);
      if (slug !== sent && !slugs.has(slug)) slugs.set(slug, member);
    }
  return { copies, slugs };
};

const isClockNear = (
  value: JsonValue,
  startMs: number | undefined,
): boolean => {
  const clock = readClock(value);
  return (
    clock !== undefined &&
    startMs !== undefined &&
    Math.abs(clock.ms - startMs) <= CLOCK_WINDOW_MS
  );
};

/** One more than the largest integer the members hold in the field, or undefined when none holds one. */
export const nextInteger = (
  members: readonly JsonObject[],
  field: string,
): number | undefined => {
  let largest: number | undefined;
  for (const member of members) {
    const value = integerOf(member[field]);
    if (value !== undefined && (largest === undefined || value > largest))
      largest = value;
  }
  return largest === undefined ? undefined : largest + 1;
};

const identityRule = (field: string, value: JsonValue): FieldRule => ({
  field,
  rule: "identity",
  generator:
    integerOf(value) !== undefined
      ? "sequence"
      : isUuid(value)
        ? "uuid"
        : "token",
});

/** The rule a request explains a created field by, before generated values and templates are considered. */
const requestRule = (
  evidence: CreateEvidence,
  index: BodyIndex,
  field: string,
  value: JsonValue,
): FieldRule | undefined => {
  const { body, pathValues } = evidence.call;
  if (Object.hasOwn(body, field) && same(body[field], value))
    return { field, rule: "echo" };
  if (typeof value === "string" && value.length >= COPY_MIN_LENGTH) {
    const from = index.copies.get(value);
    if (from !== undefined) return { field, rule: "copy", from };
  }
  const text = scalarText(value);
  for (const [name, pathValue] of pathValues)
    if (text !== undefined && text === pathValue)
      return { field, rule: "path", from: name };
  const slugged = typeof value === "string" && value.length >= 3;
  const member = slugged ? index.slugs.get(value) : undefined;
  return member === undefined
    ? undefined
    : { field, rule: "slug", from: member };
};

/** The rule a created field's generated value follows, if it follows one. */
const generatedRule = (
  evidence: CreateEvidence,
  field: string,
  value: JsonValue,
): FieldRule | undefined => {
  if (field === evidence.idField) return identityRule(field, value);
  const clock = readClock(value);
  if (clock !== undefined && isClockNear(value, evidence.startMs))
    return { field, rule: "clock", format: clock.format };
  const integer = integerOf(value);
  if (integer !== undefined) {
    if (nextInteger(evidence.collection, field) === integer)
      return { field, rule: "sequence", scope: "collection" };
    if (nextInteger(evidence.type, field) === integer)
      return { field, rule: "sequence", scope: "type" };
  }
  if (
    isUuid(value) &&
    evidence.type.length > 0 &&
    evidence.type.every((member) => member[field] !== value)
  )
    return { field, rule: "unique" };
  return undefined;
};

/** A string that embeds a generated value delimited is rebuilt around the new value. */
const templateRule = (
  entity: JsonObject,
  field: string,
  generated: readonly FieldRule[],
): FieldRule | undefined => {
  const value = entity[field];
  if (typeof value !== "string") return undefined;
  for (const rule of generated) {
    const token = scalarText(entity[rule.field]);
    if (
      rule.field !== field &&
      token !== undefined &&
      token.length > 0 &&
      delimitedOffsets(value, token).length > 0
    )
      return { field, rule: "template", from: rule.field };
  }
  return undefined;
};

/** Body members the application stored as sent, and the others with what they were sent. */
const bodyOf = (
  body: JsonObject,
  echoed: ReadonlySet<string>,
  required: readonly string[],
): WriteBody => ({
  accepted: Object.keys(body).filter((member) => echoed.has(member)),
  fixed: Object.entries(body)
    .filter(([member]) => !echoed.has(member))
    .map(([member, sent]) => ({ member, sent })),
  required: [...required],
  identity: null,
  kinds: [],
});

/** Explain every field of a created entity: echoed, copied, path, slug, generated, template or constant (unlisted). */
export const explainCreate = (
  evidence: CreateEvidence,
): {
  readonly rules: FieldRule[];
  readonly body: WriteBody;
  readonly tied: boolean;
} => {
  const rules: FieldRule[] = [];
  const unexplained: string[] = [];
  const index = indexBody(evidence.call.body);
  for (const [field, value] of Object.entries(evidence.entity)) {
    const rule =
      requestRule(evidence, index, field, value) ??
      generatedRule(evidence, field, value);
    if (rule === undefined) unexplained.push(field);
    else rules.push(rule);
  }
  const generated = rules.filter(
    (rule) =>
      rule.rule === "identity" ||
      rule.rule === "sequence" ||
      rule.rule === "unique",
  );
  const constants: string[] = [];
  for (const field of unexplained) {
    const template = templateRule(evidence.entity, field, generated);
    if (template === undefined) constants.push(field);
    else rules.push(template);
  }
  const echoed = new Set(
    rules.filter((rule) => rule.rule === "echo").map((rule) => rule.field),
  );
  const tokens = [...evidence.call.pathValues.values()].filter(
    (value) => value.length > 0,
  );
  return {
    rules,
    body: bodyOf(evidence.call.body, echoed, Object.keys(evidence.call.body)),
    // A template rebuilds only its generated value, so other text it keeps ties it like a constant.
    tied: [
      ...constants,
      ...rules.flatMap((rule) =>
        rule.rule === "template" ? [rule.field] : [],
      ),
    ].some((field) =>
      tokens.some((token) => containsDelimited(evidence.entity[field]!, token)),
    ),
  };
};

/** What explaining an update reads: the entity before and after, the call and its method. */
export interface UpdateEvidence {
  readonly before: JsonObject;
  readonly after: JsonObject;
  readonly call: WriteCall & { readonly body: JsonObject };
  readonly method: string;
  readonly idField: string;
  readonly id: string;
  readonly startMs: number | undefined;
  /** Fields covered by a later read view. Missing fields outside that coverage remain unknown. */
  readonly readFields?: readonly string[];
  /** The fields of the observing read's view when that view showed the entity before, so one the entity lacked was added. */
  readonly shown?: readonly string[];
}

/** The rule a field the update changed without sending follows, if any; `slugs` maps each echoed member's slug to the first such member. */
const changeRule = (
  evidence: UpdateEvidence,
  field: string,
  slugs: ReadonlyMap<string, string>,
): FieldRule | undefined => {
  const before = evidence.before[field];
  const after = evidence.after[field]!;
  if (readClock(after) !== undefined && isClockNear(after, evidence.startMs))
    return { field, rule: "clock", format: readClock(after)!.format };
  const was = integerOf(before);
  if (was !== undefined && integerOf(after) === was + 1)
    return { field, rule: "increment" };
  const member = typeof after === "string" ? slugs.get(after) : undefined;
  return member === undefined
    ? undefined
    : { field, rule: "slug", from: member };
};

/** Each slug an echoed string member slugs to, from the first such member. */
const echoedSlugs = (
  body: JsonObject,
  echoed: ReadonlySet<string>,
): Map<string, string> => {
  const slugs = new Map<string, string>();
  for (const member of echoed) {
    const sent = body[member];
    if (typeof sent === "string" && !slugs.has(slugOf(sent)))
      slugs.set(slugOf(sent), member);
  }
  return slugs;
};

/** Explain an update: echoed members, fixed members whose stored value is constant, and the changes it made unsent. */
export const explainUpdate = (
  evidence: UpdateEvidence,
): {
  readonly rules: FieldRule[];
  readonly body: WriteBody;
  readonly unexplained: string[];
} => {
  const { body } = evidence.call;
  const rules: FieldRule[] = [];
  const echoed = new Set<string>();
  const unexplained: string[] = [];
  let identity: string | null = null;
  for (const [member, sent] of Object.entries(body)) {
    // The identity is the entity's key: the path's id repeated is the identity member; another value is one the application ignored, or used to re-key the entity, which no rule models.
    if (member === evidence.idField) {
      if (scalarText(sent) === evidence.id) identity = member;
      else if (!same(evidence.after[member], evidence.before[member]))
        unexplained.push(member);
      continue;
    }
    if (!Object.hasOwn(evidence.after, member)) continue;
    if (same(evidence.after[member], sent)) {
      echoed.add(member);
      rules.push({ field: member, rule: "echo" });
    } else
      rules.push({
        field: member,
        rule: "constant",
        value: evidence.after[member]!,
      });
  }
  // Serving keeps every field an update does not write, so one a read shows the update removed is a change no rule models.
  if (evidence.readFields !== undefined)
    for (const field of Object.keys(evidence.before))
      if (
        evidence.readFields.includes(field) &&
        !Object.hasOwn(evidence.after, field)
      )
        unexplained.push(field);
  const slugs = echoedSlugs(body, echoed);
  for (const field of Object.keys(evidence.after)) {
    if (
      Object.hasOwn(body, field) ||
      (!Object.hasOwn(evidence.before, field) &&
        !(evidence.shown ?? []).includes(field)) ||
      same(evidence.before[field], evidence.after[field])
    )
      continue;
    const rule = changeRule(evidence, field, slugs);
    if (rule === undefined) unexplained.push(field);
    else rules.push(rule);
  }
  const shaped = bodyOf(
    Object.fromEntries(
      Object.entries(body).filter(([member]) => member !== identity),
    ),
    echoed,
    evidence.method === "PUT"
      ? Object.keys(body).filter((member) => member !== identity)
      : [],
  );
  return { rules, body: { ...shaped, identity }, unexplained };
};

/**
 * How a write's response carries the entity it wrote: an object with the type's identity field
 * equal to the id (entity), the id alone at the root or in one member (identity), nothing
 * (empty), or anything else (recorded).
 */
export const responseShapeOf = (
  ordinal: number,
  body: JsonValue | undefined,
  empty: boolean,
  entity: { readonly idField: string; readonly id: string },
): WriteResponse => {
  if (empty) return { ordinal, shape: "empty", pointer: null };
  if (body === undefined) return { ordinal, shape: "recorded", pointer: null };
  const located = locateItem(body, entity.id);
  if (located?.keys.includes(entity.idField) === true)
    return { ordinal, shape: "entity", pointer: located.pointer };
  if (scalarText(body) === entity.id)
    return { ordinal, shape: "identity", pointer: "" };
  if (isObject(body)) {
    const members = Object.entries(body).filter(
      ([, value]) => scalarText(value) === entity.id,
    );
    if (members.length === 1)
      return {
        ordinal,
        shape: "identity",
        pointer: pointerTo(members[0]![0]),
      };
  }
  return { ordinal, shape: "recorded", pointer: null };
};

/** Order two field values as numbers, instants or text; undefined when they are not comparable. */
export const compareValues = (
  left: JsonValue | undefined,
  right: JsonValue | undefined,
): number | undefined => {
  const [a, b] = [integerOf(left), integerOf(right)];
  if (a !== undefined && b !== undefined) return a - b;
  const [c, d] = [readClock(left), readClock(right)];
  if (c !== undefined && d !== undefined) return c.ms - d.ms;
  return typeof left === "string" && typeof right === "string"
    ? compare(left, right)
    : undefined;
};

/** Whether the members are strictly ordered by the field in the direction. */
const orderedBy = (
  members: readonly JsonObject[],
  field: string,
  direction: "ascending" | "descending",
): boolean =>
  members.every((member, index) => {
    if (index === 0) return true;
    const order = compareValues(members[index - 1]![field], member[field]);
    return (
      order !== undefined && (direction === "ascending" ? order < 0 : order > 0)
    );
  });

/** Insert rules consistent with a collection's recorded order: sorted by identity or clock fields when shown, then last and first. */
export const insertCandidates = (
  members: readonly JsonObject[],
  fields: readonly string[],
): InsertRule[] => {
  const sorted: InsertRule[] = [];
  if (members.length >= 2)
    for (const field of fields)
      for (const direction of ["ascending", "descending"] as const)
        if (orderedBy(members, field, direction))
          sorted.push({ rule: "sorted", field, direction });
  return [...sorted, { rule: "last" }, { rule: "first" }];
};

/** Where an entity with these fields enters a collection under an insert rule. */
export const insertIndex = (
  rule: InsertRule,
  members: readonly JsonObject[],
  fields: JsonObject,
): number => {
  if (rule.rule !== "sorted") return rule.rule === "first" ? 0 : members.length;
  const index = members.findIndex((member) => {
    const order = compareValues(fields[rule.field], member[rule.field]);
    return (
      order !== undefined &&
      (rule.direction === "ascending" ? order < 0 : order > 0)
    );
  });
  return index < 0 ? members.length : index;
};

/** The object in a document value, at the root or in one member, that holds most of a body's members. */
export const documentPointerOf = (
  value: JsonValue,
  body: JsonObject,
): string | undefined => {
  const members = Object.keys(body);
  const candidates: [string, JsonValue][] = [
    ["", value],
    ...(isObject(value)
      ? Object.entries(value).map(([name, item]): [string, JsonValue] => [
          pointerTo(name),
          item,
        ])
      : []),
  ];
  let best: { readonly pointer: string; readonly shared: number } | undefined;
  for (const [pointer, candidate] of candidates) {
    if (!isObject(candidate)) continue;
    const shared = members.filter((member) =>
      Object.hasOwn(candidate, member),
    ).length;
    if (shared > 0 && (best === undefined || shared > best.shared))
      best = { pointer, shared };
  }
  return best?.pointer;
};

/** A plan's body with the members and fixed values a later call's body adds, and the JSON types it stored those members as when the observation shows none. */
export const refinedBody = (
  body: WriteBody,
  later: WriteBody,
  values: { readonly observed: JsonObject; readonly stored: JsonObject },
): WriteBody => {
  const fixed = new Set(body.fixed.map((entry) => entry.member));
  const accepted = later.accepted.filter(
    (member) => !body.accepted.includes(member),
  );
  return {
    ...body,
    // A later call may be the first to show the body repeating the path's id.
    identity: body.identity ?? later.identity,
    accepted: [...body.accepted, ...accepted],
    fixed: [
      ...body.fixed,
      ...later.fixed.filter((entry) => !fixed.has(entry.member)),
    ],
    // Serving reads member types from the observation, which may not show a member a later call stored.
    kinds: [
      ...body.kinds,
      ...storedKinds(accepted, values.observed, values.stored),
    ],
  };
};

/** Whether a later call explains a member or field otherwise than the plan: echoed by one and stored as something else by the other, or ruled differently. */
export const conflictsWithPlan = (
  plan: Pick<StateWritePlan, "body" | "rules">,
  explained: ReturnType<typeof explainUpdate>,
): boolean => {
  const body = plan.body!;
  const fixed = new Map(body.fixed.map((entry) => [entry.member, entry.sent]));
  const rules = new Map(plan.rules.map((rule) => [rule.field, rule]));
  const { identity } = explained.body;
  // Serving checks a call's identity member before its fixed values, so a member both cannot take every recorded call.
  return (
    explained.body.accepted.some((member) => fixed.has(member)) ||
    explained.body.fixed.some(
      (entry) =>
        body.accepted.includes(entry.member) ||
        entry.member === body.identity ||
        (fixed.has(entry.member) && !same(fixed.get(entry.member), entry.sent)),
    ) ||
    (identity !== null && fixed.has(identity)) ||
    explained.rules.some((rule) => {
      const held = rules.get(rule.field);
      return held !== undefined && !same(held, rule);
    })
  );
};
