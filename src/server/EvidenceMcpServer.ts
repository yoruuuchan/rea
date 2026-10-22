import type {
  Implementation,
  McpServerOptions,
} from "@modelcontextprotocol/server";
import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import {
  FULL_CATALOG_IDENTITY,
  createCatalogIdentity,
} from "../catalogIdentity.js";
import type { ToolResultDelivery } from "./toolResult.js";
import {
  EvidenceMcpServerCore,
  type CompactInputSchemaPresentation,
} from "./EvidenceMcpServerCore.js";

export {
  forgetPendingMcpRequest,
  type CompactInputSchemaPresentation,
} from "./EvidenceMcpServerCore.js";

/** Canonical composition retains the constructor's existing identity defaults. */
export class EvidenceMcpServer extends EvidenceMcpServerCore {
  constructor(
    info: Implementation,
    options: McpServerOptions,
    recordEvidence: EvidenceWriter["recordEvidence"] | undefined,
    delivery: ToolResultDelivery,
    compactPresentation: CompactInputSchemaPresentation | undefined = undefined,
    omitOutputSchemas = false,
    identity?: ReturnType<typeof createCatalogIdentity>,
  ) {
    super(
      info,
      options,
      recordEvidence,
      delivery,
      compactPresentation,
      omitOutputSchemas,
      identity ??
        (compactPresentation === undefined && !omitOutputSchemas
          ? FULL_CATALOG_IDENTITY
          : createCatalogIdentity(
              compactPresentation,
              omitOutputSchemas ? "off" : "full",
            )),
    );
  }
}
