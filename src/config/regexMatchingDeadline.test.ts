import { expect, it, vi } from "vitest";

import { HopperProvider } from "../hopper/HopperProvider.js";
import { KunaProvider } from "../kuna/KunaProvider.js";
import { silentLogger } from "../logger.js";
import { ConfigurationError } from "../domain/configurationErrors.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { regexMatchingDeadlineError } from "../process/RegexMatcher.js";
import { parseEnvironment } from "./environment.js";
import { parseConfig } from "./parseConfig.js";
import {
  DEFAULT_REGEX_MATCHING_DEADLINE,
  MAXIMUM_REGEX_MATCHING_DEADLINE_MS,
  parseRegexMatchingDeadline,
  REGEX_MATCHING_DEADLINE_SETTING,
  regexMatchingDeadlineConstraint,
  regexMatchingDeadlineRecovery,
} from "./regexMatchingDeadline.js";

const configured = (deadlineMs: number) =>
  ({ deadlineMs, source: "setting" }) as const;

it("keeps the 5000 ms deadline when the setting is unset", () => {
  expect(parseRegexMatchingDeadline(undefined)).toEqual({
    ok: true,
    value: DEFAULT_REGEX_MATCHING_DEADLINE,
  });
  const parsed = parseConfig({});
  if (!parsed.ok) throw new Error("unset deadline was rejected");
  expect(parsed.value.regexMatchingDeadline).toEqual(
    DEFAULT_REGEX_MATCHING_DEADLINE,
  );
  const recovery = regexMatchingDeadlineRecovery(
    DEFAULT_REGEX_MATCHING_DEADLINE,
  );
  expect(recovery).toContain(
    "The effective REA_REGEX_MATCHING_DEADLINE_MS value is 5000 ms (source default; default 5000 ms, floor 1 ms, maximum 2147483647 ms).",
  );
  const projected = projectAnalysisError(
    regexMatchingDeadlineError("search_procedures"),
  );
  expect(projected.code).toBe("resource_constraint");
  expect(projected.message).toContain(recovery);
  expect(projected.remediation.action).toContain(recovery);
  expect(projected.message).not.toContain("no runtime override");
});

it("uses a valid REA_REGEX_MATCHING_DEADLINE_MS override", () => {
  expect(parseRegexMatchingDeadline("10000")).toEqual({
    ok: true,
    value: configured(10_000),
  });
  expect(
    parseRegexMatchingDeadline(String(MAXIMUM_REGEX_MATCHING_DEADLINE_MS)),
  ).toEqual({
    ok: true,
    value: configured(MAXIMUM_REGEX_MATCHING_DEADLINE_MS),
  });
  const parsed = parseConfig({ REA_REGEX_MATCHING_DEADLINE_MS: "10000" });
  if (!parsed.ok) throw new Error("valid deadline was rejected");
  expect(parsed.value.regexMatchingDeadline).toEqual(configured(10_000));
  const hopper = new HopperProvider(parsed.value, silentLogger, {
    REA_REGEX_MATCHING_DEADLINE_MS: "1",
  });
  const hopperText = hopper
    .capabilities()
    .find((capability) => capability.operation === "search_procedures")
    ?.limitations.join(" ");
  expect(hopperText).toContain("10000 ms matching deadline (source setting)");
  expect(hopperText).toContain("REA_REGEX_MATCHING_DEADLINE_MS");
  expect(hopperText).toContain("default 5000 ms");
  expect(hopperText).toContain("maximum 2147483647 ms");
  expect(hopperText).not.toContain("no runtime override");

  vi.stubEnv(REGEX_MATCHING_DEADLINE_SETTING, "1");
  try {
    const kuna = new KunaProvider({ REA_REGEX_MATCHING_DEADLINE_MS: "10000" });
    const kunaText = kuna
      .capabilities()
      .find((capability) => capability.operation === "search_strings")
      ?.limitations.join(" ");
    expect(kunaText).toContain("10000 ms matching deadline (source setting)");
    expect(kunaText).not.toContain("1 ms matching deadline");
  } finally {
    vi.unstubAllEnvs();
  }

  const ambient = new KunaProvider({});
  expect(
    ambient
      .capabilities()
      .find((capability) => capability.operation === "search_procedures")
      ?.limitations.join(" "),
  ).toContain("5000 ms matching deadline (source default)");
});

it.each([
  "",
  "0",
  "-1",
  "05000",
  "10_000",
  "1e4",
  " 5000",
  "5000 ",
  "1.5",
  String(MAXIMUM_REGEX_MATCHING_DEADLINE_MS + 1),
  "9".repeat(40),
])("rejects invalid %j as a configuration error", (value) => {
  const parsed = parseRegexMatchingDeadline(value);
  if (parsed.ok) throw new Error(`Accepted ${JSON.stringify(value)}`);
  expect(parsed.error).toBeInstanceOf(ConfigurationError);
  expect(parsed.error.settings).toEqual([
    {
      setting: "REA_REGEX_MATCHING_DEADLINE_MS",
      constraint: regexMatchingDeadlineConstraint,
    },
  ]);
  expect(parsed.error.message).toBe(regexMatchingDeadlineConstraint);
  const startup = parseEnvironment({ REA_REGEX_MATCHING_DEADLINE_MS: value });
  if (startup.ok) throw new Error(`Startup accepted ${JSON.stringify(value)}`);
  expect(startup.error.settings).toContainEqual({
    setting: "REA_REGEX_MATCHING_DEADLINE_MS",
    constraint: expect.stringContaining("from 1 to 2147483647 ms"),
  });
  const config = parseConfig({ REA_REGEX_MATCHING_DEADLINE_MS: value });
  if (config.ok)
    throw new Error(`parseConfig accepted ${JSON.stringify(value)}`);
  expect(projectAnalysisError(config.error)).toMatchObject({
    code: "configuration_invalid",
    message: expect.stringContaining("REA_REGEX_MATCHING_DEADLINE_MS"),
  });
  expect(
    () => new KunaProvider({ REA_REGEX_MATCHING_DEADLINE_MS: value }),
  ).toThrow(ConfigurationError);
});
