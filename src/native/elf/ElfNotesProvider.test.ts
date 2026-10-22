import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ElfNotesService } from "../../application/binaryDiagnostics/ElfNotesService.js";
import {
  AnalysisInputError,
  AnalysisResourceConstraintError,
} from "../../domain/analysisErrorCore.js";
import { projectAnalysisError } from "../../domain/analysisErrorProjection.js";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import {
  elfNote,
  elfNoteFixture,
  elfNoteTablePastEnd,
} from "./ElfNotes.fixture.js";
import { ElfNotesProvider } from "./ElfNotesProvider.js";

const inspect = async (
  path: string,
  input: { readonly max_file_bytes?: number } = {},
) => {
  const service = new ElfNotesService(new ElfNotesProvider());
  try {
    return await service.inspect({ path, ...input });
  } finally {
    await service.close();
  }
};

describe("ELF note provider failures", () => {
  it("reports a note table past the end of the file as invalid input", async () => {
    const root = await createTestTempDirectory("rea-elf-note-past-end-");
    const path = join(root, "program");
    await writeFile(path, elfNoteTablePastEnd());
    const result = await inspect(path);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected invalid input");
    expect(result.error).toBeInstanceOf(AnalysisInputError);
    expect(result.error).toMatchObject({
      _tag: "AnalysisInputError",
      issues: [
        {
          path: ["path"],
          reason: "invalid_format",
          message: expect.stringContaining("leaves the artifact"),
        },
      ],
    });
  });

  it("names the note text budget instead of host memory", async () => {
    const root = await createTestTempDirectory("rea-elf-note-text-budget-");
    const path = join(root, "program");
    await writeFile(
      path,
      elfNoteFixture({
        ownership: "program",
        notes: elfNote("GNU", 3, Buffer.alloc(4096, 1)),
      }),
    );
    const result = await inspect(path);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected a text budget refusal");
    const error = result.error as AnalysisResourceConstraintError;
    expect(error.resource).toBe("memory");
    expect(error.message).toMatch(/byte budget/u);
    const projected = projectAnalysisError(error);
    expect(projected.retryable).toBe(false);
    expect(projected.remediation.action).toContain(
      "ELF note text, hash, and scan budget",
    );
    expect(projected.remediation.action).toMatch(/admitted image length/u);
    expect(projected.remediation.action).toMatch(/do not raise it/u);
    expect(projected.remediation.action).not.toMatch(/available host memory/u);
  });

  it("keeps a caller file-size budget distinct from host memory", async () => {
    const root = await createTestTempDirectory("rea-elf-note-file-budget-");
    const path = join(root, "program");
    await writeFile(path, elfNoteFixture({ ownership: "program" }));
    const result = await inspect(path, { max_file_bytes: 64 });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected a file-size refusal");
    const error = result.error as AnalysisResourceConstraintError;
    expect(error.resource).toBe("file-size");
    const projected = projectAnalysisError(error);
    expect(projected.retryable).toBe(false);
    expect(projected.remediation.action).toContain("max_file_bytes");
    expect(projected.remediation.action).not.toMatch(/available host memory/u);
  });
});
