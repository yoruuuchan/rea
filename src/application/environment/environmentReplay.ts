import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { AnalysisInputError } from "../../domain/analysisErrorCore.js";
import type { JsonValue } from "../../domain/jsonValue.js";
import {
  iterateUrlQueryParameters,
  recordedPathSegments,
} from "../../domain/recordedTransportUrl.js";
import { err, ok, type Result } from "../../domain/result.js";
import { environmentToolArguments } from "./environmentTools.js";
import {
  REPLAY_BODY_LIMIT_BYTES,
  ENVIRONMENT_SERVE_OPERATION,
  replayedBody,
  type EnvironmentManifestTool,
  type EnvironmentSource,
  type RecordedExchange,
} from "./environmentSource.js";

/** Caller arguments as the MCP tool receives them. */
export type ReplayArguments = Readonly<Record<string, unknown>>;

/** What one tool call returns: the recorded response and where it came from. */
export interface ReplayResult {
  readonly status: number | null;
  readonly content_type: string | null;
  readonly body: JsonValue;
  readonly replay: {
    readonly record_ordinal: number;
    readonly evidence_id: string;
    readonly exact_match: boolean;
    readonly recorded_path: string;
    readonly recorded_query: string | null;
    /** Set when the recorded path or query was cut to REPLAY_METADATA_LIMIT_BYTES; the Evidence record keeps it whole. */
    readonly recorded_line_truncated: boolean;
    readonly content_type_truncated: boolean;
    readonly body_recorded: boolean;
    readonly body_encoding: "utf-8" | "base64";
    readonly truncated: boolean;
  };
}

interface MatchScore {
  readonly pathMatches: number;
  /** Path matches whose recorded segment equals the value as given, not only after decoding. */
  readonly verbatimMatches: number;
  readonly queryMatches: number;
  readonly exact: boolean;
}

/** A path segment percent-decoded, or as written when it is not valid percent-encoding. */
export const decodedPathSegment = (segment: string): string => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
};

/** Replay's path rule: a supplied value matches a recorded segment equal to it verbatim or after percent-decoding. */
export const pathValueMatches = (segment: string, value: string): boolean =>
  segment === value || decodedPathSegment(segment) === value;

/** Count how many supplied path and query values the recorded request line satisfies. */
const scoreExchange = (
  tool: EnvironmentManifestTool,
  pathArguments: ReadonlyMap<string, string>,
  queryArguments: ReadonlyMap<string, string>,
  exchange: RecordedExchange,
  args: ReplayArguments,
): MatchScore => {
  const providedPaths: { index: number; value: string }[] = [];
  for (const param of tool.params) {
    const value = args[pathArguments.get(param.name) ?? param.name];
    if (typeof value === "string")
      providedPaths.push({ index: param.index, value });
  }
  const segments =
    providedPaths.length === 0
      ? new Map<number, string>()
      : recordedPathSegments(
          exchange.path,
          providedPaths.map((param) => param.index),
        );
  const pathProvided = providedPaths.length;
  let pathMatches = 0;
  let verbatimMatches = 0;
  for (const { index, value } of providedPaths) {
    const segment = segments.get(index);
    if (segment === value) verbatimMatches += 1;
    if (segment !== undefined && pathValueMatches(segment, value))
      pathMatches += 1;
  }
  const supplied = new Map<string, string>();
  for (const [name, argument] of queryArguments) {
    const value = args[argument];
    if (typeof value === "string") supplied.set(name, value);
  }
  const matched = new Set<string>();
  if (supplied.size > 0)
    for (const [name, value] of iterateUrlQueryParameters(
      exchange.query ?? "",
    )) {
      if (supplied.get(name) === value) matched.add(name);
      if (matched.size === supplied.size) break;
    }
  const queryProvided = supplied.size;
  const queryMatches = matched.size;
  return {
    pathMatches,
    verbatimMatches,
    queryMatches,
    exact: pathMatches === pathProvided && queryMatches === queryProvided,
  };
};

const outranks = (score: MatchScore, best: MatchScore): boolean =>
  score.pathMatches !== best.pathMatches
    ? score.pathMatches > best.pathMatches
    : score.verbatimMatches !== best.verbatimMatches
      ? score.verbatimMatches > best.verbatimMatches
      : score.queryMatches > best.queryMatches;

/** Choose the record whose path segments, then verbatim spellings, then query values best match the call; ties keep manifest order. */
export const selectReplayExchange = (
  tool: EnvironmentManifestTool,
  exchanges: ReadonlyMap<number, RecordedExchange>,
  args: ReplayArguments,
):
  | { readonly exchange: RecordedExchange; readonly exact: boolean }
  | undefined => {
  let best: { exchange: RecordedExchange; score: MatchScore } | undefined;
  const argumentsMap = environmentToolArguments(tool);
  for (const ordinal of tool.record_ordinals) {
    const exchange = exchanges.get(ordinal);
    if (exchange === undefined) continue;
    const score = scoreExchange(
      tool,
      argumentsMap.path,
      argumentsMap.query,
      exchange,
      args,
    );
    if (best === undefined || outranks(score, best.score))
      best = { exchange, score };
  }
  return best === undefined
    ? undefined
    : { exchange: best.exchange, exact: best.score.exact };
};

/** Whether the arguments name one recorded request line exactly: every path value supplied and matching, every supplied query value matching, and every recorded query parameter supplied with its recorded value. */
export const selectsRecordedLine = (
  tool: EnvironmentManifestTool,
  exchange: RecordedExchange,
  args: ReplayArguments,
): boolean => {
  const argumentsMap = environmentToolArguments(tool);
  if (
    !tool.params.every(
      (param) =>
        typeof args[argumentsMap.path.get(param.name) ?? param.name] ===
        "string",
    ) ||
    !scoreExchange(tool, argumentsMap.path, argumentsMap.query, exchange, args)
      .exact
  )
    return false;
  for (const [name, value] of iterateUrlQueryParameters(exchange.query ?? "")) {
    const argument = argumentsMap.query.get(name);
    if (argument === undefined || args[argument] !== value) return false;
  }
  return true;
};

/** The longest prefix of text whose UTF-8 encoding fits the byte limit, encoding only that prefix. */
const utf8Prefix = (text: string, maxBytes: number): string => {
  // encodeInto stops before the first character that does not fit, so `read` ends on a boundary.
  const { read } = new TextEncoder().encodeInto(text, new Uint8Array(maxBytes));
  return text.slice(0, read);
};

/** Base64 characters, in whole groups, whose bytes fit the replay limit. */
const BASE64_LIMIT_CHARS = Math.floor(REPLAY_BODY_LIMIT_BYTES / 3) * 4;

interface ReplayBody {
  readonly body: JsonValue;
  readonly truncated: boolean;
}

/** The reply body and whether it was cut, as the source classifies the retained body. */
const replayBody = (exchange: RecordedExchange): ReplayBody => {
  const body = replayedBody(exchange);
  switch (body.kind) {
    case "none":
      return { body: null, truncated: false };
    case "base64":
      return body.whole
        ? { body: body.encoded, truncated: false }
        : { body: body.encoded.slice(0, BASE64_LIMIT_CHARS), truncated: true };
    case "cut":
      return {
        body: utf8Prefix(body.text, REPLAY_BODY_LIMIT_BYTES),
        truncated: true,
      };
    case "json":
      return { body: body.value, truncated: false };
    case "text":
      return { body: body.text, truncated: false };
  }
};

/** Recorded paths and queries are cut to this many UTF-8 bytes in replies. */
export const REPLAY_METADATA_LIMIT_BYTES = 1024;

/** Replay one tool call from the retained record that best matches its arguments. */
export const replayEnvironmentTool = (
  source: EnvironmentSource,
  tool: EnvironmentManifestTool,
  args: ReplayArguments,
): Result<ReplayResult, AnalysisError> => {
  const selected = selectReplayExchange(tool, source.exchanges, args);
  if (selected === undefined)
    return err(
      new AnalysisInputError(
        ENVIRONMENT_SERVE_OPERATION,
        {
          userMessage: `Tool ${tool.name} cites no retained record to replay.`,
        },
        [{ path: ["tool"], reason: "invalid_value", expected: tool.name }],
      ),
    );
  return ok(replayAnswer(source, selected.exchange, selected.exact));
};

/** A tool answer with one recorded exchange's status, content type and provenance; the body defaults to the recorded one. */
export const replayAnswer = (
  source: EnvironmentSource,
  exchange: RecordedExchange,
  exact: boolean,
  { body, truncated }: ReplayBody = replayBody(exchange),
): ReplayResult => {
  const recordedPath = utf8Prefix(exchange.path, REPLAY_METADATA_LIMIT_BYTES);
  const recordedQuery =
    exchange.query === null
      ? null
      : utf8Prefix(exchange.query, REPLAY_METADATA_LIMIT_BYTES);
  const contentType =
    exchange.contentType === null
      ? null
      : utf8Prefix(exchange.contentType, REPLAY_METADATA_LIMIT_BYTES);
  return {
    status: exchange.status,
    content_type: contentType,
    body,
    replay: {
      record_ordinal: exchange.ordinal,
      evidence_id: source.evidenceId,
      exact_match: exact,
      recorded_path: recordedPath,
      recorded_query: recordedQuery,
      recorded_line_truncated:
        recordedPath.length < exchange.path.length ||
        (recordedQuery?.length ?? 0) < (exchange.query?.length ?? 0),
      content_type_truncated: contentType !== exchange.contentType,
      body_recorded: exchange.bodyText !== null,
      body_encoding: exchange.bodyEncoding ?? "utf-8",
      truncated,
    },
  };
};
