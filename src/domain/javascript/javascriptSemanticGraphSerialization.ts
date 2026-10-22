import { canonicalJson } from "../comparisonSemantics.js";
import {
  javaScriptSemanticGraphSchema,
  type JavaScriptSemanticGraph,
} from "./javascriptSemanticGraph.js";

/** Parse a stored semantic graph and reject stale IDs. */
export const parseJavaScriptSemanticGraph = (
  input: unknown,
): JavaScriptSemanticGraph => javaScriptSemanticGraphSchema.parse(input);

/** Serialize a verified semantic graph as canonical JSON. */
export const serializeJavaScriptSemanticGraph = (input: unknown): string =>
  canonicalJson(
    parseJavaScriptSemanticGraph(input),
    "JavaScript semantic graph",
  );
