import { describe, expect, it } from "vitest";

import type { JsonValue } from "../../domain/jsonValue.js";
import { compareAnswers } from "./environmentCompareDiff.js";
import { IdMap, learnIds } from "./environmentCompareIds.js";

const compare = (
  live: unknown,
  env: unknown,
  map = new IdMap(),
  status: [number, number] = [200, 200],
) =>
  compareAnswers(
    { status: status[0], body: live as never },
    { status: status[1], body: env as never },
    map,
  );

describe("compareAnswers", () => {
  it("agrees on mapped ids, clocks of one format and generated values, and counts each", () => {
    const map = new IdMap();
    map.learn(101, 1);
    const result = compare(
      {
        id: 101,
        created_at: "2026-10-20T10:00:00Z",
        token: "3f2a9c8d7e",
        uuid: "6f1c2b9e-2a3d-4f5e-8a9b-0c1d2e3f4a5b",
      },
      {
        id: 1,
        created_at: "2026-10-17T18:00:03Z",
        token: "9b8e7d6c5a",
        uuid: "0a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d",
      },
      map,
    );
    expect(result.differences).toEqual([]);
    expect(result.normalised).toEqual({
      ids: 1,
      clocks: 1,
      generated: 2,
      large_bodies: 0,
      unobserved_bodies: 0,
    });
  });

  it("categorises status, missing and extra fields, values and clock formats", () => {
    const result = compare(
      { name: "A", gone: 1, at: "2026-10-20T10:00:00.123+00:00" },
      { name: "B", added: true, at: "2026-10-20T10:00:00Z" },
      new IdMap(),
      [409, 204],
    );
    expect(result.differences.map((d) => [d.category, d.pointer])).toEqual([
      ["status", ""],
      ["value", "/name"],
      ["missing-field", "/gone"],
      ["clock-format", "/at"],
      ["extra-field", "/added"],
    ]);
  });

  it("reports array length and order and compares paired items", () => {
    const result = compare(
      [
        { name: "B", n: 2 },
        { name: "A", n: 1 },
        { name: "C", n: 3 },
      ],
      [
        { name: "A", n: 1 },
        { name: "B", n: 5 },
      ],
    );
    expect(result.differences.map((d) => [d.category, d.pointer])).toEqual([
      ["length", ""],
      ["order", ""],
      ["value", "/0/n"],
    ]);
  });

  it("treats an epoch number as a clock only under a time-named field", () => {
    expect(
      compare({ updated: 1760000000 }, { updated: 1760000999 }).differences,
    ).toEqual([]);
    expect(
      compare({ size: 1760000000 }, { size: 1760000999 }).differences.map(
        (d) => d.category,
      ),
    ).toEqual(["value"]);
  });

  it("compares an object keyed by mapped ids under the environment's keys", () => {
    const map = new IdMap();
    map.learn("liveTable", "envTable");
    expect(
      compare(
        { tables: { liveTable: { name: "T" } } },
        { tables: { envTable: { name: "T" } } },
        map,
      ).differences,
    ).toEqual([]);
  });

  it("compares ordinary fields by name, even one named like a learned id", () => {
    const map = new IdMap();
    map.learn("books", "tags");
    expect(
      compare({ books: 1, tags: 2 }, { books: 1, tags: 2 }, map).differences,
    ).toEqual([]);
    // A real rename shows, rather than being taken for a mapped key.
    expect(
      compare({ books: 1 }, { tags: 1 }, map).differences.map((d) => [
        d.category,
        d.pointer,
      ]),
    ).toEqual([
      ["missing-field", "/books"],
      ["extra-field", "/tags"],
    ]);
  });

  it("still compares an object keyed by ids under the environment's keys when some ids are the same on both sides", () => {
    const map = new IdMap();
    map.learn("101", "2");
    expect(
      compare(
        { counts: { "1": 3, "101": 5 } },
        { counts: { "1": 3, "2": 5 } },
        map,
      ).differences,
    ).toEqual([]);
  });

  it("reports a reordered set of scalars as order alone and reads epoch array items as clocks", () => {
    expect(
      compare(
        { access: ["a", "b", "c"] },
        { access: ["c", "a", "b"] },
      ).differences.map((d) => [d.category, d.pointer]),
    ).toEqual([["order", "/access"]]);
    expect(
      compare({ stats: [[1792450800, 3]] }, { stats: [[1792285200, 3]] })
        .differences,
    ).toEqual([]);
  });

  it("compares a live body over the replay limit by status only and counts it", () => {
    const result = compareAnswers(
      { status: 200, body: '{"data":[', cut: true },
      { status: 200, body: null },
      new IdMap(),
    );
    expect(result.differences).toEqual([]);
    expect(result.normalised.large_bodies).toBe(1);
  });

  it("compares a live body the probe did not record by status only and counts it", () => {
    const unrecorded = { status: 200, body: null, unobserved: true };
    const result = compareAnswers(
      unrecorded,
      { status: 200, body: { id: 1 } },
      new IdMap(),
    );
    expect(result.differences).toEqual([]);
    expect(result.normalised.unobserved_bodies).toBe(1);
    expect(
      compareAnswers(unrecorded, { status: 404, body: null }, new IdMap())
        .differences,
    ).toEqual([{ category: "status", pointer: "", live: "200", env: "404" }]);
  });
});

describe("scalar sets of mapped ids", () => {
  it("differ only in order once live ids are mapped", () => {
    const map = new IdMap();
    map.learn(101, 1);
    map.learn(102, 2);
    const compared = compareAnswers(
      { status: 200, body: { ids: [101, 102] } },
      { status: 200, body: { ids: [2, 1] } },
      map,
    );
    expect(compared.differences).toEqual([
      { category: "order", pointer: "/ids" },
    ]);
    expect(compared.normalised.ids).toBe(2);
  });
});

describe("ids two collections reuse", () => {
  it("compares an entity's own id within the call's collection and any other id by the probe's mapping", () => {
    const map = new IdMap();
    map.learn(101, 1, "/api/books");
    map.learn(101, 2, "/api/authors");
    const answer = (body: JsonValue) => ({ status: 200, body });
    expect(
      compareAnswers(answer({ id: 101 }), answer({ id: 2 }), map, {
        scope: "/api/authors",
      }).differences,
    ).toEqual([]);
    expect(
      compareAnswers(answer({ book_id: 101 }), answer({ book_id: 2 }), map)
        .differences,
    ).toEqual([
      { category: "value", pointer: "/book_id", live: "101", env: "2" },
    ]);
  });
});

describe("identity responses two collections reuse", () => {
  it("compares a create's bare id and created member within the call's collection", () => {
    const books = new IdMap();
    books.learn(103, 1, "/api/books");
    learnIds(103, 3, books, {
      heldIds: new Set(),
      scope: "/api/authors",
      identity: true,
    });
    const created = new IdMap();
    created.learn(103, 1, "/api/books");
    learnIds({ created: 103 }, { created: 3 }, created, {
      heldIds: new Set(),
      scope: "/api/authors",
      entityAt: "/created",
      identity: true,
    });
    const answer = (body: JsonValue) => ({ status: 201, body });
    expect(books.env(103)).toBe(1);
    expect(books.env(103, "/api/authors")).toBe(3);
    expect(created.env(103, "/api/authors")).toBe(3);
    expect(
      compareAnswers(answer(103), answer(3), books, {
        scope: "/api/authors",
        identity: true,
      }).differences,
    ).toEqual([]);
    expect(
      compareAnswers(
        answer({ created: 103 }),
        answer({ created: 3 }),
        created,
        {
          scope: "/api/authors",
          at: "/created",
          identity: true,
        },
      ).differences,
    ).toEqual([]);
  });
});

describe("wrapped answers", () => {
  it("compares the identity of an entity inside an envelope within the call's collection", () => {
    const map = new IdMap();
    map.learn(101, 1, "/api/books");
    learnIds(
      { data: [{ id: 101, name: "Bob" }] },
      { data: [{ id: 2, name: "Bob" }] },
      map,
      { heldIds: new Set(), scope: "/api/authors", entityAt: "/data" },
    );
    expect(map.env(101, "/api/authors")).toBe(2);
    expect(
      compareAnswers(
        { status: 200, body: { data: { id: 101, name: "Bob" } } },
        { status: 200, body: { data: { id: 2, name: "Bob" } } },
        map,
        { scope: "/api/authors", at: "/data" },
      ).differences,
    ).toEqual([]);
  });
});

describe("raw ids a mapping gives to other entities", () => {
  const answer = (body: JsonValue) => ({ status: 200, body });

  it("reports an entity's own identity equal on both sides that its collection's mapping gives to another entity", () => {
    const map = new IdMap();
    map.learn(101, 1, "/api/books");
    map.learn(102, 101, "/api/books");
    const books = { scope: "/api/books" };
    expect(
      compareAnswers(answer({ id: 101 }), answer({ id: 101 }), map, books)
        .differences,
    ).toEqual([{ category: "value", pointer: "/id", live: "101", env: "101" }]);
    expect(
      compareAnswers(answer({ id: 102 }), answer({ id: 101 }), map, books)
        .differences,
    ).toEqual([]);
  });

  it("leaves an equal reference equal, as the probe's mapping cannot tell which collection it names", () => {
    const map = new IdMap();
    // Another collection's create reassigned live 2, while the seeded project 2 is the same on both sides.
    map.learn(2, 3);
    map.learn(5, 2);
    expect(
      compareAnswers(
        answer({ project_id: "2" }),
        answer({ project_id: "2" }),
        map,
      ).differences,
    ).toEqual([]);
  });
});
