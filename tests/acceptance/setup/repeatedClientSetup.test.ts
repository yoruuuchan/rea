import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

import { expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest(
  "repeated client flags plan and configure each selected client once",
  async ({ cli }) => {
    const directory = await createTestTempDirectory("rea-repeated-clients-");
    const arguments_ = [
      "setup",
      "--client",
      "cursor",
      "--client",
      "codex",
      "--client",
      "cursor",
      "--skill=false",
      "--json",
    ];
    const run = (mode: string) =>
      cli.run({
        arguments: [...arguments_, mode],
        cwd: directory,
        environment: {
          HOME: directory,
          USERPROFILE: directory,
          TMPDIR: directory,
        },
      });
    const configurations = [
      join(directory, ".cursor/mcp.json"),
      join(directory, ".codex/config.toml"),
    ];

    const preview = await run("--dry-run");
    expect(preview.exitCode, preview.stdout).toBe(0);
    expect(preview.json).toMatchObject({
      status: "planned",
      plannedActions: [
        { id: "configure_client:cursor" },
        { id: "configure_client:codex" },
      ],
      appliedActions: [],
    });
    for (const path of configurations)
      await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });

    const applied = await run("--yes");
    expect(applied.exitCode, applied.stdout).toBe(0);
    expect(applied.json).toMatchObject({
      status: "ready",
      plannedActions: [
        { id: "configure_client:cursor" },
        { id: "configure_client:codex" },
      ],
      appliedActions: ["configured_cursor", "configured_codex"],
      clients: {
        cursor: { status: "configured" },
        codex: { status: "configured" },
      },
    });
    const configured = await Promise.all(
      configurations.map((path) => readFile(path, "utf8")),
    );

    const repeated = await run("--yes");
    expect(repeated.exitCode, repeated.stdout).toBe(0);
    expect(repeated.json).toMatchObject({
      status: "ready",
      plannedActions: [],
      appliedActions: [],
    });
    expect(
      await Promise.all(configurations.map((path) => readFile(path, "utf8"))),
    ).toEqual(configured);
  },
);
