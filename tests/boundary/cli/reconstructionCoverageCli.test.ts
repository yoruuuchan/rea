import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";

import { completeReconstructionCoverageData } from "../../../src/domain/reconstructionCoverage.fixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest, type TestCli } from "../../support/cli/cliFixture.js";

const currentCoverage = () => {
  const coverage = completeReconstructionCoverageData();
  return {
    ...coverage,
    verifier_results: coverage.verifier_results.map((result) => ({
      ...result,
      observed_at: new Date().toISOString(),
    })),
  };
};

const evaluate = async (cli: TestCli, coverage: unknown) => {
  const root = await createTestTempDirectory("rea-coverage-cli-");
  const input = join(root, "request.json");
  await writeFile(
    input,
    JSON.stringify({ coverage, boundary_id: "replacement.cli" }),
  );
  return cli.run({
    arguments: ["evaluate-reconstruction-coverage", input, "--json"],
    cwd: root,
  });
};

cliTest(
  "evaluates complete inline coverage through the compiled CLI",
  async ({ cli }) => {
    const result = await evaluate(cli, currentCoverage());
    expect(result.exitCode).toBe(0);
    expect(result.json).toMatchObject({
      boundary_id: "replacement.cli",
      status: "ready",
      summary: { reasons: 0 },
    });
  },
);

cliTest(
  "reports a tampered coverage record as an integrity failure",
  async ({ cli }) => {
    const coverage = currentCoverage();
    const result = await evaluate(cli, {
      ...coverage,
      evidence_bundle: {
        ...coverage.evidence_bundle,
        records: coverage.evidence_bundle.records.map((record, index) =>
          index === 0
            ? { ...record, normalized_result: { tampered: true } }
            : record,
        ),
      },
    });
    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject({
      code: "evidence_integrity_mismatch",
      category: "integrity_mismatch",
    });
  },
);
