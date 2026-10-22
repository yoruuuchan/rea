import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import type { NativeExportsService } from "../application/binaryDiagnostics/NativeExportsService.js";
import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import { toolContract } from "../contracts/toolContracts.js";
import type { Logger } from "pino";
import { createEvidenceToolHandler } from "./contractToolHandler.js";
import type { WithAdmittedAnalysis } from "./analysisAdmission.js";
import { applicationToolRegistrationOptions } from "./toolRegistrationOptions.js";

/** Register the explicit-file export-table workflow and retain its complete Evidence. */
export const registerNativeExportsTool = (
  server: EvidenceMcpServer,
  service: NativeExportsService,
  logger: Logger,
  recordEvidence?: EvidenceWriter["recordEvidence"],
  withAdmittedAnalysis?: WithAdmittedAnalysis,
): void => {
  const contract = toolContract("inspect_native_exports");
  const handler = createEvidenceToolHandler(
    server,
    (input, options) => service.inspect(input, options),
    logger,
    recordEvidence,
    withAdmittedAnalysis,
  );
  server.registerTool(
    contract.name,
    applicationToolRegistrationOptions(contract),
    handler(contract),
  );
};
