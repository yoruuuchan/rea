import type { ToolContract } from "../contracts/toolContractTypes.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import type { Evidence } from "../domain/evidence.js";
import type { Result } from "../domain/result.js";
import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";

/** Record complete or completed-partial Evidence before projecting MCP output. */
export const deliverObservationEvidence = (
  server: EvidenceMcpServer,
  contract: ToolContract,
  result: Result<Evidence, AnalysisError>,
  recordEvidence: EvidenceWriter["recordEvidence"] | undefined,
) => {
  if (!result.ok) {
    const partial = result.error.partialObservation;
    if (
      partial !== undefined &&
      "evidence_id" in partial &&
      typeof partial.evidence_id === "string"
    ) {
      const recorded = recordEvidence?.(partial);
      if (recorded !== undefined)
        return server.delivery.toRecordedPartialErrorToolResult(
          result.error,
          partial.evidence_id,
          recorded,
          contract.returnsTargetContent,
        );
    }
    return server.delivery.toCallToolResult(result, contract);
  }
  const recorded = recordEvidence?.(result.value);
  return server.delivery.toEvidenceToolResult(result.value, contract, recorded);
};
