import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { expect, it as test } from "vitest";

import { session } from "./kunaSessionFixture.js";

const it = test.skipIf(process.platform === "win32");

it.each(["cancel", "deadline"])(
  "keeps regex %s bounded and the same session usable",
  async (mode) => {
    const { kuna, target, cacheRoot, profile } = await session(
      "rea-kuna-regex-",
      {
        functions: [
          { name: `${"a".repeat(40)}!`, addr: "0x1000" },
          { name: "Δelta", addr: "0x1040" },
        ],
      },
    );
    // A parent watchdog bounds this regression even if matching freezes the
    // child's event loop. All Kuna commands finish before adversarial matching.
    const script = `
import assert from "node:assert/strict";
import { KunaProvider } from ${JSON.stringify(pathToFileURL(resolve("dist/kuna/KunaProvider.js")).href)};
const provider = new KunaProvider(${JSON.stringify({ REA_KUNA_COMMAND: kuna, REA_KUNA_CACHE_DIR: cacheRoot })});
const client = provider.createClient(${JSON.stringify(target)}, ${JSON.stringify(profile)});
try {
  assert.equal((await client.execute("procedure_assembly", {procedure:"0x1000"})).ok, true);
  const options = ${mode === "cancel" ? "{signal:AbortSignal.timeout(100)}" : "{}"};
  const matched = await client.execute("search_procedures", {pattern:"^(a+)+$",mode:"regex"}, options);
  assert.equal(matched.ok, false);
  assert.equal(matched.error._tag, ${JSON.stringify(mode === "cancel" ? "AnalysisCancelledError" : "AnalysisResourceConstraintError")});
  if (${JSON.stringify(mode)} === "deadline") assert.equal(matched.error.reportedLimits.matching_deadline_ms, 5000);
  assert.equal((await client.execute("health", {})).ok, true);
  const unicode = await client.execute("search_procedures", {pattern:"^δ",mode:"regex"});
  assert.equal(unicode.ok, true);
  assert.deepEqual(unicode.value.result, [{address:"0x1040",value:"Δelta"}]);
  const invalid = await client.execute("search_procedures", {pattern:"[",mode:"regex"});
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error._tag, "AnalysisInputError");
  const literal = await client.execute("search_procedures", {pattern:"^(a+)+$"});
  assert.equal(literal.ok, true);
  assert.deepEqual(literal.value.result, []);
} finally {
  assert.equal((await client.close()).ok, true);
}
console.log("bounded and healthy");
`;
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", script],
      {
        encoding: "utf8",
        timeout: 25_000,
        killSignal: "SIGKILL",
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("bounded and healthy");
  },
);
