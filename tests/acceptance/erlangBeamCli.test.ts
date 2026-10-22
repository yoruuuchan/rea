import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../src/contracts/toolContracts.js";
import { erlangBeamFixture } from "../../src/erlang/Beam.fixture.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";

cliTest("reports BEAM exports through the public CLI", async ({ cli }) => {
  const root = await createTestTempDirectory("rea-beam-cli-");
  const path = join(root, "app.beam");
  await writeFile(path, erlangBeamFixture("cli_mod"));
  const result = await cli.run({
    arguments: ["inspect-erlang-beam", path, "--json"],
  });
  expect(result.exitCode, result.stderr).toBe(0);
  const evidence = toolContract("inspect_erlang_beam").outputSchema.parse(
    result.json,
  );
  expect(evidence.normalized_result.module).toBe("cli_mod");
  expect(
    evidence.normalized_result.exports?.some(
      (entry) => entry.function === "start" && entry.arity === 0,
    ),
  ).toBe(true);
});

cliTest(
  "resolves a relative BEAM path against the working directory",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-beam-cli-rel-");
    await writeFile(join(root, "app.beam"), erlangBeamFixture());
    const result = await cli.run({
      arguments: ["inspect-erlang-beam", "app.beam", "--json"],
      cwd: root,
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const evidence = toolContract("inspect_erlang_beam").outputSchema.parse(
      result.json,
    );
    expect(evidence.subject?.local_path).toBe(join(root, "app.beam"));
  },
);

cliTest("rejects an empty BEAM path before reading", async ({ cli }) => {
  const root = await createTestTempDirectory("rea-beam-cli-path-");
  const result = await cli.run({
    arguments: ["inspect-erlang-beam", "", "--json"],
    cwd: root,
  });
  expect(result.exitCode, result.stderr).not.toBe(0);
  expect(result.stdout).not.toContain("sha256");
});

cliTest("reports a truncated BEAM as invalid input", async ({ cli }) => {
  const root = await createTestTempDirectory("rea-beam-cli-bad-");
  const path = join(root, "broken.beam");
  await writeFile(path, Buffer.from("FOR1"));
  const result = await cli.run({
    arguments: ["inspect-erlang-beam", path, "--json"],
  });
  expect(result.exitCode).toBe(1);
  expect(result.json).toMatchObject({
    code: "invalid_request",
    details: { operation: "inspect_erlang_beam" },
  });
});
