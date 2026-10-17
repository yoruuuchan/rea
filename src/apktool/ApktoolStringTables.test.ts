import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  MAX_AGGREGATE_STRINGS,
  MAX_STRINGS,
} from "../domain/apktool/apktoolResourceAnalysis.js";
import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import { projectApktoolStringTables } from "./ApktoolStringTables.js";

const xml = (count: number) =>
  `<resources>${Array.from({ length: count }, (_, index) => `<string name="s_${String(index)}">value</string>`).join("")}</resources>`;

const textRead = (text: string) => ({
  text,
  truncated: false,
  sourceBytes: Buffer.byteLength(text, "utf8"),
});

describe("physical Apktool string facts", () => {
  it("reads one physical table for two caller-selected aliases", async () => {
    const paths: string[] = [];
    const outcome = await projectApktoolStringTables(
      {
        async readText(path) {
          paths.push(path);
          return textRead(xml(1));
        },
      },
      "decoded",
      { include_strings: true, locale: "pt-BR", locales: ["pt-rBR"] },
    );
    if (!outcome.ok) throw outcome.error.cause;
    const result = outcome.value;
    expect(paths).toEqual([
      join("decoded", "res", "values-pt-rBR", "strings.xml"),
    ]);
    expect(result.tables.map((table) => table.locale)).toEqual([
      "pt-BR",
      "pt-rBR",
    ]);
    expect(result.tables.map((table) => table.total_count)).toEqual([1, 1]);
  });

  it("counts complete source entries beyond the retained table prefix", async () => {
    const outcome = await projectApktoolStringTables(
      {
        async readText() {
          return textRead(
            xml(MAX_STRINGS + 1).replace(
              "</resources>",
              '<string name="styled"><b>omitted</b></string></resources>',
            ),
          );
        },
      },
      "decoded",
      { include_strings: true },
    );
    if (!outcome.ok) throw outcome.error.cause;
    const result = outcome.value;
    expect(result.tables[0]).toMatchObject({
      total_count: MAX_STRINGS + 1,
      unparsed_count: 1,
      coverage: "partial",
    });
    expect(result.strings).toHaveLength(MAX_STRINGS);
    expect(result.limitations).toContain(
      `strings reports the first ${String(MAX_STRINGS)} of ${String(MAX_STRINGS + 1)} entries`,
    );
  });

  it("does not read unexamined tables after output exhaustion", async () => {
    const paths: string[] = [];
    const outcome = await projectApktoolStringTables(
      {
        async readText(path) {
          paths.push(path);
          if (path.includes("values-fr"))
            throw new Error("Unexamined table was read");
          return textRead(xml(MAX_STRINGS));
        },
      },
      "decoded",
      { include_strings: true, locales: ["de", "es", "it", "fr"] },
    );
    if (!outcome.ok) throw outcome.error.cause;
    const result = outcome.value;
    expect(paths).toHaveLength(4);
    expect(result.tables.at(-1)).toEqual({
      locale: "fr",
      status: "skipped",
      strings: [],
      total_count: null,
      unparsed_count: null,
      coverage: "partial",
    });
    expect(
      result.strings.length +
        result.tables.reduce((count, table) => count + table.strings.length, 0),
    ).toBe(MAX_AGGREGATE_STRINGS);
  });

  it("keeps a known empty alias present after the output budget is spent", async () => {
    const paths: string[] = [];
    const outcome = await projectApktoolStringTables(
      {
        async readText(path) {
          paths.push(path);
          return textRead(
            xml(path.includes("values-pt-rBR") ? 0 : MAX_STRINGS),
          );
        },
      },
      "decoded",
      {
        include_strings: true,
        locale: "pt-BR",
        locales: ["de", "es", "it", "fr", "en", "pt-rBR"],
      },
    );
    if (!outcome.ok) throw outcome.error.cause;
    const result = outcome.value;
    expect(paths.filter((path) => path.includes("values-pt-rBR"))).toHaveLength(
      1,
    );
    expect(result.tables.at(-1)).toEqual({
      locale: "pt-rBR",
      status: "present",
      strings: [],
      total_count: 0,
      unparsed_count: 0,
      coverage: "complete",
    });
    expect(result.coverage).toBe("complete");
  });
});

describe("Apktool string projection admission", () => {
  it("retains completed tables when cancellation arrives before the next selection", async () => {
    const controller = new AbortController();
    const reason = { selected: "caller" };
    const paths: string[] = [];
    const result = await projectApktoolStringTables(
      {
        async readText(path) {
          paths.push(path);
          controller.abort(reason);
          return textRead(xml(1));
        },
      },
      "decoded",
      { include_strings: true, locales: ["de", "fr"] },
      controller.signal,
    );
    if (result.ok) throw new Error("Expected cancellation");
    expect(result.error.cause).toBeInstanceOf(AnalysisCancelledError);
    expect(result.error.cause).toHaveProperty("cause", reason);
    expect(paths).toHaveLength(1);
    expect(result.error.partial).toMatchObject({
      coverage: "partial",
      tables: [{ locale: null, total_count: 1 }],
    });
    expect(result.error.partial.limitations).toContain(
      'String projection stopped at locale "de"; this selection and 1 remaining selections were not projected',
    );
  });

  it("honors omitted strings without reading any selected table", async () => {
    const outcome = await projectApktoolStringTables(
      {
        async readText() {
          throw new Error("Unexpected read");
        },
      },
      "decoded",
      { include_strings: false, locale: "de", locales: ["fr"] },
    );
    expect(outcome).toEqual({
      ok: true,
      value: { strings: [], tables: [], limitations: [], coverage: "complete" },
    });
  });

  it("preserves the exact physical read failure", async () => {
    const cause = new Error("Physical read and close failed");
    const result = await projectApktoolStringTables(
      {
        async readText() {
          throw cause;
        },
      },
      "decoded",
      { include_strings: true },
    );
    if (result.ok) throw new Error("Expected read failure");
    expect(result.error.cause).toBe(cause);
    expect(result.error.partial.coverage).toBe("partial");
  });

  it("preserves opaque cancellation before any table read", async () => {
    const reason = { selected: "caller" };
    const pending = projectApktoolStringTables(
      {
        async readText() {
          throw new Error("Unexpected read");
        },
      },
      "decoded",
      { include_strings: true },
      AbortSignal.abort(reason),
    );
    const result = await pending;
    if (result.ok) throw new Error("Expected cancellation");
    expect(result.error.cause).toBeInstanceOf(AnalysisCancelledError);
    expect(result.error.cause).toHaveProperty("cause", reason);
  });
});
