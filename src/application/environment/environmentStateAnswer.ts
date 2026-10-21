import { stateBodyJson } from "../../domain/analysisView/EnvironmentStateAccumulator.js";
import {
  collectionPathOf,
  listItems,
  renderStateEntity,
  renderStateList,
  replaceAt,
  scalarText,
  segmentsOf,
  type JsonObject,
  type RecordedViewReason,
  type StateEntity,
  type StateItemView,
  type StateListView,
  type StateView,
} from "../../domain/analysisView/environmentStateRules.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisInputError,
  AnalysisResourceConstraintError,
} from "../../domain/analysisErrorCore.js";
import type { JsonValue } from "../../domain/jsonValue.js";
import { err, ok, type Result } from "../../domain/result.js";
import {
  decodedPathSegment,
  pathValueMatches,
  replayAnswer,
  replayEnvironmentTool,
  selectReplayExchange,
  selectsRecordedLine,
  type ReplayArguments,
  type ReplayResult,
} from "./environmentReplay.js";
import {
  ENVIRONMENT_SERVE_OPERATION,
  REPLAY_BODY_LIMIT_BYTES,
  type EnvironmentManifestTool,
  type EnvironmentSource,
  type RecordedExchange,
} from "./environmentSource.js";
import type { EnvironmentStateStore } from "./environmentStateStore.js";
import { environmentToolArguments } from "./environmentTools.js";

/** Where a served answer came from: the live state, or a recording and why. */
export type StateProvenance =
  | {
      readonly source: "recording";
      readonly reason: RecordedViewReason | "no-view" | "unrecorded-request";
    }
  | {
      readonly source: "state";
      readonly view: "item";
      readonly type: string;
      readonly collection: string;
      readonly id: string;
    }
  | {
      readonly source: "state";
      readonly view: "list";
      readonly type: string;
      readonly collection: string;
      readonly membership: "all" | "recorded";
      readonly listed: number;
    }
  | {
      readonly source: "state";
      readonly view: "document";
      readonly path: string;
    };

/** A replay answer that also says whether the state or a recording produced it. */
export interface StateAnswer extends ReplayResult {
  readonly state: StateProvenance;
}

/** The manifest and capture a state answer cites, and the live state it reads. */
export interface StateServing {
  readonly source: EnvironmentSource;
  readonly store: EnvironmentStateStore;
}

const refused = (
  tool: EnvironmentManifestTool,
  userMessage: string,
): AnalysisError =>
  new AnalysisInputError(ENVIRONMENT_SERVE_OPERATION, { userMessage }, [
    { path: ["tool"], reason: "invalid_value", expected: tool.name },
  ]);

/** One entity as an item or list view shows it, or a refusal when it lacks a field the view's every recording carried; a partial body is never answered. */
const shownEntity = (
  tool: EnvironmentManifestTool,
  view: StateItemView | StateListView,
  entity: StateEntity,
  volatile: ReadonlySet<string>,
): Result<JsonObject, AnalysisError> => {
  const shown = renderStateEntity(entity, view, volatile);
  const missing = view.required_fields.filter(
    (name) => !Object.hasOwn(shown, name),
  );
  return missing.length === 0
    ? ok(shown)
    : err(
        refused(
          tool,
          `The state holds no complete ${view.type} entity ${entity.id} in ${entity.collection}: it lacks fields this tool's responses always carried: ${missing.join(", ")}.`,
        ),
      );
};

/** The recorded answer, labelled with why the state did not produce it. */
const fromRecording = (
  source: EnvironmentSource,
  tool: EnvironmentManifestTool,
  args: ReplayArguments,
  reason: Extract<StateProvenance, { source: "recording" }>["reason"],
): Result<StateAnswer, AnalysisError> => {
  const replayed = replayEnvironmentTool(source, tool, args);
  return replayed.ok
    ? ok({ ...replayed.value, state: { source: "recording", reason } })
    : replayed;
};

/** A recorded body the state renders into, usable exactly when extraction could use it. */
const recordedJson = (exchange: RecordedExchange): JsonValue | undefined =>
  stateBodyJson(exchange.contentType, exchange);

/** The rendered body on the base record's status, content type and provenance; never cut. */
const stateAnswer = (
  serving: StateServing,
  base: { readonly exchange: RecordedExchange; readonly exact: boolean },
  body: JsonValue,
  state: StateProvenance,
): Result<StateAnswer, AnalysisError> => {
  const bytes = Buffer.byteLength(JSON.stringify(body), "utf8");
  if (bytes > REPLAY_BODY_LIMIT_BYTES)
    return err(
      new AnalysisResourceConstraintError(
        ENVIRONMENT_SERVE_OPERATION,
        "capacity",
        "The answer rendered from the state exceeds the reply body limit",
        { max_body_bytes: REPLAY_BODY_LIMIT_BYTES, body_bytes: bytes },
        {
          retryable: false,
          remediationAction:
            "Load a smaller state with data/add; the state is not cut to fit.",
        },
      ),
    );
  return ok({
    ...replayAnswer(serving.source, base.exchange, base.exact, {
      body,
      truncated: false,
    }),
    state,
  });
};

/** One collection segment an item call names: a template literal, or a supplied path value. */
interface CallSegment {
  readonly text: string;
  readonly supplied: boolean;
}

/** An item call's collection segments and identity value, kept as supplied rather than joined and re-split. */
interface ItemCall {
  readonly segments: readonly CallSegment[];
  readonly id: string;
}

/** What an item call names, or undefined when a path argument is missing. */
const itemCall = (
  tool: EnvironmentManifestTool,
  args: ReplayArguments,
): ItemCall | undefined => {
  const names = environmentToolArguments(tool).path;
  const params = new Map(tool.params.map((param) => [param.index, param]));
  const segments: CallSegment[] = [];
  const template = tool.path_template
    .slice(tool.path_template.indexOf("/") + 1)
    .split("/");
  for (const [index, text] of template.entries()) {
    const param = params.get(index);
    if (param === undefined) {
      if (text !== "") segments.push({ text, supplied: false });
      continue;
    }
    const value = args[names.get(param.name) ?? param.name];
    if (typeof value !== "string") return undefined;
    segments.push({ text: value, supplied: true });
  }
  const last = segments.pop();
  return last?.supplied === true ? { segments, id: last.text } : undefined;
};

/** How many supplied segments a held collection matches verbatim, when it matches the call under replay's path rule. */
const collectionMatch = (
  collection: string,
  segments: readonly CallSegment[],
): number | undefined => {
  const held = segmentsOf(collection);
  if (held.length !== segments.length) return undefined;
  let verbatim = 0;
  for (const [index, { text, supplied }] of segments.entries()) {
    const segment = held[index]!;
    if (supplied ? !pathValueMatches(segment, text) : segment !== text)
      return undefined;
    if (supplied && segment === text) verbatim += 1;
  }
  return verbatim;
};

/** The entity an item call names, preferring verbatim collection spellings as replay does; the id is tried percent-decoded, then as written. */
const namedEntity = (
  store: EnvironmentStateStore,
  type: string,
  call: ItemCall,
): StateEntity | undefined => {
  const ids = [...new Set([decodedPathSegment(call.id), call.id])];
  const candidates = store
    .collectionsOf(type)
    .flatMap((collection) => {
      const verbatim = collectionMatch(collection, call.segments);
      return verbatim === undefined ? [] : [{ collection, verbatim }];
    })
    .sort((left, right) => right.verbatim - left.verbatim);
  for (const { collection } of candidates)
    for (const id of ids) {
      const entity = store.entity(type, collection, id);
      if (entity !== undefined) return entity;
    }
  return undefined;
};

/** An item call renders the named entity into the recorded envelope; it never invents an entity. */
const answerItem = (
  serving: StateServing,
  tool: EnvironmentManifestTool,
  view: StateItemView,
  args: ReplayArguments,
): Result<StateAnswer, AnalysisError> => {
  const { source, store } = serving;
  const call = itemCall(tool, args);
  if (call === undefined)
    return err(refused(tool, `Tool ${tool.name} needs every path argument.`));
  const entity = namedEntity(store, view.type, call);
  if (entity === undefined)
    return err(
      refused(
        tool,
        `The state holds no ${view.type} entity ${call.id} in /${call.segments.map(({ text }) => text).join("/")}.`,
      ),
    );
  const shown = shownEntity(
    tool,
    view,
    entity,
    new Set(store.type(view.type)?.volatile_fields),
  );
  if (!shown.ok) return shown;
  const base = source.exchanges.get(view.envelope_ordinal);
  const envelope = base === undefined ? undefined : recordedJson(base);
  if (base === undefined || envelope === undefined)
    return err(
      refused(tool, `Tool ${tool.name} has no usable recorded envelope.`),
    );
  const exact =
    selectReplayExchange(tool, new Map([[base.ordinal, base]]), args)?.exact ===
    true;
  return stateAnswer(
    serving,
    { exchange: base, exact },
    replaceAt(envelope, view.pointer, shown.value),
    {
      source: "state",
      view: "item",
      type: view.type,
      collection: entity.collection,
      id: entity.id,
    },
  );
};

/** The checked recorded line a list or document call names exactly, chosen among them as replay chooses; later or filtered recordings never qualify. */
const checkedLine = (
  source: EnvironmentSource,
  tool: EnvironmentManifestTool,
  checked: readonly number[],
  args: ReplayArguments,
): RecordedExchange | undefined => {
  const lines = new Map<number, RecordedExchange>();
  for (const ordinal of checked) {
    const exchange = source.exchanges.get(ordinal);
    if (exchange !== undefined && selectsRecordedLine(tool, exchange, args))
      lines.set(ordinal, exchange);
  }
  return selectReplayExchange(tool, lines, args)?.exchange;
};

type StateDocumentView = Extract<StateView, { shape: "document" }>;

/** One tool call: the tool and the arguments it was called with. */
interface ToolCall {
  readonly tool: EnvironmentManifestTool;
  readonly args: ReplayArguments;
}

/** A list call renders the members of the checked line it names from the state. */
const answerList = (
  serving: StateServing,
  { tool, args }: ToolCall,
  view: StateListView,
  base: RecordedExchange,
): Result<StateAnswer, AnalysisError> => {
  const { source, store } = serving;
  const envelope = recordedJson(base);
  const recorded =
    envelope === undefined ? undefined : listItems(envelope, view.pointer);
  if (envelope === undefined || recorded === undefined)
    return fromRecording(source, tool, args, "body-unusable");
  const collection = collectionPathOf(base, false);
  const type = store.type(view.type);
  const members: readonly StateEntity[] =
    view.membership === "all"
      ? store.inCollection(view.type, collection)
      : recorded.flatMap((item) => {
          const id = scalarText(item[type?.id_field ?? ""]);
          const entity =
            id === undefined
              ? undefined
              : store.entity(view.type, collection, id);
          return entity === undefined ? [] : [entity];
        });
  const volatile = new Set(type?.volatile_fields);
  const items: JsonObject[] = [];
  for (const entity of members) {
    const shown = shownEntity(tool, view, entity, volatile);
    if (!shown.ok) return shown;
    items.push(shown.value);
  }
  return stateAnswer(
    serving,
    { exchange: base, exact: true },
    renderStateList(view, envelope, items),
    {
      source: "state",
      view: "list",
      type: view.type,
      collection,
      membership: view.membership,
      listed: items.length,
    },
  );
};

/** A document call answers the state's value for the document on its checked line's status and provenance. */
const answerDocument = (
  serving: StateServing,
  tool: EnvironmentManifestTool,
  base: RecordedExchange,
): Result<StateAnswer, AnalysisError> => {
  const current = serving.store.document(tool.name);
  if (current === undefined)
    return err(refused(tool, `The state holds no document for ${tool.name}.`));
  return stateAnswer(serving, { exchange: base, exact: true }, current.value, {
    source: "state",
    view: "document",
    path: current.path,
  });
};

/** A list or document call that names a checked line answers from the state; one that names none answers from its recording. */
const answerCheckedLine = (
  serving: StateServing,
  tool: EnvironmentManifestTool,
  view: StateListView | StateDocumentView,
  args: ReplayArguments,
): Result<StateAnswer, AnalysisError> => {
  const base = checkedLine(
    serving.source,
    tool,
    view.checked_record_ordinals,
    args,
  );
  if (base === undefined)
    return fromRecording(serving.source, tool, args, "unrecorded-request");
  return view.shape === "list"
    ? answerList(serving, { tool, args }, view, base)
    : answerDocument(serving, tool, base);
};

/** Answer one read tool call from the live state where its view is state-backed, else from its recordings. */
export const answerFromState = (
  serving: StateServing,
  tool: EnvironmentManifestTool,
  args: ReplayArguments,
): Result<StateAnswer, AnalysisError> => {
  const view = serving.store.state.views.get(tool.name);
  if (view === undefined)
    return fromRecording(serving.source, tool, args, "no-view");
  switch (view.shape) {
    case "recorded":
      return fromRecording(serving.source, tool, args, view.reason);
    case "item":
      return answerItem(serving, tool, view, args);
    case "list":
    case "document":
      return answerCheckedLine(serving, tool, view, args);
  }
};

/** How a served environment answers one tool call. */
export type EnvironmentToolAnswer = (
  tool: EnvironmentManifestTool,
  args: ReplayArguments,
) => Result<ReplayResult, AnalysisError>;

/** The answer a served environment gives: replay without a state store, the live state with one. */
export const environmentToolAnswer = (
  source: EnvironmentSource,
  store: EnvironmentStateStore | undefined,
): EnvironmentToolAnswer =>
  store === undefined
    ? (tool, args) => replayEnvironmentTool(source, tool, args)
    : (tool, args) => answerFromState({ source, store }, tool, args);
