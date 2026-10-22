import { expect, it, vi } from "vitest";

import { HopperProvider } from "../hopper/HopperProvider.js";
import { KunaProvider } from "../kuna/KunaProvider.js";
import { silentLogger } from "../logger.js";
import { ConfigurationError } from "../domain/configurationErrors.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { regexWorkerHeapError } from "../process/RegexMatcher.js";
import { parseEnvironment } from "./environment.js";
import { parseConfig } from "./parseConfig.js";
import {
  DEFAULT_REGEX_WORKER_HEAP_REQUEST,
  MAXIMUM_REGEX_WORKER_HEAP_REQUEST_MIB,
  MINIMUM_REGEX_WORKER_HEAP_REQUEST_MIB,
  parseRegexWorkerHeapRequest,
  REGEX_WORKER_HEAP_REQUEST_SETTING,
  regexWorkerHeapRequestConstraint,
  regexWorkerHeapRequestRecovery,
} from "./regexWorkerHeapRequest.js";

const configured = (heapMiB: number) =>
  ({ heapMiB, source: "setting" }) as const;

const expectHeapRecoveryTokens = (text: string | undefined) => {
  expect(text).toContain(`Set ${REGEX_WORKER_HEAP_REQUEST_SETTING}`);
  expect(text).toContain("then restart REA");
  expect(text).toContain(
    `floor ${String(MINIMUM_REGEX_WORKER_HEAP_REQUEST_MIB)} MiB`,
  );
  expect(text).toContain(
    `maximum ${String(MAXIMUM_REGEX_WORKER_HEAP_REQUEST_MIB)} MiB`,
  );
};

it("keeps the 128 MiB request when the setting is unset", () => {
  expect(parseRegexWorkerHeapRequest(undefined)).toEqual({
    ok: true,
    value: DEFAULT_REGEX_WORKER_HEAP_REQUEST,
  });
  const parsed = parseConfig({});
  if (!parsed.ok) throw new Error("unset heap request was rejected");
  expect(parsed.value.regexWorkerHeapRequest).toEqual(
    DEFAULT_REGEX_WORKER_HEAP_REQUEST,
  );
  const recovery = regexWorkerHeapRequestRecovery(
    DEFAULT_REGEX_WORKER_HEAP_REQUEST,
  );
  expect(recovery).toContain(REGEX_WORKER_HEAP_REQUEST_SETTING);
  expect(recovery).toContain(String(DEFAULT_REGEX_WORKER_HEAP_REQUEST.heapMiB));
  expect(recovery).toContain(
    `source ${DEFAULT_REGEX_WORKER_HEAP_REQUEST.source}`,
  );
  expectHeapRecoveryTokens(recovery);
  const projected = projectAnalysisError(
    regexWorkerHeapError("search_procedures", new Error("heap")),
  );
  expect(projected).toMatchObject({
    code: "resource_constraint",
    details: {
      resource: "memory",
      reported_limits: {
        requested_worker_heap_mib: DEFAULT_REGEX_WORKER_HEAP_REQUEST.heapMiB,
        requested_worker_heap_source: DEFAULT_REGEX_WORKER_HEAP_REQUEST.source,
      },
    },
  });
  expect(projected.remediation.action).toContain(
    REGEX_WORKER_HEAP_REQUEST_SETTING,
  );
  expectHeapRecoveryTokens(projected.remediation.action);
  expect(projected.remediation.action).not.toContain("no runtime override");
});

it("uses a valid REA_REGEX_WORKER_HEAP_REQUEST_MIB override", () => {
  expect(MINIMUM_REGEX_WORKER_HEAP_REQUEST_MIB).toBe(7);
  expect(
    parseRegexWorkerHeapRequest(String(MINIMUM_REGEX_WORKER_HEAP_REQUEST_MIB)),
  ).toEqual({
    ok: true,
    value: configured(MINIMUM_REGEX_WORKER_HEAP_REQUEST_MIB),
  });
  expect(parseRegexWorkerHeapRequest("256")).toEqual({
    ok: true,
    value: configured(256),
  });
  expect(
    parseRegexWorkerHeapRequest(String(MAXIMUM_REGEX_WORKER_HEAP_REQUEST_MIB)),
  ).toEqual({
    ok: true,
    value: configured(MAXIMUM_REGEX_WORKER_HEAP_REQUEST_MIB),
  });
  const parsed = parseConfig({ REA_REGEX_WORKER_HEAP_REQUEST_MIB: "256" });
  if (!parsed.ok) throw new Error("valid heap request was rejected");
  expect(parsed.value.regexWorkerHeapRequest).toEqual(configured(256));
  const hopper = new HopperProvider(parsed.value, silentLogger, {
    REA_REGEX_WORKER_HEAP_REQUEST_MIB: "8",
  });
  const hopperText = hopper
    .capabilities()
    .find((capability) => capability.operation === "search_procedures")
    ?.limitations.join(" ");
  expect(hopperText).toContain(REGEX_WORKER_HEAP_REQUEST_SETTING);
  expect(hopperText).toContain("256 MiB (source setting");
  expect(hopperText).not.toMatch(/\b8 MiB\b/u);
  expect(hopperText).not.toContain("no runtime override");

  vi.stubEnv(REGEX_WORKER_HEAP_REQUEST_SETTING, "8");
  try {
    const kuna = new KunaProvider({
      REA_REGEX_WORKER_HEAP_REQUEST_MIB: "256",
    });
    const kunaText = kuna
      .capabilities()
      .find((capability) => capability.operation === "search_strings")
      ?.limitations.join(" ");
    expect(kunaText).toContain(REGEX_WORKER_HEAP_REQUEST_SETTING);
    expect(kunaText).toContain("256 MiB (source setting");
    expect(kunaText).not.toMatch(/\b8 MiB\b/u);
  } finally {
    vi.unstubAllEnvs();
  }

  const ambient = new KunaProvider({});
  expect(
    ambient
      .capabilities()
      .find((capability) => capability.operation === "search_procedures")
      ?.limitations.join(" "),
  ).toContain(REGEX_WORKER_HEAP_REQUEST_SETTING);
  expect(
    ambient
      .capabilities()
      .find((capability) => capability.operation === "search_procedures")
      ?.limitations.join(" "),
  ).toContain(
    `${String(DEFAULT_REGEX_WORKER_HEAP_REQUEST.heapMiB)} MiB (source ${DEFAULT_REGEX_WORKER_HEAP_REQUEST.source}`,
  );
});

it.each([
  "",
  "0",
  "6",
  "-1",
  "0128",
  "10_000",
  "1e4",
  " 128",
  "128 ",
  "1.5",
  String(MAXIMUM_REGEX_WORKER_HEAP_REQUEST_MIB + 1),
  "9".repeat(40),
])("rejects invalid %j as a configuration error", (value) => {
  const parsed = parseRegexWorkerHeapRequest(value);
  if (parsed.ok) throw new Error(`Accepted ${JSON.stringify(value)}`);
  expect(parsed.error).toBeInstanceOf(ConfigurationError);
  expect(parsed.error.settings).toEqual([
    {
      setting: "REA_REGEX_WORKER_HEAP_REQUEST_MIB",
      constraint: regexWorkerHeapRequestConstraint,
    },
  ]);
  expect(parsed.error.message).toBe(regexWorkerHeapRequestConstraint);
  const startup = parseEnvironment({
    REA_REGEX_WORKER_HEAP_REQUEST_MIB: value,
  });
  if (startup.ok) throw new Error(`Startup accepted ${JSON.stringify(value)}`);
  expect(startup.error.settings).toContainEqual({
    setting: REGEX_WORKER_HEAP_REQUEST_SETTING,
    constraint: regexWorkerHeapRequestConstraint,
  });
  const config = parseConfig({ REA_REGEX_WORKER_HEAP_REQUEST_MIB: value });
  if (config.ok)
    throw new Error(`parseConfig accepted ${JSON.stringify(value)}`);
  expect(projectAnalysisError(config.error)).toMatchObject({
    code: "configuration_invalid",
    message: expect.stringContaining("REA_REGEX_WORKER_HEAP_REQUEST_MIB"),
  });
  expect(
    () => new KunaProvider({ REA_REGEX_WORKER_HEAP_REQUEST_MIB: value }),
  ).toThrow(ConfigurationError);
});
