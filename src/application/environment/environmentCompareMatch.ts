import { decodedSegment } from "../../domain/analysisView/environmentStateRules.js";
import { isPagingParameter } from "../../domain/analysisView/environmentStatePaging.js";
import { segmentRule } from "../../domain/analysisView/webNetworkRouteTemplates.js";
import type { JsonValue } from "../../domain/jsonValue.js";
import type {
  EnvironmentManifest,
  EnvironmentManifestTool,
} from "./environmentSource.js";
import { environmentToolArguments } from "./environmentTools.js";

const FORMAT_RULES: ReadonlySet<string> = new Set([
  "numeric",
  "uuid",
  "hex",
  "iso-date",
]);

/** One request of a probe capture, as the comparison replays it. */
export interface ProbeRequest {
  readonly method: string;
  readonly path: string;
  /** WHATWG query spelling including `?`, or null. */
  readonly query: string | null;
  readonly body: JsonValue | undefined;
}

/** A probe request as a call of one manifest tool. */
export interface ProbeToolCall {
  readonly tool: EnvironmentManifestTool;
  readonly args: Record<string, JsonValue>;
  /** Argument names of the path values, in path order. */
  readonly pathArguments: readonly string[];
  /** Argument names of query values that page a list: counts, never ids. */
  readonly pagingArguments: readonly string[];
  /** Query names the tool does not take; the call drops them. */
  readonly ignoredQuery: readonly string[];
}

/**
 * A tool's path segments up to `end`. A parameter stays `{}` unless `segments` gives the live value at that position,
 * decoded once and encoded again, so two parents of one template do not share a child collection, spellings replay
 * treats as equal name one, and a decoded slash stays inside its segment. An empty parent stays `{}`. A second
 * encoding stays distinct: decoding again would join it with the value.
 */
const collectionAt = (
  tool: EnvironmentManifestTool,
  end: number,
  segments?: readonly string[],
): string => {
  const params = new Set(tool.params.map((param) => param.index));
  return `/${tool.path_template
    .slice(1)
    .split("/")
    .slice(0, end)
    .map((segment, index) => {
      if (!params.has(index)) return segment;
      const value = segments?.[index];
      return value === undefined || value === ""
        ? "{}"
        : encodeURIComponent(decodedSegment(value));
    })
    .join("/")}`;
};

/** The collection a call of the tool names: its path, less the trailing parameter of an item route. */
export const collectionScope = (
  tool: EnvironmentManifestTool,
  segments?: readonly string[],
): string => {
  const length = tool.path_template.slice(1).split("/").length;
  return collectionAt(
    tool,
    tool.params.some((param) => param.index === length - 1)
      ? length - 1
      : length,
    segments,
  );
};

/** The collection each path parameter names an entity of: the path before it, by the parameter's position. */
export const parameterScopes = (
  tool: EnvironmentManifestTool,
  segments?: readonly string[],
): ReadonlyMap<number, string> =>
  new Map(
    tool.params.map((param) => [
      param.index,
      collectionAt(tool, param.index, segments),
    ]),
  );

/** Template positions that are literals, so a mapped id is not written over the route. */
export const literalPositions = (
  tool: EnvironmentManifestTool,
): ReadonlySet<number> => {
  const params = new Set(tool.params.map((param) => param.index));
  return new Set(
    tool.path_template
      .slice(1)
      .split("/")
      .flatMap((_, index) => (params.has(index) ? [] : [index])),
  );
};

interface Fit {
  readonly tool: EnvironmentManifestTool;
  readonly literals: number;
}

/** How a path fits a tool's template: the literal segments it matches, or undefined when it does not fit. */
const fitOf = (
  tool: EnvironmentManifestTool,
  segments: readonly string[],
): Fit | undefined => {
  const template = tool.path_template.slice(1).split("/");
  if (template.length !== segments.length) return undefined;
  const params = new Map(tool.params.map((param) => [param.index, param]));
  let literals = 0;
  for (const [index, part] of template.entries()) {
    const segment = segments[index]!;
    const param = params.get(index);
    if (param === undefined) {
      if (part !== segment && part !== decodedSegment(segment))
        return undefined;
      literals += 1;
    } else if (
      // Replay matches a path value decoded, so its format is the decoded value's.
      FORMAT_RULES.has(param.rule) &&
      segmentRule(decodedSegment(segment)) !== param.rule
    )
      return undefined;
    else if (segment === "") return undefined;
  }
  return { tool, literals };
};

/** The tool of the request's method whose template fits the path with the most literal segments; the manifest's order breaks ties. */
export const matchProbeRequest = (
  manifest: EnvironmentManifest,
  request: ProbeRequest,
): ProbeToolCall | undefined => {
  const segments = request.path.slice(1).split("/");
  let best: Fit | undefined;
  for (const tool of manifest.tools) {
    if (tool.method !== request.method) continue;
    const fit = fitOf(tool, segments);
    if (
      fit !== undefined &&
      (best === undefined || fit.literals > best.literals)
    )
      best = fit;
  }
  if (best === undefined) return undefined;
  const { tool } = best;
  const names = environmentToolArguments(tool);
  const args: Record<string, JsonValue> = {};
  const pathArguments: string[] = [];
  for (const param of tool.params) {
    const name = names.path.get(param.name) ?? param.name;
    // The environment decodes a path id once. Passing the raw segment keeps `book%2531` from becoming `book1`.
    args[name] = segments[param.index]!;
    pathArguments.push(name);
  }
  const ignoredQuery: string[] = [];
  const pagingArguments: string[] = [];
  if (request.query !== null)
    for (const [key, value] of new URLSearchParams(request.query.slice(1))) {
      const name = names.query.get(key);
      if (name === undefined) ignoredQuery.push(key);
      else if (!Object.hasOwn(args, name)) {
        args[name] = value;
        if (isPagingParameter(key)) pagingArguments.push(name);
      }
    }
  if (names.body !== undefined && request.body !== undefined)
    args[names.body] = request.body;
  return { tool, args, pathArguments, pagingArguments, ignoredQuery };
};
