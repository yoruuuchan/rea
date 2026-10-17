import { expect, it } from "vitest";
import {
  androidLocaleDirectorySuffix,
  androidLocaleQualifierSchema,
  classifyAndroidStringsTable,
} from "./apktoolResourceAnalysis.js";

it.each([
  "de",
  "pt-rBR",
  "en-r419",
  "b+sr+Latn",
  "b+zh+Hans+CN",
  "b+sr+Latn+RS+REVISED",
  "b+fil+Latn+419+ABCDEFGH",
])("recognizes the exact selectable strings table values-%s", (suffix) => {
  expect(classifyAndroidStringsTable(suffix)).toEqual({
    kind: "locale",
    locale: suffix,
  });
});

it.each([
  "en-rUS-v21",
  "b+zh+Hans+CN-night",
  "pt-rBR-sw600dp",
  "mcc310-fr",
  "mcc310-mnc004-en-rUS-v21",
  "car",
  "night",
  "v21",
  "pt-BR",
  "en-419",
  "unknown_CONFIGURATION",
  "",
])(
  "preserves a non-selectable configuration suffix without inferring its locale: %s",
  (suffix) => {
    expect(classifyAndroidStringsTable(suffix)).toEqual({
      kind: "other",
      suffix,
    });
  },
);

it.each([
  ["pt-BR", "pt-rBR"],
  ["en-419", "en-r419"],
  ["pt-rBR", "pt-rBR"],
  ["b+zh+Hans+CN", "b+zh+Hans+CN"],
])(
  "normalizes the request alias %s at the selection owner",
  (locale, suffix) => {
    expect(androidLocaleDirectorySuffix(locale)).toBe(suffix);
  },
);

it.each([
  "b+fil+Latn+419+ABCDEFGH+US",
  "b+sr+Latn+RS+REVISED-v21",
  "../values-fr",
  "car",
  "night",
])(
  "refuses suffixes outside the bounded locale selection contract: %s",
  (suffix) => {
    expect(androidLocaleQualifierSchema.safeParse(suffix).success).toBe(false);
    expect(classifyAndroidStringsTable(suffix)).toEqual({
      kind: "other",
      suffix,
    });
  },
);
