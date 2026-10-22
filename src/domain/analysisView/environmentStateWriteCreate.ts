import type { JsonValue } from "../jsonValue.js";
import { ok } from "../result.js";
import {
  isObject,
  isStateWrite,
  scalarText,
  type JsonObject,
  type StateEntity,
} from "./environmentStateRules.js";
import { createdFields } from "./environmentStateWriteApply.js";
import {
  collectionTarget,
  entityTarget,
  heldCollection,
} from "./environmentStateWriteChecks.js";
import {
  built,
  callOf,
  fail,
  refuse,
  requestObject,
  retainFixed,
  searchFrom,
  startOf,
  UNKNOWN,
  type EffectContext,
  type EffectResult,
  type WriteDraft,
  type WriteStep,
} from "./environmentStateWriteEffects.js";
import {
  explainCreate,
  insertCandidates,
  insertIndex,
  nextInteger,
  responseShapeOf,
} from "./environmentStateWriteExplain.js";
import {
  laterObservation,
  newEntityIn,
  type Observed,
} from "./environmentStateWriteObserve.js";
import {
  pathValuesOf,
  type FieldRule,
  type WriteCall,
} from "./environmentStateWriteRules.js";
import {
  integerOf,
  isUuid,
  nextSequence,
  readClock,
} from "./environmentStateWriteValues.js";

/** The id a response names alone: a scalar body, or an object's id field or single scalar member. */
const respondedId = (
  body: JsonValue | undefined,
  idField: string,
): string | undefined => {
  if (body === undefined) return undefined;
  if (!isObject(body)) return scalarText(body);
  if (Object.hasOwn(body, idField)) return scalarText(body[idField]);
  const members = Object.values(body);
  return members.length === 1 ? scalarText(members[0]) : undefined;
};

/** The written entity a create's response or a later read shows. */
const createdObservation = (
  context: EffectContext,
  step: WriteStep,
  target: {
    readonly type: string;
    readonly collection: string;
    readonly idField: string;
  },
): Observed | undefined => {
  const held = (id: string) =>
    context.state.entity(target.type, target.collection, id) !== undefined;
  const own = context.io.withBody(step.record.ordinal, (body) =>
    newEntityIn(step.record.ordinal, body, target.idField, held),
  );
  if (own !== undefined) return own;
  // A response that names the created id alone ties the later read to that id.
  const id = context.io.withBody(step.record.ordinal, (body) =>
    respondedId(body, target.idField),
  );
  const later = laterObservation(searchFrom(context, step), {
    ...target,
    ...(id === undefined ? {} : { id }),
    held,
    isWrite: isStateWrite,
  });
  if (later !== undefined) context.observed(later.ordinal);
  return later;
};

const fieldsOf = (entities: readonly StateEntity[]): JsonObject[] =>
  entities.map((entity) => entity.fields);

/** Build a create plan from its exemplar's observation. */
const buildCreate = (
  context: EffectContext,
  draft: WriteDraft,
  step: WriteStep,
  evidence: {
    readonly observed: Observed;
    readonly call: WriteCall & { readonly body: JsonObject };
    readonly collection: string;
  },
): void => {
  const type = draft.plan.target!;
  const idField = context.idField(type);
  const members = fieldsOf(context.state.members(type, evidence.collection));
  const explained = explainCreate({
    entity: evidence.observed.object,
    call: evidence.call,
    idField,
    startMs: startOf(context, step),
    collection: members,
    type: fieldsOf(context.state.ofType(type)),
  });
  const clocks = explained.rules.flatMap((rule) =>
    rule.rule === "clock" ? [rule.field] : [],
  );
  // Identity and clock orders first, then any other scalar field the collection may be sorted by.
  const scalars = Object.keys(members[0] ?? {}).filter((field) =>
    members.every((member) =>
      ["string", "number"].includes(typeof member[field]),
    ),
  );
  draft.candidates = insertCandidates(members, [
    ...new Set([idField, ...clocks, ...scalars]),
  ]);
  retainFixed(context, explained.body.fixed);
  Object.assign(draft.plan, {
    exemplar_ordinal: step.record.ordinal,
    observation: {
      ordinal: evidence.observed.ordinal,
      pointer: evidence.observed.pointer,
    },
    response: context.io.withBody(step.record.ordinal, (body) =>
      responseShapeOf(
        step.record.ordinal,
        body,
        context.io.emptyResponse(step.record.ordinal),
        { idField, id: evidence.observed.id },
      ),
    ),
    body: explained.body,
    rules: explained.rules,
    collection: explained.tied ? evidence.collection : null,
    insert: draft.candidates[0]!,
  });
  draft.observed = evidence.observed.object;
};

type SequenceRule = Extract<FieldRule, { rule: "sequence" }>;

/** The sequences a create's plan generates, each with the key serving counts it under. */
const sequencesOf = (
  draft: WriteDraft,
  collection: string,
): { readonly rule: SequenceRule; readonly key: string }[] =>
  draft.plan.rules.flatMap((rule) =>
    rule.rule === "sequence"
      ? [
          {
            rule,
            key:
              rule.scope === "collection"
                ? `${rule.field} ${collection}`
                : rule.field,
          },
        ]
      : [],
  );

/** Whether a later call's sequences hold what serving generates: one past the largest value their scope holds or started with, and past the plan's last. */
const followsSequences = (
  context: EffectContext,
  draft: WriteDraft,
  created: Pick<StateEntity, "type" | "collection" | "fields">,
): boolean =>
  sequencesOf(draft, created.collection).every(({ rule, key }) => {
    const scope = [
      ...context.state.ofType(created.type),
      ...context.startedWith(created.type),
    ].filter(
      (entity) =>
        rule.scope === "type" || entity.collection === created.collection,
    );
    const next = nextSequence(
      nextInteger(fieldsOf(scope), rule.field),
      draft.sequences.get(key),
    );
    return integerOf(created.fields[rule.field]) === next;
  });

/** Whether a later call's generated values take the forms serving generates them in: clocks in the learned format, unique values and UUID identities as UUIDs, and sequences in order. */
const followsGenerated = (
  context: EffectContext,
  draft: WriteDraft,
  created: Pick<StateEntity, "type" | "collection" | "fields">,
): boolean =>
  draft.plan.rules.every((rule) => {
    const value = created.fields[rule.field];
    if (rule.rule === "clock")
      return (
        JSON.stringify(readClock(value)?.format) === JSON.stringify(rule.format)
      );
    if (rule.rule === "unique")
      return (
        isUuid(value) &&
        !context.state
          .ofType(created.type)
          .some((held) => held.fields[rule.field] === value)
      );
    return (
      rule.rule !== "identity" || rule.generator !== "uuid" || isUuid(value)
    );
  }) && followsSequences(context, draft, created);

/** Record the values a create's sequences took, which the next call follows. */
const takeSequences = (
  draft: WriteDraft,
  created: Pick<StateEntity, "collection" | "fields">,
): void => {
  for (const { rule, key } of sequencesOf(draft, created.collection)) {
    const value = integerOf(created.fields[rule.field]);
    if (value !== undefined) draft.sequences.set(key, value);
  }
};

/** Add a created entity to the state at the plan's insert position, or last before the plan has one. */
const insertCreated = (
  context: EffectContext,
  draft: WriteDraft,
  entity: StateEntity,
): string => {
  const members = fieldsOf(
    context.state.members(entity.type, entity.collection),
  );
  context.io.retain(64 + JSON.stringify(entity.fields).length * 2);
  context.state.put(
    entity,
    draft.plan.insert === null
      ? members.length
      : insertIndex(draft.plan.insert, members, entity.fields),
  );
  return entityTarget(entity.type, entity.collection, entity.id);
};

/** Apply a recorded create, with the values it recorded for generated fields; an unexplained create adds what it recorded. */
export const applyCreate = (
  context: EffectContext,
  draft: WriteDraft,
  step: WriteStep,
): EffectResult => {
  const type = draft.plan.target!;
  const idField = context.idField(type);
  // The held collection serving would pick for this path, as an item read's names its entity.
  const collection = heldCollection(context.state, type, step.record.path);
  const body = requestObject(context, step.record);
  const observed = createdObservation(context, step, {
    type,
    collection,
    idField,
  });
  if (observed === undefined) {
    fail(draft, step, body === undefined ? "body-unusable" : "no-observation");
    return UNKNOWN;
  }
  const entity = (fields: JsonObject, id: string): StateEntity => ({
    type,
    collection,
    id,
    fields,
    view_fields: [],
    record_ordinals: [],
  });
  const recorded = (): EffectResult => {
    const inserted = insertCreated(
      context,
      draft,
      entity(observed.object, observed.id),
    );
    return {
      kind: "observed",
      targets: [inserted, collectionTarget(type, collection)],
      entity: { type, collection, id: observed.id },
    };
  };
  if (step.observeOnly || body === undefined) {
    fail(draft, step, "body-unusable");
    return recorded();
  }
  const call = { ...callOf(step, body), body };
  // The exemplar defines the plan's sequences; each later call must follow them.
  const later = built(draft);
  if (!later) buildCreate(context, draft, step, { observed, call, collection });
  // Rules learn from the recorded path; serving fills path fields from the collection it selects.
  const created = {
    ...call,
    pathValues:
      pathValuesOf(step.tool.path_template, collection) ?? call.pathValues,
  };
  const fields = createdFields(draft.plan, draft.observed!, created, (rule) =>
    ok(observed.object[rule.field] ?? null),
  );
  const id = fields.ok ? scalarText(fields.value[idField]) : undefined;
  if (
    !fields.ok ||
    id === undefined ||
    context.state.entity(type, collection, id) !== undefined ||
    (later &&
      !followsGenerated(context, draft, {
        type,
        collection,
        fields: fields.value,
      }))
  ) {
    refuse(draft, step, "unexplained-change");
    return recorded();
  }
  takeSequences(draft, { collection, fields: fields.value });
  const inserted = insertCreated(context, draft, entity(fields.value, id));
  return {
    kind: "applied",
    targets: [inserted, collectionTarget(type, collection)],
    entity: { type, collection, id },
    inserted,
  };
};
