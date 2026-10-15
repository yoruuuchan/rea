import * as t from "@babel/types";

import { unwrapJavaScriptExpression } from "./javascriptAstValues.js";

const preserveGrouping = { stopAtParentheses: true } as const;

/** Instance values run on construction; their computed keys run at definition. */
export const delayedInstanceFieldValue = (
  parent: t.Node | undefined,
  child: t.Node | undefined,
): boolean =>
  (t.isClassProperty(parent) ||
    t.isClassPrivateProperty(parent) ||
    t.isClassAccessorProperty(parent)) &&
  !parent.static &&
  parent.value === child;

/** Shared branch facts for binding writes and their possible execution positions. */
export const semanticBranchMayBeSkipped = (
  parent: t.Node,
  child: t.Node,
): boolean => {
  if (delayedInstanceFieldValue(parent, child)) return true;
  if (t.isIfStatement(parent))
    return child === parent.consequent || child === parent.alternate;
  if (t.isSwitchCase(parent)) return true;
  if (t.isTryStatement(parent))
    return child === parent.block || child === parent.handler;
  if (t.isForStatement(parent))
    return child === parent.body || child === parent.update;
  if (t.isWhileStatement(parent)) return child === parent.body;
  if (t.isDoWhileStatement(parent)) return child === parent.test;
  if (t.isForInStatement(parent) || t.isForOfStatement(parent))
    return child === parent.left || child === parent.body;
  if (t.isLogicalExpression(parent)) return child === parent.right;
  if (t.isAssignmentPattern(parent)) return child === parent.right;
  if (t.isAssignmentExpression(parent))
    return (
      ["&&=", "||=", "??="].includes(parent.operator) && child === parent.right
    );
  if (t.isConditionalExpression(parent))
    return child === parent.consequent || child === parent.alternate;
  if (t.isOptionalCallExpression(parent) || t.isCallExpression(parent))
    return (
      parent.arguments.includes(child as t.Expression) &&
      ((t.isOptionalCallExpression(parent) && parent.optional) ||
        optionalChainMayShortCircuit(parent.callee))
    );
  if (t.isOptionalMemberExpression(parent))
    return (
      parent.computed &&
      child === parent.property &&
      (parent.optional || optionalChainMayShortCircuit(parent.object))
    );
  return false;
};

const optionalChainMayShortCircuit = (expression: t.Node): boolean => {
  let current = expression;
  while (true) {
    // Parentheses terminate optional-chain short-circuiting. In particular,
    // `(foo?.bar)(arg)` evaluates arg before attempting the call.
    if (current.extra?.parenthesized === true) return false;
    const unwrapped = unwrapJavaScriptExpression(
      current,
      preserveGrouping,
    ).node;
    if (unwrapped !== current) {
      current = unwrapped;
      continue;
    }
    if (t.isOptionalMemberExpression(current)) {
      if (current.optional) return true;
      current = current.object;
    } else if (t.isMemberExpression(current)) current = current.object;
    else if (t.isOptionalCallExpression(current)) {
      if (current.optional) return true;
      current = current.callee;
    } else if (t.isCallExpression(current)) current = current.callee;
    else return false;
  }
};
