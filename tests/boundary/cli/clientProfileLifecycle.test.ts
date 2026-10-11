import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

const cases = [
  {
    client: "gemini_cli",
    env: { GEMINI_CLI_HOME: "profile" },
    config: "profile/.gemini/settings.json",
    skill: "profile/.agents/skills",
  },
  {
    client: "opencode",
    env: { OPENCODE_CONFIG_DIR: "profile" },
    config: "profile/opencode.json",
    skill: ".agents/skills",
  },
  {
    client: "opencode",
    env: { OPENCODE_CONFIG_DIR: "" },
    config: ".config/opencode/opencode.json",
    skill: ".agents/skills",
  },
  {
    client: "codex",
    env: { CODEX_HOME: "" },
    config: ".codex/config.toml",
    skill: ".agents/skills",
  },
  {
    client: "grok_build",
    env: { GROK_HOME: "" },
    config: ".grok/config.toml",
    skill: ".agents/skills",
  },
  {
    client: "omp",
    env: { PI_CODING_AGENT_DIR: "profile" },
    config: "profile/mcp.json",
    skill: ".agents/skills",
  },
  {
    client: "devin",
    env: { XDG_CONFIG_HOME: "profile" },
    config: "profile/devin/mcp_config.json",
    skill: ".agents/skills",
  },
  {
    client: "antigravity",
    env: {},
    config: ".gemini/config/mcp_config.json",
    skill: ".gemini/config/skills",
  },
];
for (const testCase of cases.filter(
  ({ client }) => process.platform !== "win32" || client !== "devin",
)) {
  cliTest(
    `${testCase.client} lifecycle follows the selected roots (${testCase.config})`,
    async ({ cli }) => {
      const home = await createTestTempDirectory("rea-client-profile-");
      const environment: NodeJS.ProcessEnv = { HOME: home, USERPROFILE: home };
      for (const [key, value] of Object.entries(testCase.env))
        environment[key] = value === "profile" ? join(home, value) : value;
      // OMP's relative override is relative to the caller, not silently ignored.
      if (testCase.client === "omp")
        environment.PI_CODING_AGENT_DIR = "profile";
      const config = join(home, testCase.config);
      const skillDirectory = join(
        home,
        testCase.skill,
        "reverse-engineer-anything",
      );
      const run = (arguments_: readonly string[]) =>
        cli.run({
          arguments: arguments_,
          cwd: home,
          environment,
          timeoutMs: 20_000,
        });
      const planned = await run([
        "setup",
        "--client",
        testCase.client,
        "--dry-run",
        "--json",
      ]);
      expect(planned.exitCode).toBe(0);
      expect(planned.json).toMatchObject({
        status: "planned",
        plannedActions: expect.arrayContaining([
          expect.objectContaining({ target: config }),
          expect.objectContaining({ target: skillDirectory }),
        ]),
      });
      await expect(access(config)).rejects.toMatchObject({ code: "ENOENT" });
      const setup = await run([
        "setup",
        "--client",
        testCase.client,
        "--yes",
        "--json",
      ]);
      expect(setup.exitCode).toBe(0);
      expect(setup.json).toMatchObject({ status: "ready" });
      await expect(access(config)).resolves.toBeUndefined();
      expect(
        await readFile(join(skillDirectory, "SKILL.md"), "utf8"),
      ).toContain("reverse-engineer-anything");
      await expect(access(join(home, "config.toml"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      const doctor = await run([
        "doctor",
        "--client",
        testCase.client,
        "--skill",
        "--json",
      ]);
      expect(doctor.exitCode).toBe(0);
      expect(doctor.json).toMatchObject({
        healthy: true,
        identity: { skill: { state: "aligned" } },
      });
      if (testCase.client === "grok_build") {
        const original = await readFile(config, "utf8");
        await writeFile(
          config,
          original.replace(
            "[mcp_servers.rea]",
            "[mcp_servers.rea]\ndisabled = true",
          ),
        );
        expect(
          (await run(["doctor", "--client", "grok_build", "--json"])).exitCode,
        ).toBe(0);
        await writeFile(config, original);
      }
      const repeat = await run([
        "setup",
        "--client",
        testCase.client,
        "--yes",
        "--json",
      ]);
      expect(repeat.json).toMatchObject({
        status: "ready",
        appliedActions: [],
      });
      const uninstall = await run(["uninstall", "--json"]);
      expect(uninstall.exitCode).toBe(0);
      expect(uninstall.json).toMatchObject({ status: "complete" });
      await expect(
        access(join(skillDirectory, "SKILL.md")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    },
  );
}
