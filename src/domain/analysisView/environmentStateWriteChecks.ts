import type { JsonValue } from "../jsonValue.js";
import { iterateUrlQueryParameters } from "../recordedTransportUrl.js";
import {
  compareUnicodeCodePoints as compare,
  compositeKey,
} from "../unicodeCodePointOrder.js";
import {
  at,
  decodedSegment,
  isObject,
  isParam,
  listItems,
  missingRequiredFields,
  renderStateEntity,
  renderStateList,
  replaceAt,
  same,
  scalarText,
  segmentsOf,
  type JsonObject,
  type StateDocument,
  type StateEntity,
  type StateItemView,
  type StateListView,
  type StateRecordFacts,
  type StateToolFacts,
  type StateView,
} from "./environmentStateRules.js";
import { pageBound, pagesOnly } from "./environmentStatePaging.js";

/** A query as replay compares a call's: decoded values by name, in any order; undefined when it repeats a name with another value, which no call's arguments can carry. */
const queryKey = (query: string | undefined): string | undefined => {
  const values = new Map<string, string>();
  for (const [name, value] of iterateUrlQueryParameters(query ?? "")) {
    if (values.has(name) && values.get(name) !== value) return undefined;
    values.set(name, value);
  }
  return compositeKey(
    [...values].sort(([left], [right]) => compare(left, right)),
  );
};

interface CheckedLine {
  readonly ordinal: number;
  readonly segments: readonly string[];
}

/** A list or document view's checked lines, by query, in the tool's recorded order, and which path segments are the tool's parameters. */
export interface CheckedLines {
  readonly params: ReadonlySet<number>;
  readonly byQuery: ReadonlyMap<string, readonly CheckedLine[]>;
  /** A whole list's lines that only page it, which serving answers a call supplying no query from. */
  readonly unfiltered: readonly CheckedLine[];
}

/** The line a read's call is answered from, and the collection serving lists for it. */
export interface ServedLine {
  readonly ordinal: number;
  readonly collection: string;
}

/** Each list or document view's checked lines. */
export const checkedLines = (input: {
  readonly tools: readonly StateToolFacts[];
  readonly records: readonly StateRecordFacts[];
  readonly views: ReadonlyMap<string, StateView>;
}): Map<string, CheckedLines> => {
  const byOrdinal = new Map(
    input.records.map((record) => [record.ordinal, record]),
  );
  const tools = new Map(input.tools.map((tool) => [tool.name, tool]));
  const byView = new Map<string, CheckedLines>();
  for (const view of input.views.values()) {
    const tool = tools.get(view.tool);
    if (view.shape === "recorded" || view.shape === "item" || !tool) continue;
    const checked = new Set(view.checked_record_ordinals);
    const byQuery = new Map<string, CheckedLine[]>();
    const unfiltered: CheckedLine[] = [];
    const whole = view.shape === "list" && view.membership === "all";
    for (const ordinal of tool.record_ordinals) {
      const record = byOrdinal.get(ordinal);
      const key = record === undefined ? undefined : queryKey(record.query);
      if (!checked.has(ordinal) || key === undefined) continue;
      const line = { ordinal, segments: segmentsOf(record!.path) };
      byQuery.set(key, [...(byQuery.get(key) ?? []), line]);
      if (whole && pagesOnly(record!.query)) unfiltered.push(line);
    }
    const params = new Set(
      segmentsOf(tool.path_template).flatMap((segment, index) =>
        isParam(segment) ? [index] : [],
      ),
    );
    byView.set(view.tool, { params, byQuery, unfiltered });
  }
  return byView;
};

/**
 * The checked line serving answers a read's call from, ranked as replay ranks lines: every
 * parameter the read's value verbatim or once percent-decoded and the query the read's, then the
 * most verbatim parameters, then recorded order. A read with no query falls back, as serving does,
 * on a whole list's lines that only page it.
 */
export const servedLine = (
  lines: CheckedLines | undefined,
  record: StateRecordFacts,
): ServedLine | undefined => {
  const key = queryKey(record.query);
  if (lines === undefined || key === undefined) return undefined;
  return (
    bestLine(lines, lines.byQuery.get(key) ?? [], record) ??
    ([...iterateUrlQueryParameters(record.query ?? "")].length === 0
      ? bestLine(lines, lines.unfiltered, record)
      : undefined)
  );
};

const bestLine = (
  lines: CheckedLines,
  candidates: readonly CheckedLine[],
  record: StateRecordFacts,
): ServedLine | undefined => {
  const read = segmentsOf(record.path);
  let best: { line: ServedLine; verbatim: number } | undefined;
  for (const { ordinal, segments } of candidates) {
    if (segments.length !== read.length) continue;
    let verbatim = 0;
    const matches = segments.every((segment, index) => {
      if (segment === read[index]) {
        if (lines.params.has(index)) verbatim += 1;
        return true;
      }
      return lines.params.has(index) && decodedSegment(segment) === read[index];
    });
    if (matches && (best === undefined || verbatim > best.verbatim))
      best = {
        line: { ordinal, collection: `/${segments.join("/")}` },
        verbatim,
      };
  }
  return best?.line;
};

export const entityTarget = (type: string, collection: string, id: string) =>
  `e${compositeKey([type, collection, id])}`;
export const collectionTarget = (type: string, collection: string) =>
  `c${compositeKey([type, collection])}`;
export const documentTarget = (tool: string) => `d${compositeKey([tool])}`;

/** A target `remove` dropped, so a later absence can still name the collection and id serving resolved. */
interface RemovedTarget {
  readonly type: string;
  readonly collection: string;
  readonly id: string;
}

/** The gate's copy of the state: entities in collection order and documents, changed by modelled writes. */
export class SimulatedState {
  readonly #entities = new Map<string, StateEntity>();
  readonly #collections = new Map<string, string[]>();
  readonly #documents = new Map<string, JsonValue>();
  readonly #removed: RemovedTarget[] = [];

  constructor(
    entities: readonly StateEntity[],
    documents: readonly StateDocument[],
  ) {
    for (const entity of entities) this.put(entity);
    for (const document of documents)
      this.#documents.set(document.tool, document.value);
  }

  entity(
    type: string,
    collection: string,
    id: string,
  ): StateEntity | undefined {
    return this.#entities.get(entityTarget(type, collection, id));
  }

  members(type: string, collection: string): StateEntity[] {
    return (
      this.#collections.get(collectionTarget(type, collection)) ?? []
    ).map((key) => this.#entities.get(key)!);
  }

  ofType(type: string): StateEntity[] {
    return [...this.#entities.values()].filter(
      (entity) => entity.type === type,
    );
  }

  /** Replace an entity in place, or add it at `index` of its collection (the end when omitted). */
  put(entity: StateEntity, index?: number): void {
    const key = entityTarget(entity.type, entity.collection, entity.id);
    const known = this.#entities.has(key);
    this.#entities.set(key, entity);
    if (known) return;
    const collection = collectionTarget(entity.type, entity.collection);
    const order = this.#collections.get(collection) ?? [];
    order.splice(index ?? order.length, 0, key);
    this.#collections.set(collection, order);
  }

  remove(entity: StateEntity): void {
    const key = entityTarget(entity.type, entity.collection, entity.id);
    this.#entities.delete(key);
    const collection = collectionTarget(entity.type, entity.collection);
    const order = this.#collections.get(collection) ?? [];
    this.#collections.set(
      collection,
      order.filter((member) => member !== key),
    );
    const index = this.#removed.findIndex(
      (target) =>
        target.type === entity.type &&
        target.collection === entity.collection &&
        target.id === entity.id,
    );
    if (index >= 0) this.#removed.splice(index, 1);
    this.#removed.push({
      type: entity.type,
      collection: entity.collection,
      id: entity.id,
    });
  }

  /** Removed targets of this type the state does not hold again. */
  removedTargets(type: string): readonly RemovedTarget[] {
    return this.#removed.filter(
      (target) =>
        target.type === type &&
        !this.#entities.has(entityTarget(type, target.collection, target.id)),
    );
  }

  document(tool: string): JsonValue | undefined {
    return this.#documents.get(tool);
  }

  setDocument(tool: string, value: JsonValue): void {
    this.#documents.set(tool, value);
  }
}

/** An item read status that says the entity does not exist: 400, 404 or 410, as applications answer a missing id. */
export const isAbsence = (status: number | null): boolean =>
  status === 400 || status === 404 || status === 410;

/** A 2xx record: the only status whose response shows what a request did. */
export const succeeded = (record: StateRecordFacts): boolean =>
  record.status !== null && record.status >= 200 && record.status < 300;

/** Hand a base recording's body and a read's body to `use` together, parsing a recording once when both are the same. */
export const withBodies = <T>(
  withBody: <U>(ordinal: number, use: (body: JsonValue | undefined) => U) => U,
  ordinals: { readonly base: number; readonly read: number },
  use: (base: JsonValue | undefined, body: JsonValue | undefined) => T,
): T => {
  const { base, read } = ordinals;
  return base === read
    ? withBody(read, (body) => use(body, body))
    : withBody(base, (served) => withBody(read, (body) => use(served, body)));
};

/** A check's outcome and the targets it covered. */
export interface CheckOutcome {
  readonly pass: boolean;
  readonly targets: readonly string[];
  /** Entities the recording, or the served base of a recorded-membership list, lists that the state does not hold, by target. */
  readonly unheld: readonly string[];
  /** For a failed list read that differs only in some members' fields, those members' targets. */
  readonly differing?: readonly string[];
}

/** What a check compares: the read's recorded body and the served base recording it would answer on. */
interface ReadBodies {
  readonly body: JsonValue | undefined;
  /** The recording whose envelope the served answer keeps: an item view's envelope, a list line's latest init recording. */
  readonly base: JsonValue | undefined;
  readonly volatile: ReadonlySet<string>;
}

/** An item read: the answer the held entity renders into the served envelope must equal the recording; a recorded 404 or 410 agrees with none held. */
/** How many of a held collection's segments match a path's verbatim, or undefined when one matches neither verbatim nor once percent-decoded. */
const segmentMatch = (
  held: readonly string[],
  read: readonly string[],
): number | undefined => {
  if (held.length !== read.length) return undefined;
  let verbatim = 0;
  for (const [index, segment] of held.entries())
    if (segment === read[index]) verbatim += 1;
    else if (decodedSegment(segment) !== read[index]) return undefined;
  return verbatim;
};

/** A held target an item path names, preferring the path's own collection, then a verbatim spelling. */
const matchingTarget = (
  path: {
    readonly read: readonly string[];
    readonly ids: readonly string[];
    readonly written: string;
  },
  collections: readonly string[],
  held: (collection: string, id: string) => boolean,
): { readonly collection: string; readonly id: string } | undefined => {
  for (const id of path.ids)
    if (held(path.written, id)) return { collection: path.written, id };
  const ranked = [...new Set(collections)]
    .flatMap((collection) => {
      const verbatim = segmentMatch(segmentsOf(collection), path.read);
      return verbatim === undefined ? [] : [{ collection, verbatim }];
    })
    .sort((left, right) => right.verbatim - left.verbatim);
  for (const { collection } of ranked)
    for (const id of path.ids)
      if (held(collection, id)) return { collection, id };
  return undefined;
};

/**
 * The entity an item read or write names, as serving names it: in a held collection its path matches, verbatim
 * spellings first, the id percent-decoded once, then as written; else a removed target still named that way, so
 * an absence keeps the collection and id a delete resolved; else the collection and decoded id as written.
 */
export const itemTarget = (
  state: SimulatedState,
  type: string,
  record: Pick<StateRecordFacts, "path">,
): { readonly collection: string; readonly id: string } => {
  const read = segmentsOf(record.path);
  const raw = read.pop() ?? "";
  const path = {
    read,
    ids: [...new Set([decodedSegment(raw), raw])],
    written: `/${read.join("/")}`,
  };
  const removed = state.removedTargets(type);
  return (
    matchingTarget(
      path,
      state.ofType(type).map((entity) => entity.collection),
      (collection, id) => state.entity(type, collection, id) !== undefined,
    ) ??
    matchingTarget(
      path,
      removed.map((target) => target.collection),
      (collection, id) =>
        removed.some(
          (target) => target.collection === collection && target.id === id,
        ),
    ) ?? { collection: path.written, id: path.ids[0]! }
  );
};

/** The held collection of a type a path names, as serving picks a create's: the most verbatim spelling, else the path as written. */
export const heldCollection = (
  state: SimulatedState,
  type: string,
  path: string,
): string => {
  const read = segmentsOf(path);
  let held: string | undefined;
  let verbatim = -1;
  for (const collection of new Set(
    state.ofType(type).map((entity) => entity.collection),
  )) {
    const matched = segmentMatch(segmentsOf(collection), read);
    if (matched !== undefined && matched > verbatim) {
      held = collection;
      verbatim = matched;
    }
  }
  return held ?? `/${read.join("/")}`;
};

export const checkItemRead = (
  state: SimulatedState,
  view: StateItemView,
  record: StateRecordFacts,
  check: ReadBodies,
): CheckOutcome | undefined => {
  const { collection, id } = itemTarget(state, view.type, record);
  const entity = state.entity(view.type, collection, id);
  const targets = [entityTarget(view.type, collection, id)];
  if (isAbsence(record.status) || (succeeded(record) && check.body === null))
    return { pass: entity === undefined, targets, unheld: [] };
  if (!succeeded(record) || check.base === undefined) return undefined;
  const object =
    check.body === undefined ? undefined : at(check.body, view.pointer);
  // A usable body that no longer holds the entity is not what serving answers for one it holds.
  if (!isObject(object))
    return check.body === undefined || entity === undefined
      ? undefined
      : { pass: false, targets, unheld: [] };
  if (entity === undefined) return { pass: false, targets, unheld: targets };
  // Serving refuses an entity lacking a field every recording carried, so no read can confirm one.
  if (missingRequiredFields(entity, view, check.volatile).length > 0)
    return { pass: false, targets, unheld: [] };
  const shown = renderStateEntity(entity, view, check.volatile, object);
  return {
    pass: same(replaceAt(check.base, view.pointer, shown), check.body),
    targets,
    unheld: [],
  };
};

/** A list read's bodies with the listed items of the read and of its served base. */
interface ListBodies {
  readonly body: JsonValue;
  readonly base: JsonValue;
  readonly items: readonly JsonObject[];
  readonly baseItems: readonly JsonObject[];
  readonly idField: string;
  readonly volatile: ReadonlySet<string>;
  /** The collection serving lists: the answering line's. */
  readonly collection: string;
}

/** The served list rendered from the base with `members`, compared with the read; volatile fields take the read's values. */
const listCheck = (
  view: StateListView,
  check: ListBodies,
  members: readonly StateEntity[],
): Pick<CheckOutcome, "pass" | "differing"> => {
  if (
    members.some(
      (entity) =>
        missingRequiredFields(entity, view, check.volatile).length > 0,
    )
  )
    return { pass: false };
  const observed = new Map(
    check.items.map((item) => [scalarText(item[check.idField]) ?? "", item]),
  );
  const rendered = members.map((entity) =>
    renderStateEntity(entity, view, check.volatile, observed.get(entity.id)),
  );
  if (same(renderStateList(view, check.base, rendered), check.body))
    return { pass: true };
  // When the recorded members alone account for the difference, only they differ.
  const differs = members.filter((entity, index) => {
    const item = observed.get(entity.id);
    return item !== undefined && !same(rendered[index], item);
  });
  const patched = rendered.map(
    (item, index) => observed.get(members[index]!.id) ?? item,
  );
  return differs.length > 0 &&
    same(renderStateList(view, check.base, patched), check.body)
    ? {
        pass: false,
        differing: differs.map((entity) =>
          entityTarget(view.type, check.collection, entity.id),
        ),
      }
    : { pass: false };
};

/** A list read of every entity of a collection: membership, order, fields and counters must render from the state. */
const checkAllList = (
  state: SimulatedState,
  view: StateListView,
  check: ListBodies,
): CheckOutcome => {
  const { collection } = check;
  const members = state.members(view.type, collection);
  const held = new Set(members.map((entity) => entity.id));
  return {
    ...listCheck(view, check, members),
    targets: [
      collectionTarget(view.type, collection),
      ...members.map((entity) =>
        entityTarget(view.type, collection, entity.id),
      ),
    ],
    unheld: check.items
      .map((item) => scalarText(item[check.idField]) ?? "")
      .filter((id) => !held.has(id))
      .map((id) => entityTarget(view.type, collection, id)),
  };
};

/** A list read of recorded members: the served list holds the base's members the state still holds, so a member it dropped or never listed fails. */
const checkRecordedList = (
  state: SimulatedState,
  view: StateListView,
  check: ListBodies,
): CheckOutcome => {
  const { collection } = check;
  const idOf = (item: JsonObject) => scalarText(item[check.idField]) ?? "";
  const members = check.baseItems.flatMap((item) => {
    const entity = state.entity(view.type, collection, idOf(item));
    return entity === undefined ? [] : [entity];
  });
  const targets: string[] = [];
  const unheld: string[] = [];
  for (const id of new Set([...check.baseItems, ...check.items].map(idOf)))
    (state.entity(view.type, collection, id) === undefined
      ? unheld
      : targets
    ).push(entityTarget(view.type, collection, id));
  return { ...listCheck(view, check, members), targets, unheld };
};

/** A list read on a checked line, compared with the answer the served environment renders on that line's base recording from the collection it names. */
export const checkListRead = (
  state: SimulatedState,
  view: StateListView,
  record: StateRecordFacts,
  check: ReadBodies & { readonly idField: string; readonly collection: string },
): CheckOutcome | undefined => {
  if (!succeeded(record)) return undefined;
  const { body, base } = check;
  const baseItems =
    base === undefined ? undefined : listItems(base, view.pointer);
  if (body === undefined || base === undefined || baseItems === undefined)
    return undefined;
  // Serving answers a page too small for the collection from its recording, so such a read checks nothing.
  const size = pageBound(record.query, baseItems.length);
  if (
    view.membership === "all" &&
    size !== undefined &&
    state.members(view.type, check.collection).length > size
  )
    return undefined;
  // A usable body that no longer holds the list is not what serving answers on this line.
  const items = listItems(body, view.pointer);
  const bodies = { ...check, body, base, items: items ?? [], baseItems };
  const outcome =
    view.membership === "all"
      ? checkAllList(state, view, bodies)
      : checkRecordedList(state, view, bodies);
  return items === undefined ? { ...outcome, pass: false } : outcome;
};

/** A document read on its checked line must equal the held document. */
export const checkDocumentRead = (
  state: SimulatedState,
  tool: string,
  record: StateRecordFacts,
  body: JsonValue | undefined,
): CheckOutcome | undefined => {
  if (!succeeded(record)) return undefined;
  const value = state.document(tool);
  if (body === undefined || value === undefined) return undefined;
  return {
    pass: same(value, body),
    targets: [documentTarget(tool)],
    unheld: [],
  };
};

/**
 * Check, field by field, the writes that changed an entity an unmodelled write also changed:
 * each write's own fields must show as the state holds them, but for volatile ones, which take
 * the read's value and so show nothing of a write. A create wrote every field, so it cannot be
 * told apart from the unmodelled change and is not checked.
 */
export const writtenFieldChecks = (
  entity: StateEntity,
  view: StateItemView,
  observed: JsonObject,
  check: {
    readonly volatile: ReadonlySet<string>;
    readonly writes: ReadonlyMap<string, readonly string[] | null>;
  },
): Map<string, boolean> => {
  const shown = renderStateEntity(entity, view, check.volatile, observed);
  const outcomes = new Map<string, boolean>();
  for (const [tool, fields] of check.writes) {
    const compared = (fields ?? []).filter(
      (field) =>
        !check.volatile.has(field) &&
        (Object.hasOwn(observed, field) || Object.hasOwn(shown, field)),
    );
    if (fields === null || compared.length === 0) continue;
    outcomes.set(
      tool,
      compared.every((field) => same(shown[field], observed[field])),
    );
  }
  return outcomes;
};
