import { createInterface } from "node:readline";
import { writeFile } from "node:fs/promises";

const mode = process.env.REA_MCP_PROBE_MODE ?? "serve";

if (mode === "fail") {
  console.error("unrelated probe failure");
  process.exit(1);
}

const respond = (id, result) => {
  const response =
    result === undefined
      ? {
          error: {
            code: -32601,
            message: "unrelated fixture method refusal",
          },
        }
      : { result };
  process.stdout.write(
    `${JSON.stringify({ jsonrpc: "2.0", id, ...response })}\n`,
  );
};

const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  if (request.id === undefined) return;
  if (mode === "hang") return;
  if (mode === "initialize-then-hang" && request.method !== "initialize")
    return;
  if (mode === "hang-on-call" && request.method === "tools/call") {
    const readyPath = process.env.REA_MCP_PROBE_READY_PATH;
    if (readyPath !== undefined) void writeFile(readyPath, "ready");
    return;
  }
  if (mode === "refuse-call" && request.method === "tools/call") {
    respond(request.id, undefined);
    return;
  }
  let result;
  switch (request.method) {
    case "initialize":
      result = {
        protocolVersion: request.params?.protocolVersion ?? "2025-11-25",
        capabilities: { tools: {}, prompts: {} },
        serverInfo: { name: "probe-fixture", version: "1" },
      };
      break;
    case "tools/list":
      result = { tools: [] };
      break;
    case "prompts/list":
      result = { prompts: [] };
      break;
    case "ping":
      result = {};
      break;
    default:
      result = undefined;
  }
  respond(request.id, result);
});
input.on("close", () => {
  process.exit(0);
});
