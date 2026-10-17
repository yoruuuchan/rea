import {
  cleanupOwnedProcessGroup,
  cleanupWindowsProcessTree,
  verifyNoTokenOwnedProcesses,
  type OwnedProcessGroup,
  type ProcessCleanupResult,
  type ProcessLineageObservation,
  type OwnershipSweepUnverifiedProcess,
} from "../process/ProcessOwnership.js";
import { selectCapturedProcessGroupIds } from "../process/ProcessOwnershipProcessTree.js";

/** Clean up an Electron launch. Windows signals a process only after lineage is verified. */
export const cleanupElectronProcesses = async (
  ownership: OwnedProcessGroup,
  lineage: ProcessLineageObservation | undefined,
  host: {
    readonly platform: NodeJS.Platform;
    readonly terminateTree: typeof cleanupWindowsProcessTree;
  } = {
    platform: process.platform,
    terminateTree: cleanupWindowsProcessTree,
  },
): Promise<ProcessCleanupResult> => {
  if (
    lineage?.status === "verified" &&
    (lineage.lineage.runId !== ownership.runId ||
      lineage.lineage.launcherPid !== ownership.leaderPid ||
      lineage.lineage.processGroupId !== ownership.processGroupId)
  ) {
    return {
      cleaned: false,
      reason: "Electron lineage does not match the retained process owner",
    };
  }
  if (lineage?.status !== "verified") {
    const root =
      host.platform === "win32"
        ? { cleaned: true as const, signaled: false }
        : await cleanupOwnedProcessGroup(ownership);
    if (!root.cleaned) return root;
    const released = await verifyFamilyRelease(ownership, root);
    return released.cleaned
      ? released
      : {
          ...released,
          reason: `${lineage?.reason ?? "owned Electron lineage was not observed"}; helper cleanup was not proven: ${released.reason}`,
        };
  }
  if (host.platform === "win32") {
    // /t already includes descendants. Do not signal cached child PIDs again
    // after awaiting root termination: they may have exited or been reused.
    const root = await host.terminateTree(ownership.leaderPid);
    return root.cleaned ? verifyFamilyRelease(ownership, root) : root;
  }
  const groupIds = selectCapturedProcessGroupIds(
    ownership.leaderPid,
    lineage.lineage.descendants.map(({ pid, processGroupId }) => ({
      pid,
      process_group_id: processGroupId,
    })),
  );
  let signaled = false;
  const unverified: OwnershipSweepUnverifiedProcess[] = [];
  for (const processGroupId of groupIds) {
    const cleanupOwnership: OwnedProcessGroup =
      processGroupId === ownership.processGroupId
        ? { ...ownership, leaderPid: processGroupId, processGroupId }
        : {
            runId: ownership.runId,
            leaderPid: processGroupId,
            processGroupId,
          };
    const result = await cleanupOwnedProcessGroup(cleanupOwnership);
    if (!result.cleaned) return result;
    signaled ||= result.signaled;
    unverified.push(...(result.unverified ?? []));
  }
  return verifyFamilyRelease(ownership, {
    cleaned: true,
    signaled,
    ...(unverified.length === 0 ? {} : { unverified }),
  });
};

const verifyFamilyRelease = async (
  ownership: OwnedProcessGroup,
  root: Extract<ProcessCleanupResult, { readonly cleaned: true }>,
): Promise<ProcessCleanupResult> => {
  const remaining = await verifyNoTokenOwnedProcesses(
    ownership.runId,
    undefined,
    ownership.captureBaseline,
    {
      leaderPid: ownership.leaderPid,
      processGroupId: ownership.processGroupId,
      ...(ownership.sampledProcessGroupIds === undefined
        ? {}
        : { sampledProcessGroupIds: ownership.sampledProcessGroupIds }),
    },
  );
  const unverified = [
    ...(root.unverified ?? []),
    ...(remaining.unverified ?? []),
  ];
  if (!remaining.cleaned)
    return { ...remaining, ...(unverified.length === 0 ? {} : { unverified }) };
  return {
    cleaned: true,
    signaled: root.signaled || remaining.signaled,
    ...(unverified.length === 0
      ? {}
      : {
          unverified: [
            ...new Map(
              unverified.map((item) => [
                `${String(item.pid)}:${item.diagnostic}`,
                item,
              ]),
            ).values(),
          ],
        }),
  };
};
