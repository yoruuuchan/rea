import {
  erlangBeamSchema,
  inspectErlangBeamInputSchema,
} from "../../domain/erlang/beam.js";
import type { ToolContract } from "../toolContractTypes.js";
import { toolContractMetadata } from "../toolEffects.js";
import { evidenceResultOf } from "../toolOutputSchemaPrimitives.js";

/** Static BEAM IFF inspection is independent of active native-analysis providers. */
export const ERLANG_BEAM_TOOL_CONTRACTS = [
  {
    name: "inspect_erlang_beam",
    ...toolContractMetadata("inspect_erlang_beam"),
    kind: "artifact-provider",
    description:
      "Inspect one explicit local Erlang BEAM IFF container without executing bytecode or installing Erlang. Returns FOR1 form bounds, chunk names, payload SHA-256, Atom/AtU8 names, export/import/lambda tables with resolved atom names when present, and the Code chunk instruction-set header. Missing optional tables stay null rather than empty-everywhere. Reads a stable regular file; malformed FOR1/BEAM headers, truncated chunks and exhausted budgets return no partial success. Portable on supported Node hosts; no BEAM emulator is required.",
    inputSchema: inspectErlangBeamInputSchema,
    outputSchema: evidenceResultOf(erlangBeamSchema),
    examples: [
      {
        title: "Inspect BEAM atoms, exports and the Code header",
        input: { path: "/artifacts/app.beam" },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
