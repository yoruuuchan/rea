import * as t from "@babel/types";

import type { JavaScriptModuleOrigin } from "./javascriptSemanticIr.js";
import {
  resolveSemanticBindingState,
  semanticResolutionBlocked,
  type JavaScriptSemanticAnalysisState,
  type JavaScriptSemanticBindingState,
} from "./javascriptSemanticState.js";
import {
  semanticStaticPropertyKey,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import { stringValue } from "./javascriptStaticAnalysisHelpers.js";

interface JavaScriptRequireOrigin {
  readonly origin: JavaScriptModuleOrigin;
  readonly call: t.CallExpression;
}

/** Recover an unshadowed literal require origin and its exact member path. */
export const semanticRequireOrigin = (
  node: t.Node | null | undefined,
  state: JavaScriptSemanticAnalysisState,
): JavaScriptRequireOrigin | undefined => {
  const members: string[] = [];
  let current = node;
  while (current !== null && current !== undefined) {
    current = unwrapJavaScriptExpression(current).node;
    if (
      !t.isMemberExpression(current) &&
      !t.isOptionalMemberExpression(current)
    )
      break;
    const member = semanticStaticPropertyKey(
      current.property,
      current.computed,
    );
    if (member === null || !t.isNode(current.object)) return undefined;
    members.push(member);
    current = current.object;
  }
  if (
    !t.isCallExpression(current) ||
    !t.isIdentifier(current.callee, { name: "require" })
  )
    return undefined;
  if (
    resolveSemanticBindingState(state, current.callee, "require") !==
      undefined ||
    semanticResolutionBlocked(state, current.callee, "require")
  )
    return undefined;
  const specifier = stringValue(current.arguments[0]);
  return specifier === undefined
    ? undefined
    : {
        origin: { specifier, importedPath: members.reverse() },
        call: current,
      };
};

// esbuild/Rolldown, TypeScript, and Babel emit these helpers for namespace
// imports of CommonJS modules; each returns an object exposing every own
// member of its operand, so member paths through the result are unchanged.
// Helper bodies are not evaluated: recognition trusts a single program-scope
// function definition under one of these emitted names.
const NAMESPACE_INTEROP_HELPERS = new Set([
  "__importStar",
  "__toESM",
  "_interopRequireWildcard",
]);

/** Return the module operand of a locally declared namespace interop helper. */
export const semanticNamespaceInteropOperand = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
): t.Expression | undefined => {
  const call = unwrapJavaScriptExpression(node).node;
  if (
    !t.isCallExpression(call) ||
    !t.isIdentifier(call.callee) ||
    !NAMESPACE_INTEROP_HELPERS.has(call.callee.name) ||
    semanticResolutionBlocked(state, call.callee, call.callee.name)
  )
    return undefined;
  const helper = resolveSemanticBindingState(
    state,
    call.callee,
    call.callee.name,
  );
  const [operand] = call.arguments;
  return helper !== undefined &&
    emittedInteropHelper(helper, state) &&
    t.isExpression(operand)
    ? operand
    : undefined;
};

// Emitters declare each helper once at program scope as a function, an
// arrow/function expression, or `(this && this.name) || <function>`.
const emittedInteropHelper = (
  helper: JavaScriptSemanticBindingState,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  const [initializer] = helper.initializers;
  if (
    initializer === undefined ||
    helper.initializers.length !== 1 ||
    helper.definitions.length !== 1 ||
    (helper.kind !== "function" && helper.kind !== "variable") ||
    state.scopesById.get(helper.scopeId)?.kind !== "program"
  )
    return false;
  const value = unwrapJavaScriptExpression(initializer.node).node;
  const emitted =
    t.isLogicalExpression(value, { operator: "||" }) &&
    t.isLogicalExpression(unwrapJavaScriptExpression(value.left).node, {
      operator: "&&",
    })
      ? unwrapJavaScriptExpression(value.right).node
      : value;
  return (
    t.isFunctionDeclaration(emitted) ||
    t.isFunctionExpression(emitted) ||
    t.isArrowFunctionExpression(emitted) ||
    (t.isCallExpression(emitted) &&
      (t.isFunctionExpression(emitted.callee) ||
        t.isArrowFunctionExpression(emitted.callee)))
  );
};
