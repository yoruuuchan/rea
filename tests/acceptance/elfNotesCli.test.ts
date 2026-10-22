import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../src/contracts/toolContracts.js";
import { elfNoteFixture } from "../../src/native/elf/ElfNotes.fixture.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";

cliTest("reports a GNU build-id through the public CLI", async ({ cli }) => {
  const root = await createTestTempDirectory("rea-elf-notes-cli-");
  const path = join(root, "program");
  await writeFile(path, elfNoteFixture({ ownership: "program" }));
  const result = await cli.run({
    arguments: ["inspect-elf-notes", path, "--json"],
  });
  expect(result.exitCode, result.stderr).toBe(0);
  const evidence = toolContract("inspect_elf_notes").outputSchema.parse(
    result.json,
  );
  expect(
    evidence.normalized_result.entries.find(
      (entry) => entry.type_name === "gnu_build_id",
    )?.gnu?.build_id_hex,
  ).toBe("0123456789abcdef0123456789abcdef01234567");
});

cliTest(
  "resolves a relative ELF path against the working directory",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-elf-notes-cli-rel-");
    await writeFile(
      join(root, "unsigned"),
      elfNoteFixture({ ownership: "none" }),
    );
    const result = await cli.run({
      arguments: ["inspect-elf-notes", "unsigned", "--json"],
      cwd: root,
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const evidence = toolContract("inspect_elf_notes").outputSchema.parse(
      result.json,
    );
    expect(evidence.normalized_result.tables).toEqual([]);
    expect(evidence.subject?.local_path).toBe(join(root, "unsigned"));
  },
);

cliTest("reports a truncated ELF as invalid input", async ({ cli }) => {
  const root = await createTestTempDirectory("rea-elf-notes-cli-bad-");
  const path = join(root, "broken");
  await writeFile(path, Buffer.from("\x7fELF"));
  const result = await cli.run({
    arguments: ["inspect-elf-notes", path, "--json"],
  });
  expect(result.exitCode).toBe(1);
  expect(result.json).toMatchObject({
    code: "invalid_request",
    details: { operation: "inspect_elf_notes" },
  });
});
