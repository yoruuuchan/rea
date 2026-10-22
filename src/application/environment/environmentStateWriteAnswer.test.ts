import { describe, expect, it } from "vitest";

import {
  servedFrom,
  type Served,
} from "../../../tests/fixtures/environmentStateServing.js";
import {
  BOOK_INIT_ROWS,
  BOOK_NOT_FOUND,
  BOOK_ROWS,
  DELETE_NOT_FOUND,
  FIRST_BOOK,
  SECOND_BOOK,
  THIRD_BOOK,
  book,
  bookClock,
  renamedBook,
  type Book,
} from "../../../tests/fixtures/environmentStateWrites.js";
import type { TimedCaptureRow } from "../../../tests/fixtures/analysisView.js";
import { seededUuid } from "../../domain/analysisView/environmentStateWriteValues.js";
import type { ReplayArguments } from "./environmentReplay.js";
import { servedCatalog } from "./environmentState.js";
import {
  environmentToolArguments,
  environmentToolDefinitions,
} from "./environmentTools.js";

/** The book the first served create of "New Book" makes: the next id, one second past the served clock's start. */
const NEW_BOOK = book(3, "New Book", bookClock(13));
const CREATE_NEW_BOOK = { body: { name: "New Book" } };

const entityOf = (books: Served, id: string) =>
  books.store.snapshot().rea_state.entities.find((entity) => entity.id === id);

/** Load what data/get reports back through data/add: the state must come back byte for byte. */
const expectReloadsUnchanged = (books: Served): void => {
  const before = books.snapshot();
  expect(books.store.replace(JSON.parse(before)).ok).toBe(true);
  expect(books.snapshot()).toBe(before);
};

describe("served creates", () => {
  it("refuses an exhausted generated-value collision search without changing state", () => {
    const existing = {
      id: "123e4567-e89b-42d3-a456-426614174000",
      ref: "223e4567-e89b-42d3-a456-426614174000",
      name: "Existing",
    };
    const created = {
      id: "323e4567-e89b-42d3-a456-426614174000",
      ref: "423e4567-e89b-42d3-a456-426614174000",
      name: "Created",
    };
    const books = servedFrom([
      ["GET", "/api/items", [existing]],
      ["GET", `/api/items/${existing.id}`, existing],
      ["POST", "/api/items", created, 201, { name: "Created" }],
      ["GET", `/api/items/${created.id}`, created],
      ["GET", "/api/items", [existing, created]],
    ]);
    const plan = books.store.state.writes.get("post_items");
    if (plan?.served !== true)
      throw new Error("Expected post_items to be served");
    const rule = plan.rules.find((candidate) => candidate.rule === "unique");
    expect(rule).toMatchObject({ field: "ref", rule: "unique" });
    if (rule?.rule !== "unique") throw new Error("Expected a unique ref rule");
    const candidates = Array.from({ length: 65 }, (_, attempt) =>
      seededUuid(
        `${books.state.evidenceId}:${plan.tool}:${rule.field}:1:${String(attempt)}`,
        created.ref,
      ),
    );
    const snapshot = books.store.snapshot();
    const collisions = candidates.map((ref, index) => ({
      type: "/api/items",
      collection: "/api/items",
      id: `collision-${String(index)}`,
      fields: { id: `collision-${String(index)}`, ref, name: "Collision" },
      view_fields: [],
      record_ordinals: [],
    }));
    const loaded = {
      ...snapshot,
      rea_state: {
        ...snapshot.rea_state,
        entities: [...snapshot.rea_state.entities, ...collisions],
      },
    };
    const replaced = books.store.replace(loaded);
    if (!replaced.ok) throw new Error(JSON.stringify(replaced.error));
    const before = books.snapshot();
    const pending = books.store.pendingWrite();

    const refusal = books.refusal(plan.tool, { body: { name: "Created" } });

    expect(JSON.stringify(refusal)).toContain(
      "Could not generate a unique value for ref after 64 attempts",
    );
    expect(books.snapshot()).toBe(before);
    expect(books.store.pendingWrite()).toEqual(pending);
  });
  it("creates a book with the next id, the served clock and a derived slug, which later reads show", () => {
    const books = servedFrom();
    const created = books.answer("post_books", CREATE_NEW_BOOK);
    expect(created).toMatchObject({
      status: 201,
      content_type: "application/json",
      state: {
        source: "state",
        view: "create",
        type: "/api/books",
        collection: "/api/books",
        id: "3",
      },
    });
    expect(created.body).toEqual(NEW_BOOK);
    expect(books.answer("get_books_by_id", { id: "3" })).toMatchObject({
      status: 200,
      body: NEW_BOOK,
      state: { source: "state", view: "item", id: "3" },
    });
    expect(books.answer("get_books")).toMatchObject({
      body: [FIRST_BOOK, SECOND_BOOK, NEW_BOOK],
      state: { source: "state", view: "list", membership: "all", listed: 3 },
    });
  });

  it("reports a created book in data/get without record citations and loads it back unchanged", () => {
    const books = servedFrom();
    books.answer("post_books", CREATE_NEW_BOOK);
    expect(entityOf(books, "3")).toEqual({
      type: "/api/books",
      collection: "/api/books",
      id: "3",
      fields: NEW_BOOK,
      view_fields: [],
      record_ordinals: [],
    });
    expectReloadsUnchanged(books);
    expect(books.answer("get_books_by_id", { id: "3" }).body).toEqual(NEW_BOOK);
  });
});

describe("served updates and deletes", () => {
  it("keeps an entity's identity when the application ignored the id an update sent", () => {
    const renamed = renamedBook(FIRST_BOOK, "Renamed Book", 3);
    const books = servedFrom([
      ...BOOK_INIT_ROWS,
      [
        "PATCH",
        "/api/books/1",
        renamed,
        200,
        { id: 999, name: "Renamed Book" },
      ],
      ["GET", "/api/books/1", renamed],
    ]);
    const answer = books.answer("patch_books_by_id", {
      id: "2",
      body: { id: 999, name: "Second Edition" },
    });
    expect(answer.body).toMatchObject({ id: 2, name: "Second Edition" });
    expect(books.answer("get_books_by_id", { id: "2" }).body).toMatchObject({
      id: 2,
    });
  });

  const SECOND_EDITION = renamedBook(SECOND_BOOK, "Second Edition", 13);
  const RENAME_SECOND = { id: "2", body: { name: "Second Edition" } };

  it("changes only the sent members, the slug that follows them and the clock", () => {
    const books = servedFrom();
    expect(books.answer("patch_books_by_id", RENAME_SECOND)).toMatchObject({
      status: 200,
      body: SECOND_EDITION,
      state: { source: "state", view: "update", id: "2" },
    });
    expect(books.answer("get_books_by_id", { id: "2" }).body).toEqual(
      SECOND_EDITION,
    );
    expect(books.answer("get_books").body).toEqual([
      FIRST_BOOK,
      SECOND_EDITION,
    ]);
  });

  it("cites no records for an updated book in data/get, so it loads back unchanged", () => {
    const books = servedFrom();
    books.answer("patch_books_by_id", RENAME_SECOND);
    expect(entityOf(books, "2")).toMatchObject({
      fields: SECOND_EDITION,
      record_ordinals: [],
    });
    expectReloadsUnchanged(books);
  });

  it("removes a deleted book; a later read answers the recorded 404 as a missing entity", () => {
    const books = servedFrom();
    expect(books.answer("delete_books_by_id", { id: "2" })).toMatchObject({
      status: 204,
      body: null,
      state: { source: "state", view: "delete", id: "2" },
    });
    expect(books.answer("get_books_by_id", { id: "2" })).toMatchObject({
      status: 404,
      body: BOOK_NOT_FOUND,
      state: {
        source: "state",
        view: "missing",
        type: "/api/books",
        collection: "/api/books",
        id: "2",
      },
    });
    expect(books.answer("get_books").body).toEqual([FIRST_BOOK]);
  });

  it("answers an update or delete of a missing book with a recorded 404, else refuses it", () => {
    const books = servedFrom();
    const before = books.snapshot();
    // The update recorded no absence, so it answers the item view's; the delete answers its own.
    expect(
      books.answer("patch_books_by_id", { id: "99", body: { name: "Ghost" } }),
    ).toMatchObject({
      status: 404,
      body: BOOK_NOT_FOUND,
      state: { view: "missing", id: "99" },
    });
    expect(books.answer("delete_books_by_id", { id: "99" })).toMatchObject({
      status: 404,
      body: DELETE_NOT_FOUND,
      state: { view: "missing", id: "99" },
    });
    expect(books.snapshot()).toBe(before);
    const unrecorded = servedFrom(
      BOOK_ROWS.filter(([, , , status]) => status !== 404),
    );
    for (const [name, args] of [
      ["patch_books_by_id", { id: "99", body: { name: "Ghost" } }],
      ["delete_books_by_id", { id: "99" }],
    ] as const)
      expect(unrecorded.refusal(name, args)).toMatchObject({
        code: "invalid_request",
        message: expect.stringContaining(
          "holds no /api/books entity 99 in /api/books",
        ),
      });
  });
});

describe("refusals", () => {
  it("refuses a body the capture does not support and leaves the state unchanged", () => {
    const books = servedFrom();
    const before = books.snapshot();
    const refused: [string, ReplayArguments, string][] = [
      [
        "post_books",
        { body: { name: "Extra", color: "red" } },
        "Member color is not one the capture showed stored",
      ],
      ["post_books", { body: {} }, 'lacks required members "name"'],
      [
        "post_books",
        { body: { name: 42 } },
        "Member name must be a JSON string",
      ],
      ["post_books", { body: ["New Book"] }, "takes a JSON object body"],
      [
        "patch_books_by_id",
        { id: "1", body: "New Book" },
        "takes a JSON object body",
      ],
      ["patch_books_by_id", { id: "1", body: {} }, "sends none of the members"],
      [
        "patch_books_by_id",
        { id: "1", body: { title: "New" } },
        "Member title is not one",
      ],
    ];
    for (const [name, args, message] of refused) {
      expect(books.refusal(name, args)).toMatchObject({
        code: "invalid_request",
        message: expect.stringContaining(message),
      });
      expect(books.snapshot()).toBe(before);
    }
  });

  it("accepts a member the application stored differently only with the value the capture sent", () => {
    const bound = (entry: Book, format: string): Book => ({ ...entry, format });
    const books = servedFrom([
      [
        "GET",
        "/api/books",
        [bound(FIRST_BOOK, "PAPERBACK"), bound(SECOND_BOOK, "PAPERBACK")],
      ],
      ["GET", "/api/books/1", bound(FIRST_BOOK, "PAPERBACK")],
      ["GET", "/api/books/2", bound(SECOND_BOOK, "PAPERBACK")],
      [
        "POST",
        "/api/books",
        bound(THIRD_BOOK, "HARDCOVER"),
        201,
        { name: "Third Book", format: "hardcover" },
      ],
      ["GET", "/api/books/3", bound(THIRD_BOOK, "HARDCOVER")],
    ]);
    const before = books.snapshot();
    expect(
      books.refusal("post_books", {
        body: { name: "Soft", format: "softcover" },
      }),
    ).toMatchObject({
      message: expect.stringContaining(
        "Member format is accepted only with the value the capture sent",
      ),
    });
    expect(books.snapshot()).toBe(before);
    expect(
      books.answer("post_books", {
        body: { name: "Hard", format: "hardcover" },
      }).body,
    ).toMatchObject({ id: 3, name: "Hard", format: "HARDCOVER" });
  });

  it("holds a member a later update first stored to the JSON type it stored", () => {
    const shelved = { ...SECOND_BOOK, tags: ["a"] };
    const renamed = renamedBook(FIRST_BOOK, "Renamed Book", 3);
    const retagged = { ...shelved, tags: ["x"], updated_at: bookClock(5) };
    // The rename the plan was built from shows no tags, which the first book never had.
    const books = servedFrom([
      ["GET", "/api/books", [FIRST_BOOK, shelved]],
      ["GET", "/api/books/1", FIRST_BOOK],
      ["GET", "/api/books/2", shelved],
      ["PATCH", "/api/books/1", renamed, 200, { name: "Renamed Book" }],
      ["GET", "/api/books/1", renamed],
      ["PATCH", "/api/books/2", retagged, 200, { tags: ["x"] }],
      ["GET", "/api/books/2", retagged],
    ]);
    expect(books.state.writes.get("patch_books_by_id")).toMatchObject({
      served: true,
      body: { kinds: [{ member: "tags", kind: "array" }] },
    });
    const before = books.snapshot();
    expect(
      books.refusal("patch_books_by_id", { id: "1", body: { tags: "x" } }),
    ).toMatchObject({
      message: expect.stringContaining("Member tags must be a JSON array"),
    });
    expect(books.snapshot()).toBe(before);
    books.answer("patch_books_by_id", { id: "1", body: { tags: ["y"] } });
    expect(entityOf(books, "1")?.fields).toMatchObject({ tags: ["y"] });
  });

  it("generates the same values after a refused call as without it", () => {
    const refusedFirst = servedFrom();
    refusedFirst.refusal("post_books", { body: {} });
    refusedFirst.refusal("patch_books_by_id", {
      id: "1",
      body: { title: "New" },
    });
    expect(refusedFirst.answer("post_books", CREATE_NEW_BOOK).body).toEqual(
      servedFrom().answer("post_books", CREATE_NEW_BOOK).body,
    );
  });
});

/** Items whose `rank` is a collection sequence, with a recorded create at `recorded`. */
const rankedItems = (initial: readonly [number, number], recorded: number) => {
  const item = (id: number, rank: number) => ({
    id,
    name: `n${String(id)}`,
    rank,
  });
  const [first, second] = initial;
  return servedFrom([
    ["GET", "/api/items", [item(1, first), item(2, second)]],
    ["GET", "/api/items/1", item(1, first)],
    ["GET", "/api/items/2", item(2, second)],
    ["POST", "/api/items", item(3, recorded), 201, { name: "n3" }],
    ["GET", "/api/items/3", item(3, recorded)],
    ["GET", "/api/items", [item(1, first), item(2, second), item(3, recorded)]],
  ]);
};

describe("generated values", () => {
  it("answers the same calls identically after a reset, never reusing a deleted id", () => {
    const books = servedFrom();
    const session = () => {
      const answers = [
        books.answer("post_books", CREATE_NEW_BOOK),
        books.answer("patch_books_by_id", {
          id: "3",
          body: { name: "Newer Book" },
        }),
        books.answer("delete_books_by_id", { id: "3" }),
        books.answer("post_books", { body: { name: "Another Book" } }),
        books.answer("get_books"),
      ];
      return { answers, text: JSON.stringify([answers, books.snapshot()]) };
    };
    const first = session();
    books.store.reset();
    expect(session().text).toBe(first.text);
    expect(first.answers[3]?.body).toMatchObject({
      id: 4,
      name: "Another Book",
    });
  });

  it("serves the next rank when a collection sequence runs through negative values", () => {
    const acrossZero = rankedItems([-2, -1], 0);
    expect(
      acrossZero.answer("post_items", { body: { name: "n4" } }).body,
    ).toMatchObject({ id: 3, rank: 0 });
    expect(
      acrossZero.answer("post_items", { body: { name: "n5" } }).body,
    ).toMatchObject({ id: 4, rank: 1 });
    // The value after a stored negative rank stays on that sequence.
    const negative = rankedItems([-4, -3], -2);
    expect(
      negative.answer("post_items", { body: { name: "n4" } }).body,
    ).toMatchObject({ id: 3, rank: -2 });
    expect(
      negative.answer("post_items", { body: { name: "n5" } }).body,
    ).toMatchObject({ id: 4, rank: -1 });
  });

  it("restarts the clock and the sequences when data/add loads a state", () => {
    const books = servedFrom();
    const initial: unknown = JSON.parse(books.snapshot());
    const created = books.answer("post_books", CREATE_NEW_BOOK);
    books.answer("post_books", { body: { name: "Another Book" } });
    expect(books.store.replace(initial).ok).toBe(true);
    // Had the sequence and clock run on, this create would take id 5 one second later.
    expect(books.answer("post_books", CREATE_NEW_BOOK).body).toEqual(
      created.body,
    );
  });
});

describe("served catalog", () => {
  it("adds only the served write tools, saying what each does to the state", () => {
    const { source, state } = servedFrom();
    const catalog = servedCatalog(source, state, "books");
    if (!catalog.ok) throw catalog.error;
    const described = new Map(
      catalog.value.tools.map((tool) => [tool.name, tool]),
    );
    // The export write targets no state type, so it is not served.
    expect([...described.keys()].sort()).toEqual([
      "delete_books_by_id",
      "get_books",
      "get_books_by_id",
      "patch_books_by_id",
      "post_books",
    ]);
    expect(described.get("post_books")?.description).toContain(
      'creates an entity of /api/books in the served environment state (body members "name"; required: "name"), modelled on the recorded calls',
    );
    expect(described.get("patch_books_by_id")?.description).toContain(
      'changes the entity the path names in the served environment state (body members "name"; send at least one)',
    );
    expect(described.get("delete_books_by_id")?.description).toContain(
      "removes the entity the path names from the served environment state",
    );
    expect(described.get("post_books")?.annotations.readOnlyHint).toBe(false);
    expect(described.get("get_books")?.description).toContain(
      "answers from the served environment state where the state backs this tool",
    );
  });

  it("quotes the member names a write's description lists and samples a long one", () => {
    const long = "n".repeat(90_000);
    const item = (id: number, name: string) => ({
      id,
      name,
      "x, y": name,
      [long]: name,
    });
    const { source, state } = servedFrom([
      ["GET", "/api/books", [item(1, "A")]],
      ["GET", "/api/books/1", item(1, "A")],
      [
        "POST",
        "/api/books",
        item(2, "B"),
        201,
        { name: "B", "x, y": "B", [long]: "B" },
      ],
      ["GET", "/api/books/2", item(2, "B")],
      ["GET", "/api/books", [item(1, "A"), item(2, "B")]],
    ]);
    const catalog = servedCatalog(source, state, "books");
    if (!catalog.ok) throw catalog.error;
    const created = catalog.value.tools.find(
      (tool) => tool.name === "post_books",
    );
    expect(created?.description).toContain(
      'body members "name", "x, y", … (2/3 shown; full list in state Evidence)',
    );
  });

  it("serves every manifest tool unchanged in replay mode", () => {
    const { source } = servedFrom();
    const replay = servedCatalog(source, undefined, "books");
    const definitions = environmentToolDefinitions(source, "books");
    if (!replay.ok || !definitions.ok) throw new Error("Expected a catalog");
    expect(replay.value).toEqual({
      tools: definitions.value,
      dataPlane: "none",
    });
    expect(replay.value.tools.map(({ name }) => name)).toContain(
      "post_exports",
    );
  });
});

describe("paged list lines", () => {
  it("answers an argument-less list from the state on a line that only pages, and another page from its recording", () => {
    const paged = servedFrom([
      ["GET", "/api/books?limit=50", [FIRST_BOOK, SECOND_BOOK]],
      ...BOOK_INIT_ROWS.slice(1),
      ["POST", "/api/books", THIRD_BOOK, 201, { name: "Third Book" }],
      ["GET", "/api/books/3", THIRD_BOOK],
      ["GET", "/api/books?limit=50", [FIRST_BOOK, SECOND_BOOK, THIRD_BOOK]],
    ]);
    const created = paged.answer("post_books", CREATE_NEW_BOOK).body;
    expect(paged.answer("get_books")).toMatchObject({
      body: [FIRST_BOOK, SECOND_BOOK, created],
      replay: { record_ordinal: 0, exact_match: false },
      state: { source: "state", view: "list", listed: 3 },
    });
    expect(paged.answer("get_books", { limit: "10" })).toMatchObject({
      body: [FIRST_BOOK, SECOND_BOOK],
      state: { source: "recording", reason: "unrecorded-request" },
    });
  });
});

describe("path values", () => {
  const orgBook = (id: number, org: string, name: string): Book => ({
    id,
    org,
    name,
  });
  const ALPHA = orgBook(1, "my org1", "Alpha");
  const BETA = orgBook(2, "acme2", "Beta");
  const GAMMA = orgBook(3, "my org1", "Gamma");
  const DELTA = orgBook(4, "acme2", "Delta");
  /** Books under two organisations, one whose name the paths percent-encode, and a create under each. */
  const ROWS: readonly TimedCaptureRow[] = [
    ["GET", "/api/orgs/my%20org1/books", [ALPHA]],
    ["GET", "/api/orgs/acme2/books", [BETA]],
    ["GET", "/api/orgs/my%20org1/books/1", ALPHA],
    ["GET", "/api/orgs/acme2/books/2", BETA],
    ["POST", "/api/orgs/my%20org1/books", GAMMA, 201, { name: "Gamma" }],
    ["GET", "/api/orgs/my%20org1/books", [ALPHA, GAMMA]],
    ["POST", "/api/orgs/acme2/books", DELTA, 201, { name: "Delta" }],
    ["GET", "/api/orgs/acme2/books", [BETA, DELTA]],
  ];

  it("stores a parent path value decoded, as the gate learned it, whichever spelling the call uses", () => {
    for (const spelling of ["my%20org1", "my org1"]) {
      const books = servedFrom(ROWS);
      const tool = books.source.manifest.tools.find(
        (candidate) => candidate.method === "POST",
      )!;
      expect(books.state.writes.get(tool.name)).toMatchObject({
        served: true,
        rules: expect.arrayContaining([
          expect.objectContaining({ field: "org", rule: "path" }),
        ]),
      });
      const [org] = environmentToolArguments(tool).path.values();
      books.answer(tool.name, { [org!]: spelling, body: { name: "Epsilon" } });
      const created = books.store
        .snapshot()
        .rea_state.entities.find(
          (entity) => entity.fields["name"] === "Epsilon",
        );
      expect(created).toMatchObject({
        collection: "/api/orgs/my%20org1/books",
        fields: { org: "my org1" },
      });
    }
  });
});

describe("collections a create chooses", () => {
  const orgBook = (id: number, name: string): Book => ({ id, name });
  /** One organisation listed under two spellings and another organisation, each with a create. */
  const ROWS: readonly TimedCaptureRow[] = [
    ["GET", "/api/orgs/%61cme1/books", [orgBook(1, "Alpha")]],
    ["GET", "/api/orgs/acme1/books", [orgBook(2, "Beta")]],
    ["GET", "/api/orgs/beta2/books", [orgBook(3, "Gamma")]],
    [
      "POST",
      "/api/orgs/acme1/books",
      orgBook(4, "Delta"),
      201,
      { name: "Delta" },
    ],
    ["GET", "/api/orgs/acme1/books", [orgBook(2, "Beta"), orgBook(4, "Delta")]],
    [
      "POST",
      "/api/orgs/beta2/books",
      orgBook(5, "Epsilon"),
      201,
      { name: "Epsilon" },
    ],
    [
      "GET",
      "/api/orgs/beta2/books",
      [orgBook(3, "Gamma"), orgBook(5, "Epsilon")],
    ],
  ];

  it("creates in the collection the call spells verbatim, as item calls choose their entity", () => {
    const books = servedFrom(ROWS);
    const tool = books.source.manifest.tools.find(
      (candidate) => candidate.method === "POST",
    )!;
    expect(books.state.writes.get(tool.name)).toMatchObject({ served: true });
    const [org] = environmentToolArguments(tool).path.values();
    books.answer(tool.name, { [org!]: "acme1", body: { name: "Zeta" } });
    expect(
      books.store
        .snapshot()
        .rea_state.entities.find((entity) => entity.fields["name"] === "Zeta")
        ?.collection,
    ).toBe("/api/orgs/acme1/books");
  });

  it("refuses an empty parent segment before storing an unreadable collection", () => {
    const books = servedFrom(ROWS);
    const tool = books.source.manifest.tools.find(
      (candidate) => candidate.method === "POST",
    )!;
    const [org] = environmentToolArguments(tool).path.values();
    const before = books.snapshot();
    expect(
      books.refusal(tool.name, { [org!]: "", body: { name: "Invalid" } }),
    ).toMatchObject({
      code: "invalid_request",
      message: expect.stringContaining("path argument to be non-empty"),
    });
    expect(books.snapshot()).toBe(before);
    expect(
      books.store.knownCollectionsOf("/api/orgs/{org}/books"),
    ).not.toContain("/api/orgs//books");
  });
});

describe("missing entities after a delete", () => {
  it("answers with a recorded 2xx null, which the gate also took as an absence", () => {
    const books = servedFrom([
      ...BOOK_INIT_ROWS,
      ["DELETE", "/api/books/2", "", 204],
      ["GET", "/api/books/2", null],
    ]);
    expect(books.state.writes.get("delete_books_by_id")).toMatchObject({
      served: true,
    });
    books.answer("delete_books_by_id", { id: "1" });
    expect(books.answer("get_books_by_id", { id: "1" })).toMatchObject({
      status: 200,
      body: null,
      state: { view: "missing", id: "1" },
    });
  });

  it("never answers a write of a missing entity with success, even when the write recorded a 2xx null", () => {
    const books = servedFrom([
      ...BOOK_INIT_ROWS,
      ["DELETE", "/api/books/2", null, 200],
      ["GET", "/api/books/2", BOOK_NOT_FOUND, 404],
    ]);
    expect(books.state.writes.get("delete_books_by_id")).toMatchObject({
      served: true,
    });
    expect(books.answer("delete_books_by_id", { id: "9" })).toMatchObject({
      status: 404,
      body: BOOK_NOT_FOUND,
      state: { view: "missing", id: "9" },
    });
  });
});

describe("values the state started with", () => {
  it("never reuses a seeded id for a create, even after its entity is deleted first", () => {
    const books = servedFrom();
    books.answer("delete_books_by_id", { id: "2" });
    books.answer("post_books", CREATE_NEW_BOOK);
    expect(entityOf(books, "2")).toBeUndefined();
    expect(entityOf(books, "3")?.fields).toMatchObject({ name: "New Book" });
  });

  const orgBook = (id: number, org: string, name: string): Book => ({
    id,
    org,
    name,
  });
  /** Books under two organisations, one spelled `first` in its paths, with creates and a delete the lists confirm. */
  const twoOrgs = (first: string, org: string) => {
    const alpha = orgBook(1, org, "Alpha");
    const beta = orgBook(2, "acme2", "Beta");
    const gamma = orgBook(3, org, "Gamma");
    const delta = orgBook(4, "acme2", "Delta");
    const books = servedFrom([
      ["GET", `/api/orgs/${first}/books`, [alpha]],
      ["GET", "/api/orgs/acme2/books", [beta]],
      ["GET", `/api/orgs/${first}/books/1`, alpha],
      ["GET", "/api/orgs/acme2/books/2", beta],
      ["POST", `/api/orgs/${first}/books`, gamma, 201, { name: "Gamma" }],
      ["GET", `/api/orgs/${first}/books`, [alpha, gamma]],
      ["POST", "/api/orgs/acme2/books", delta, 201, { name: "Delta" }],
      ["GET", "/api/orgs/acme2/books", [beta, delta]],
      ["DELETE", `/api/orgs/${first}/books/3`, "", 204],
      ["GET", `/api/orgs/${first}/books`, [alpha]],
    ]);
    const toolOf = (method: string) =>
      books.source.manifest.tools.find(
        (candidate) => candidate.method === method,
      )!;
    const create = (value: string, name: string): string | undefined => {
      const tool = toolOf("POST");
      const [parent] = environmentToolArguments(tool).path.values();
      books.answer(tool.name, { [parent!]: value, body: { name } });
      return books.store
        .snapshot()
        .rea_state.entities.find((entity) => entity.fields["name"] === name)
        ?.collection;
    };
    return { books, toolOf, create };
  };

  it("creates in a collection's recorded spelling after the collection empties", () => {
    const { books, toolOf, create } = twoOrgs("my%20org1", "my org1");
    const remove = toolOf("DELETE");
    const [parent, id] = environmentToolArguments(remove).path.values();
    for (const held of ["1", "3"])
      books.answer(remove.name, { [parent!]: "my%20org1", [id!]: held });
    expect(books.store.collectionsOf("/api/orgs/{org}/books")).not.toContain(
      "/api/orgs/my%20org1/books",
    );
    expect(create("my%20org1", "Epsilon")).toBe("/api/orgs/my%20org1/books");
  });

  it("creates in the Evidence's spelling of a collection a loaded state does not hold", () => {
    const { books, create } = twoOrgs("my%20org1", "my org1");
    const { rea_state: held } = books.store.snapshot();
    expect(
      books.store.replace({
        rea_state: {
          version: held.version,
          entities: held.entities.filter(
            (entity) => !entity.collection.includes("%20"),
          ),
          documents: held.documents,
        },
      }).ok,
    ).toBe(true);
    expect(create("my%20org1", "Epsilon")).toBe("/api/orgs/my%20org1/books");
  });

  it("creates in the loaded state's collection when the Evidence spells the same one differently", () => {
    const { books, create } = twoOrgs("%61cme1", "acme1");
    const { rea_state: held } = books.store.snapshot();
    expect(
      books.store.replace({
        rea_state: {
          version: held.version,
          entities: held.entities.map((entity) =>
            entity.collection.includes("%61cme1")
              ? {
                  ...entity,
                  collection: entity.collection.replace("%61cme1", "a%63me1"),
                  record_ordinals: [],
                }
              : entity,
          ),
          documents: held.documents,
        },
      }).ok,
    ).toBe(true);
    // Both spellings decode to the argument; the one holding books wins over the Evidence's emptied one.
    expect(create("acme1", "Epsilon")).toBe("/api/orgs/a%63me1/books");
  });

  it("creates in the spelling of a collection the capture listed empty", () => {
    const beta = orgBook(2, "acme2", "Beta");
    const gamma = orgBook(3, "my org1", "Gamma");
    const delta = orgBook(4, "acme2", "Delta");
    // The state starts before the first create, when the encoded organisation's list was empty.
    const books = servedFrom([
      ["GET", "/api/orgs/my%20org1/books", []],
      ["GET", "/api/orgs/acme2/books", [beta]],
      ["GET", "/api/orgs/acme2/books/2", beta],
      ["POST", "/api/orgs/my%20org1/books", gamma, 201, { name: "Gamma" }],
      ["GET", "/api/orgs/my%20org1/books", [gamma]],
      ["POST", "/api/orgs/acme2/books", delta, 201, { name: "Delta" }],
      ["GET", "/api/orgs/acme2/books", [beta, delta]],
    ]);
    const tool = books.source.manifest.tools.find(
      (candidate) => candidate.method === "POST",
    )!;
    const [parent] = environmentToolArguments(tool).path.values();
    books.answer(tool.name, {
      [parent!]: "my%20org1",
      body: { name: "Epsilon" },
    });
    expect(
      books.store
        .snapshot()
        .rea_state.entities.find(
          (entity) => entity.fields["name"] === "Epsilon",
        )?.collection,
    ).toBe("/api/orgs/my%20org1/books");
  });

  it("forgets the spellings of a loaded state once reset", () => {
    const { books, create } = twoOrgs("%61cme1", "acme1");
    const { rea_state: held } = books.store.snapshot();
    // A loaded state spells the first organisation plainly; the Evidence's state spells it encoded.
    expect(
      books.store.replace({
        rea_state: {
          version: held.version,
          // Moved to another spelling, the entity cites none of the Evidence's records.
          entities: held.entities.map((entity) =>
            entity.collection.includes("%61cme1")
              ? {
                  ...entity,
                  collection: entity.collection.replace("%61cme1", "acme1"),
                  record_ordinals: [],
                }
              : entity,
          ),
          documents: held.documents,
        },
      }).ok,
    ).toBe(true);
    books.store.reset();
    expect(create("acme1", "Epsilon")).toBe("/api/orgs/%61cme1/books");
  });
});

describe("paged lines", () => {
  it("answers a requested page the collection has outgrown from its recording, and a call with no query from the state", () => {
    const books = servedFrom([
      ["GET", "/api/books?limit=2", [FIRST_BOOK, SECOND_BOOK]],
      ["GET", "/api/books/1", FIRST_BOOK],
      ["GET", "/api/books/2", SECOND_BOOK],
      ["POST", "/api/books", THIRD_BOOK, 201, { name: "Third Book" }],
      // The application answers the same page with two books; serving would not answer it from the state.
      ["GET", "/api/books?limit=2", [FIRST_BOOK, SECOND_BOOK]],
      ["GET", "/api/books", [FIRST_BOOK, SECOND_BOOK, THIRD_BOOK]],
    ]);
    const created = books.answer("post_books", CREATE_NEW_BOOK).body as Book;
    expect(books.answer("get_books", { limit: "2" })).toMatchObject({
      body: [FIRST_BOOK, SECOND_BOOK],
      state: { source: "recording", reason: "page-exceeded" },
    });
    expect(books.answer("get_books")).toMatchObject({
      body: [FIRST_BOOK, SECOND_BOOK, created],
      state: { source: "state", membership: "all", listed: 3 },
    });
  });

  it("answers a whole list a zero limit names from the state, as zero lists every match", () => {
    const books = servedFrom([
      ["GET", "/api/books?limit=0", [FIRST_BOOK, SECOND_BOOK]],
      ["GET", "/api/books/1", FIRST_BOOK],
      ["GET", "/api/books/2", SECOND_BOOK],
      ["POST", "/api/books", THIRD_BOOK, 201, { name: "Third Book" }],
      ["GET", "/api/books/3", THIRD_BOOK],
    ]);
    const created = books.answer("post_books", CREATE_NEW_BOOK).body as Book;
    expect(books.answer("get_books", { limit: "0" })).toMatchObject({
      body: [FIRST_BOOK, SECOND_BOOK, created],
      state: { source: "state", membership: "all", listed: 3 },
    });
  });

  it("answers a zero limit a whole line recorded empty from that recording once a create fills its collection", () => {
    const alpha = { id: 1, name: "Alpha", org: "1" };
    const beta = { id: 2, name: "Beta", org: "2" };
    const books = servedFrom([
      ["GET", "/api/orgs/1/books", [alpha]],
      ["GET", "/api/orgs/1/books/1", alpha],
      ["GET", "/api/orgs/2/books?limit=0", []],
      ["POST", "/api/orgs/2/books", beta, 201, { name: "Beta" }],
      ["GET", "/api/orgs/2/books/2", beta],
    ]);
    books.answer("post_orgs_books_by_id", { id: "2", body: { name: "Gamma" } });
    // Only a recording that listed items under it shows that zero lists every entity.
    expect(
      books.answer("get_orgs_books_by_id", { id: "2", limit: "0" }),
    ).toMatchObject({
      body: [],
      state: { source: "recording", reason: "page-exceeded" },
    });
  });

  it("keeps a range's bound beside a zero size its recording shows unbounded", () => {
    const books = servedFrom([
      ["GET", "/api/books?limit=0&_start=0&_end=2", [FIRST_BOOK, SECOND_BOOK]],
      ["GET", "/api/books/1", FIRST_BOOK],
      ["GET", "/api/books/2", SECOND_BOOK],
      ["POST", "/api/books", THIRD_BOOK, 201, { name: "Third Book" }],
      ["GET", "/api/books/3", THIRD_BOOK],
    ]);
    books.answer("post_books", CREATE_NEW_BOOK);
    expect(
      books.answer("get_books", { limit: "0", _start: "0", _end: "2" }),
    ).toMatchObject({
      body: [FIRST_BOOK, SECOND_BOOK],
      state: { source: "recording", reason: "page-exceeded" },
    });
  });

  it("answers a range the collection has outgrown from its recording", () => {
    const books = servedFrom([
      ["GET", "/api/books?_start=0&_end=2", [FIRST_BOOK, SECOND_BOOK]],
      ["GET", "/api/books/1", FIRST_BOOK],
      ["GET", "/api/books/2", SECOND_BOOK],
      ["POST", "/api/books", THIRD_BOOK, 201, { name: "Third Book" }],
      ["GET", "/api/books?_start=0&_end=2", [FIRST_BOOK, SECOND_BOOK]],
      ["GET", "/api/books/3", THIRD_BOOK],
    ]);
    books.answer("post_books", CREATE_NEW_BOOK);
    expect(books.answer("get_books", { _start: "0", _end: "2" })).toMatchObject(
      {
        body: [FIRST_BOOK, SECOND_BOOK],
        state: { source: "recording", reason: "page-exceeded" },
      },
    );
  });
});
