import {
  inspectPythonPycInputSchema,
  pythonPycSchema,
} from "../../domain/python/pythonPyc.js";
import type { ToolContract } from "../toolContractTypes.js";
import { toolContractMetadata } from "../toolEffects.js";
import { evidenceResultOf } from "../toolOutputSchemaPrimitives.js";

/** Static CPython pyc inspection is independent of active native-analysis providers. */
export const PYTHON_PYC_TOOL_CONTRACTS = [
  {
    name: "inspect_python_pyc",
    ...toolContractMetadata("inspect_python_pyc"),
    kind: "artifact-provider",
    description:
      "Inspect one explicit local CPython 3.7–3.13 .pyc file without executing bytecode, invoking CPython or recovering source. Returns the 16-byte header (magic, pinned python_version, PEP 552 flags, source hash or mtime/size), the top-level code object with nested functions, names, const summaries, and bytecode length/SHA-256. Marshal is walked with object, depth and string budgets; unknown magics, truncated streams and exhausted budgets return no partial success. A decoded header is not proof the matching .py is present. Portable on supported Node hosts; no Python installation required.",
    inputSchema: inspectPythonPycInputSchema,
    outputSchema: evidenceResultOf(pythonPycSchema),
    examples: [
      {
        title: "Inspect a CPython 3.12 pyc header and nested code objects",
        input: { path: "/artifacts/module.pyc" },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
