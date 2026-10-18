import { ArtifactResourceScope } from "../../dist/artifacts/ArtifactResourceScope.js";
import { AnalysisCleanupLease } from "../../dist/artifacts/AnalysisCleanupLease.js";
import { inspectGhidraInstallation } from "../../dist/ghidra/GhidraInstallation.js";
import { closeVerifierResources } from "./verifier-cleanup.mjs";

/** Complete one prerequisite inspection and release its exact retained owners. */
export async function inspectVerifierGhidraInstallation(options, host) {
  const resources = new ArtifactResourceScope();
  const resourceOwner = {
    retain(owner, resource) {
      resources.retain({
        kind: "lease",
        resource,
        lease: AnalysisCleanupLease.forCloseOwner(owner, resource),
      });
    },
    run: (operation) => resources.run(operation),
  };
  let primaryError;
  try {
    return await inspectGhidraInstallation({ ...options, resourceOwner }, host);
  } catch (cause) {
    primaryError = cause;
    throw cause;
  } finally {
    await closeVerifierResources([() => resources.close()], primaryError);
  }
}
