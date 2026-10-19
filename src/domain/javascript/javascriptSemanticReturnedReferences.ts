import * as t from "@babel/types";

import {
  semanticStaticPropertyKey,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import { semanticCallableResultExpressions } from "./javascriptSemanticCallableResults.js";
import { semanticBindingAtRead } from "./javascriptSemanticMutationInitializers.js";
import {
  semanticArrayIndex,
  type JavaScriptSemanticPropertyPath,
} from "./javascriptSemanticPropertyPaths.js";
import {
  resolveSemanticBindingState,
  type JavaScriptSemanticAnalysisState,
} from "./javascriptSemanticState.js";

/** A reference potentially handed to a caller or generator consumer. */
export interface SemanticReturnedReference {
  readonly node: t.Node;
  readonly projection: JavaScriptSemanticPropertyPath;
}

interface Candidate {
  readonly node: t.Node;
  /** `undefined` means any projection depth after different projection depths merge. */
  readonly path: readonly (string | number | null)[] | undefined;
}

export interface SemanticReturnedReferenceResult {
  readonly references: readonly SemanticReturnedReference[];
  /** Both states close the supported source-local may-target graph. Widened joins projections without dropping represented targets; it does not claim runtime completeness. */
  readonly precision: "exact" | "widened";
}

const joinProjection = (
  left: Candidate["path"],
  right: Candidate["path"],
): Candidate["path"] => {
  if (left === undefined || right === undefined || left.length !== right.length)
    return undefined;
  return left.map((key, index) => (key === right[index] ? key : null));
};

const sameProjection = (
  left: Candidate["path"],
  right: Candidate["path"],
): boolean =>
  left === undefined
    ? right === undefined
    : right !== undefined &&
      left.length === right.length &&
      left.every((key, index) => key === right[index]);

interface ObjectTargetIndex {
  readonly propertyByName: ReadonlyMap<
    string,
    t.ObjectMethod | t.ObjectProperty
  >;
  readonly trailingUnknownsByProperty: ReadonlyMap<
    t.ObjectMethod | t.ObjectProperty,
    ObjectTargetUnknown
  >;
}

interface ObjectTargetUnknown {
  readonly node: t.ObjectMethod | t.ObjectProperty | t.SpreadElement;
  readonly previous: ObjectTargetUnknown | undefined;
}

/** Resolve local result references conservatively, without claiming call execution. */
export const createSemanticReturnedReferences = (
  state: JavaScriptSemanticAnalysisState,
): ((callee: t.Node) => SemanticReturnedReferenceResult) => {
  const results = new WeakMap<t.Node, SemanticReturnedReferenceResult>();
  const objectTargets = new WeakMap<t.ObjectExpression, ObjectTargetIndex>();
  return (callee) => {
    const existing = results.get(callee);
    if (existing !== undefined) return existing;
    const functions = new Set<t.Function>();
    const work: t.Node[] = [];
    // A transition depends on the source read and current projection, not the
    // initializer history used to reach it. Keeping history out of the key lets
    // shared diamonds and reassignment cycles converge to the graph fixed point.
    const projections = new WeakMap<t.Node, Candidate["path"]>();
    const queued = new WeakSet<t.Node>();
    const result: {
      references: readonly SemanticReturnedReference[];
      precision: SemanticReturnedReferenceResult["precision"];
    } = { references: [], precision: "exact" };
    const enqueue = (node: t.Node, path: Candidate["path"]): void => {
      const source = unwrapJavaScriptExpression(node).node;
      if (!projections.has(source)) {
        projections.set(source, path);
      } else {
        const previous = projections.get(source);
        const joined = joinProjection(previous, path);
        if (sameProjection(previous, joined)) return;
        projections.set(source, joined);
        result.precision = "widened";
      }
      if (!queued.has(source)) {
        work.push(source);
        queued.add(source);
      }
    };
    enqueue(callee, []);
    while (work.length > 0) {
      const node = work.pop();
      if (node === undefined) break;
      queued.delete(node);
      const current: Candidate = { node, path: projections.get(node) };
      const pending: Candidate[] = [];
      if (t.isIdentifier(node)) {
        const binding = resolveSemanticBindingState(state, node, node.name);
        if (binding === undefined) continue;
        const selected = semanticBindingAtRead(
          binding,
          node,
          state.parentsByNode,
        ).binding;
        for (const initializer of [
          ...selected.initializers,
          ...selected.referenceInitializers,
        ]) {
          pending.push({
            node: initializer.node,
            path:
              current.path === undefined
                ? undefined
                : [...initializer.projection, ...current.path],
          });
        }
      } else if (
        t.isMemberExpression(node) ||
        t.isOptionalMemberExpression(node)
      ) {
        const path: (string | number | null)[] = [];
        let receiver: t.Node = node;
        while (
          t.isMemberExpression(receiver) ||
          t.isOptionalMemberExpression(receiver)
        ) {
          path.push(
            semanticStaticPropertyKey(receiver.property, receiver.computed),
          );
          receiver = unwrapJavaScriptExpression(receiver.object).node;
        }
        pending.push({
          ...current,
          node: receiver,
          path:
            current.path === undefined
              ? undefined
              : [...path.reverse(), ...current.path],
        });
      } else if (
        t.isConditionalExpression(node) ||
        t.isLogicalExpression(node)
      ) {
        pending.push(
          {
            ...current,
            node: t.isConditionalExpression(node) ? node.consequent : node.left,
          },
          {
            ...current,
            node: t.isConditionalExpression(node) ? node.alternate : node.right,
          },
        );
      } else if (t.isSequenceExpression(node)) {
        const last = node.expressions.at(-1);
        if (last !== undefined) pending.push({ ...current, node: last });
      } else if (
        t.isFunction(node) &&
        (current.path === undefined || current.path.length === 0)
      )
        functions.add(node);
      else if (t.isObjectExpression(node))
        selectObjectTargets(node, current, pending, objectTargets);
      else if (t.isArrayExpression(node)) {
        const [key, ...path] = current.path ?? [];
        const index =
          current.path === undefined || key === undefined || key === null
            ? null
            : semanticArrayIndex(key);
        let uncertainOffset = false;
        node.elements.forEach((element, offset) => {
          if (element === null) return;
          if (t.isSpreadElement(element)) {
            uncertainOffset = true;
            pending.push({
              ...current,
              node: element.argument,
              path: current.path === undefined ? undefined : [null, ...path],
            });
          } else if (index === null || uncertainOffset || index === offset)
            pending.push({
              ...current,
              node: element,
              path: current.path === undefined ? undefined : path,
            });
        });
      } else if (t.isNewExpression(node))
        pending.push({ ...current, node: node.callee });
      else if (t.isClass(node)) {
        const [key, ...path] = current.path ?? [];
        for (const member of node.body.body) {
          if (t.isClassMethod(member)) {
            if (
              ((current.path === undefined || current.path.length === 0) &&
                member.kind === "constructor") ||
              current.path === undefined ||
              (key !== undefined &&
                (key === null ||
                  semanticStaticPropertyKey(member.key, member.computed) ===
                    String(key)))
            )
              pending.push({
                ...current,
                node: member,
                path: current.path === undefined ? undefined : path,
              });
          } else if (
            t.isClassProperty(member) &&
            member.value !== null &&
            member.value !== undefined &&
            (key !== undefined || current.path === undefined) &&
            (current.path === undefined ||
              key === null ||
              semanticStaticPropertyKey(member.key, member.computed) ===
                String(key))
          )
            pending.push({
              ...current,
              node: member.value,
              path: current.path === undefined ? undefined : path,
            });
        }
        if (node.superClass !== null && node.superClass !== undefined)
          pending.push({ ...current, node: node.superClass });
      }
      for (let index = pending.length - 1; index >= 0; index--) {
        const child = pending[index];
        if (child !== undefined) enqueue(child.node, child.path);
      }
    }
    const output = [...functions].flatMap((callable) =>
      semanticCallableResultExpressions(callable).flatMap(
        ({ node, delegated }) =>
          node === null ? [] : [{ node, projection: delegated ? [null] : [] }],
      ),
    );
    result.references = output;
    results.set(callee, result);
    if (result.precision === "widened")
      state.returnedReferenceWidenings.add(callee);
    return result;
  };
};

const selectObjectTargets = (
  node: t.ObjectExpression,
  item: Candidate,
  pending: Candidate[],
  indexes: WeakMap<t.ObjectExpression, ObjectTargetIndex>,
): void => {
  const [key, ...path] = item.path ?? [];
  const childPath = item.path === undefined ? undefined : path;
  if (key !== null && key !== undefined) {
    const index = objectTargetIndex(node, indexes);
    const property = index.propertyByName.get(String(key));
    if (property !== undefined) {
      const unknowns: ObjectTargetUnknown[] = [];
      for (
        let unknown = index.trailingUnknownsByProperty.get(property);
        unknown !== undefined;
        unknown = unknown.previous
      )
        unknowns.push(unknown);
      for (const { node: unknown } of unknowns.reverse())
        pending.push({
          ...item,
          node: t.isSpreadElement(unknown)
            ? unknown.argument
            : t.isObjectProperty(unknown)
              ? unknown.value
              : unknown,
          ...(t.isSpreadElement(unknown) ? {} : { path: childPath }),
        });
      pending.push({
        ...item,
        node: t.isObjectProperty(property) ? property.value : property,
        path: childPath,
      });
      return;
    }
  }
  let replaced = false;
  for (const property of [...node.properties].reverse()) {
    if (replaced) break;
    if (t.isSpreadElement(property)) {
      pending.push({ ...item, node: property.argument });
      continue;
    }
    const name = semanticStaticPropertyKey(property.key, property.computed);
    if (
      key !== null &&
      key !== undefined &&
      name !== null &&
      name !== String(key)
    )
      continue;
    if (t.isObjectProperty(property))
      pending.push({ ...item, node: property.value, path: childPath });
    else pending.push({ ...item, node: property, path: childPath });
    if (key !== null && key !== undefined && name === String(key))
      replaced = true;
  }
};

const objectTargetIndex = (
  node: t.ObjectExpression,
  indexes: WeakMap<t.ObjectExpression, ObjectTargetIndex>,
): ObjectTargetIndex => {
  const existing = indexes.get(node);
  if (existing !== undefined) return existing;
  const propertyByName = new Map<string, t.ObjectMethod | t.ObjectProperty>();
  const trailingUnknownsByProperty = new Map<
    t.ObjectMethod | t.ObjectProperty,
    ObjectTargetUnknown
  >();
  let trailingUnknown: ObjectTargetUnknown | undefined;
  for (const property of [...node.properties].reverse()) {
    if (t.isSpreadElement(property)) {
      trailingUnknown = { node: property, previous: trailingUnknown };
      continue;
    }
    const name = semanticStaticPropertyKey(property.key, property.computed);
    if (name === null) {
      trailingUnknown = { node: property, previous: trailingUnknown };
      continue;
    }
    if (propertyByName.has(name)) continue;
    propertyByName.set(name, property);
    if (trailingUnknown !== undefined)
      trailingUnknownsByProperty.set(property, trailingUnknown);
  }
  const created = { propertyByName, trailingUnknownsByProperty };
  indexes.set(node, created);
  return created;
};
