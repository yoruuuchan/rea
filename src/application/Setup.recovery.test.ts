import { describe, expect, it } from "vitest";

import { AnalysisError } from "../domain/analysisErrorBase.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { ConfigurationError } from "../domain/configurationErrors.js";
import { SUPPORTED_NODE_VERSION_PROSE } from "../domain/runtimeVersion.js";
import { FakeSetupHost, options } from "./Setup.fixture.js";
import { runSetup } from "./Setup.js";
import {
  parseLinuxDistribution,
  type LinuxDistribution,
} from "./LinuxHopper.js";
import type { SetupProgressEvent } from "./SetupTypes.js";

describe("setup workflow", () => {
  it("rejects Node 25 before applying setup actions", async () => {
    const host = new FakeSetupHost();
    host.nodeVersion = "25.1.0";
    host.clients = [{ name: "codex", configPath: "/codex.toml" }];

    const result = await runSetup(
      { ...options(true, true), installSkill: true, clientIds: ["codex"] },
      host,
    );

    expect(result.status).toBe("needs_human");
    expect(result.appliedActions).toEqual([]);
    expect(host.hopperInstalls).toBe(0);
    expect(host.configurations).toBe(0);
    expect(host.skillInstalls).toBe(0);
  });

  it("records every detected client outcome after an earlier failure", async () => {
    const host = new FakeSetupHost();
    host.hopper = "/Applications/Hopper";
    host.clients = [
      { name: "first", configPath: "/first.json" },
      { name: "second", configPath: "/second.json" },
      { name: "third", configPath: "/third.json" },
    ];
    host.clientResults.set("first", { status: "failed", reason: "write" });
    host.clientResults.set("second", { status: "configured" });
    host.clientResults.set("third", { status: "failed", reason: "readback" });

    const result = await runSetup(
      { ...options(true), clientIds: ["first", "second", "third"] },
      host,
    );

    expect(host.configurations).toBe(3);
    expect(result.clients).toEqual({
      first: { status: "failed", reason: "write" },
      second: { status: "configured" },
      third: { status: "failed", reason: "readback" },
    });
    expect(result.appliedActions).toEqual(["configured_second"]);
    expect(result.status).toBe("needs_human");
    expect(result.remediation).toContain("could not be updated");
  });

  it("reports a failed config rollback with its destination and recovery backup", async () => {
    const host = new FakeSetupHost();
    host.hopper = "/Applications/Hopper";
    host.clients = [{ name: "codex", configPath: "/fixture/codex.json" }];
    host.clientResults.set("codex", {
      status: "failed",
      reason: "rollback",
      backupPath: "/fixture/codex.json.rea.backup",
      failure: {
        kind: "restore",
        path: "/fixture/codex.json",
        detail: "permission denied",
      },
    });

    const result = await runSetup(
      { ...options(true), clientIds: ["codex"] },
      host,
    );

    expect(result.clients.codex).toEqual({
      status: "failed",
      reason: "rollback",
      backupPath: "/fixture/codex.json.rea.backup",
      failure: {
        kind: "restore",
        path: "/fixture/codex.json",
        detail: "permission denied",
      },
    });
    expect(result.remediation).toContain("permission denied");
    expect(result.remediation).toContain("/fixture/codex.json.rea.backup");
  });

  it("explains skill installation recovery", async () => {
    const host = new FakeSetupHost();
    host.hopper = "/Applications/Hopper";
    host.skill = "failed";
    const progress: SetupProgressEvent[] = [];
    const result = await runSetup(
      {
        ...options(true),
        installSkill: true,
        clientIds: [],
        onProgress: (event) => {
          if (event.actionId === "install_skill") progress.push(event);
        },
      },
      host,
    );
    expect(result.status).toBe("needs_human");
    expect(result.code).toBe("skill_install_failed");
    expect(result.remediation).toContain("REA skill write failed at");
    expect(result.remediation).toContain("injected skill write failure");
    expect(result.remediation).toContain("Check permissions and rerun setup.");
    expect(progress.at(-1)).toMatchObject({
      state: "failed",
      detail: expect.stringContaining("injected skill write failure"),
    });
  });

  it("delegates remaining unhealthy checks to doctor remediation", async () => {
    const host = new FakeSetupHost();
    host.hopper = "/Applications/Hopper";
    host.doctorHealthy = false;
    const result = await runSetup(
      { ...options(true), readinessScope: { providers: ["hopper"] } },
      host,
    );
    expect(result.remediation).toBe(
      "Run rea doctor and apply each reported remediation.",
    );
  });

  it("uses requested readiness scope without hiding environment drift", async () => {
    const host = new FakeSetupHost();
    host.hopper = "/Applications/Hopper";
    host.doctorHealthy = false;
    host.scopedDoctorHealthy = true;
    host.clients = [{ name: "codex", configPath: "/codex.toml" }];
    const readinessScope = {
      clients: ["codex"],
      providers: [] as string[],
      skill: true,
    };

    const result = await runSetup(
      {
        ...options(true),
        proposeHopper: false,
        installSkill: false,
        readinessScope,
      },
      host,
    );

    expect(result).toMatchObject({
      status: "ready",
      doctor: { healthy: true, environment_healthy: false },
    });
    expect(host.doctorScopes).toEqual(expect.arrayContaining([readinessScope]));
  });
});

describe("setup failure cleanup projection", () => {
  it("projects a configuration failure together with failed host cleanup", async () => {
    const configPath = "/fixture/home/vscode/settings.json";
    const primary = new ConfigurationError("Client config could not be read", {
      settings: [
        {
          setting: configPath,
          constraint: "The selected config could not be read.",
        },
      ],
      cleanup: {
        reason: "The admitted config handle remains open.",
        resources: [configPath],
      },
    });
    class SetupHostWithCleanupFailure extends FakeSetupHost {
      close = async (): Promise<string> =>
        "Setup could not release its client configuration resources.";
    }
    const host = new SetupHostWithCleanupFailure();
    host.clients = [{ name: "codex", configPath }];
    host.inspectClientConfiguration = async () => {
      throw primary;
    };

    const failure = await runSetup(
      { ...options(true), clientIds: ["codex"] },
      host,
    ).then(
      () => undefined,
      (cause: unknown) => cause,
    );
    expect(failure).toBeInstanceOf(AnalysisError);
    if (!(failure instanceof AnalysisError))
      throw new Error("Expected setup to preserve a typed analysis failure");

    const projected = projectAnalysisError(failure);
    expect(projected).toMatchObject({
      code: "cleanup_incomplete",
      details: {
        cleanup: "incomplete",
        resources: [configPath],
        diagnostics: {
          primary_error: {
            code: "cleanup_incomplete",
            details: { resources: [configPath] },
          },
          cleanup_error: {
            code: "cleanup_incomplete",
            details: { resources: [configPath] },
          },
        },
      },
    });
    expect(projected.details).toMatchObject({
      diagnostics: {
        primary_error: { message: expect.stringContaining("selected config") },
        cleanup_error: {
          details: {
            diagnostics: {
              reason:
                "Setup could not release its client configuration resources.",
            },
          },
        },
      },
    });
  });
});

describe("setup scoped readiness", () => {
  it("limits Hopper host checks to workflows that request Hopper", async () => {
    const platformHost = new FakeSetupHost("win32");
    platformHost.hopper = "/Applications/Hopper";
    platformHost.skill = "unchanged";
    platformHost.clients = [{ name: "codex", configPath: "/codex.toml" }];
    const windowsAgent = await runSetup(
      { ...options(true), clientIds: ["codex"] },
      platformHost,
    );
    expect(windowsAgent.status).toBe("ready");
    expect(platformHost.configurations).toBe(1);

    const nodeHost = new FakeSetupHost();
    nodeHost.nodeVersion = "20.0.0";
    expect((await runSetup(options(true), nodeHost)).remediation).toBe(
      `Install ${SUPPORTED_NODE_VERSION_PROSE} and rerun setup.`,
    );

    const macHost = new FakeSetupHost();
    macHost.version = "11.7";
    expect((await runSetup(options(true), macHost)).status).toBe("ready");
    expect((await runSetup(options(true, true), macHost)).remediation).toBe(
      "Upgrade to macOS 12 or newer.",
    );
  });

  it("keeps an unchanged selected client in final readiness checks", async () => {
    const host = new FakeSetupHost();
    host.hopper = "/Applications/Hopper";
    host.skill = "unchanged";
    host.clients = [{ name: "codex", configPath: "/codex.toml" }];
    host.productRegistrations = [
      {
        client: "codex",
        config_path: "/codex.toml",
        command: ["rea", "mcp"],
        state: "aligned",
        remediation: null,
      },
    ];
    host.clientInspections.set("codex", { status: "already_current" });
    host.scopedDoctorHealthy = true;

    const result = await runSetup(options(true), host);

    expect(result.status).toBe("ready");
    expect(result.plannedActions).toEqual([]);
    expect(host.doctorScopes.at(-1)).toEqual({
      clients: ["codex"],
      providers: [],
      skill: true,
      skillClients: ["codex"],
    });
  });

  it("does not advertise an unhealthy Hopper in the selected readiness summary", async () => {
    const host = new FakeSetupHost("win32");
    host.hopper = "C:\\Hopper\\Hopper.exe";
    host.unsupportedHopperVersion = true;
    host.clients = [{ name: "codex", configPath: "C:\\codex.toml" }];
    host.scopedDoctorHealthy = true;

    const result = await runSetup(
      {
        ...options(true),
        clientIds: ["codex"],
        installSkill: false,
      },
      host,
    );

    expect(result.status).toBe("ready");
    expect(result.doctor.availableProviders).toEqual([]);
  });

  it("rejects unsupported hosts before mutation", async () => {
    const host = new FakeSetupHost("linux");
    host.distribution = {
      id: "debian",
      versionId: "13",
      packageFamily: "deb",
      hopperSetupSupported: false,
    };
    const result = await runSetup(options(true, true), host);
    expect(result.status).toBe("needs_human");
    expect(host.hopperInstalls).toBe(0);
    expect(result.remediation).toBe(
      "Automated Hopper setup requires an x86_64 host running Ubuntu 24.04+, Fedora 41+, Nobara 44+, Arch Linux, CachyOS, or Omarchy; configure an existing supported provider instead.",
    );
  });

  it("configures BYO Ghidra on Linux outside Hopper's installer matrix", async () => {
    const host = new FakeSetupHost("linux");
    host.distribution = {
      id: "debian",
      versionId: "13",
      packageFamily: "deb",
      hopperSetupSupported: false,
    };
    host.ghidra = "/opt/ghidra_12.1.4_PUBLIC";
    host.javaHome = "/usr/lib/jvm/jdk-21";
    host.doctorHealthy = true;
    host.skill = "unchanged";
    host.clients = [{ name: "codex", configPath: "/codex.toml" }];

    const result = await runSetup(
      { ...options(true), clientIds: ["codex"] },
      host,
    );

    expect(result.status).toBe("ready");
    expect(host.hopperInstalls).toBe(0);
    expect(host.configuredProviderEnvironments).toContainEqual({
      GHIDRA_INSTALL_DIR: "/opt/ghidra_12.1.4_PUBLIC",
      JAVA_HOME: "/usr/lib/jvm/jdk-21",
    });
  });
});

const unsupportedDebian = {
  id: "debian",
  versionId: "13",
  packageFamily: "deb",
  hopperSetupSupported: false,
} as const;
const supportedUbuntu = {
  id: "ubuntu",
  versionId: "24.04",
  packageFamily: "deb",
  hopperSetupSupported: true,
} as const;
const unsupportedLinux =
  "Automated Hopper setup requires an x86_64 host running Ubuntu 24.04+, Fedora 41+, Nobara 44+, Arch Linux, CachyOS, or Omarchy; configure an existing supported provider instead.";
const unhealthyManualClientHost = (
  platform: NodeJS.Platform,
  facts: {
    readonly version?: string | undefined;
    readonly distribution?: LinuxDistribution;
  },
) => {
  const host = new FakeSetupHost(platform);
  host.version = facts.version;
  host.distribution = facts.distribution;
  host.doctorHealthy = false;
  host.clients = [
    {
      name: "grok_bot",
      displayName: "Grok Bot",
      configPath: "/fixture/home/.grokbot",
      format: "unsupported",
    },
  ];
  return host;
};
const manualClientSetup = {
  ...options(true),
  clientIds: ["grok_bot"],
  installSkill: false,
};
const proposesHopper = async (host: FakeSetupHost) =>
  (
    await runSetup(
      {
        ...options(false),
        proposeHopper: true,
        dryRun: true,
        clientIds: [],
        installSkill: false,
      },
      host,
    )
  ).plannedActions.some(({ kind }) => kind === "install_hopper");

describe("setup Hopper install eligibility", () => {
  it.each([
    {
      label: "Windows",
      platform: "win32",
      refusal:
        "REA supports Hopper on macOS and selected x86_64 Linux distributions.",
    },
    {
      label: "macOS 11",
      platform: "darwin",
      version: "11.7",
      refusal: "Upgrade to macOS 12 or newer.",
    },
    {
      label: "macOS with an unknown version",
      platform: "darwin",
      version: undefined,
      refusal: "Upgrade to macOS 12 or newer.",
    },
    {
      label: "an unsupported Linux distribution",
      platform: "linux",
      distribution: unsupportedDebian,
      refusal: unsupportedLinux,
    },
    {
      label: "Ubuntu on arm64",
      platform: "linux",
      distribution: parseLinuxDistribution(
        'ID=ubuntu\nVERSION_ID="24.04"',
        "arm64",
      ),
      refusal: unsupportedLinux,
    },
    {
      label: "an unidentified Linux distribution",
      platform: "linux",
      refusal: unsupportedLinux,
    },
  ] as const)(
    "neither offers nor accepts an unsupported Hopper installation on $label",
    async ({ platform, refusal, ...facts }) => {
      const host = unhealthyManualClientHost(platform, facts);

      const advised = await runSetup(manualClientSetup, host);
      expect(advised.status).toBe("needs_human");
      expect(advised.remediation).not.toContain("--install-hopper");
      expect(advised.remediation).toContain(
        "Run rea doctor and apply each reported remediation.",
      );
      expect(advised.remediation).toContain("hosted computer");
      expect(await proposesHopper(host)).toBe(false);

      const requested = await runSetup(
        { ...manualClientSetup, installHopper: true },
        host,
      );
      expect(requested).toMatchObject({
        status: "needs_human",
        remediation: refusal,
        appliedActions: [],
      });
      expect(host.hopperInstalls).toBe(0);
    },
  );

  it.each([
    { label: "macOS 14", platform: "darwin", version: "14.5" },
    {
      label: "a supported Linux distribution",
      platform: "linux",
      distribution: supportedUbuntu,
    },
  ] as const)(
    "offers a Hopper installation that succeeds on $label",
    async ({ platform, ...facts }) => {
      const host = unhealthyManualClientHost(platform, facts);

      const advised = await runSetup(manualClientSetup, host);
      expect(advised.status).toBe("needs_human");
      expect(advised.remediation).toContain(
        "Rerun with --yes --install-hopper",
      );
      expect(advised.remediation).toContain("hosted computer");
      expect(await proposesHopper(host)).toBe(true);

      const followed = await runSetup(
        { ...manualClientSetup, installHopper: true },
        host,
      );
      expect(followed.appliedActions).toContain("installed_hopper");
      expect(host.hopperInstalls).toBe(1);
    },
  );

  it.each([
    { version: "", installs: false },
    { version: "14beta", installs: false },
    { version: "12", installs: true },
    { version: "12.0", installs: true },
  ])(
    "decides an explicit Hopper installation for macOS %j",
    async ({ version, installs }) => {
      const host = new FakeSetupHost("darwin");
      host.version = version;

      const result = await runSetup(options(true, true), host);

      expect(result.appliedActions.includes("installed_hopper")).toBe(installs);
      expect(host.hopperInstalls).toBe(installs ? 1 : 0);
      if (!installs)
        expect(result).toMatchObject({
          status: "needs_human",
          remediation: "Upgrade to macOS 12 or newer.",
        });
    },
  );
});
