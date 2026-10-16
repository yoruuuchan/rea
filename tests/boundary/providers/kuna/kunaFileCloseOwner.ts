import { ArtifactResourceScope } from "../../../../src/artifacts/ArtifactResourceScope.js";
import type { FileCloseResourceOwner } from "../../../../src/application/AnalysisProvider.js";
import type { KunaInstallationOptions } from "../../../../src/kuna/KunaInstallation.js";
import { inspectKunaInstallation } from "../../../../src/kuna/KunaInstallation.js";
import { inspectKunaProvider } from "../../../../src/kuna/KunaDoctor.js";

export const withKunaFileCloseOwner = async <T>(
  operation: (owner: FileCloseResourceOwner) => Promise<T>,
): Promise<T> => {
  const scope = new ArtifactResourceScope();
  const owner: FileCloseResourceOwner = {
    retain: (handle, resource) =>
      scope.retain({
        kind: "lease",
        resource,
        lease: { release: () => handle.close() },
      }),
    run: (work) => scope.run(work),
  };
  try {
    return await operation(owner);
  } finally {
    await scope.close();
  }
};

export const inspectKunaInstallationOwned = (
  environment: Readonly<NodeJS.ProcessEnv>,
  options: Omit<KunaInstallationOptions, "fileCloseResources"> = {},
) =>
  withKunaFileCloseOwner((fileCloseResources) =>
    inspectKunaInstallation(environment, { ...options, fileCloseResources }),
  );

export const inspectKunaProviderOwned = (
  environment: Readonly<NodeJS.ProcessEnv>,
  platform?: NodeJS.Platform,
) =>
  withKunaFileCloseOwner((fileCloseResources) =>
    inspectKunaProvider(environment, platform, { fileCloseResources }),
  );
