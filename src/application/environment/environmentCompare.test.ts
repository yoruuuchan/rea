import { describe, expect, it } from "vitest";

import type { JsonValue } from "../../domain/jsonValue.js";
import {
  analysisViewCaptureEvidence,
  environmentManifestCaptureFixture,
  timedCaptureEvidence,
  type TimedCaptureRow,
} from "../../../tests/fixtures/analysisView.js";
import {
  environmentServeSource,
  environmentStateServeFixture,
} from "../../../tests/fixtures/environmentServe.js";
import {
  BOOK_NOT_FOUND,
  BOOK_ROWS,
  FIRST_BOOK,
  SECOND_BOOK,
  book,
  renamedBook,
} from "../../../tests/fixtures/environmentStateWrites.js";
import {
  scenarioCaptureEvidence,
  scenarioCaptureFixture,
  scenarioHeaderOnlyCaptureEvidence,
} from "../../../tests/fixtures/browserScenarioCapture.js";
import { compareEnvironment } from "./environmentCompare.js";
import {
  environmentArguments,
  IdMap,
  translatePath,
} from "./environmentCompareIds.js";
import {
  collectionScope,
  matchProbeRequest,
  parameterScopes,
} from "./environmentCompareMatch.js";
import type { EnvironmentManifestTool } from "./environmentSource.js";
import { isCut } from "./environmentCompareProbe.js";
import { parseCaptureEvidence } from "./environmentSource.js";

const fixture = environmentStateServeFixture(timedCaptureEvidence(BOOK_ROWS));
const source = environmentServeSource(fixture);

/** The books application re-seeded: the same books under other ids and creation times. */
const LIVE_FIRST = book(101, "First Book", "2026-10-20T09:00:00Z");
const LIVE_SECOND = book(102, "Second Book", "2026-10-20T10:00:00Z");
const LIVE_FOURTH = book(103, "Fourth Book", "2026-10-20T11:00:00Z");
const LIVE_RENAMED = renamedBook(LIVE_FIRST, "Renamed Book", 5);
const ANN = { id: 1, name: "Ann" };
const BOB = { id: 2, name: "Bob" };

const compare = (...probes: (readonly TimedCaptureRow[])[]) => {
  const report = compareEnvironment({
    source,
    captureValue: fixture.capture,
    probes: probes.map((rows, index) => ({
      label: `probe-${String(index + 1)}`,
      value: timedCaptureEvidence(rows),
    })),
    operation: "environment-compare",
  });
  if (!report.ok) throw report.error;
  return report.value;
};

describe("matchProbeRequest", () => {
  it("prefers literal segments, requires format-rule parameters to fit, and maps query and body arguments", () => {
    const item = matchProbeRequest(source.manifest, {
      method: "GET",
      path: "/api/books/7",
      query: "?expand=all",
      body: undefined,
    });
    expect(item?.tool.path_template).toBe("/api/books/{numeric}");
    expect(item?.args).toEqual({ id: "7" });
    expect(item?.ignoredQuery).toEqual(["expand"]);
    const create = matchProbeRequest(source.manifest, {
      method: "POST",
      path: "/api/books",
      query: null,
      body: { name: "X" },
    });
    expect(create?.args).toEqual({ body: { name: "X" } });
    expect(
      matchProbeRequest(source.manifest, {
        method: "GET",
        path: "/api/books/x",
        query: null,
        body: undefined,
      }),
    ).toBeUndefined();
  });

  it("fits a format-rule parameter by its decoded value and passes the raw segment", () => {
    const item = matchProbeRequest(source.manifest, {
      method: "GET",
      path: "/api/books/%31",
      query: null,
      body: undefined,
    });
    expect(item?.tool.path_template).toBe("/api/books/{numeric}");
    // The environment decodes this once, as replay decodes a recorded segment once.
    expect(item?.args).toEqual({ id: "%31" });
  });
});

const nestedUsers = {
  path_template: "/api/orgs/{numeric}/users/{numeric}",
  params: [
    { index: 2, name: "org_id", rule: "numeric" },
    { index: 4, name: "id", rule: "numeric" },
  ],
} as EnvironmentManifestTool;

describe("collections under different parents", () => {
  it("names each parent's collection from the live path, and does not rename a literal segment", () => {
    const orgOne = ["api", "orgs", "1", "users", "110"];
    const orgTwo = ["api", "orgs", "2", "users", "110"];
    expect(collectionScope(nestedUsers, orgOne)).toBe("/api/orgs/1/users");
    expect(collectionScope(nestedUsers, orgTwo)).toBe("/api/orgs/2/users");
    expect(
      collectionScope(nestedUsers, ["api", "orgs", "", "users", "110"]),
    ).toBe("/api/orgs/{}/users");
    const map = new IdMap();
    map.learn(110, 10, "/api/orgs/1/users");
    map.learn(110, 20, "/api/orgs/2/users");
    map.learn("users", "stored-tag");
    const scopes = parameterScopes(nestedUsers, orgOne);
    // Template indexes of api, orgs and users; the two parameters are not literals.
    const literals = new Set([0, 1, 3]);
    expect(
      translatePath(
        "/api/orgs/1/users/110",
        map,
        (index) => scopes.get(index),
        (index) => literals.has(index),
      ),
    ).toBe("/api/orgs/1/users/10");
    expect(map.env(110, "/api/orgs/2/users")).toBe(20);
  });

  it("shares a child map when the same parent is spelled with one encoding", () => {
    const encoded = ["api", "orgs", "%32", "users", "101"];
    const plain = ["api", "orgs", "2", "users", "101"];
    const twice = ["api", "orgs", "%2532", "users", "101"];
    expect(collectionScope(nestedUsers, encoded)).toBe("/api/orgs/2/users");
    expect(collectionScope(nestedUsers, plain)).toBe(
      collectionScope(nestedUsers, encoded),
    );
    // Decoding again would make this parent the same as `2`. Encoding the once-decoded segment keeps it distinct.
    expect(collectionScope(nestedUsers, twice)).toBe("/api/orgs/%2532/users");
    const map = new IdMap();
    map.learn(101, 10, "/api/orgs/1/users");
    map.learn(101, 20, collectionScope(nestedUsers, encoded));
    const literals = new Set([0, 1, 3]);
    const translate = (segments: readonly string[], path: string) => {
      const scopes = parameterScopes(nestedUsers, segments);
      return translatePath(
        path,
        map,
        (index) => scopes.get(index),
        (index) => literals.has(index),
      );
    };
    // Org 1 taught 101 → 10 globally. The child learned under `%32` is the one `/api/orgs/2/users/101` names.
    expect(translate(plain, "/api/orgs/2/users/101")).toBe(
      "/api/orgs/2/users/20",
    );
    expect(translate(twice, "/api/orgs/%2532/users/101")).toBe(
      "/api/orgs/%2532/users/10",
    );
  });

  it("keeps child ids apart when a decoded parent contains slashes", () => {
    const nested = {
      path_template:
        "/api/groups/uid/{uid}/folders/uid/{uid_2}/users/{numeric}",
      params: [
        { index: 3, name: "uid", rule: "after-uid-literal" },
        { index: 6, name: "uid_2", rule: "after-uid-literal" },
        { index: 8, name: "id", rule: "numeric" },
      ],
    } as EnvironmentManifestTool;
    const first = [
      "api",
      "groups",
      "uid",
      "a%2Ffolders%2Fuid%2Fb",
      "folders",
      "uid",
      "c",
      "users",
      "101",
    ];
    const second = [
      "api",
      "groups",
      "uid",
      "a",
      "folders",
      "uid",
      "b%2Ffolders%2Fuid%2Fc",
      "users",
      "101",
    ];
    const firstScope =
      "/api/groups/uid/a%2Ffolders%2Fuid%2Fb/folders/uid/c/users";
    const secondScope =
      "/api/groups/uid/a/folders/uid/b%2Ffolders%2Fuid%2Fc/users";
    expect(collectionScope(nested, first)).toBe(firstScope);
    expect(collectionScope(nested, second)).toBe(secondScope);
    const map = new IdMap();
    map.learn(101, 10, collectionScope(nested, first));
    map.learn(101, 20, collectionScope(nested, second));
    const literals = new Set([0, 1, 2, 4, 5, 7]);
    const translate = (segments: readonly string[], path: string) => {
      const scopes = parameterScopes(nested, segments);
      return translatePath(
        path,
        map,
        (index) => scopes.get(index),
        (index) => literals.has(index),
      );
    };
    expect(translate(first, `/${first.join("/")}`)).toBe(
      "/api/groups/uid/a%2Ffolders%2Fuid%2Fb/folders/uid/c/users/10",
    );
    expect(translate(second, `/${second.join("/")}`)).toBe(
      "/api/groups/uid/a/folders/uid/b%2Ffolders%2Fuid%2Fc/users/20",
    );
    expect(map.env(101, secondScope)).toBe(20);
  });
});

describe("compareEnvironment", () => {
  it("agrees with a re-seeded application once seeded and created ids are mapped", () => {
    const report = compare([
      ["GET", "/api/books", [LIVE_FIRST, LIVE_SECOND]],
      ["GET", "/api/books/101", LIVE_FIRST],
      ["POST", "/api/books", LIVE_FOURTH, 201, { name: "Fourth Book" }],
      ["GET", "/api/books/103", LIVE_FOURTH],
      ["PATCH", "/api/books/101", LIVE_RENAMED, 200, { name: "Renamed Book" }],
      ["GET", "/api/books/101", LIVE_RENAMED],
      ["DELETE", "/api/books/103", "", 204],
      ["GET", "/api/books/103", BOOK_NOT_FOUND, 404],
      ["GET", "/api/books", [LIVE_RENAMED, LIVE_SECOND]],
    ]);
    expect(report.environment.state).toBe("served");
    expect(report.probes[0]?.results.filter((step) => !step.equal)).toEqual([]);
    expect(report.summary).toMatchObject({
      probes: 1,
      steps: 9,
      equal: 9,
      agreement: 1,
    });
    expect(report.probes[0]?.ids_mapped).toBe(3);
    expect(report.summary.normalised.ids).toBeGreaterThan(0);
  });

  it("resets the state per probe and categorises every kind of disagreement", () => {
    const report = compare(
      [
        ["GET", "/api/books", [LIVE_FIRST, LIVE_SECOND]],
        ["DELETE", "/api/books/101", { detail: "Book is referenced." }, 409],
        ["GET", "/api/authors", []],
        ["GET", "/api/books/555", LIVE_FIRST],
      ],
      [["GET", "/api/books", [LIVE_SECOND, LIVE_FIRST, LIVE_FOURTH]]],
    );
    const [first, second] = report.probes;
    expect(first?.results.map((step) => step.categories)).toEqual([
      [],
      ["status", "value"],
      ["no-tool"],
      ["unmapped-id", "status", "missing-field", "extra-field"],
    ]);
    expect(second?.results[0]?.categories).toEqual(["length", "order"]);
    expect(second?.results[0]?.equal_ignoring_order).toBe(false);
    expect(report.summary.agreement_ignoring_order).toBe(
      report.summary.agreement,
    );
    expect(report.summary.categories).toMatchObject({
      status: 2,
      "no-tool": 1,
      "unmapped-id": 1,
      length: 1,
      order: 1,
    });
    expect(report.tools.map((tool) => tool.tool)).toContain(
      "delete_books_by_id",
    );
  });
});

describe("what the comparison translates and learns", () => {
  /** The books capture with a paged, filtered list and reports the state does not model, so other reports replay this one. */
  const extra = environmentStateServeFixture(
    timedCaptureEvidence([
      ...BOOK_ROWS,
      ["GET", "/api/books?limit=2&author=7", [FIRST_BOOK, SECOND_BOOK]],
      ["GET", "/api/reports/1", [{ owner_id: 7 }]],
      ["GET", "/api/authors", [ANN, BOB]],
      ["GET", "/api/authors/1", ANN],
      ["GET", "/api/authors/2", BOB],
      ["GET", "/api/ping", ""],
      ["POST", "/api/books/search", [FIRST_BOOK], 200, { q: "First" }],
      ["POST", "/api/tags/search", [{ id: 1 }], 200, { q: "first" }],
      ["GET", "/api/motd", '""'],
    ]),
  );
  const extraSource = environmentServeSource(extra);
  const compareExtra = (rows: readonly TimedCaptureRow[]) => {
    const report = compareEnvironment({
      source: extraSource,
      captureValue: extra.capture,
      probes: [{ label: "probe", value: timedCaptureEvidence(rows) }],
      operation: "environment-compare",
    });
    if (!report.ok) throw report.error;
    return report.value.probes[0]!;
  };

  it("translates a path id by the collection it names when two collections reuse a live id", () => {
    // Live book 101 is the environment's book 1, while live author 101 is its author 2.
    const probe = compareExtra([
      ["GET", "/api/books", [LIVE_FIRST, LIVE_SECOND]],
      [
        "GET",
        "/api/authors",
        [
          { ...ANN, id: 102 },
          { ...BOB, id: 101 },
        ],
      ],
      ["GET", "/api/authors/101", { ...BOB, id: 101 }],
    ]);
    expect(probe.results.map((step) => step.equal)).toEqual([true, true, true]);
  });

  it("refuses arguments the served tool's input schema refuses, as the server would", () => {
    // A search replays its recording whatever it is sent, but the server refuses a body that is not an object.
    const [step] = compareExtra([
      ["POST", "/api/books/search", [FIRST_BOOK], 200, ["First"]],
    ]).results;
    expect(step?.categories).toEqual(["refused"]);
    expect(step?.differences[0]?.env).toContain("Invalid arguments");
  });

  it("agrees on an empty response however each side spells it, and keeps a JSON empty string", () => {
    expect(compareExtra([["GET", "/api/ping", ""]]).results[0]?.equal).toBe(
      true,
    );
    expect(compareExtra([["GET", "/api/motd", '""']]).results[0]?.equal).toBe(
      true,
    );
  });

  it("learns ids from a replayed recording only of the same call, body included", () => {
    expect(
      compareExtra([
        ["POST", "/api/tags/search", [{ id: 102 }], 200, { q: "second" }],
      ]).ids_mapped,
    ).toBe(0);
    expect(
      compareExtra([
        ["POST", "/api/tags/search", [{ id: 102 }], 200, { q: "first" }],
      ]).ids_mapped,
    ).toBe(1);
    // A body the probe did not send is not the body the recording sent.
    expect(
      compareExtra([["POST", "/api/tags/search", [{ id: 102 }], 200]])
        .ids_mapped,
    ).toBe(0);
  });

  it("compares a large binary body only by status, as it does large text", () => {
    expect(isCut({ kind: "base64", encoded: "AAAA", whole: false })).toBe(true);
    expect(isCut({ kind: "base64", encoded: "AAAA", whole: true })).toBe(false);
    expect(isCut({ kind: "cut", text: "a" })).toBe(true);
  });

  it("translates mapped ids in query values except those that page a list", () => {
    const call = matchProbeRequest(extraSource.manifest, {
      method: "GET",
      path: "/api/books",
      query: "?limit=101&author=101",
      body: undefined,
    });
    const map = new IdMap();
    map.learn(101, 1);
    expect(call?.pagingArguments).toEqual(["limit"]);
    expect(call && environmentArguments(call, map)).toEqual({
      limit: "101",
      author: "1",
    });
  });

  it("learns no ids from another call's recording replayed in place of an answer", () => {
    const report = compareEnvironment({
      source: extraSource,
      captureValue: extra.capture,
      probes: [
        {
          label: "reports",
          value: timedCaptureEvidence([
            ["GET", "/api/reports/2", [{ owner_id: 107 }]],
          ]),
        },
      ],
      operation: "environment-compare",
    });
    if (!report.ok) throw report.error;
    const [probe] = report.value.probes;
    expect(probe?.ids_mapped).toBe(0);
    expect(probe?.results[0]?.differences).toEqual([
      { category: "value", pointer: "/0/owner_id", live: "107", env: "7" },
    ]);
  });
});

const compareRows = (
  recorded: readonly TimedCaptureRow[],
  probe: readonly TimedCaptureRow[],
) => {
  const capture = timedCaptureEvidence(recorded);
  const built = environmentStateServeFixture(capture);
  const report = compareEnvironment({
    source: environmentServeSource(built),
    captureValue: capture,
    probes: [{ label: "probe", value: timedCaptureEvidence(probe) }],
    operation: "environment-compare",
  });
  if (!report.ok) throw report.error;
  return report.value.probes[0]!;
};

describe("ids the comparison used to misread", () => {
  it("reads a twice-encoded path id once, so book%2531 is not book1", () => {
    const probe = compareRows(
      [
        ["GET", "/api/files/book1", { id: "book1", name: "One" }],
        ["GET", "/api/files/book%2531", { id: "book%31", name: "Encoded" }],
        ["GET", "/api/files/other", { id: "other", name: "Other" }],
      ],
      [["GET", "/api/files/book%2531", { id: "book%31", name: "Encoded" }]],
    );
    expect(probe.results[0]?.equal).toBe(true);
    expect(probe.results[0]?.categories).not.toContain("value");
  });

  it("learns a create that answers with only the new id", () => {
    const item = (id: number, name: string) => ({ id, name });
    const third = item(3, "Third");
    const probe = compareRows(
      [
        ["GET", "/api/items", [item(1, "First"), item(2, "Second")]],
        ["GET", "/api/items/1", item(1, "First")],
        ["GET", "/api/items/2", item(2, "Second")],
        ["POST", "/api/items", { created: 3 }, 201, { name: "Third" }],
        ["GET", "/api/items/3", third],
        ["GET", "/api/items", [item(1, "First"), item(2, "Second"), third]],
      ],
      [
        ["GET", "/api/items", [item(101, "First"), item(102, "Second")]],
        ["POST", "/api/items", { created: 103 }, 201, { name: "Third" }],
        ["GET", "/api/items/103", item(103, "Third")],
      ],
    );
    expect(probe.results.map((step) => step.equal)).toEqual([true, true, true]);
    expect(probe.ids_mapped).toBeGreaterThan(0);
    const scalar = compareRows(
      [
        ["GET", "/api/items", [item(1, "First"), item(2, "Second")]],
        ["GET", "/api/items/1", item(1, "First")],
        ["GET", "/api/items/2", item(2, "Second")],
        ["POST", "/api/items", 3, 201, { name: "Third" }],
        ["GET", "/api/items/3", third],
        ["GET", "/api/items", [item(1, "First"), item(2, "Second"), third]],
      ],
      [
        ["GET", "/api/items", [item(101, "First"), item(102, "Second")]],
        ["POST", "/api/items", 103, 201, { name: "Third" }],
        ["GET", "/api/items/103", item(103, "Third")],
      ],
    );
    expect(scalar.results.map((step) => step.equal)).toEqual([
      true,
      true,
      true,
    ]);
  });

  it("compares a create id within its collection when another collection already mapped that live id", () => {
    const item = (id: number, name: string) => ({ id, name });
    const recorded = (
      created: number | { readonly created: number },
    ): TimedCaptureRow[] => [
      ["GET", "/api/books", [item(1, "Book")]],
      ["GET", "/api/books/1", item(1, "Book")],
      ["GET", "/api/authors", [item(2, "Ann")]],
      ["GET", "/api/authors/2", item(2, "Ann")],
      ["POST", "/api/authors", created, 201, { name: "Bob" }],
      ["GET", "/api/authors/3", item(3, "Bob")],
      ["GET", "/api/authors", [item(2, "Ann"), item(3, "Bob")]],
    ];
    const probe = (
      created: number | { readonly created: number },
    ): TimedCaptureRow[] => [
      ["GET", "/api/books", [item(103, "Book")]],
      ["POST", "/api/authors", created, 201, { name: "Bob" }],
      ["GET", "/api/authors/103", item(103, "Bob")],
    ];
    expect(
      compareRows(recorded(3), probe(103)).results.map((step) => step.equal),
    ).toEqual([true, true, true]);
    expect(
      compareRows(
        recorded({ created: 3 }),
        probe({ created: 103 }),
      ).results.map((step) => step.equal),
    ).toEqual([true, true, true]);
  });

  it("keeps each parent's child ids and does not rename a literal route segment", () => {
    const users = (id: number, name: string) => ({ id, name });
    const probe = compareRows(
      [
        ["GET", "/api/orgs/1/users", [users(10, "Ann"), users(11, "Bea")]],
        ["GET", "/api/orgs/2/users", [users(20, "Cy"), users(21, "Di")]],
        ["GET", "/api/orgs/1/users/10", users(10, "Ann")],
        ["GET", "/api/orgs/2/users/20", users(20, "Cy")],
        ["GET", "/api/tags", [{ id: "stored-tag", name: "Books" }]],
        ["GET", "/api/tags/stored-tag", { id: "stored-tag", name: "Books" }],
        ["GET", "/api/books", [users(1, "First")]],
      ],
      [
        ["GET", "/api/orgs/1/users", [users(110, "Ann"), users(111, "Bea")]],
        ["GET", "/api/orgs/2/users", [users(110, "Cy"), users(111, "Di")]],
        ["GET", "/api/orgs/1/users/110", users(110, "Ann")],
        ["GET", "/api/orgs/2/users/110", users(110, "Cy")],
        ["GET", "/api/tags", [{ id: "books", name: "Books" }]],
        ["GET", "/api/books", [users(1, "First")]],
      ],
    );
    expect(probe.results.map((step) => step.categories)).toEqual([
      [],
      [],
      [],
      [],
      [],
      [],
    ]);
  });
});

describe("browser probes", () => {
  it("keeps a browser probe's request bodies, which are its call arguments", () => {
    const post = (purpose?: "manifest") => {
      const parsed = parseCaptureEvidence(
        "environment-compare",
        scenarioCaptureEvidence(),
        purpose,
      );
      if (!parsed.ok) throw parsed.error;
      return parsed.value.records.find((record) =>
        JSON.stringify(record.reported).includes('"method":"POST"'),
      )?.reported;
    };
    expect(JSON.stringify(post("manifest"))).toContain("postData");
    expect(JSON.stringify(post())).not.toContain("postData");
  });
});

describe("what a probe did not observe", () => {
  const at = (second: number): string =>
    new Date(
      Date.parse("2026-10-20T09:00:00.000Z") + second * 1000,
    ).toISOString();
  const exchange = (
    second: number,
    method: string,
    url: string | null,
    status: number,
  ) => ({
    startedDateTime: at(second),
    request: { method, url },
    response: { status, content: { mimeType: "application/json" } },
  });
  const run = (value: unknown) =>
    compareEnvironment({
      source,
      captureValue: fixture.capture,
      probes: [{ label: "probe-1", value }],
      operation: "environment-compare",
    });

  it("compares an unrecorded body by status only and lists the records it could not compare", () => {
    const report = run(
      analysisViewCaptureEvidence(
        environmentManifestCaptureFixture([
          exchange(0, "GET", "http://app.example/api/books/1", 200),
          exchange(1, "GET", null, 200),
          { startedDateTime: at(2) },
          exchange(3, "GET", "http://app.example/api/books", 0),
          // A 204 carries no body, so its missing body is known to be empty.
          exchange(4, "DELETE", "http://app.example/api/books/2", 204),
        ]),
      ),
    );
    if (!report.ok) throw report.error;
    expect(report.value.probes[0]?.unobserved).toEqual([
      { ordinal: 1, reason: "url-redacted" },
      { ordinal: 2, reason: "request-unavailable" },
      { ordinal: 3, reason: "no-response" },
    ]);
    expect(report.value.summary).toMatchObject({
      steps: 2,
      equal: 2,
      unobserved: 3,
    });
    expect(report.value.summary.normalised.unobserved_bodies).toBe(1);
  });

  it("makes a request whose answer was lost, so later reads see its effect", () => {
    const report = run(
      analysisViewCaptureEvidence(
        environmentManifestCaptureFixture([
          exchange(0, "DELETE", "http://app.example/api/books/2", 0),
          {
            ...exchange(1, "GET", "http://app.example/api/books/2", 404),
            response: {
              status: 404,
              content: {
                mimeType: "application/json",
                text: JSON.stringify(BOOK_NOT_FOUND),
              },
            },
          },
        ]),
      ),
    );
    if (!report.ok) throw report.error;
    expect(report.value.probes[0]?.unobserved).toEqual([
      { ordinal: 0, reason: "no-response" },
    ]);
    expect(report.value.summary).toMatchObject({ steps: 1, equal: 1 });
  });

  it("makes no request to another origin, so it cannot change the environment", () => {
    const answered = (second: number, url: string, body: JsonValue) => ({
      ...exchange(second, "GET", url, 200),
      response: {
        status: 200,
        content: { mimeType: "application/json", text: JSON.stringify(body) },
      },
    });
    const report = run(
      analysisViewCaptureEvidence(
        environmentManifestCaptureFixture([
          // The probe also called another server's API, at a path the application's tools match.
          exchange(0, "DELETE", "http://cdn.example/api/books/2", 204),
          answered(1, "http://app.example/api/books/1", FIRST_BOOK),
          answered(2, "http://app.example/api/books/2", SECOND_BOOK),
        ]),
      ),
    );
    if (!report.ok) throw report.error;
    expect(report.value.probes[0]?.unobserved).toEqual([
      { ordinal: 0, reason: "other-origin" },
    ]);
    expect(report.value.summary).toMatchObject({ steps: 2, equal: 2 });
  });

  it("keeps the recorded order when a record has no start time, as state extraction does", () => {
    const { startedDateTime: _undated, ...read } = {
      ...exchange(1, "GET", "http://app.example/api/books/2", 404),
      response: {
        status: 404,
        content: {
          mimeType: "application/json",
          text: JSON.stringify(BOOK_NOT_FOUND),
        },
      },
    };
    const report = run(
      analysisViewCaptureEvidence(
        environmentManifestCaptureFixture([
          exchange(0, "DELETE", "http://app.example/api/books/2", 204),
          read,
        ]),
      ),
    );
    if (!report.ok) throw report.error;
    expect(report.value.summary).toMatchObject({ steps: 2, equal: 2 });
  });

  it("refuses a browser probe that makes writes without recorded request bodies", () => {
    const report = run(
      scenarioCaptureEvidence(
        scenarioCaptureFixture(undefined, {
          request_body: false,
          response_body: true,
          header_values: true,
        }),
      ),
    );
    expect(report.ok).toBe(false);
    if (report.ok) return;
    expect(JSON.stringify(report.error)).toContain(
      "needs capture.network.request_body selected",
    );
  });

  it("refuses a browser probe captured without response bodies", () => {
    const report = run(scenarioHeaderOnlyCaptureEvidence());
    expect(report.ok).toBe(false);
    if (report.ok) return;
    expect(JSON.stringify(report.error)).toContain(
      "probe-1: a browser probe needs capture.network.response_body selected",
    );
  });
});
