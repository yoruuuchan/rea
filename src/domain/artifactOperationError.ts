import {
  projectArtifactIntegrityDetails,
  type ArtifactIntegrityDetails,
} from "./artifactIntegrity.js";
import {
  AnalysisError,
  type AnalysisErrorOptions,
} from "./analysisErrorBase.js";

/** Artifact inventory or extraction failed a typed safety boundary. */
export class ArtifactOperationError extends AnalysisError {
  readonly _tag = "ArtifactOperationError";

  constructor(
    readonly operation:
      | "inventory_artifact"
      | "inspect_artifact"
      | "inspect_desktop_application"
      | "inspect_pe_resources"
      | "extract_artifact"
      | "decode_interface_builder"
      | "inspect_asset_catalog"
      | "inspect_keyed_archive"
      | "trace_dylib_resolution"
      | "export_web_scripts"
      | "trace_web_module_imports"
      | "trace_web_source_location"
      | "analyze_javascript_application",
    readonly reason:
      | "cancelled"
      | "format"
      | "integrity"
      | "limit"
      | "path"
      | "unavailable"
      | "io",
    readonly artifactDetails?: ArtifactIntegrityDetails,
    /** The specific constraint that failed, such as the colliding path. */
    readonly detail?: string,
    options?: AnalysisErrorOptions,
  ) {
    super(
      artifactDetails === undefined
        ? `Artifact ${operation} failed: ${reason}`
        : artifactDetailsMessage(operation, reason, artifactDetails),
      options,
    );
  }
}

const artifactDetailsMessage = (
  operation: string,
  reason: string,
  details: ArtifactIntegrityDetails,
): string => {
  const { logical_path, ...facts } = projectArtifactIntegrityDetails(details);
  const description = Object.entries(facts)
    .map(([key, value]) => `${key}=${String(value ?? "unavailable")}`)
    .join(", ");
  return `Artifact ${operation} failed: ${reason} at ${logical_path} (${description})`;
};
