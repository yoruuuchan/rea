import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { expect, it } from "vitest";

import { parseEvidence } from "../../../src/domain/evidence.js";
import { javascriptApplicationAnalysisResultSchema } from "../../../src/domain/javascript/javascriptApplicationAnalysis.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const execute = promisify(execFile);

it("reports a candidate endpoint through the worker boundary in the public CLI", async () => {
  const root = await createTestTempDirectory("rea-endpoint-candidate-cli-");
  // Retain ambiguous requests while excluding type-erased collection/config reads.
  await writeFile(
    join(root, "main.ts"),
    `
    import * as vscode from "vscode";
    client.post("session");
    (client.get as any)("/api/items");
    (new Headers().get as any)("content-type");
    (new URLSearchParams() as any).delete("q");
    ((vscode.workspace.getConfiguration("editor") as any).get as any)("tabSize");
    (context.globalState.get as any)("lastSession");
    const browser = window as Window;
    (browser.open as any)(method, "browser-context");
    const database = indexedDB as IDBFactory;
    (database.open as any)("fixture-db", "2");
    const cache = caches as CacheStorage;
    (cache.open as any)("fixture-cache");
  `,
  );
  const { stdout } = await execute(
    process.execPath,
    ["scripts/rea.mjs", "analyze-javascript-application", root, "--json"],
    { cwd: process.cwd(), maxBuffer: 16 * 1024 * 1024 },
  );
  const result = javascriptApplicationAnalysisResultSchema.parse(
    parseEvidence(JSON.parse(stdout)).normalized_result,
  );
  expect
    .soft(
      result.graph.nodes
        .filter(({ kind }) => kind === "endpoint")
        .flatMap(({ observations }) =>
          observations.map(({ properties }) => properties.value),
        )
        .sort(),
    )
    .toEqual(["/api/items", "session"]);
  expect(
    result.graph.nodes
      .filter(({ kind }) => kind === "storage")
      .flatMap(({ observations }) =>
        observations.map(
          ({ properties }) =>
            `${String(properties.storage_kind)}:${String(properties.name)}`,
        ),
      )
      .sort(),
  ).toEqual(["cache-storage:fixture-cache", "indexed-db:fixture-db"]);
  const endpoint = result.graph.nodes.find(
    ({ kind, observations }) =>
      kind === "endpoint" &&
      observations.some(({ properties }) => properties.value === "session"),
  );
  expect(endpoint?.observations[0]).toMatchObject({
    properties: {
      endpoint_kind: "network",
      value: "session",
      mechanism: "call:client.post",
      interpretation: "candidate",
    },
    evidence: { state: "inferred", confidence: "low" },
  });
  const edge = result.graph.edges.find(
    ({ target_node_id }) => target_node_id === endpoint?.node_id,
  );
  expect(edge?.properties).toMatchObject({ interpretation: "candidate" });
}, 20_000);
