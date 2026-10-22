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

const expectDeadlineRecoveryTokens = (text: string | undefined) => {
  expect(text).toContain(`Set ${REGEX_MATCHING_DEADLINE_SETTING}`);
  expect(text).toContain("then restart REA");
  expect(text).toContain("floor 1 ms");
  expect(text).toContain(
    `maximum ${String(MAXIMUM_REGEX_MATCHING_DEADLINE_MS)} ms`,
  );
};

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
  expect(recovery).toContain(REGEX_MATCHING_DEADLINE_SETTING);
  expect(recovery).toContain(
    String(DEFAULT_REGEX_MATCHING_DEADLINE.deadlineMs),
  );
  expect(recovery).toContain(
    `source ${DEFAULT_REGEX_MATCHING_DEADLINE.source}`,
  );
  expectDeadlineRecoveryTokens(recovery);
  const projected = projectAnalysisError(
    regexMatchingDeadlineError("search_procedures"),
  );
  expect(projected).toMatchObject({
    code: "resource_constraint",
    details: {
      resource: "cpu",
      reported_limits: {
        matching_deadline_ms: DEFAULT_REGEX_MATCHING_DEADLINE.deadlineMs,
        matching_deadline_source: DEFAULT_REGEX_MATCHING_DEADLINE.source,
      },
    },
  });
  expect(projected.message).toContain(REGEX_MATCHING_DEADLINE_SETTING);
  expect(projected.remediation.action).toContain(
    REGEX_MATCHING_DEADLINE_SETTING,
  );
  expectDeadlineRecoveryTokens(projected.message);
  expectDeadlineRecoveryTokens(projected.remediation.action);
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
  expect(hopperText).toContain(REGEX_MATCHING_DEADLINE_SETTING);
  expect(hopperText).toContain(
    `${String(parsed.value.regexMatchingDeadline.deadlineMs)} ms (source setting`,
  );
  expect(hopperText).not.toContain("1 ms matching deadline");
  expect(hopperText).not.toContain("no runtime override");

  vi.stubEnv(REGEX_MATCHING_DEADLINE_SETTING, "1");
  try {
    const kuna = new KunaProvider({ REA_REGEX_MATCHING_DEADLINE_MS: "10000" });
    const kunaText = kuna
      .capabilities()
      .find((capability) => capability.operation === "search_strings")
      ?.limitations.join(" ");
    expect(kunaText).toContain(REGEX_MATCHING_DEADLINE_SETTING);
    expect(kunaText).toContain("10000 ms (source setting");
    expect(kunaText).not.toContain("1 ms matching deadline");
  } finally {
    vi.unstubAllEnvs();
  }

  const ambient = new KunaProvider({});
  const ambientText = ambient
    .capabilities()
    .find((capability) => capability.operation === "search_procedures")
    ?.limitations.join(" ");
  expect(ambientText).toContain(REGEX_MATCHING_DEADLINE_SETTING);
  expect(ambientText).toContain(
    `${String(DEFAULT_REGEX_MATCHING_DEADLINE.deadlineMs)} ms (source ${DEFAULT_REGEX_MATCHING_DEADLINE.source}`,
  );
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
    setting: REGEX_MATCHING_DEADLINE_SETTING,
    constraint: regexMatchingDeadlineConstraint,
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
