import { workflowUnknownInput } from "../../application/investigation/WorkflowUnknown.js";
import type { EvidenceMcpServer } from "../EvidenceMcpServer.js";
import { runAdmittedToolOperation } from "../admittedToolOperation.js";
import { recordSessionEvidenceSources } from "../sessionEvidence.js";

import { executeManagedNativeBoundaries } from "../../application/managed/ManagedNativeVerificationService.js";
import { logToolExecution } from "../toolLogging.js";
import { toolRegistrationOptions } from "../toolRegistrationOptions.js";
import { managedWorkflowContract } from "./contract.js";
import type { ManagedWorkflowToolRegistration } from "./types.js";

const nativeVerificationContract = managedWorkflowContract(
  "verify_managed_native_boundaries",
);

/** Register the managed/native boundary verification workflow tool. */
export const registerVerifyManagedNativeBoundaries = (
  server: EvidenceMcpServer,
  options: ManagedWorkflowToolRegistration,
): void => {
  server.registerTool(
    nativeVerificationContract.name,
    toolRegistrationOptions(nativeVerificationContract),
    async (input, context) =>
      runAdmittedToolOperation(
        server,
        options.withAdmittedAnalysis,
        nativeVerificationContract.name,
        context.mcpReq.signal,
        async () => {
          const result = await logToolExecution(
            options.logger,
            nativeVerificationContract.name,
            () => Promise.resolve(executeManagedNativeBoundaries(input)),
          );
          if (!result.ok)
            return server.delivery.toCallToolResult(
              result,
              nativeVerificationContract,
            );
          const execution = result.value;
          const recordedSources = recordSessionEvidenceSources(
            options.recordEvidence,
            execution.sourceEvidence,
          );
          if (!recordedSources.ok)
            return server.delivery.toCallToolResult(
              recordedSources,
              nativeVerificationContract,
            );
          const summary = execution.summary;
          const unknown =
            summary.unresolved > 0 ||
            summary.contradicted > 0 ||
            summary.native_body_unresolved > 0;
          const unknownInput = unknown
            ? workflowUnknownInput(execution.evidence.evidence_id, {
                question:
                  "Which managed/native boundaries remain unresolved or contradicted by the supplied native Evidence?",
                severity: "medium",
                domain: "managed-native-verification",
                required_authority: "shipped-artifact",
                required_confidence: "observed",
                required_environment: null,
                recommended_probes: [
                  {
                    operation: "inspect_managed_native_boundaries",
                    rationale:
                      "Review the inspection Evidence coverage and limit diagnostics; this operation has no page override, so unresolved declarations must remain unknown.",
                  },
                  {
                    operation: "analyze_function",
                    rationale:
                      "Analyze the provider-resolved native function candidate for the declared export.",
                  },
                ],
                relationships: [],
              })
            : undefined;
          const output =
            unknownInput === undefined
              ? options.recordEvidence?.(execution.evidence)
              : unknownInput.ok
                ? options.recordEvidenceWithUnknown?.(
                    execution.evidence,
                    unknownInput.value,
                  )
                : unknownInput;
          return server.delivery.toEvidenceToolResult(
            execution.evidence,
            nativeVerificationContract,
            output,
          );
        },
      ),
  );
};
