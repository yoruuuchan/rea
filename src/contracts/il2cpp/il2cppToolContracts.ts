import { z } from "zod";
import { il2cppMetadataSummaryViewResultSchema } from "../../domain/analysisView/analysisView.js";
import {
  il2cppMetadataSchema,
  inspectIl2cppMetadataInputSchema,
} from "../../domain/il2cpp/il2cppMetadata.js";
import type { ToolContract } from "../toolContractTypes.js";
import { toolContractMetadata } from "../toolEffects.js";
import { evidenceResultOf } from "../toolOutputSchemaPrimitives.js";

/** Static IL2CPP metadata is independent of native-analysis providers and Unity installations. */
export const IL2CPP_TOOL_CONTRACTS = [
  {
    name: "inspect_il2cpp_metadata",
    ...toolContractMetadata("inspect_il2cpp_metadata"),
    kind: "artifact-provider",
    description:
      "Inspect a local Unity IL2CPP global-metadata.dat (versions 29, 31 and 39). Default summary retains complete Evidence and returns artifact identity, version and counts and parent_evidence_id. Query inspect_analysis_view kind il2cpp-metadata, collection sections/images/types/methods, with exact indices or names, fields and pagination. Types also accept image_indices, namespaces and declaring_types; methods accept declaring_types. Filters intersect and empty arrays select none. Each row always keeps index, scoped to its artifact SHA-256 and collection; page offsets count matching rows in metadata order. Explicit detail complete returns all rows. Reads existing files, with 256 MiB input and 64 MiB encoded-report guards and one active inspection per reader. Unsupported versions and malformed metadata return reasons. Type declaring_type is derived from nestedTypes; native code addresses and runtime behavior remain unknown.",
    inputSchema: inspectIl2cppMetadataInputSchema,
    outputSchema: evidenceResultOf(
      z.union([il2cppMetadataSchema, il2cppMetadataSummaryViewResultSchema]),
    ),
    examples: [
      {
        title: "Summarize metadata and retain rows for paging",
        input: {
          path: "/artifacts/Data/Managed/Metadata/global-metadata.dat",
          detail: "summary",
        },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
