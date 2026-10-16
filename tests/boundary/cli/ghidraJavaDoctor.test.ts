import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { elf, thinMach } from "../../../src/domain/binaryTarget.fixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest.skipIf(!["darwin", "linux"].includes(process.platform)).for([
  ["missing", "missing_dependency", "runtime_missing"],
  ["nonzero", "runtime_failure", "runtime_unavailable"],
  ["properties", "config_drift", "version_unresolved"],
] as const)(
  "preserves the %s Java prerequisite result through doctor",
  async ([failure, classification, code], { cli }) => {
    const root = await createTestTempDirectory("rea-java-doctor-");
    const jdk = join(root, "jdk");
    const install = join(root, "ghidra");
    const platform = process.platform === "darwin" ? "mac" : "linux";
    const architecture = process.arch === "arm64" ? "arm_64" : "x86_64";
    const native = join(
      install,
      "Ghidra/Features/Decompiler/os",
      `${platform}_${architecture}`,
      "decompile",
    );
    for (const path of [
      join(jdk, "bin"),
      join(install, "support"),
      join(install, "Ghidra"),
      join(native, ".."),
    ])
      await mkdir(path, { recursive: true });
    await writeFile(
      join(install, "Ghidra/application.properties"),
      "application.version=12.1.4\napplication.java.min=21\n",
    );
    await writeFile(
      join(install, "support/analyzeHeadless"),
      "#!/bin/sh\nexit 99\n",
    );
    await chmod(join(install, "support/analyzeHeadless"), 0o700);
    await writeFile(
      native,
      process.platform === "darwin"
        ? thinMach(
            0xfeedfacf,
            process.arch === "arm64" ? 0x0100000c : 0x01000007,
          )
        : elf(2, 1, process.arch === "arm64" ? 183 : 62),
    );
    await chmod(native, 0o700);
    if (failure !== "missing") {
      const body =
        failure === "nonzero"
          ? 'process.stderr.write("controlled runtime failure\\n"); process.exit(7);'
          : `process.stdout.write(${JSON.stringify(`java.home = ${jdk}\nos.arch = aarch64\n`)});`;
      await writeFile(
        join(jdk, "bin/java"),
        `#!${process.execPath}\n${body}\n`,
      );
      await chmod(join(jdk, "bin/java"), 0o700);
    }
    const result = await cli.run({
      arguments: ["doctor", "--provider", "ghidra", "--json"],
      environment: {
        JAVA_HOME: jdk,
        GHIDRA_INSTALL_DIR: install,
        REA_LOG_LEVEL: "silent",
      },
    });
    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(1);
    expect(result.json).toMatchObject({
      checks: expect.arrayContaining([
        expect.objectContaining({
          name: "ghidra-java",
          classification,
          ok: false,
        }),
      ]),
      providerInspections: expect.arrayContaining([
        expect.objectContaining({
          id: "ghidra",
          checks: expect.arrayContaining([
            expect.objectContaining({ name: "java", code }),
          ]),
        }),
      ]),
    });
    if (failure === "nonzero")
      expect(result.json).toMatchObject({
        checks: expect.arrayContaining([
          expect.objectContaining({
            name: "ghidra-java",
            detail: expect.stringContaining("Java exited 7"),
            details: expect.objectContaining({
              output: expect.objectContaining({
                stderr: "controlled runtime failure\n",
                exit_code: 7,
                stderr_bytes: 27,
              }),
            }),
          }),
        ]),
      });
    if (failure === "properties")
      expect(result.json).toMatchObject({
        checks: expect.arrayContaining([
          expect.objectContaining({
            name: "ghidra-java",
            details: expect.objectContaining({
              properties: expect.objectContaining({ home: jdk, version: null }),
            }),
          }),
        ]),
      });
  },
);
