import { z } from "zod";
import type { AnalysisError } from "../analysisErrorBase.js";
import { parseExactJson } from "../exactJsonNumber.js";
import { MAX_JSON_DEPTH, type JsonValue } from "../jsonValue.js";
import { ok, type Result } from "../result.js";
import {
  WEB_NETWORK_CAPTURE_LIMITS,
  type WebNetworkCaptureRecord,
} from "../webNetworkCapture.js";
import type { UnsignedAnalysisView } from "./analysisView.js";
import {
  EnvironmentManifestAccumulator,
  isJsonLike,
} from "./EnvironmentManifestAccumulator.js";
import { EnvironmentStateExtraction } from "./EnvironmentStateExtraction.js";
import type { TemplateRule } from "./environmentManifestRules.js";
import {
  deeperThan,
  hasPrototypeKey,
  isStateWrite,
  STATE_BODY_LIMIT_BYTES,
  type ParsedBody,
  type StateRecordFacts,
  type StateTimeline,
} from "./environmentStateRules.js";
import {
  base64PrefixChars,
  readRecordedResponseBody,
  type RecordedResponseBody,
} from "./recordedResponseBody.js";
import {
  ENTRY_BYTES,
  RECORD_SCRATCH_BYTES,
  mediaTypeEssence,
  readRecordedRequestLine,
  textBytes,
} from "./webNetworkRouteTemplates.js";

type StateView = Extract<UnsignedAnalysisView, { kind: "environment-state" }>;
type StateFields = Pick<
  StateView,
  | "origin"
  | "name"
  | "timeline"
  | "types"
  | "entities"
  | "documents"
  | "views"
  | "writes"
  | "write_clock"
  | "unknowns"
  | "coverage"
  | "limitations"
>;

/**
 * Levels the state's own nesting adds above a recorded value: Evidence, a `data/get` reply and a
 * JSON-RPC response hold a body's members about ten levels down, so a body must leave this much
 * room under the JSON depth limit to be sealed and served.
 */
const STATE_NESTING_DEPTH = 16;

/** A recorded response body as state JSON: a JSON-like media type, complete UTF-8 text within the state body limit, exact numbers and no `__proto__` member; otherwise undefined. */
export const stateBodyJson = (
  contentType: string | null,
  body: RecordedResponseBody,
): JsonValue | undefined => {
  if (
    contentType === null ||
    !isJsonLike(mediaTypeEssence(contentType)) ||
    body.bodyText === null ||
    body.bodyEncoding === "base64" ||
    body.bodyCut === true ||
    Buffer.byteLength(body.bodyText, "utf8") > STATE_BODY_LIMIT_BYTES
  )
    return undefined;
  const value = parseExactJson(body.bodyText);
  return value === undefined ||
    hasPrototypeKey(value) ||
    deeperThan(value, MAX_JSON_DEPTH - STATE_NESTING_DEPTH)
    ? undefined
    : value;
};

const timingSchema = z.object({
  startedDateTime: z.string(),
  time: z.number().nonnegative(),
});
const redactedWriteSchema = z.object({
  request: z.object({ method: z.string() }),
  response: z.object({ status: z.number() }).optional(),
});
const contentSchema = z.object({
  response: z.object({ content: z.object({ text: z.string() }) }),
});
const requestSchema = z.object({
  request: z.object({
    postData: z.object({ mimeType: z.string(), text: z.string() }),
  }),
});
const responseSizeSchema = z.object({
  response: z.object({
    status: z.number(),
    content: z.object({ text: z.string().optional() }).optional(),
  }),
});

interface RecordEntry {
  readonly facts: StateRecordFacts;
  /** Null for a write whose URL was redacted: its target is unknown, so it bounds every type. */
  readonly origin: string | null;
  readonly contentType: string;
  readonly timed: boolean;
  readonly record: WebNetworkCaptureRecord;
}

const UNKNOWNS: StateView["unknowns"] = [
  {
    kind: "authorization-model",
    statement:
      "Authorization headers and cookies are structurally excluded from captures; the state states no authorization model.",
  },
  {
    kind: "response-semantics",
    statement:
      "Views reproduce their recorded responses from the state; they do not establish how the application computes responses, derived values or values copied outside entity objects.",
  },
  {
    kind: "state-transition",
    statement:
      "The state is one snapshot from before the first related recorded write; write effects are modelled only from the calls the capture recorded, and served only where its later reads confirmed them.",
  },
];

/** The manifest's grouping plus the record facts and bodies the init state is extracted from. */
export class EnvironmentStateAccumulator extends EnvironmentManifestAccumulator {
  readonly #entries = new Map<number, RecordEntry>();

  constructor(
    maximumBytes = WEB_NETWORK_CAPTURE_LIMITS.outputBytes,
    rules: readonly TemplateRule[] = [],
  ) {
    super(maximumBytes, true, rules, "Environment-state");
  }

  /** The state publishes no body shapes. */
  protected override get reportsBodyShapes(): boolean {
    return false;
  }

  override add(record: WebNetworkCaptureRecord): Result<void, AnalysisError> {
    const grouped = super.add(record);
    if (!grouped.ok) return grouped;
    try {
      const line = readRecordedRequestLine(record.reported, true, this.scratch);
      if (line === null) return this.overBudget();
      const timing = timingSchema.safeParse(record.reported);
      const start = timing.success
        ? Date.parse(timing.data.startedDateTime)
        : Number.NaN;
      const timed = timing.success && Number.isFinite(start);
      if (line.kind === "excluded")
        return line.reason === "url-redacted"
          ? this.#redactedWrite(
              record,
              timing.success && timed
                ? { start, end: start + timing.data.time }
                : undefined,
            )
          : ok(undefined);
      // The entry keeps the line's strings and a reference to the already admitted record.
      if (
        !this.retain(
          ENTRY_BYTES * 8 +
            textBytes(
              line.method.length +
                line.origin.length +
                line.path.length +
                (line.query?.length ?? 0) +
                line.rawMime.length,
            ),
        )
      )
        return this.overBudget();
      this.#entries.set(record.ordinal, {
        facts: {
          ordinal: record.ordinal,
          method: line.method,
          path: line.path,
          query: line.query === "" ? undefined : line.query,
          status: line.status,
          start: timed ? start : record.ordinal,
          end: timed ? start + timing.data.time : record.ordinal,
        },
        origin: line.origin,
        contentType: line.rawMime,
        timed,
        record,
      });
      return ok(undefined);
    } finally {
      this.releaseTemporary();
    }
  }

  /** Keep a successful write whose URL was redacted, with an empty path whose root relates to every type. */
  #redactedWrite(
    record: WebNetworkCaptureRecord,
    timing: { readonly start: number; readonly end: number } | undefined,
  ): Result<void, AnalysisError> {
    const parsed = redactedWriteSchema.safeParse(record.reported);
    if (!parsed.success) return ok(undefined);
    const status = parsed.data.response?.status ?? 0;
    const facts: StateRecordFacts = {
      ordinal: record.ordinal,
      method: parsed.data.request.method,
      path: "",
      query: undefined,
      status: status > 0 ? status : null,
      start: timing?.start ?? record.ordinal,
      end: timing?.end ?? record.ordinal,
    };
    if (!isStateWrite(facts)) return ok(undefined);
    if (!this.retain(ENTRY_BYTES * 8 + textBytes(facts.method.length)))
      return this.overBudget();
    this.#entries.set(record.ordinal, {
      facts,
      origin: null,
      contentType: "",
      timed: timing !== undefined,
      record,
    });
    return ok(undefined);
  }

  /** Parse one retained response body as state JSON, charging its decoding and tree as temporary work. */
  #body(ordinal: number): ParsedBody | null {
    const entry = this.#entries.get(ordinal);
    // A body that is not JSON-like is refused before its decoding is charged.
    if (entry === undefined || !isJsonLike(mediaTypeEssence(entry.contentType)))
      return { kind: "unusable" };
    const content = contentSchema.safeParse(entry.record.reported);
    if (!content.success) return { kind: "unusable" };
    // Larger bodies are never parsed; within the limit, decoding copies at most the retained text and the tree is linear in it.
    const length = content.data.response.content.text.length;
    if (length > base64PrefixChars(STATE_BODY_LIMIT_BYTES))
      return { kind: "unusable" };
    if (!this.temporary(RECORD_SCRATCH_BYTES + textBytes(length) * 4))
      return null;
    const value = stateBodyJson(
      entry.contentType,
      readRecordedResponseBody(entry.record, STATE_BODY_LIMIT_BYTES),
    );
    return value === undefined ? { kind: "unusable" } : { kind: "json", value };
  }

  /** Parse one recorded request body as state JSON, as response bodies are admitted. */
  #requestBody(ordinal: number): ParsedBody | null {
    const entry = this.#entries.get(ordinal);
    const request = requestSchema.safeParse(entry?.record.reported);
    if (
      entry === undefined ||
      !request.success ||
      !isJsonLike(mediaTypeEssence(request.data.request.postData.mimeType))
    )
      return { kind: "unusable" };
    const { mimeType, text } = request.data.request.postData;
    if (Buffer.byteLength(text, "utf8") > STATE_BODY_LIMIT_BYTES)
      return { kind: "unusable" };
    if (!this.temporary(RECORD_SCRATCH_BYTES + textBytes(text.length) * 4))
      return null;
    try {
      const value = stateBodyJson(mimeType, { bodyText: text });
      return value === undefined
        ? { kind: "unusable" }
        : { kind: "json", value };
    } finally {
      this.releaseTemporary();
    }
  }

  /** Whether a record's response carried no body: a 204, or empty content. */
  #emptyResponse(ordinal: number): boolean {
    const parsed = responseSizeSchema.safeParse(
      this.#entries.get(ordinal)?.record.reported,
    );
    return (
      parsed.success &&
      (parsed.data.response.status === 204 ||
        (parsed.data.response.content?.text ?? "") === "")
    );
  }

  /** Project the init state of the manifest's primary origin; records keep timeline order. */
  finishState(): Result<StateFields, AnalysisError> {
    const manifest = this.finish();
    if (!manifest.ok) return manifest;
    const entries = [...this.#entries.values()].filter(
      (entry) =>
        entry.origin === manifest.value.origin || entry.origin === null,
    );
    const redactedWrites = entries.filter(
      (entry) => entry.origin === null,
    ).length;
    const timeline: StateTimeline =
      entries.length > 0 && entries.every((entry) => entry.timed)
        ? "recorded-start-time"
        : "record-order";
    const records = entries
      .map((entry) => entry.facts)
      .sort((left, right) =>
        timeline === "record-order"
          ? left.ordinal - right.ordinal
          : left.start - right.start || left.ordinal - right.ordinal,
      )
      .map((facts) =>
        timeline === "record-order"
          ? { ...facts, start: facts.ordinal, end: facts.ordinal }
          : facts,
      );
    const state = new EnvironmentStateExtraction({
      tools: manifest.value.tools,
      records,
      timeline,
      budget: {
        body: (ordinal) => this.#body(ordinal),
        requestBody: (ordinal) => this.#requestBody(ordinal),
        emptyResponse: (ordinal) => this.#emptyResponse(ordinal),
        retain: (bytes) => this.retain(bytes),
        release: () => this.releaseTemporary(),
      },
    }).run();
    if (state === null) return this.overBudget();
    const limitations = this.addLimitations([
      ...(redactedWrites > 0
        ? [
            `${String(redactedWrites)} of the recorded writes had a redacted URL; each ends the initial state of every type, since its target is unknown.`,
          ]
        : []),
      ...(timeline === "record-order"
        ? [
            "Some records carry no start time, so the state's timeline is record order and overlapping requests are not detected.",
          ]
        : []),
      ...(state.views.some((view) => view.shape === "recorded")
        ? [
            "Tools whose recordings do not reproduce from the extracted state are listed as recorded views with the reason; they replay their recordings.",
          ]
        : []),
    ]);
    if (!limitations.ok) return limitations;
    return ok({
      origin: manifest.value.origin,
      name: manifest.value.name,
      timeline,
      ...state,
      unknowns: UNKNOWNS.map((unknown) => ({ ...unknown })),
      coverage: manifest.value.coverage,
      limitations: this.sortedLimitations(),
    });
  }
}
