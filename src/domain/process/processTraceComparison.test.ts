import { describe, expect, it } from "vitest";
import { parseProcessCapture } from "./processCaptureParsing.js";
import type { ProcessTraceSpecification } from "./processTraceSpecification.js";
import { processTraceSpecificationSchema as specificationSchema } from "./processTraceSpecification.js";
import { processTraceComparisonResultSchema } from "./processTraceEvaluation.js";
import {
  capture,
  partialSpecification,
  processStarted,
  terminal,
  values,
} from "./processTraceComparison.fixture.js";

import { compareProcessCaptures } from "./processComparison.js";
import { compareProcessTraces } from "./processTraceComparison.js";
describe("generic capture trace comparison", () => {
  it("requires explicit partial ordering and never infers causality from timestamps", () => {
    const specification = partialSpecification();
    const left = capture(values(["terminal", "process"]));
    const right = capture(values(["process", "terminal"]));
    expect(compareProcessTraces(left, right, specification)).toMatchObject({
      verdict: "different",
      diagnostic: { kind: "edge", side: "right" },
    });

    const concurrent: ProcessTraceSpecification = {
      ...specification,
      language: {
        kind: "partial_order",
        happens_before: [],
        not_before: [],
        unordered_groups: [{ events: ["ready", "worker"] }],
        prefix: [],
        suffix: [],
      },
    };
    expect(compareProcessTraces(left, right, concurrent)).toMatchObject({
      verdict: "equivalent",
    });
  });

  it("rejects malformed result contracts", () => {
    const result = compareProcessTraces(
      capture(values(["terminal", "process"])),
      capture(values(["terminal", "process"])),
      partialSpecification(),
    );
    expect(
      processTraceComparisonResultSchema.safeParse({
        ...result,
        right: {
          ...result.right,
          status: "fail",
          matched_variant: "invented",
        },
      }).success,
    ).toBe(false);
  });

  it("supports declared optional events and bounded duplicates", () => {
    const first = { sequence: 0, at_ms: 1, data: "tick" };
    const second = { sequence: 1, at_ms: 2, data: "tick" };
    const one = capture({
      frames: [first],
      process_samples: [],
      event_journal: [{ collection: "frames", index: 0 }],
    });
    const two = capture({
      frames: [first, second],
      process_samples: [],
      event_journal: [
        { collection: "frames", index: 0 },
        { collection: "frames", index: 1 },
      ],
    });
    const specification: ProcessTraceSpecification = {
      events: [
        {
          id: "tick1",
          source: "terminal_raw",
          exact: first,
          cardinality: { kind: "required" },
        },
        {
          id: "tick2",
          source: "terminal_raw",
          exact: second,
          cardinality: { kind: "optional" },
        },
      ],
      language: {
        kind: "finite_traces",
        variants: [
          { id: "one", trace: ["tick1"] },
          { id: "two", trace: ["tick1", "tick2"] },
        ],
      },
    };
    expect(compareProcessTraces(one, two, specification)).toMatchObject({
      verdict: "equivalent",
      left: { matched_variant: "one" },
      right: { matched_variant: "two" },
    });
  });

  it("compares a declared identifier the comparison result can represent", () => {
    // The specification owns the trace identifier vocabulary and the result
    // echoes those identifiers verbatim, so both must accept the same values
    // rather than handing the caller a raw schema error for its own input.
    const eventId = `e${"0".repeat(64)}`;
    const specification: ProcessTraceSpecification = {
      events: [
        {
          id: eventId,
          source: "terminal_raw",
          exact: terminal,
          cardinality: { kind: "required" },
        },
      ],
      language: {
        kind: "finite_traces",
        variants: [{ id: "only", trace: [eventId] }],
      },
    };
    expect(specificationSchema.safeParse(specification).success).toBe(true);
    const left = capture(values(["terminal", "process"]));
    expect(compareProcessTraces(left, left, specification)).toMatchObject({
      verdict: "equivalent",
      left: { matched_variant: "only", raw_trace: [{ event_id: eventId }] },
    });
  });
});

describe("process trace constraints and evidence sufficiency", () => {
  it("enforces exact and range cardinality for a repeated terminal observation", () => {
    const repeated = (count: number) =>
      capture({
        frames: Array.from({ length: count }, (_, sequence) => ({
          sequence,
          at_ms: sequence,
          data: "tick",
        })),
        process_samples: [],
        event_journal: Array.from({ length: count }, (_, index) => ({
          collection: "frames" as const,
          index,
        })),
      });
    const event: Omit<
      ProcessTraceSpecification["events"][number],
      "cardinality"
    > = {
      id: "tick",
      source: "terminal_raw",
      exact: { data: "tick" },
      ignore_fields: ["sequence", "at_ms"],
    };
    const rangeSpecification: ProcessTraceSpecification = {
      events: [{ ...event, cardinality: { kind: "range", min: 2, max: 3 } }],
      language: {
        kind: "partial_order",
        happens_before: [],
        not_before: [],
        unordered_groups: [],
        prefix: [],
        suffix: [],
      },
    };
    expect(
      compareProcessTraces(repeated(2), repeated(3), rangeSpecification),
    ).toMatchObject({ verdict: "equivalent" });
    expect(
      compareProcessTraces(repeated(1), repeated(2), rangeSpecification),
    ).toMatchObject({
      verdict: "different",
      diagnostic: { kind: "cardinality", side: "left" },
    });
    expect(
      compareProcessTraces(repeated(2), repeated(4), rangeSpecification),
    ).toMatchObject({
      verdict: "different",
      diagnostic: { kind: "cardinality", side: "right" },
    });

    const exactSpecification: ProcessTraceSpecification = {
      events: [{ ...event, cardinality: { kind: "exact", count: 2 } }],
      language: {
        kind: "finite_traces",
        variants: [{ id: "two", trace: ["tick", "tick"] }],
      },
    };
    expect(
      compareProcessTraces(repeated(2), repeated(2), exactSpecification),
    ).toMatchObject({ verdict: "equivalent" });
    expect(
      compareProcessTraces(repeated(3), repeated(2), exactSpecification),
    ).toMatchObject({
      verdict: "different",
      diagnostic: { kind: "cardinality", side: "left" },
    });
  });

  it("enforces an explicit not-before relation between terminal and process events", () => {
    const specification: ProcessTraceSpecification = {
      events: [
        {
          id: "ready",
          source: "terminal_raw",
          exact: terminal,
          cardinality: { kind: "required" },
        },
        {
          id: "worker",
          source: "process",
          exact: processStarted,
          cardinality: { kind: "required" },
        },
      ],
      language: {
        kind: "partial_order",
        happens_before: [],
        not_before: [{ event: "ready", anchor: "worker" }],
        unordered_groups: [],
        prefix: [],
        suffix: [],
      },
    };
    const readyFirst = capture(values(["terminal", "process"]));
    const workerFirst = capture(values(["process", "terminal"]));

    expect(
      compareProcessTraces(workerFirst, readyFirst, specification),
    ).toMatchObject({
      verdict: "different",
      diagnostic: {
        kind: "edge",
        side: "right",
        event_ids: ["ready", "worker"],
      },
    });
    expect(
      compareProcessTraces(workerFirst, workerFirst, specification),
    ).toMatchObject({ verdict: "equivalent" });
  });
});

describe("unknown process trace evidence", () => {
  it("never proves equivalence from truncated, unknown, or journal-free evidence", () => {
    const complete = capture(values(["terminal", "process"]));
    const truncated = capture(values(["terminal", "process"]), {
      omittedTerminalFrame: true,
    });
    expect(
      compareProcessTraces(complete, truncated, partialSpecification()).verdict,
    ).toBe("unknown");
    const unknown = capture(values(["terminal", "process"]), {
      residualUnknowns: [{ scope: "process", reason: "sampled" }],
    });
    expect(
      compareProcessTraces(complete, unknown, partialSpecification()).verdict,
    ).toBe("unknown");
    expect(
      compareProcessTraces(complete, unknown, partialSpecification()),
    ).toMatchObject({
      verdict: "unknown",
      right: {
        status: "unknown",
        matched_variant: null,
        satisfied_constraints: [],
        raw_trace: [{ event_id: "ready" }, { event_id: "worker" }],
      },
    });
    const noJournal = parseProcessCapture({ ...complete, event_journal: [] });
    expect(
      compareProcessTraces(complete, noJournal, partialSpecification()),
    ).toMatchObject({
      verdict: "unknown",
      diagnostic: { kind: "journal", side: "right" },
    });

    expect(() =>
      parseProcessCapture({
        ...complete,
        event_journal: complete.event_journal.slice(1),
      }),
    ).toThrow("event_journal");
  });
});

describe("process trace dimension attribution", () => {
  const traced = (
    left: ReturnType<typeof capture>,
    right: ReturnType<typeof capture>,
  ) =>
    compareProcessCaptures(left, right, {
      traceSpecification: partialSpecification(),
    });
  const make = (data: string, command: string) =>
    capture({
      ...values(["terminal", "process"]),
      frames: [{ ...terminal, data }],
      process_samples: [{ ...processStarted, command }],
    });

  it("keeps equal dimensions unchanged when one side fails a predicate", () => {
    expect(
      traced(make("Ready", "worker"), make("Different", "worker")),
    ).toMatchObject({
      trace: { verdict: "different" },
      terminal: "changed",
      process: "unchanged",
    });
    expect(
      traced(make("Ready", "worker"), make("Ready", "other-worker")),
    ).toMatchObject({
      trace: { verdict: "different" },
      terminal: "unchanged",
      process: "changed",
    });
  });

  it("still attributes an ordering difference to both ordered dimensions", () => {
    expect(
      traced(
        capture(values(["terminal", "process"])),
        capture(values(["process", "terminal"])),
      ),
    ).toMatchObject({
      trace: { verdict: "different" },
      terminal: "changed",
      process: "changed",
    });
  });

  it("attributes every independent failed ordering edge", () => {
    const terminals = [
      terminal,
      { ...terminal, sequence: 1, data: "Ready again" },
    ];
    const workers = [processStarted, { ...processStarted, at_ms: 2, pid: 2 }];
    const events = ["ready1", "worker1", "ready2", "worker2"] as const;
    const make = (order: readonly (typeof events)[number][]) =>
      capture({
        frames: terminals,
        process_samples: workers,
        event_journal: order.map((event) => ({
          collection: event.startsWith("ready")
            ? ("frames" as const)
            : ("process_samples" as const),
          index: Number(event.slice(-1)) - 1,
        })),
      });
    const left = make(events);
    const right = make(["worker1", "ready1", "worker2", "ready2"]);
    const specification: ProcessTraceSpecification = {
      events: [
        ...terminals.map((frame, index) => ({
          id: `ready${String(index + 1)}`,
          source: "terminal_raw" as const,
          exact: frame,
          cardinality: { kind: "required" as const },
        })),
        ...workers.map((sample, index) => ({
          id: `worker${String(index + 1)}`,
          source: "process" as const,
          exact: sample,
          cardinality: { kind: "required" as const },
        })),
      ],
      language: {
        kind: "partial_order",
        happens_before: [
          { before: "ready1", after: "worker1" },
          { before: "ready2", after: "worker2" },
        ],
        not_before: [],
        unordered_groups: [
          { events: ["ready1", "ready2"] },
          { events: ["worker1", "worker2"] },
          { events: ["ready1", "worker2"] },
          { events: ["worker1", "ready2"] },
        ],
        prefix: [],
        suffix: [],
      },
    };

    expect(
      compareProcessCaptures(left, right, {
        traceSpecification: specification,
      }),
    ).toMatchObject({
      trace: { verdict: "different" },
      terminal: "changed",
      process: "changed",
    });
  });
});
