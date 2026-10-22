import { expect, it } from "vitest";
import type { JsonValue } from "../jsonValue.js";
import type { JsonObject } from "./environmentStateRules.js";
import {
  compareValues,
  documentPointerOf,
  explainCreate,
  explainUpdate,
  insertCandidates,
  insertIndex,
  responseShapeOf,
  type CreateEvidence,
  type UpdateEvidence,
} from "./environmentStateWriteExplain.js";
import {
  classifyWrite,
  pathValuesOf,
  prefixRelated,
  type FieldRule,
  type InsertRule,
  type WriteEffect,
  type WriteResponse,
} from "./environmentStateWriteRules.js";

const START = Date.UTC(2026, 2, 4, 5, 6, 0);
const MINUTE = 60_000;
const UUID = "123e4567-e89b-42d3-a456-426614174000";
const OTHER_UUID = "00000000-0000-4000-8000-000000000000";

const created = (
  entity: JsonObject,
  body: JsonObject,
  context: Partial<CreateEvidence> & {
    readonly path?: Record<string, string>;
  } = {},
): CreateEvidence => {
  const { path = {}, ...rest } = context;
  return {
    entity,
    call: { path: "/items", pathValues: new Map(Object.entries(path)), body },
    idField: "id",
    startMs: START,
    collection: [],
    type: [],
    ...rest,
  };
};

const updated = (
  before: JsonObject,
  after: JsonObject,
  body: JsonObject,
  context: Partial<UpdateEvidence> = {},
): UpdateEvidence => ({
  before,
  after,
  call: { path: "/items/42", pathValues: new Map([["item", "42"]]), body },
  method: "PATCH",
  idField: "id",
  id: "42",
  startMs: START,
  ...context,
});

const ruleFor = (
  rules: readonly FieldRule[],
  field: string,
): FieldRule | undefined => rules.find((rule) => rule.field === field);

it("explains created fields by echo, copy, path and slug, leaving constants unlisted", () => {
  const notes = ["x", "drafted by the finance team"];
  const result = explainCreate(
    created(
      {
        id: 7,
        title: "Quarterly report",
        heading: "Quarterly report",
        summary: "drafted by the finance team",
        projectId: 42,
        slug: "quarterly-report",
        code: "abc",
        status: "open",
      },
      { title: "Quarterly report", meta: { notes }, label: "abc" },
      { path: { project: "42" } },
    ),
  );
  expect(result.rules).toEqual([
    { field: "id", rule: "identity", generator: "sequence" },
    { field: "title", rule: "echo" },
    { field: "heading", rule: "copy", from: "/title" },
    { field: "summary", rule: "copy", from: "/meta/notes/1" },
    { field: "projectId", rule: "path", from: "project" },
    { field: "slug", rule: "slug", from: "title" },
  ]);
  expect(result.tied).toBe(false);
});

it("copies only body strings of eight or more characters", () => {
  const short = explainCreate(
    created({ id: 1, label: "seven77" }, { name: "seven77" }),
  );
  expect(ruleFor(short.rules, "label")).toBeUndefined();
  const long = explainCreate(
    created({ id: 1, label: "eight888" }, { name: { first: "eight888" } }),
  );
  expect(ruleFor(long.rules, "label")).toEqual({
    field: "label",
    rule: "copy",
    from: "/name/first",
  });
});

it.each<[string, JsonValue, number | undefined, boolean]>([
  [
    "ten minutes after",
    new Date(START + 10 * MINUTE).toISOString(),
    START,
    true,
  ],
  [
    "ten minutes before",
    new Date(START - 10 * MINUTE).toISOString(),
    START,
    true,
  ],
  [
    "just outside",
    new Date(START + 10 * MINUTE + 1).toISOString(),
    START,
    false,
  ],
  ["untimed", new Date(START).toISOString(), undefined, false],
])("explains a clock %s the request start", (_, value, startMs, clock) => {
  const result = explainCreate(created({ id: 1, at: value }, {}, { startMs }));
  expect(ruleFor(result.rules, "at")).toEqual(
    clock
      ? {
          field: "at",
          rule: "clock",
          format: { kind: "iso", separator: "T", fraction: 3, zone: "Z" },
        }
      : undefined,
  );
});

it("keeps an epoch clock's unit", () => {
  const result = explainCreate(created({ id: 1, at: START / 1000 + 5 }, {}));
  expect(ruleFor(result.rules, "at")).toEqual({
    field: "at",
    rule: "clock",
    format: { kind: "epoch", unit: "s" },
  });
});

it.each<[JsonValue, FieldRule | undefined]>([
  [4, { field: "number", rule: "sequence", scope: "collection" }],
  ["4", { field: "number", rule: "sequence", scope: "collection" }],
  [10, { field: "number", rule: "sequence", scope: "type" }],
  [5, undefined],
])("explains the number %j by the sequence it continues", (value, rule) => {
  const collection = [{ number: 1 }, { number: "3" }];
  const evidence = created(
    { id: 1, number: value },
    {},
    {
      collection,
      type: [...collection, { number: 9 }, { number: "x" }],
    },
  );
  expect(ruleFor(explainCreate(evidence).rules, "number")).toEqual(rule);
});

it.each<[string, JsonObject[], boolean]>([
  ["no other entity shares", [{ ref: OTHER_UUID }, {}], true],
  ["another entity shares", [{ ref: OTHER_UUID }, { ref: UUID }], false],
  ["the type holds no other entity", [], false],
])("explains a UUID as unique when %s it", (_, type, unique) => {
  const result = explainCreate(created({ id: 1, ref: UUID }, {}, { type }));
  expect(ruleFor(result.rules, "ref")).toEqual(
    unique ? { field: "ref", rule: "unique" } : undefined,
  );
});

it.each<[JsonValue, "sequence" | "uuid" | "token"]>([
  [17, "sequence"],
  ["17", "sequence"],
  [UUID, "uuid"],
  ["tok_AbC9", "token"],
])("generates the identity %j as a %s", (id, generator) => {
  const result = explainCreate(
    created({ key: id, title: "x" }, {}, { idField: "key" }),
  );
  expect(result.rules).toEqual([{ field: "key", rule: "identity", generator }]);
});

it("rebuilds strings that embed a generated value as a delimited token", () => {
  const result = explainCreate(
    created(
      {
        id: "abc123",
        number: 4,
        url: "https://x.test/items/abc123",
        ref: "#4",
        near: "abc1234 is not it",
        year: "2024",
      },
      {},
      { collection: [{ number: 3 }] },
    ),
  );
  expect(result.rules).toEqual([
    { field: "id", rule: "identity", generator: "token" },
    { field: "number", rule: "sequence", scope: "collection" },
    { field: "url", rule: "template", from: "id" },
    { field: "ref", rule: "template", from: "number" },
  ]);
});

it("accepts echoed members and fixes the others at their sent values", () => {
  const result = explainCreate(
    created(
      { id: 1, title: "A", priority: "high" },
      { title: "A", priority: "HIGH", notify: true },
    ),
  );
  expect(result.body).toEqual({
    accepted: ["title"],
    fixed: [
      { member: "priority", sent: "HIGH" },
      { member: "notify", sent: true },
    ],
    required: ["title", "priority", "notify"],
    identity: null,
    kinds: [],
  });
});

it.each<[string, JsonObject, boolean]>([
  [
    "a constant holds the path value delimited",
    { team: "/orgs/acme/teams" },
    true,
  ],
  ["a constant holds it only inside a word", { team: "acmecorp" }, false],
  ["only a path field holds it", { org: "acme" }, false],
  [
    "a template keeps it beside the generated value",
    { url: "/orgs/acme/items/1" },
    true,
  ],
])("ties a create to its collection only when %s", (_, fields, tied) => {
  const result = explainCreate(
    created({ id: 1, ...fields }, {}, { path: { org: "acme", empty: "" } }),
  );
  expect(result.tied).toBe(tied);
});

it("explains an update's sent members as echoes, constants or the identity", () => {
  const result = explainUpdate(
    updated(
      { id: "42", title: "Old", status: "open" },
      { id: "42", title: "New", status: "closed" },
      { id: 42, title: "New", status: "CLOSED", comment: "done" },
    ),
  );
  expect(result).toEqual({
    rules: [
      { field: "title", rule: "echo" },
      { field: "status", rule: "constant", value: "closed" },
    ],
    body: {
      accepted: ["title"],
      fixed: [
        { member: "status", sent: "CLOSED" },
        { member: "comment", sent: "done" },
      ],
      required: [],
      identity: "id",
      kinds: [],
    },
    unexplained: [],
  });
});

it("treats omitted read fields as removed only when the selected view covers them", () => {
  const before = {
    id: "42",
    name: "Old",
    description: "Kept",
    updated_at: "2026-01-01T00:00:00Z",
  };
  const after = { id: "42", name: "New" };
  const result = explainUpdate(
    updated(before, after, { name: "New" }, { readFields: ["id", "name"] }),
  );
  expect(result.unexplained).toEqual([]);

  const complete = explainUpdate(
    updated(
      before,
      after,
      { name: "New" },
      {
        readFields: ["id", "name", "description", "updated_at"],
      },
    ),
  );
  expect(complete.unexplained).toEqual(["description", "updated_at"]);
});

it("explains unsent changes as a clock, an increment or a slug of an echoed member", () => {
  const result = explainUpdate(
    updated(
      {
        id: "42",
        title: "Old Title",
        slug: "old-title",
        version: 3,
        revision: "9",
        updatedAt: "2026-01-01T00:00:00Z",
        color: "red",
      },
      {
        id: "42",
        title: "New Title",
        slug: "new-title",
        version: 4,
        revision: "10",
        updatedAt: new Date(START + 1000).toISOString(),
        color: "blue",
        added: true,
      },
      { title: "New Title" },
    ),
  );
  expect(result.rules).toEqual([
    { field: "title", rule: "echo" },
    { field: "slug", rule: "slug", from: "title" },
    { field: "version", rule: "increment" },
    { field: "revision", rule: "increment" },
    {
      field: "updatedAt",
      rule: "clock",
      format: { kind: "iso", separator: "T", fraction: 3, zone: "Z" },
    },
  ]);
  expect(result.unexplained).toEqual(["color"]);
});

it("leaves a slug of a transformed member, an untimed clock and a jump unexplained", () => {
  const result = explainUpdate(
    updated(
      { id: "42", title: "Old", slug: "old", at: "2026-01-01T00:00:00Z", n: 3 },
      {
        id: "42",
        title: "new title",
        slug: "new-title",
        at: new Date(START).toISOString(),
        n: 5,
      },
      { title: "New Title" },
      { startMs: undefined },
    ),
  );
  expect(result.rules).toEqual([
    { field: "title", rule: "constant", value: "new title" },
  ]);
  expect(result.unexplained).toEqual(["slug", "at", "n"]);
});

it.each<[string, string[]]>([
  ["PUT", ["title", "status"]],
  ["PATCH", []],
  ["POST", []],
])(
  "requires the members a %s sent apart from the identity",
  (method, required) => {
    const after = { id: "42", title: "New", status: "closed" };
    const body = { id: "42", title: "New", status: "closed" };
    const result = explainUpdate(updated(after, after, body, { method }));
    expect(result.body.required).toEqual(required);
    expect(result.body.identity).toBe("id");
  },
);

type Shaped = [WriteResponse["shape"], string | null];

it.each<[string, JsonValue | undefined, boolean, Shaped]>([
  ["no body", undefined, true, ["empty", null]],
  ["an empty response with a body", { id: "42" }, true, ["empty", null]],
  ["no recorded body", undefined, false, ["recorded", null]],
  ["the entity at the root", { id: "42", title: "x" }, false, ["entity", ""]],
  [
    "the entity in one member",
    { data: { id: 42 } },
    false,
    ["entity", "/data"],
  ],
  [
    "the entity in a one-element array",
    [{ id: "42" }],
    false,
    ["entity", "/0"],
  ],
  ["the identity at the root", "42", false, ["identity", ""]],
  ["a numeric identity at the root", 42, false, ["identity", ""]],
  [
    "the identity in one member",
    { created: "42", ok: true },
    false,
    ["identity", "/created"],
  ],
  [
    "the identity in an escaped member",
    { "a/b": 42 },
    false,
    ["identity", "/a~1b"],
  ],
  [
    "the identity in two members",
    { a: "42", b: "42" },
    false,
    ["recorded", null],
  ],
  ["no identity", { ok: true }, false, ["recorded", null]],
])("shapes a response carrying %s", (_, body, empty, [shape, pointer]) => {
  expect(responseShapeOf(3, body, empty, { idField: "id", id: "42" })).toEqual({
    ordinal: 3,
    shape,
    pointer,
  });
});

it.each<[JsonValue | undefined, JsonValue | undefined, number | undefined]>([
  [2, 10, -1],
  ["10", 9, 1],
  ["7", 7, 0],
  ["2026-03-04T05:00:00Z", "2026-03-04T06:30:00+02:00", 1],
  [Date.UTC(2026, 2, 4, 6) / 1000, "2026-03-04T05:00:00Z", 1],
  ["apple", "banana", -1],
  ["Zebra", "apple", -1],
  ["b", "b", 0],
  [5, "apple", undefined],
  [true, false, undefined],
  [undefined, "x", undefined],
  [{ a: 1 }, { a: 1 }, undefined],
])("orders %j against %j as %j", (left, right, sign) => {
  const order = compareValues(left, right);
  expect(order === undefined ? undefined : Math.sign(order)).toBe(sign);
});

it("offers each strictly ordered field in its direction, then last and first", () => {
  const members = [
    { id: 1, at: "2026-03-02T00:00:00Z", name: "b", tag: "x" },
    { id: 2, at: "2026-03-01T12:00:00+02:00", name: "a", tag: "x" },
    { id: "3", at: "2026-02-28T00:00:00Z", name: "c" },
  ];
  expect(insertCandidates(members, ["id", "at", "name", "tag"])).toEqual([
    { rule: "sorted", field: "id", direction: "ascending" },
    { rule: "sorted", field: "at", direction: "descending" },
    { rule: "last" },
    { rule: "first" },
  ]);
  const fallback = [{ rule: "last" }, { rule: "first" }];
  expect(insertCandidates([{ id: 1 }], ["id"])).toEqual(fallback);
  expect(insertCandidates([], ["id"])).toEqual(fallback);
});

const ASCENDING = [{ n: 1 }, { n: 3 }, { n: 5 }];
const DESCENDING = [{ n: 5 }, { n: 3 }, { n: 1 }];
const up: InsertRule = { rule: "sorted", field: "n", direction: "ascending" };
const down: InsertRule = {
  rule: "sorted",
  field: "n",
  direction: "descending",
};

it.each<[string, InsertRule, JsonObject, number]>([
  ["first", { rule: "first" }, { n: 9 }, 0],
  ["last", { rule: "last" }, { n: 0 }, 3],
  ["ascending, between members", up, { n: 4 }, 2],
  ["ascending, before every member", up, { n: 0 }, 0],
  ["ascending, after every member", up, { n: 6 }, 3],
  ["ascending, after an equal member", up, { n: 3 }, 2],
  ["descending, between members", down, { n: 4 }, 1],
  ["descending, after every member", down, { n: 0 }, 3],
  ["sorted, with an incomparable value", up, { n: true }, 3],
  ["sorted, without the field", up, {}, 3],
])("inserts %s", (_, rule, fields, index) => {
  const members = rule === down ? DESCENDING : ASCENDING;
  expect(insertIndex(rule, members, fields)).toBe(index);
});

it.each<[string, JsonValue, JsonObject, string | undefined]>([
  ["the root", { theme: "dark", lang: "en" }, { theme: "light" }, ""],
  [
    "the member sharing most",
    { theme: "dark", settings: { theme: "dark", lang: "en" } },
    { theme: "light", lang: "fr" },
    "/settings",
  ],
  [
    "the root on a tie",
    { theme: "d", s: { lang: "en" } },
    { theme: "x", lang: "y" },
    "",
  ],
  ["an escaped member", { "a/b": { theme: "dark" } }, { theme: "x" }, "/a~1b"],
  [
    "nothing when none is shared",
    { a: 1, b: { c: 2 } },
    { theme: "x" },
    undefined,
  ],
  ["nothing in an array", [{ theme: "dark" }], { theme: "x" }, undefined],
])("points a document write at %s", (_, value, body, pointer) => {
  expect(documentPointerOf(value, body)).toBe(pointer);
});

it.each<[string, string, WriteEffect, string | null]>([
  ["POST", "/users", "create", "/users"],
  ["POST", "/users/", "create", "/users"],
  ["POST", "/users/{userId}/posts", "create", "/users/{userId}/posts"],
  ["PUT", "/users/{userId}", "update", "/users"],
  ["PATCH", "/users/{id}", "update", "/users"],
  ["POST", "/users/{id}", "update", "/users"],
  ["DELETE", "/users/{id}", "delete", "/users"],
  [
    "DELETE",
    "/users/{userId}/posts/{postId}",
    "delete",
    "/users/{userId}/posts",
  ],
  ["GET", "/users/{id}", "none", null],
  ["DELETE", "/users", "none", null],
  ["PUT", "/users", "none", null],
  ["PUT", "/users/me", "none", null],
  ["POST", "/users/{id}/archive", "none", null],
  ["PUT", "/settings", "document", "get_settings"],
  ["PATCH", "/settings/", "document", "get_settings"],
  ["POST", "/settings", "document", "get_settings"],
  ["DELETE", "/settings", "none", null],
])("classifies %s %s as %s", (method, path, effect, target) => {
  expect(
    classifyWrite(
      { method, path_template: path },
      new Set(["/users", "/users/{userId}/posts"]),
      new Map([["/settings", "get_settings"]]),
    ),
  ).toEqual({ effect, target });
});

it.each<[string, string, Record<string, string> | undefined]>([
  [
    "/orgs/{org}/repos/{repo}",
    "/orgs/acme/repos/rea",
    { org: "acme", repo: "rea" },
  ],
  ["/orgs/{org}", "/orgs/a%20b%2Fc/", { org: "a b/c" }],
  ["/orgs/{org}", "/orgs/%E0%A4%A", { org: "%E0%A4%A" }],
  ["/orgs", "/orgs", {}],
  ["/orgs/{org}", "/teams/acme", undefined],
  ["/orgs/{org}", "/orgs/acme/repos", undefined],
])("reads %s from %s", (template, path, values) => {
  expect(pathValuesOf(template, path)).toEqual(
    values === undefined ? undefined : new Map(Object.entries(values)),
  );
});

it.each<[string, string, boolean]>([
  ["/users", "/users/{id}", true],
  ["/users/{id}/posts", "/users/42", true],
  ["/users/42/posts", "/users/{id}/posts/7", true],
  ["/", "/anything/at/all", true],
  ["/users/42", "/users/43", false],
  ["/users", "/teams/{id}", false],
  ["/{tenant}/users", "/acme/teams", false],
])("relates %s and %s by prefix: %s", (left, right, related) => {
  expect(prefixRelated(left, right)).toBe(related);
  expect(prefixRelated(right, left)).toBe(related);
});

it(
  "explains many copied and slugged fields of a wide body without searching it again for each",
  { timeout: 5_000 },
  () => {
    const n = 8_000;
    const value = (index: number) => `value-${String(index).padStart(6, "0")}`;
    const nested = Object.fromEntries(
      Array.from({ length: n }, (_, index) => [
        `g${String(index)}`,
        { s: value(index) },
      ]),
    );
    const copies = Object.fromEntries(
      Array.from({ length: n }, (_, index) => [
        `c${String(index)}`,
        value(index),
      ]),
    );
    const copied = explainCreate(created({ id: 1, ...copies }, nested));
    expect(ruleFor(copied.rules, `c${String(n - 1)}`)).toEqual({
      field: `c${String(n - 1)}`,
      rule: "copy",
      from: `/g${String(n - 1)}/s`,
    });
    // Strings no member slugs to, in a body of many members, each tried as a slug.
    const flat = Object.fromEntries(
      Array.from({ length: n }, (_, index) => [
        `m${String(index)}`,
        `Member ${String(index)}`,
      ]),
    );
    const others = Object.fromEntries(
      Array.from({ length: n }, (_, index) => [
        `o${String(index)}`,
        `x${String(index)}`,
      ]),
    );
    const slugged = explainCreate(
      created({ id: 1, ...others, s: "member-7" }, flat),
    );
    expect(ruleFor(slugged.rules, "s")).toEqual({
      field: "s",
      rule: "slug",
      from: "m7",
    });
  },
);

it(
  "searches a wide request body for a copied value in linear time",
  { timeout: 5_000 },
  () => {
    // Shifting each value off the queue made one fruitless search over 500,000 zeros take about a minute.
    const wide = Array.from({ length: 500_000 }, () => 0);
    const result = explainCreate(
      created({ id: 1, note: "not anywhere in the body" }, { items: wide }),
    );
    expect(ruleFor(result.rules, "note")).toBeUndefined();
  },
);
