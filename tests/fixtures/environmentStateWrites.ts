import {
  projectAnalysisView,
  type AnalysisViewResult,
} from "../../src/domain/analysisView/analysisView.js";
import type { TemplateRule } from "../../src/domain/analysisView/environmentManifestRules.js";
import type { Evidence } from "../../src/domain/evidence.js";
import type { JsonValue } from "../../src/domain/jsonValue.js";
import {
  analysisViewCaptureEvidence,
  environmentManifestCaptureFixture,
  type TimedCaptureRow,
} from "./analysisView.js";

/** When the first synthetic exchange starts; exchange `i` starts `i` seconds later, as in `timedCaptureEvidence`. */
const CAPTURE_START_MS = Date.parse("2026-10-17T18:00:00.000Z");

/** The instant `seconds` after the first exchange, spelled as the books application spells clock values. */
export const bookClock = (seconds: number): string =>
  new Date(CAPTURE_START_MS + seconds * 1000)
    .toISOString()
    .replace(".000Z", "Z");

/** Lower case with every run of other characters joined by one `-`, as the books application slugs names. */
const slugOf = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "");

/** A book as the application shows it. */
export type Book = { [field: string]: JsonValue };

/** A book whose slug follows its name. */
export const book = (
  id: number,
  name: string,
  created: string,
  updated = created,
): Book => ({
  id,
  name,
  slug: slugOf(name),
  created_at: created,
  updated_at: updated,
});

/** A book renamed by an update recorded at exchange `seconds`: its slug and update clock follow. */
export const renamedBook = (
  entity: Book,
  name: string,
  seconds: number,
): Book => ({
  ...entity,
  name,
  slug: slugOf(name),
  updated_at: bookClock(seconds),
});

export const FIRST_BOOK = book(1, "First Book", "2026-10-01T09:00:00Z");
export const SECOND_BOOK = book(2, "Second Book", "2026-10-01T10:00:00Z");
/** The book the recorded create at exchange 3 made. */
export const THIRD_BOOK = book(3, "Third Book", bookClock(3));
/** The first book after the recorded update at exchange 5. */
export const RENAMED_BOOK = renamedBook(FIRST_BOOK, "Renamed Book", 5);

/** What the item read answered for a book the application does not hold. */
export const BOOK_NOT_FOUND = { detail: "Not found." };
/** What the delete answered for a book the application does not hold. */
export const DELETE_NOT_FOUND = { detail: "No Book matches the given query." };

/** Reads before any write: the whole list, then each book; the initial state comes from these. */
export const BOOK_INIT_ROWS: readonly TimedCaptureRow[] = [
  ["GET", "/api/books", [FIRST_BOOK, SECOND_BOOK]],
  ["GET", "/api/books/1", FIRST_BOOK],
  ["GET", "/api/books/2", SECOND_BOOK],
];

/**
 * A create, an update and a delete, each confirmed by later reads; a delete of a book the
 * application did not hold; and a write to no state type.
 */
export const BOOK_ROWS: readonly TimedCaptureRow[] = [
  ...BOOK_INIT_ROWS,
  ["POST", "/api/books", THIRD_BOOK, 201, { name: "Third Book" }],
  ["GET", "/api/books/3", THIRD_BOOK],
  ["PATCH", "/api/books/1", RENAMED_BOOK, 200, { name: "Renamed Book" }],
  ["GET", "/api/books/1", RENAMED_BOOK],
  ["DELETE", "/api/books/3", "", 204],
  ["GET", "/api/books/3", BOOK_NOT_FOUND, 404],
  ["GET", "/api/books", [RENAMED_BOOK, SECOND_BOOK]],
  ["DELETE", "/api/books/9", DELETE_NOT_FOUND, 404],
  ["POST", "/api/exports", { queued: true }, 202, { format: "csv" }],
];

/** The end of the last exchange of BOOK_ROWS, to the next whole second: where the served clock starts. */
export const BOOK_WRITE_CLOCK = "2026-10-17T18:00:12.000Z";

/**
 * Capture Evidence like `timedCaptureEvidence`, but each request body is recorded under the
 * given media type (a string as written, anything else as JSON), and the exchanges may carry
 * no start times.
 */
export const rawCaptureEvidence = (
  rows: readonly TimedCaptureRow[],
  request: { readonly mimeType: string; readonly timed: boolean },
): Evidence =>
  analysisViewCaptureEvidence(
    environmentManifestCaptureFixture(
      rows.map(([method, path, body = null, status = 200, sent], index) => ({
        ...(request.timed
          ? {
              startedDateTime: new Date(
                CAPTURE_START_MS + index * 1000,
              ).toISOString(),
              time: 5,
            }
          : {}),
        request: {
          method,
          url: `http://app.example${path}`,
          ...(sent === undefined
            ? {}
            : {
                postData: {
                  mimeType: request.mimeType,
                  text: typeof sent === "string" ? sent : JSON.stringify(sent),
                },
              }),
        },
        response: {
          status,
          content: {
            mimeType: "application/json",
            text: typeof body === "string" ? body : JSON.stringify(body),
          },
        },
      })),
    ),
  );

type EnvironmentStateView = Extract<
  AnalysisViewResult,
  { kind: "environment-state" }
>;

/** The environment-state view a capture projects with no opt-in template rules. */
export const environmentStateViewOf = (
  capture: Evidence,
  templateRules: readonly TemplateRule[] = [],
): EnvironmentStateView => {
  const result = projectAnalysisView(
    {
      evidenceId: capture.evidence_id,
      operation: capture.operation,
      normalizedResult: capture.normalized_result,
      subject: capture.subject,
      limitations: [],
      parameters: capture.parameters,
    },
    { kind: "environment-state", template_rules: [...templateRules] },
  );
  if (!result.ok || result.value.kind !== "environment-state")
    throw new Error("Expected an environment state");
  return result.value;
};
