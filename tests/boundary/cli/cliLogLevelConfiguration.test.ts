import { expect } from "vitest";

import { cliTest } from "../../support/cli/cliFixture.js";

const invalidLogLevelMessage =
  'REA configuration is invalid: REA_LOG_LEVEL: Invalid option: expected one of "trace"|"debug"|"info"|"warn"|"error"|"fatal"|"silent".\n';

for (const level of ["loud", "INFO"])
  cliTest(
    `reports REA_LOG_LEVEL=${level} as invalid configuration`,
    async ({ cli }) => {
      const help = await cli.run({
        arguments: ["--help"],
        environment: { REA_LOG_LEVEL: level },
      });
      expect(help.exitCode).toBe(1);
      expect(help.stdout).toBe("");
      expect(help.stderr).toBe(invalidLogLevelMessage);

      const doctor = await cli.run({
        arguments: ["--json", "doctor", "--provider", "hopper"],
        environment: { REA_LOG_LEVEL: level },
      });
      expect(doctor.exitCode, doctor.stderr).toBe(1);
      expect(doctor.stderr).toBe("");
      expect(doctor.json).toMatchObject({
        healthy: false,
        scope_checks: expect.arrayContaining([
          expect.objectContaining({
            name: "runtime-configuration:REA_LOG_LEVEL",
            ok: false,
            classification: "config_drift",
            detail: expect.stringContaining("REA_LOG_LEVEL"),
          }),
        ]),
      });

      const client = await cli.run({
        arguments: ["--json", "doctor", "--client", "codex"],
        environment: { REA_LOG_LEVEL: level },
      });
      expect(client.exitCode, client.stderr).toBe(1);
      expect(client.stderr).toBe("");
      expect(client.json).toMatchObject({
        healthy: false,
        scope: { mode: "explicit", clients: ["codex"], providers: [] },
        scope_checks: expect.arrayContaining([
          expect.objectContaining({
            name: "runtime-configuration:REA_LOG_LEVEL",
            ok: false,
          }),
        ]),
        informational_checks: expect.not.arrayContaining([
          expect.objectContaining({
            name: "runtime-configuration:REA_LOG_LEVEL",
          }),
        ]),
      });
    },
  );
