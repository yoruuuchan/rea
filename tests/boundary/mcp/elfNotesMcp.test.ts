import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { createServer } from "../../../src/server/createServer.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { elfNoteFixture } from "../../../src/native/elf/ElfNotes.fixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { mcpTest, type TestMcp } from "../../support/mcp/mcpFixture.js";

const connect = async (mcp: TestMcp) => {
  const session = createTestBinarySession(() => {
    throw new Error("ELF note inspection must not start a deep provider");
  });
  const client = await mcp.connect(createServer({ kind: "session", session }));
  return { client, session };
};

mcpTest(
  "advertises inspect_elf_notes and reads a GNU build-id",
  async ({ mcp }) => {
    const { client, session } = await connect(mcp);
    try {
      const advertised = (await client.listTools()).tools.find(
        (tool) => tool.name === "inspect_elf_notes",
      );
      expect(advertised?.annotations).toMatchObject({
        readOnlyHint: false,
        idempotentHint: true,
      });
      const root = await createTestTempDirectory("rea-elf-notes-mcp-");
      const path = join(root, "program");
      await writeFile(path, elfNoteFixture({ bits: 32, ownership: "section" }));
      const response = await client.callTool({
        name: "inspect_elf_notes",
        arguments: { path },
      });
      expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
      const evidence = toolContract("inspect_elf_notes").outputSchema.parse(
        response.structuredContent,
      );
      expect(evidence.normalized_result.format).toBe("elf32");
      expect(
        evidence.normalized_result.entries.find(
          (entry) => entry.type_name === "gnu_build_id",
        )?.gnu?.build_id_hex,
      ).toBe("0123456789abcdef0123456789abcdef01234567");
    } finally {
      await session.close();
    }
  },
);

mcpTest("requires an absolute path for inspect_elf_notes", async ({ mcp }) => {
  const { client, session } = await connect(mcp);
  try {
    const response = await client.callTool({
      name: "inspect_elf_notes",
      arguments: { path: "program" },
    });
    expect(response.isError).toBe(true);
    expect(parseMcpToolError(response).error).toMatchObject({
      code: "invalid_request",
      details: { operation: "inspect_elf_notes" },
    });
  } finally {
    await session.close();
  }
});
