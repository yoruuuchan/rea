import {
  at,
  changesState,
  isObject,
  isStateWrite,
  normalizedPath,
  type JsonObject,
  type StateEntity,
  type StateRecordFacts,
  type StateToolFacts,
  type StateType,
  type StateView,
} from "./environmentStateRules.js";
import { updatedEntity } from "./environmentStateWriteApply.js";
import {
  checkDocumentRead,
  checkItemRead,
  checkListRead,
  checkedLines,
  collectionTarget,
  entityTarget,
  isAbsence,
  itemTarget,
  servedLine,
  succeeded,
  withBodies,
  writtenFieldChecks,
  SimulatedState,
  type CheckOutcome,
  type CheckedLines,
  type ServedLine,
} from "./environmentStateWriteChecks.js";
import {
  exercisedBy,
  interference,
  type WriteHistory,
  forgetChecked,
  runningAt,
  shownFields,
  shownWrites,
  touchTarget,
  WriteEffects,
  type PendingTargets,
  type TouchedTargets,
} from "./environmentStateWriteAttribution.js";
import { applyCreate } from "./environmentStateWriteCreate.js";
import { applyDocument } from "./environmentStateWriteDocument.js";
import {
  applyDelete,
  applyUpdate,
  type EffectContext,
  type EffectResult,
  type WriteDraft,
  type WriteSimulationInput,
  type WriteStep,
} from "./environmentStateWriteEffects.js";
import { insertIndex } from "./environmentStateWriteExplain.js";
import {
  classifyWrite,
  prefixRelated,
  unservedPlan,
  type StateWritePlan,
} from "./environmentStateWriteRules.js";
import { WriteTaint } from "./environmentStateWriteTaint.js";
import { writeVerdict } from "./environmentStateWriteVerdict.js";

const APPLY = {
  create: applyCreate,
  update: applyUpdate,
  delete: applyDelete,
  document: applyDocument,
} as const;

/**
 * Replay the capture's timeline on a copy of the initial state: modelled writes apply their
 * effects, other writes taint related types, and each read the served state would answer is
 * compared with its recording and attributed to the writes it exercises.
 */
export class EnvironmentStateWriteSimulation {
  readonly #input: WriteSimulationInput;
  readonly #state: SimulatedState;
  readonly #drafts = new Map<string, WriteDraft>();
  readonly #toolOf = new Map<number, StateToolFacts>();
  readonly #types = new Map<string, StateType>();
  /** Each list or document view's checked request lines, with the recording a call of the line is answered on. */
  readonly #checkedLines: ReadonlyMap<string, CheckedLines>;
  /** Reads a write's effect was learned from, with the tools that borrowed each. */
  readonly #observations = new Map<number, Set<string>>();
  readonly #taint: WriteTaint;
  readonly #touched: TouchedTargets = new Map();
  readonly #effects = new WriteEffects();
  readonly #lastCheck = new Map<string, number>();
  /** When the latest modelled write to each target since its last check ended. */
  readonly #touchedSince: PendingTargets = new Map();
  /** Timeline indexes of writes the gate does not model. */
  readonly #unmodelledAt: number[] = [];
  readonly #history: WriteHistory = {
    touched: this.#touched,
    pending: this.#touchedSince,
    checked: this.#lastCheck,
    unmodelledAt: this.#unmodelledAt,
  };
  readonly #log: {
    readonly index: number;
    readonly tool: string;
    readonly path: string;
  }[] = [];
  /** Entities a create inserted, by target, with the create's tool. */
  readonly #inserted = new Map<string, string>();
  /** Creates whose insert rule a passing list check relied on, so it is no longer changed. */
  readonly #placed = new Set<string>();

  constructor(input: WriteSimulationInput) {
    this.#input = input;
    this.#state = new SimulatedState(input.entities, input.documents);
    for (const type of input.types)
      this.#types.set(type.collection_template, type);
    for (const tool of input.tools)
      for (const ordinal of tool.record_ordinals)
        this.#toolOf.set(ordinal, tool);
    this.#checkedLines = checkedLines(input);
    this.#taint = new WriteTaint(
      [...this.#types.keys()],
      new Map(
        input.documents.map((document) => [document.tool, document.path]),
      ),
      this.#state,
    );
  }

  /** Every state-changing tool's plan, in manifest order, with its verdict. */
  run(): StateWritePlan[] {
    const documents = new Map<string, string>();
    for (const tool of this.#input.tools)
      if (this.#input.views.get(tool.name)?.shape === "document")
        documents.set(normalizedPath(tool.path_template), tool.name);
    const types = new Set(this.#types.keys());
    for (const tool of this.#input.tools) {
      if (!changesState(tool.method, tool.path_template)) continue;
      const { effect, target } = classifyWrite(tool, types, documents);
      this.#input.io.retain(512);
      this.#drafts.set(tool.name, {
        plan: {
          ...unservedPlan(tool.name, effect, target, "no-state-target"),
          reason: effect === "none" ? "no-state-target" : null,
        },
        observed: undefined,
        candidates: [],
        confirmed: [],
        contradictedBy: undefined,
        sideEffect: false,
        calls: 0,
        updates: [],
        sequences: new Map(),
      });
    }
    this.#input.records.forEach((record, index) => this.#step(record, index));
    return [...this.#drafts.values()].map((draft) =>
      writeVerdict(draft, this.#input),
    );
  }

  #step(record: StateRecordFacts, index: number): void {
    const tool = this.#toolOf.get(record.ordinal);
    // A redirected or unanswered write may have changed state, but only a 2xx one shows its effect.
    if (isStateWrite(record) && !succeeded(record))
      this.#unmodelled(record.path, index);
    else if (isStateWrite(record)) this.#write(record, index, tool);
    else if (tool?.method === "GET") this.#read(record, index, tool);
  }

  #context(writer: string): EffectContext {
    return {
      state: this.#state,
      io: this.#input.io,
      records: this.#input.records,
      timed: this.#input.timed,
      viewOf: (ordinal) =>
        this.#input.views.get(this.#toolOf.get(ordinal)?.name ?? ""),
      idField: (type) => this.#types.get(type)!.id_field,
      observed: (ordinal) =>
        this.#observations.set(
          ordinal,
          (this.#observations.get(ordinal) ?? new Set()).add(writer),
        ),
      unknown: (type, collection, id) =>
        this.#taint.unknown(type, collection, id),
      initialDocument: (tool) =>
        this.#input.documents.find((document) => document.tool === tool),
      startedWith: (type) =>
        this.#input.entities.filter((entity) => entity.type === type),
    };
  }

  #write(
    record: StateRecordFacts,
    index: number,
    tool: StateToolFacts | undefined,
  ): void {
    const draft = tool === undefined ? undefined : this.#drafts.get(tool.name);
    const effect = draft?.plan.effect;
    if (
      draft === undefined ||
      tool === undefined ||
      effect === undefined ||
      effect === "none"
    ) {
      this.#unmodelled(record.path, index);
      return;
    }
    const observeOnly = draft.plan.reason !== null;
    if (!observeOnly) draft.calls += 1;
    const step: WriteStep = { record, index, tool, observeOnly };
    this.#settle(APPLY[effect](this.#context(tool.name), draft, step), {
      index,
      tool: tool.name,
      path: record.path,
      end: record.end,
    });
  }

  /** Attribute an applied effect to its tool; a recorded outcome is the state's new baseline; an unknown one taints. */
  #settle(
    result: EffectResult,
    write: {
      readonly index: number;
      readonly tool: string;
      readonly path: string;
      readonly end: number;
    },
  ): void {
    if (result.kind === "unknown") {
      this.#unmodelled(write.path, write.index);
      return;
    }
    if (result.entity !== undefined)
      this.#taint.known(
        result.entity.type,
        result.entity.collection,
        result.entity.id,
      );
    if (result.kind === "observed") {
      this.#effects.observed(this.#touched, result.targets);
      // A recorded outcome replaces the entity's values, not its collection's membership.
      this.#touched.delete(result.targets[0]!);
      return;
    }
    this.#effects.supersede(this.#touched, write.tool, result);
    for (const target of result.targets)
      touchTarget(this.#touched, this.#touchedSince, target, {
        ...write,
        fields: result.fields,
      });
    this.#log.push(write);
    if (result.inserted !== undefined)
      this.#inserted.set(result.inserted, write.tool);
  }

  /**
   * An item read of an entity an unmodelled write may have changed shows it again: the writes that
   * changed it are checked on their own fields, and the state takes what the read recorded.
   */
  #resync(
    view: Extract<StateView, { shape: "item" }>,
    record: StateRecordFacts,
    entity: StateEntity,
  ): void {
    const target = entityTarget(entity.type, entity.collection, entity.id);
    const writes = this.#touched.get(target) ?? new Map();
    this.#taint.known(entity.type, entity.collection, entity.id);
    this.#touched.delete(target);
    if (isAbsence(record.status)) {
      this.#state.remove(entity);
      return;
    }
    const object = this.#checkFields(view, record, entity, writes);
    if (object !== undefined)
      this.#state.put(updatedEntity(entity, { ...entity.fields, ...object }));
  }

  /** Whether an item read is of an entity left unknown that it shows again rather than checks. */
  #resynced(view: StateView, record: StateRecordFacts): boolean {
    if (view.shape !== "item") return false;
    const { collection, id } = itemTarget(this.#state, view.type, record);
    if (!this.#taint.unknown(view.type, collection, id)) return false;
    // A read begun while a modelled write to the entity still ran may show either state, so it neither checks nor shows it.
    const target = entityTarget(view.type, collection, id);
    if (runningAt(this.#touchedSince, target, record.start)) return true;
    // A failed read that is no absence shows nothing of the entity, so it stays unknown for a usable read.
    if (!succeeded(record) && !isAbsence(record.status)) return true;
    const entity = this.#state.entity(view.type, collection, id);
    // A recorded absence of an entity the state no longer holds is still a check of its delete.
    if (entity === undefined) {
      if (isAbsence(record.status)) return false;
      this.#taint.known(view.type, collection, id);
      return true;
    }
    this.#resync(view, record, entity);
    return true;
  }

  #check(view: StateView, record: StateRecordFacts): CheckOutcome | undefined {
    if (view.shape === "recorded") return undefined;
    const line = this.#line(view, record);
    if (view.shape !== "item" && line === undefined) return undefined;
    if (view.shape === "document")
      return this.#input.io.withBody(record.ordinal, (body) =>
        checkDocumentRead(this.#state, view.tool, record, body),
      );
    const item = view.shape === "item";
    const collection = item
      ? itemTarget(this.#state, view.type, record).collection
      : line!.collection;
    if (this.#taint.under(collection)) return undefined;
    if (!item) {
      const ids = this.#state
        .members(view.type, collection)
        .map((entity) => entity.id);
      // A recorded-membership list covers no collection target, so a write at the collection is checked here.
      if (
        this.#taint.tainted(collectionTarget(view.type, collection)) ||
        this.#taint.blocksList(view.type, collection, ids)
      )
        return undefined;
    }
    // The served answer keeps the envelope of the item view's or the line's base recording.
    const base = item ? view.envelope_ordinal : line!.ordinal;
    const ordinals = { base, read: record.ordinal };
    return withBodies(this.#input.io.withBody, ordinals, (served, body) => {
      const check = {
        body,
        base: served,
        idField: this.#types.get(view.type)?.id_field ?? "",
        volatile: this.#input.volatileOf(view.type),
        collection,
      };
      return item
        ? checkItemRead(this.#state, view, record, check)
        : checkListRead(this.#state, view, record, check);
    });
  }

  /** The checked line serving answers a list or document read's call from, as replay chooses it. */
  #line(view: StateView, record: StateRecordFacts): ServedLine | undefined {
    return servedLine(this.#checkedLines.get(view.tool), record);
  }

  #read(record: StateRecordFacts, index: number, tool: StateToolFacts): void {
    const view = this.#input.views.get(tool.name);
    const borrowers = this.#observations.get(record.ordinal);
    if (view === undefined || (!borrowers && this.#resynced(view, record)))
      return;
    const outcome = this.#check(view, record);
    if (outcome === undefined) return;
    const keys = [...outcome.targets, ...outcome.unheld];
    if (
      keys.some(
        (key) =>
          this.#taint.tainted(key) ||
          runningAt(this.#touchedSince, key, record.start),
      )
    )
      return;
    const exercised = exercisedBy(this.#touched, keys, borrowers);
    const interferes = interference(this.#history, outcome);
    if (borrowers !== undefined) {
      if (!outcome.pass) this.#contradictOthers(exercised, record, interferes);
      return;
    }
    const pass =
      outcome.pass ||
      (view.shape === "list" && this.#retryInsert(view, record, exercised));
    const unseen = pass
      ? this.#confirm(view, record, keys, exercised)
      : undefined;
    if (!pass) {
      const interfered = new Set([...exercised].filter(interferes));
      if (interfered.size === 0)
        this.#mismatch({ record, index, keys, exercised, view });
      else {
        // An unmodelled write after some of these writes may explain the difference: those are checked on their own members only.
        this.#contradictOthers(exercised, record, interferes);
        if (view.shape === "item") this.#checkMembers(view, record, interfered);
        else for (const key of keys) this.#taint.fail(key);
      }
      if (view.shape === "item") this.#adopt(view, record);
    }
    const pending = {
      touched: this.#touched,
      since: this.#touchedSince,
      effects: this.#effects,
    };
    for (const key of keys) {
      this.#lastCheck.set(key, index);
      forgetChecked(pending, key, unseen?.get(key));
    }
  }

  /** A failed read contradicts the writes it exercised that no unmodelled write came after, as a read a write's effect was learned from still does the others. */
  #contradictOthers(
    exercised: ReadonlySet<string>,
    record: StateRecordFacts,
    interferes: (name: string) => boolean,
  ): void {
    for (const name of exercised)
      if (!interferes(name))
        this.#drafts.get(name)!.contradictedBy ??= record.ordinal;
  }

  /** A passing read confirms the writes it exercised that it shows something of, and names, per target, those it shows nothing of. */
  #confirm(
    view: StateView,
    record: StateRecordFacts,
    keys: readonly string[],
    exercised: ReadonlySet<string>,
  ): Map<string, Set<string>> {
    const shown = shownWrites(this.#touched, this.#effects, {
      keys,
      exercised,
      fields: shownFields(view, this.#input.volatileOf),
    });
    for (const name of shown.confirmed) {
      this.#drafts.get(name)!.confirmed.push(record.ordinal);
      if (view.shape === "list") this.#placed.add(name);
    }
    return shown.unseen;
  }

  #unmodelled(path: string, index: number): void {
    this.#taint.write(path);
    this.#unmodelledAt.push(index);
  }

  /** Check the writes to an item read's entity on the members they sent, as a resynchronising read does. */
  #checkMembers(
    view: Extract<StateView, { shape: "item" }>,
    record: StateRecordFacts,
    only: ReadonlySet<string>,
  ): void {
    const { collection, id } = itemTarget(this.#state, view.type, record);
    const entity = this.#state.entity(view.type, collection, id);
    if (entity === undefined) return;
    const target = entityTarget(entity.type, entity.collection, entity.id);
    const writes = [...(this.#touched.get(target) ?? [])];
    const checked = new Map(writes.filter(([name]) => only.has(name)));
    this.#checkFields(view, record, entity, checked);
  }

  /** Check the writes to an entity on the fields each wrote against an item read; the read's object, when it shows one. */
  #checkFields(
    view: Extract<StateView, { shape: "item" }>,
    record: StateRecordFacts,
    entity: StateEntity,
    writes: ReadonlyMap<string, readonly string[] | null> = new Map(),
  ): JsonObject | undefined {
    const object = this.#input.io.withBody(record.ordinal, (body) =>
      body === undefined || body === null ? undefined : at(body, view.pointer),
    );
    if (!isObject(object)) return undefined;
    for (const [name, pass] of writtenFieldChecks(entity, view, object, {
      volatile: this.#input.volatileOf(view.type),
      writes,
    })) {
      const draft = this.#drafts.get(name)!;
      if (pass) draft.confirmed.push(record.ordinal);
      else draft.contradictedBy ??= record.ordinal;
    }
    return object;
  }

  /** After a failed item check the state takes what the read recorded, so later checks start from it. */
  #adopt(
    view: Extract<StateView, { shape: "item" }>,
    record: StateRecordFacts,
  ): void {
    const { collection, id } = itemTarget(this.#state, view.type, record);
    const entity = this.#state.entity(view.type, collection, id);
    if (entity === undefined) {
      this.#taint.fail(entityTarget(view.type, collection, id));
      return;
    }
    const object = this.#input.io.withBody(record.ordinal, (body) =>
      body === undefined || body === null ? undefined : at(body, view.pointer),
    );
    if (isObject(object))
      this.#state.put(updatedEntity(entity, { ...entity.fields, ...object }));
    else this.#state.remove(entity);
  }

  /** Contradict the writes a failed check exercised, or, when none, the related writes since its targets were last checked; a failed list stops being checked. */
  #mismatch(failed: {
    readonly record: StateRecordFacts;
    readonly index: number;
    readonly keys: readonly string[];
    readonly exercised: ReadonlySet<string>;
    readonly view: StateView;
  }): void {
    if (failed.exercised.size > 0)
      for (const name of failed.exercised) {
        const draft = this.#drafts.get(name)!;
        draft.contradictedBy ??= failed.record.ordinal;
      }
    else {
      const since = Math.min(
        ...failed.keys.map((key) => this.#lastCheck.get(key) ?? -1),
      );
      for (const write of this.#log)
        if (
          write.index > since &&
          prefixRelated(write.path, failed.record.path)
        )
          this.#drafts.get(write.tool)!.sideEffect = true;
    }
    if (failed.view.shape !== "item")
      for (const key of failed.keys) this.#taint.fail(key);
  }

  /** A list that fails only for where one create placed its entities passes under another of that create's insert candidates. */
  #retryInsert(
    view: Extract<StateView, { shape: "list" }>,
    record: StateRecordFacts,
    exercised: ReadonlySet<string>,
  ): boolean {
    const collection = this.#line(view, record)?.collection;
    if (view.membership !== "all" || collection === undefined) return false;
    const members = this.#state.members(view.type, collection);
    const key = (entity: StateEntity) =>
      entityTarget(entity.type, entity.collection, entity.id);
    const inserted = members.filter((entity) =>
      this.#inserted.has(key(entity)),
    );
    const creates = new Set(
      inserted.map((entity) => this.#inserted.get(key(entity))!),
    );
    if (creates.size !== 1) return false;
    const [name] = creates;
    const draft = this.#drafts.get(name!)!;
    // An item read confirms the entity, not where a list places it.
    if (!exercised.has(name!) || this.#placed.has(name!)) return false;
    for (const candidate of draft.candidates.slice(1)) {
      for (const entity of inserted) this.#state.remove(entity);
      for (const entity of inserted) {
        const order = this.#state
          .members(view.type, collection)
          .map((member) => member.fields);
        this.#state.put(entity, insertIndex(candidate, order, entity.fields));
      }
      if (this.#check(view, record)?.pass === true) {
        draft.plan.insert = candidate;
        return true;
      }
    }
    return false;
  }
}
