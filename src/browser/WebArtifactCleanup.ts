import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import type { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import type { WebScriptArtifactPort } from "../application/WebScriptArtifactPort.js";
import { LocalWebScriptArtifacts } from "./assets/LocalWebScriptArtifacts.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";

type WebArtifactOwner =
  | "web-source-location-artifacts"
  | "web-module-artifacts";

/** Close a composed artifact reader without closing a shared script scope twice. */
export const closeWebArtifactResources = async (
  owner: WebArtifactOwner,
  resources: ArtifactResourceScope,
  scripts: WebScriptArtifactPort,
): Promise<void> => {
  const sourceLocation = owner === "web-source-location-artifacts";
  const operation = sourceLocation
    ? "trace_web_source_location"
    : "trace_web_module_imports";
  const resource = sourceLocation
    ? "web source-location artifacts"
    : "web module artifacts";
  const closeScript =
    scripts instanceof LocalWebScriptArtifacts &&
    scripts.resources === resources
      ? undefined
      : scripts.close?.bind(scripts);
  const results = await Promise.allSettled([
    Promise.resolve().then(() => resources.close()),
    ...(closeScript === undefined ? [] : [Promise.resolve().then(closeScript)]),
  ]);
  const failures = results.flatMap((result, index) =>
    result.status === "rejected"
      ? [
          {
            cause: result.reason,
            resource: index === 0 ? resource : "web scripts",
          },
        ]
      : [],
  );
  const error = webArtifactCleanupFailures(owner, operation, failures);
  if (error !== undefined) throw error;
};

export const webArtifactCleanupFailures = (
  owner: string,
  operation: string,
  failures: readonly { readonly resource: string; readonly cause: unknown }[],
): ProviderCleanupError | undefined => {
  if (failures.length === 0) return undefined;
  const normalized = failures.map(({ resource, cause }) => {
    if (cause instanceof AnalysisError) {
      const projection = projectAnalysisError(cause);
      return {
        cause,
        projection,
        observation: {
          reason: projection.message,
          resources:
            cause.cleanupResources.length === 0
              ? [resource]
              : cause.cleanupResources,
        },
      };
    }
    return {
      cause,
      projection: undefined,
      observation: ArtifactReaderFailure.cleanupObservation(cause, resource),
    };
  });
  const recoveryActions = [
    ...new Set(
      normalized.flatMap(({ projection }) =>
        projection === undefined ? [] : [projection.remediation.action],
      ),
    ),
  ];
  return new ProviderCleanupError(
    owner,
    [
      ...new Set(
        normalized.flatMap(({ observation }) => observation.resources),
      ),
    ],
    {
      reason: normalized
        .map(({ observation }) => observation.reason)
        .join("; "),
      failures: normalized.map(({ cause, projection, observation }) =>
        projection !== undefined
          ? projection
          : {
              name: cause instanceof Error ? cause.name : "UnknownError",
              message: cause instanceof Error ? cause.message : String(cause),
              resource: [...observation.resources],
            },
      ),
    },
    {
      cause:
        normalized.length === 1
          ? normalized[0]!.cause
          : new AggregateError(
              normalized.map(({ cause }) => cause),
              `${owner} cleanup failed`,
            ),
      operation,
      ...(recoveryActions.length === 0
        ? {}
        : { remediationAction: recoveryActions.join("; ") }),
    },
  );
};
