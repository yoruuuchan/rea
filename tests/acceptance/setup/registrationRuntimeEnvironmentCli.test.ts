import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { expect } from "vitest";
import { stringify } from "yaml";

import {
  effectiveClientServer,
  parseClientConfiguration,
  clientRegistrationEntry,
} from "../../../src/application/ClientConfigurationDocument.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

const scenarios = [
  {
    client: "cursor",
    format: "json",
    path: ".cursor/mcp.json",
    setting: "HOPPER_LOADER_ARGS_JSON",
    invalid: { HOPPER_LOADER_ARGS_JSON: "{" },
    repaired: { HOPPER_LOADER_ARGS_JSON: '["", "--loader", "Mach-O"]' },
  },
  {
    client: "dsh",
    format: "dsh",
    path: ".dsh/cordis.patch.yml",
    setting: "REA_GHIDRA_COMPILER_SPEC_ID",
    invalid: { REA_GHIDRA_COMPILER_SPEC_ID: "borlandcpp" },
    repaired: {
      REA_GHIDRA_COMPILER_SPEC_ID: "borlandcpp",
      REA_GHIDRA_LANGUAGE_ID: "x86:LE:32:default",
    },
  },
] as const;

for (const scenario of scenarios)
  cliTest(
    `setup and doctor reject ${scenario.client} overrides rejected by MCP startup`,
    async ({ cli }) => {
      const home = await createTestTempDirectory("rea-registration-runtime-");
      const config = join(home, scenario.path);
      await mkdir(dirname(config), { recursive: true });
      const environment = {
        HOME: home,
        USERPROFILE: home,
        XDG_CONFIG_HOME: join(home, ".config"),
        DSH_HOME: join(home, ".dsh"),
      };
      const registration = (env: Readonly<Record<string, string>>) => {
        const server = {
          command: "stale-launcher",
          args: ["mcp"],
          env: { CALLER_SETTING: "keep exactly", ...env },
        };
        return scenario.client === "dsh"
          ? stringify([
              {
                insert: [
                  {
                    id: "rea-mcp",
                    name: "@deepseek-ai/dsh-mcp-client",
                    config: {
                      serverName: "rea",
                      transport: "stdio",
                      ...server,
                    },
                  },
                ],
              },
            ])
          : JSON.stringify({ mcpServers: { rea: server } });
      };
      const original = registration(scenario.invalid);
      await writeFile(config, original);
      const startup = await cli.run({
        arguments: ["mcp"],
        cwd: home,
        environment: { ...environment, ...scenario.invalid },
      });
      expect(startup.exitCode).toBe(1);
      expect(startup.stderr).toContain(scenario.setting);
      expect(startup.stdout).toBe("");
      const run = (args: readonly string[]) =>
        cli.run({ arguments: [...args, "--json"], cwd: home, environment });
      const setup = await run([
        "setup",
        "--client",
        scenario.client,
        "--skill=false",
        "--yes",
      ]);
      expect(setup.exitCode).toBe(1);
      expect(setup.json).toMatchObject({
        status: "needs_human",
        plannedActions: [],
        appliedActions: [],
        remediation: expect.stringContaining(scenario.setting),
      });
      const doctor = await run(["doctor", "--client", scenario.client]);
      expect(doctor.exitCode).toBe(1);
      expect(doctor.json).toMatchObject({
        identity: {
          registrations: expect.arrayContaining([
            expect.objectContaining({
              client: scenario.client,
              state: "invalid",
              remediation: expect.stringContaining(scenario.setting),
            }),
          ]),
        },
      });
      expect(await readFile(config, "utf8")).toBe(original);
      await expect(access(`${config}.rea.backup`)).rejects.toMatchObject({
        code: "ENOENT",
      });

      // Model the caller repairing the named setting before rerunning setup.
      const repaired = registration(scenario.repaired);
      await writeFile(config, repaired);
      const configured = await run([
        "setup",
        "--client",
        scenario.client,
        "--skill=false",
        "--yes",
      ]);
      expect(configured.exitCode, configured.stdout).toBe(0);
      const text = await readFile(config, "utf8");
      const parsed = parseClientConfiguration(text, scenario.format);
      expect(effectiveClientServer(parsed, "rea")).toMatchObject({
        env: { CALLER_SETTING: "keep exactly", ...scenario.repaired },
      });
      expect(await readFile(`${config}.rea.backup`, "utf8")).toBe(repaired);
      const repeated = await run([
        "setup",
        "--client",
        scenario.client,
        "--skill=false",
        "--yes",
      ]);
      expect(repeated.json).toMatchObject({
        status: "ready",
        appliedActions: [],
        plannedActions: [],
      });
      expect(await readFile(config, "utf8")).toBe(text);
    },
  );

cliTest(
  "OpenCode CLI validates dependent settings after merging JSON and JSONC",
  async ({ cli }) => {
    const home = await createTestTempDirectory("rea-layered-runtime-cli-");
    const directory = join(home, ".config/opencode");
    await mkdir(directory, { recursive: true });
    const lower = join(directory, "opencode.json");
    const upper = join(directory, "opencode.jsonc");
    const content = (env: Record<string, string>) =>
      JSON.stringify({
        mcp: {
          rea: clientRegistrationEntry(
            "opencode",
            [resolve("scripts/rea.mjs"), "mcp"],
            env,
          ),
        },
      });
    const lowerContent = content({
      REA_GHIDRA_LANGUAGE_ID: "x86:LE:32:default",
    });
    const upperContent = content({ REA_GHIDRA_COMPILER_SPEC_ID: "borlandcpp" });
    await writeFile(lower, lowerContent);
    await writeFile(upper, upperContent);
    const environment = {
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: join(home, ".config"),
    };
    const run = (args: readonly string[]) =>
      cli.run({ arguments: [...args, "--json"], cwd: home, environment });
    const setup = await run([
      "setup",
      "--client",
      "opencode",
      "--skill=false",
      "--yes",
    ]);
    expect(setup.exitCode, setup.stdout).toBe(0);
    expect(setup.json).toMatchObject({
      status: "ready",
      plannedActions: [],
      appliedActions: [],
    });
    const doctor = await run(["doctor", "--client", "opencode"]);
    expect(doctor.exitCode, doctor.stdout).toBe(0);
    expect(doctor.json).toMatchObject({
      identity: {
        registrations: expect.arrayContaining([
          expect.objectContaining({ client: "opencode", state: "aligned" }),
        ]),
      },
    });
    expect(await readFile(lower, "utf8")).toBe(lowerContent);
    expect(await readFile(upper, "utf8")).toBe(upperContent);
    await writeFile(lower, content({ CALLER_SETTING: "retained" }));
    const missing = await run([
      "setup",
      "--client",
      "opencode",
      "--skill=false",
      "--yes",
    ]);
    expect(missing.exitCode).toBe(1);
    expect(missing.json).toMatchObject({
      status: "needs_human",
      plannedActions: [],
      appliedActions: [],
      remediation: expect.stringContaining("REA_GHIDRA_COMPILER_SPEC_ID"),
    });
    const invalidDoctor = await run(["doctor", "--client", "opencode"]);
    expect(invalidDoctor.exitCode).toBe(1);
    expect(invalidDoctor.json).toMatchObject({
      identity: {
        registrations: expect.arrayContaining([
          expect.objectContaining({ client: "opencode", state: "invalid" }),
        ]),
      },
    });
    expect(await readFile(upper, "utf8")).toBe(upperContent);
    for (const path of [lower, upper])
      await expect(access(`${path}.rea.backup`)).rejects.toMatchObject({
        code: "ENOENT",
      });
  },
);
