import { readClientPolicyBlock } from "./GeminiClientSettings.js";
import { readEffectiveClientRegistrationConfiguration } from "./ClientConfigurationFiles.js";
import {
  clientServerForcedEnabled,
  clientServerListedDisabled,
  effectiveClientServer,
  type ClientConfigurationDocument,
} from "./ClientConfigurationDocument.js";
import { access } from "node:fs/promises";
import { resolve } from "node:path";

import { z } from "zod";
import { valid } from "semver";

import { PRODUCT_IDENTITY } from "../identity.js";
import { MCP_STARTUP_POLICY } from "../mcpStartupPolicy.js";
import {
  clientRegistrationPackageReference,
  isOwnedClientRegistrationCommand,
  packageRunnerRegistrationCommand,
} from "./ClientRegistrationIdentity.js";
import {
  clientEvidencePaths,
  manualRegistrationRemediation,
  supportedClients,
} from "./SupportedClients.js";
import type { SetupClient } from "./SupportedClients.js";
import { compareUnicodeCodePoints } from "../domain/unicodeCodePointOrder.js";
import { dshDocument } from "./DshCordisPatch.js";
import type { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";

interface ClientRegistrationStatusBase {
  readonly client: string;
  readonly config_path: string;
  /** Exact package reference requested by npx/bunx, when registration uses one. */
  readonly package_reference?: string;
}

type RegistrationCommand = readonly [string, ...string[]];

export type ClientRegistrationStatus = ClientRegistrationStatusBase &
  (
    | {
        readonly command: RegistrationCommand;
        readonly state: "aligned";
        readonly remediation: null;
      }
    | {
        readonly command: RegistrationCommand;
        readonly state: "stale";
        readonly remediation: string;
      }
    | {
        readonly command: readonly [];
        readonly state: "missing" | "invalid" | "manual";
        readonly remediation: string;
      }
  );

export type UnhealthyClientRegistrationStatus = Exclude<
  ClientRegistrationStatus,
  { readonly state: "aligned" }
>;

const registrationSchema = z
  .object({
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    startup_timeout_sec: z.number().positive().optional(),
    startupTimeoutMs: z.number().positive().optional(),
    toolTimeoutMs: z.number().positive().optional(),
    type: z.string().optional(),
    transport: z.string().optional(),
    serverName: z.string().optional(),
    tools: z.array(z.string()).optional(),
    disabled: z.boolean().optional(),
    enabled: z.boolean().optional(),
  })
  .passthrough();

interface ClientRegistrationReadOptions {
  readonly platform?: NodeJS.Platform;
  readonly environment?: NodeJS.ProcessEnv;
  readonly resources?: ArtifactResourceScope;
}

/** Registration facts shared by diagnostics and update maintenance. */
export interface ClientRegistrationInspection {
  readonly status: ClientRegistrationStatus;
  readonly activation: "enabled" | "disabled" | "unknown";
}

/** Project diagnostics from the same inspection used to select maintenance. */
export const readClientRegistrationStatuses = async (
  home: string,
  currentCommandPath: string = resolve(process.argv[1] ?? "unknown"),
  options: ClientRegistrationReadOptions = {},
): Promise<readonly ClientRegistrationStatus[]> =>
  (
    await readClientRegistrationInspections(home, currentCommandPath, options)
  ).map(({ status }) => status);

/** Parse effective registrations and their client-specific activation once. */
export const readClientRegistrationInspections = async (
  home: string,
  currentCommandPath: string = resolve(process.argv[1] ?? "unknown"),
  options: ClientRegistrationReadOptions = {},
): Promise<readonly ClientRegistrationInspection[]> => {
  const inspections: ClientRegistrationInspection[] = [];
  const record = (
    status: ClientRegistrationStatus,
    activation: ClientRegistrationInspection["activation"] = "unknown",
  ): void => {
    inspections.push({ status, activation });
  };
  for (const client of supportedClients(
    home,
    options.platform,
    options.environment,
  )) {
    if (client.configPathError !== undefined) {
      record({
        client: client.name,
        config_path: client.configPath,
        command: [],
        state: "invalid",
        remediation: client.configPathError,
      });
      continue;
    }
    if (!(await clientEvidencePresent(client))) continue;
    const manualRemediation = manualRegistrationRemediation(client.name);
    if (client.format === "unsupported") {
      if (manualRemediation !== undefined)
        record({
          client: client.name,
          config_path: client.markerPath ?? client.configPath,
          command: [],
          state: "manual",
          remediation: manualRemediation,
        });
      continue;
    }
    let selectedConfigPath = client.configPath;
    try {
      const configuration = await readEffectiveClientRegistrationConfiguration(
        client,
        options.resources,
      );
      if (!configuration.ok) {
        record({
          client: client.name,
          config_path: configuration.error.path,
          command: [],
          state: "invalid",
          remediation: configuration.error.detail,
        });
        continue;
      }
      const { document: parsed, configPath } = configuration.value;
      selectedConfigPath = configPath;
      if (parsed === undefined) {
        record(unavailableStatus(client, "missing", configPath));
        continue;
      }
      const policy = await readClientPolicyBlock(
        client,
        parsed,
        undefined,
        options.resources,
      );
      if (!policy.ok) {
        record({
          client: client.name,
          config_path: configPath,
          command: [],
          state: "invalid",
          remediation: policy.error.detail,
        });
        continue;
      }
      const policyBlock = policy.value;
      const raw = effectiveClientServer(parsed, PRODUCT_IDENTITY.mcpServerKey);
      if (raw === undefined) {
        const editabilityError =
          parsed.dialect === "dsh"
            ? dshDocument(parsed.document).editabilityError
            : undefined;
        if (editabilityError !== undefined) {
          record({
            client: client.name,
            config_path: configPath,
            command: [],
            state: "invalid",
            remediation: editabilityError.message,
          });
          continue;
        }
        record(unavailableStatus(client, "missing", configPath));
        continue;
      }
      const effectiveClient: SetupClient =
        parsed.dialect === "zcode_fallback"
          ? {
              ...client,
              configPath,
              configPaths: [configPath],
              format: "zcode_fallback",
            }
          : client;
      const registration = parseRegistration(raw, effectiveClient);
      const command: RegistrationCommand = [
        registration.command,
        ...registration.args,
      ];
      const packageReference = clientRegistrationPackageReference(command);
      const activation = registrationActivation(registration, client, parsed);
      const packageVersion = exactRegisteredPackageVersion(packageReference);
      const packageVersionDrift =
        packageVersion !== undefined &&
        packageVersion !== PRODUCT_IDENTITY.packageVersion;
      record(
        configuredStatus(
          effectiveClient,
          command,
          activation === "enabled" &&
            !packageVersionDrift &&
            registrationAligned(
              registration,
              effectiveClient,
              currentCommandPath,
              options.platform ?? process.platform,
            ) &&
            (parsed.dialect !== "dsh" || dshDocument(parsed.document).ready) &&
            policyBlock === undefined
            ? "aligned"
            : "stale",
          policyBlock ??
            (packageVersionDrift
              ? packageVersionRemediation(packageReference ?? "", client)
              : undefined),
          packageReference,
        ),
        activation,
      );
    } catch (cause: unknown) {
      record(
        unavailableStatus(
          client,
          isMissing(cause) ? "missing" : "invalid",
          selectedConfigPath,
        ),
      );
    }
  }
  return inspections.sort((left, right) =>
    compareUnicodeCodePoints(left.status.client, right.status.client),
  );
};

const registrationActivation = (
  registration: z.output<typeof registrationSchema>,
  client: SetupClient,
  parsed: ClientConfigurationDocument,
): "enabled" | "disabled" =>
  (client.format !== "grok" && registration.disabled === true) ||
  (registration.enabled === false &&
    !clientServerForcedEnabled(parsed, PRODUCT_IDENTITY.mcpServerKey)) ||
  ((parsed.dialect === "zcode" || parsed.dialect === "zcode_fallback") &&
    registration.enable === false) ||
  clientServerListedDisabled(parsed, PRODUCT_IDENTITY.mcpServerKey)
    ? "disabled"
    : "enabled";

const registrationAligned = (
  registration: z.output<typeof registrationSchema>,
  client: SetupClient,
  currentCommandPath: string,
  platform: NodeJS.Platform,
): boolean => {
  const command = [registration.command, ...registration.args];
  if (!isOwnedClientRegistrationCommand(command, currentCommandPath))
    return false;
  if (
    (client.name === "codex" || client.name === "grok_build") &&
    registration.startup_timeout_sec !==
      MCP_STARTUP_POLICY.codexStartupTimeoutSeconds
  )
    return false;
  if (
    client.name === "kimi" &&
    (registration.startupTimeoutMs !==
      MCP_STARTUP_POLICY.kimiStartupTimeoutMs ||
      registration.toolTimeoutMs !== MCP_STARTUP_POLICY.kimiToolTimeoutMs)
  )
    return false;
  if (
    (client.format === "kimi" ||
      client.format === "omp" ||
      client.format === "pi") &&
    registration.type !== undefined &&
    registration.type !== "stdio"
  )
    return false;
  if (client.format === "vscode" && registration.type !== "stdio") return false;
  // A Harness registration only connects as the rea stdio server; another
  // server name or transport leaves the session without REA tools.
  if (
    client.format === "dsh" &&
    (registration.serverName !== "rea" || registration.transport !== "stdio")
  )
    return false;
  if (
    client.format === "copilot_cli" &&
    (registration.type !== "stdio" ||
      JSON.stringify(registration.tools) !== JSON.stringify(["*"]))
  )
    return false;
  if (client.format === "commandcode" && registration.transport !== "stdio")
    return false;
  if (
    command.length === 3 &&
    command[2] === "mcp" &&
    resolve(command[0] ?? "") === resolve(process.execPath) &&
    resolve(command[1] ?? "") === currentCommandPath
  )
    return true;
  if (
    (["npx", "bunx"] as const).some((runner) => {
      const runnerCommand = packageRunnerRegistrationCommand(runner, platform);
      return (
        command.length === runnerCommand.length &&
        command.every((argument, index) => argument === runnerCommand[index])
      );
    })
  )
    return true;
  return (
    command.length === 2 &&
    command[1] === "mcp" &&
    resolve(command[0] ?? "") === currentCommandPath
  );
};

const parseRegistration = (
  value: unknown,
  client: SetupClient,
): z.output<typeof registrationSchema> => {
  if (client.format === "dsh")
    return registrationSchema
      .pick({ command: true, args: true, serverName: true, transport: true })
      .strip()
      .parse(value);
  if (client.format === "opencode") {
    const entry = z
      .object({
        type: z.literal("local"),
        command: z.array(z.string()).min(1),
        environment: z.record(z.string(), z.string()).optional(),
      })
      .passthrough()
      .parse(value);
    const [command = "", ...args] = entry.command;
    return registrationSchema.parse({
      ...entry,
      command,
      args,
    });
  }
  const registration = registrationSchema.parse(value);
  if (
    client.format === "kimi" &&
    registration.transport !== undefined &&
    registration.transport !== "stdio"
  )
    throw new TypeError("Expected an stdio registration");
  if (
    (client.format === "vscode" || client.format === "copilot_cli") &&
    registration.type !== "stdio"
  )
    throw new TypeError("Expected an stdio registration");
  if (client.format === "commandcode" && registration.transport !== "stdio")
    throw new TypeError("Expected an stdio registration");
  if (
    (client.format === "kimi" ||
      client.format === "omp" ||
      client.format === "pi") &&
    registration.type !== undefined &&
    registration.type !== "stdio"
  )
    throw new TypeError("Expected an stdio registration");
  return registration;
};

/** A client that rewrites its file from memory must be quit before setup. */
const remediation = (client: SetupClient): string => {
  if (client.quitBeforeSetup !== true)
    return "Run rea setup to refresh this registration, then restart the client.";
  const name = client.displayName ?? client.name;
  return `Quit ${name} fully, run rea setup to refresh this registration, then start ${name} again. A running ${name} can rewrite its configuration from memory and drop the registration.`;
};

const configuredStatus = (
  client: SetupClient,
  command: RegistrationCommand,
  state: "aligned" | "stale",
  policyRemediation?: string,
  packageReference?: string,
): ClientRegistrationStatus =>
  state === "aligned"
    ? {
        client: client.name,
        config_path: client.configPath,
        command,
        ...(packageReference === undefined
          ? {}
          : { package_reference: packageReference }),
        state,
        remediation: null,
      }
    : {
        client: client.name,
        config_path: client.configPath,
        command,
        ...(packageReference === undefined
          ? {}
          : { package_reference: packageReference }),
        state,
        remediation: policyRemediation ?? remediation(client),
      };

const exactRegisteredPackageVersion = (
  packageReference: string | undefined,
): string | undefined => {
  if (packageReference === undefined) return undefined;
  const prefix = `${PRODUCT_IDENTITY.packageName}@`;
  if (!packageReference.startsWith(prefix)) return undefined;
  const version = packageReference.slice(prefix.length);
  return valid(version) === version ? version : undefined;
};

const packageVersionRemediation = (
  packageReference: string,
  client: SetupClient,
): string =>
  `This registration requests ${packageReference}, while the current REA CLI package is ${PRODUCT_IDENTITY.packageVersion}. REA does not resolve package-runner requests during doctor; update the registration with rea setup --client ${client.name}, then restart the client.`;

const unavailableStatus = (
  client: SetupClient,
  state: "missing" | "invalid",
  configPath: string = client.configPath,
): ClientRegistrationStatus => ({
  client: client.name,
  config_path: configPath,
  command: [],
  state,
  remediation: remediation(client),
});

const clientEvidencePresent = async (client: SetupClient): Promise<boolean> => {
  for (const path of clientEvidencePaths(client))
    if (await exists(path)) return true;
  return false;
};

const exists = async (path: string | undefined): Promise<boolean> => {
  if (path === undefined) return false;
  try {
    await access(path);
    return true;
  } catch (cause: unknown) {
    // best-effort cleanup: optional registration probing; absence means unregistered.
    void cause;
    return false;
  }
};

const isMissing = (cause: unknown): boolean =>
  cause instanceof Error && "code" in cause && cause.code === "ENOENT";
