import type { Document, Node } from "@xmldom/xmldom";

import {
  createPlistNumberCollector,
  parsePlistIntegerLiteral,
} from "./apple/plistNumbers.js";

/** Interpret an already validated, depth-bounded DOM, owning values and number facts together. */
export const decodeXmlPropertyList = (document: Document) => {
  const root = document.documentElement;
  if (root?.nodeName !== "plist")
    throw new TypeError("malformed document. First element should be <plist>");
  const numbers = createPlistNumberCollector();
  const requireContent = (node: Node): Node => {
    if (node.firstChild === null)
      throw new TypeError(`Cannot parse "" as ${node.nodeName}`);
    return node.firstChild;
  };
  const textNode = (node: Node) => node.nodeType === node.TEXT_NODE;
  const characterNode = (node: Node) =>
    textNode(node) || node.nodeType === node.CDATA_SECTION_NODE;
  const content = (node: Node, accepts: (child: Node) => boolean) => {
    let text = "";
    let complete = true;
    for (
      let child = node.firstChild;
      child !== null;
      child = child.nextSibling
    ) {
      if (accepts(child)) text += child.nodeValue ?? "";
      else complete = false;
    }
    return { text, complete };
  };
  const dictionaryKey = (node: Node): string => {
    for (let child = node.firstChild; child !== null; child = child.nextSibling)
      if (child.nodeType === child.ELEMENT_NODE)
        return String(node.firstChild?.nodeValue ?? null);
    return content(node, characterNode).text;
  };
  const members = function* (node: Node) {
    for (let child = node.firstChild; child !== null; child = child.nextSibling)
      if (
        child.nodeType !== child.TEXT_NODE &&
        child.nodeType !== child.CDATA_SECTION_NODE &&
        child.nodeType !== child.COMMENT_NODE
      )
        yield child;
  };
  const decode = (node: Node): unknown => {
    switch (node.nodeName) {
      case "plist":
        return Array.from(members(node), decode);
      case "array": {
        const values: unknown[] = [];
        for (const member of members(node)) {
          const value = decode(member);
          if (value !== null) values.push(value);
        }
        return values;
      }
      case "dict": {
        const entries: [string, unknown][] = [];
        let key: string | undefined;
        for (const child of members(node)) {
          if (key === undefined) {
            if (child.nodeName !== "key")
              throw new TypeError("Missing key while parsing <dict/>");
            key = dictionaryKey(child);
          } else {
            if (child.nodeName === "key")
              throw new TypeError(
                "Unexpected <key> while parsing <dict/>. Keys and values must alternate.",
              );
            entries.push([key, decode(child)]);
            key = undefined;
          }
        }
        if (key !== undefined) entries.push([key, ""]);
        // Define own properties safely, including __proto__; the caller owns omission accounting.
        return Object.fromEntries(entries);
      }
      case "key": {
        // The pinned decoder also accepted key elements as scalars. Keep their
        // first-child interpretation separate from dictionary key identities.
        const value = node.firstChild === null ? "" : node.firstChild.nodeValue;
        if (value === "__proto__")
          throw new TypeError("__proto__ is not a scalar plist key");
        return value;
      }
      case "string":
        return content(node, characterNode).text;
      case "integer": {
        const first = requireContent(node);
        const literal = content(node, textNode);
        const exact = literal.complete
          ? parsePlistIntegerLiteral(literal.text)
          : undefined;
        if (exact === undefined) {
          numbers.markIncomplete();
          return Number.parseInt(first.nodeValue ?? "", 10);
        }
        numbers.integer(exact);
        const decoded = Number(exact);
        // Keep a finite integer's identity when it cannot fit even a Number
        // approximation; otherwise it would be mislabeled as a non-finite real.
        return Number.isFinite(decoded) ? decoded : exact;
      }
      case "real": {
        requireContent(node);
        const literal = content(node, characterNode);
        const value = Number.parseFloat(literal.text);
        if (literal.complete) numbers.real(value);
        else numbers.markIncomplete();
        return value;
      }
      case "data": {
        const binary = atob(content(node, textNode).text.replace(/\s+/gu, ""));
        return Uint8Array.from(binary, (character) => character.charCodeAt(0));
      }
      case "date": {
        const value = requireContent(node).nodeValue;
        return new Date(value === null ? 0 : value);
      }
      case "null":
        return null;
      case "true":
        return true;
      case "false":
        return false;
      default:
        throw new TypeError(`Invalid PLIST tag ${node.nodeName}`);
    }
  };
  const values = Array.from(members(root), decode);
  return {
    value: values.length === 1 ? values[0] : values,
    numberLiterals: numbers.result(),
  };
};
