import { expect, it } from "vitest";

import { normalizeKunaAddress } from "../../../../src/kuna/KunaAddress.js";
import {
  parseKunaCallGraph,
  parseKunaIncomingReferences,
} from "../../../../src/kuna/KunaReferenceFiles.js";

const input = "/snapshot/program";
// Fixture-only numeric placeholders preserve decimal u64 tokens in JSON text.
const wire = (value: unknown) =>
  JSON.stringify(value).replace(/"@(\d+)"/gu, "$1");
const node = (address: string, name: string) => ({
  address: `@${address}`,
  name,
  kind: "normal",
  hasIndirectCalls: false,
  forwardsTo: null,
  codeC: null,
  assembly: null,
  error: null,
});
const graph = () => ({
  schemaVersion: 4,
  binary: { sourcePath: input, functionCount: 3, edgeCount: 2 },
  functions: [
    node("9007199254740993", "caller"),
    node("18446744073709551615", "callee"),
    node("1", "jump-target"),
  ],
  edges: [
    {
      callerAddress: "@9007199254740993",
      calleeAddress: "@18446744073709551615",
      kind: "call",
      calleeOrder: 0,
    },
    {
      callerAddress: "@9007199254740993",
      calleeAddress: "@1",
      kind: "jump",
      calleeOrder: 1,
    },
  ],
});

it("preserves u64 numeric tokens and excludes non-call edges", () => {
  const result = parseKunaCallGraph(wire(graph()), input);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect([...result.value.nodes.keys()]).toEqual([
    "0x20000000000001",
    "0xffffffffffffffff",
    "0x1",
  ]);
  expect(result.value.callees.get("0x20000000000001")).toEqual([
    "0xffffffffffffffff",
  ]);
  expect(result.value.callers.get("0xffffffffffffffff")).toEqual([
    "0x20000000000001",
  ]);
  expect(result.value.callers.has("0x1")).toBe(false);
});

it("keeps a forwarding instruction address separate from function identity", () => {
  const value = graph();
  const result = parseKunaCallGraph(
    wire({
      ...value,
      functions: value.functions.map((fn, index) =>
        index === 0 ? { ...fn, forwardsTo: "@9007199254741000" } : fn,
      ),
    }),
    input,
  );
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.nodes.get("0x20000000000001")?.forwardsTo).toBe(
    "0x20000000000008",
  );
  expect(result.value.nodes.has("0x20000000000008")).toBe(false);
  expect(result.value.callees.get("0x20000000000001")).toEqual([
    "0xffffffffffffffff",
  ]);
});

it.each([
  [
    "version",
    (value: ReturnType<typeof graph>) => {
      value.schemaVersion = 5;
    },
  ],
  [
    "count",
    (value: ReturnType<typeof graph>) => {
      value.binary.edgeCount = 1;
    },
  ],
  [
    "duplicate node",
    (value: ReturnType<typeof graph>) => {
      value.functions[1]!.address = value.functions[0]!.address;
    },
  ],
  [
    "unknown endpoint",
    (value: ReturnType<typeof graph>) => {
      value.edges[0]!.calleeAddress = "@2";
    },
  ],
  [
    "duplicate edge",
    (value: ReturnType<typeof graph>) => {
      value.edges[1]!.calleeAddress = value.edges[0]!.calleeAddress;
    },
  ],
  [
    "duplicate order",
    (value: ReturnType<typeof graph>) => {
      value.edges[1]!.calleeOrder = 0;
    },
  ],
  [
    "missing order",
    (value: ReturnType<typeof graph>) => {
      value.edges[1]!.calleeOrder = 2;
    },
  ],
  [
    "overflow",
    (value: ReturnType<typeof graph>) => {
      value.functions[0]!.address = "@18446744073709551616";
    },
  ],
] as const)(
  "rejects graph %s rather than returning an empty relationship set",
  (_name, mutate) => {
    const value = graph();
    mutate(value);
    expect(parseKunaCallGraph(wire(value), input).ok).toBe(false);
  },
);

it("rejects unrequested bodies and a document for a different input", () => {
  const value = graph();
  expect(parseKunaCallGraph(wire(value), "/other/program").ok).toBe(false);
  const body = {
    ...value,
    functions: value.functions.map((fn) => ({
      ...fn,
      codeC: "must not be materialized as reference data",
    })),
  };
  expect(parseKunaCallGraph(wire(body), input).ok).toBe(false);
});

const identity = (name: string, value: number) => ({
  name,
  address: `@${value}`,
  address_hex: `0x${value.toString(16)}`,
});
const row = (from: number, to: number) => ({
  address: `@${from}`,
  address_hex: `0x${from.toString(16)}`,
  from_address: `@${from}`,
  from_address_hex: `0x${from.toString(16)}`,
  to_address: `@${to}`,
  to_address_hex: `0x${to.toString(16)}`,
  kind: "call",
  from_function: identity("caller", 4096),
  to_function: null,
  instruction: "CALL",
});
const xrefs = () => ({
  binary: input,
  direction: "to",
  count: 3,
  target: { ...identity("callee", 8192), aliases: [identity("slot", 12288)] },
  xrefs: [row(4100, 8192), row(4100, 8192), row(4200, 12288)],
});

it("keeps exact endpoints, deduplicates sites and counts excluded forwarding aliases", () => {
  expect(
    parseKunaIncomingReferences(wire(xrefs()), input, "0x2000"),
  ).toMatchObject({
    ok: true,
    value: { addresses: ["0x1004"], rows: 3, excludedAliasRows: 1 },
  });
});

it.each([
  [
    "count",
    (value: ReturnType<typeof xrefs>) => {
      value.count = 2;
    },
  ],
  [
    "target",
    (value: ReturnType<typeof xrefs>) => {
      value.target.address = "@8193";
    },
  ],
  [
    "unadvertised alias",
    (value: ReturnType<typeof xrefs>) => {
      value.target.aliases = [];
    },
  ],
  [
    "numeric/hex mismatch",
    (value: ReturnType<typeof xrefs>) => {
      value.xrefs[0]!.from_address_hex = "0x1005";
    },
  ],
] as const)(
  "rejects xref %s without inventing absent references",
  (_name, mutate) => {
    const value = xrefs();
    mutate(value);
    expect(parseKunaIncomingReferences(wire(value), input, "0x2000").ok).toBe(
      false,
    );
  },
);

it("bounds u64 input parsing before BigInt allocation", () => {
  expect(normalizeKunaAddress(`0X${"0".repeat(1000)}ABC`)).toBe("0xabc");
  expect(normalizeKunaAddress("0xffffffffffffffff")).toBe("0xffffffffffffffff");
  expect(normalizeKunaAddress("0x10000000000000000")).toBeUndefined();
  expect(normalizeKunaAddress("caller")).toBeUndefined();
});
