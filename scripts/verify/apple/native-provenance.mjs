import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { toolContract } from "../../../dist/contracts/toolContracts.js";
import {
  artifactCliEvidence,
  withArtifactMcp,
  withBundleResourcesMcp,
} from "../../lib/artifact-e2e.mjs";

/** Inspect the compiled bundle with real native utilities through both adapters. */
export async function verifyNativeProvenance(app, executable) {
  const original = await readFile(executable);
  const sha256 = createHash("sha256").update(original).digest("hex");
  const symbols = ["$s4main3FooV", "plain_symbol"];
  const operations = [
    ["inspect_macho", []],
    ["inspect_signature", []],
    ["list_architectures", []],
    ["demangle_swift", symbols],
  ];
  const observations = [];
  const resourcePlistCli = toolContract("inspect_plist").outputSchema.parse(
    await artifactCliEvidence("inspect-plist", app),
  );
  assert.equal(resourcePlistCli.subject, null);
  assert.equal(resourcePlistCli.raw_result, null);
  await withBundleResourcesMcp(app, async (client) => {
    const response = await client.callTool({
      name: "inspect_plist",
      arguments: {},
    });
    assert.notEqual(response.isError, true, JSON.stringify(response));
    const mcp = toolContract("inspect_plist").outputSchema.parse(
      response.structuredContent,
    );
    assert.equal(mcp.subject, null);
    assert.equal(mcp.raw_result, null);
    assert.deepEqual(mcp.normalized_result, resourcePlistCli.normalized_result);
    assert.deepEqual(
      JSON.parse(response.content.find((item) => item.type === "text").text),
      response.structuredContent,
    );
    await client.ping();
    observations.push({
      operation: "inspect_plist_resource_root",
      commands: resourcePlistCli.normalized_result.provenance.length,
      cli_bytes: Buffer.byteLength(JSON.stringify(resourcePlistCli)),
      mcp_bytes: Buffer.byteLength(JSON.stringify(response)),
    });
  });

  const binaryPlistCli = toolContract("inspect_plist").outputSchema.parse(
    await artifactCliEvidence("inspect-plist", executable),
  );
  assert.equal(binaryPlistCli.subject?.digest.sha256, sha256);
  assert.equal(binaryPlistCli.raw_result, null);
  assert.equal(binaryPlistCli.normalized_result.resource_root, undefined);
  await withArtifactMcp(app, async (client) => {
    const definitions = new Map(
      (await client.listTools()).tools.map((tool) => [tool.name, tool]),
    );
    const plistResponse = await client.callTool(
      { name: "inspect_plist", arguments: {} },
      { toolDefinition: definitions.get("inspect_plist") },
    );
    assert.notEqual(plistResponse.isError, true, JSON.stringify(plistResponse));
    const binaryPlistMcp = toolContract("inspect_plist").outputSchema.parse(
      plistResponse.structuredContent,
    );
    assert.equal(binaryPlistMcp.subject?.digest.sha256, sha256);
    assert.equal(binaryPlistMcp.raw_result, null);
    assert.equal(binaryPlistMcp.normalized_result.resource_root, undefined);
    assert.deepEqual(
      binaryPlistMcp.normalized_result,
      binaryPlistCli.normalized_result,
    );
    assert.deepEqual(
      JSON.parse(
        plistResponse.content.find((item) => item.type === "text").text,
      ),
      plistResponse.structuredContent,
    );
    await client.ping();
    observations.push({
      operation: "inspect_plist_binary_bound",
      commands: binaryPlistCli.normalized_result.provenance.length,
      cli_bytes: Buffer.byteLength(JSON.stringify(binaryPlistCli)),
      mcp_bytes: Buffer.byteLength(JSON.stringify(plistResponse)),
    });

    for (const [operation, arguments_] of operations) {
      const cli = toolContract(operation).outputSchema.parse(
        await artifactCliEvidence(
          operation.replaceAll("_", "-"),
          app,
          arguments_,
        ),
      );
      const response = await client.callTool(
        {
          name: operation,
          arguments: operation === "demangle_swift" ? { symbols } : {},
        },
        { toolDefinition: definitions.get(operation) },
      );
      assert.notEqual(response.isError, true, JSON.stringify(response));
      const mcp = toolContract(operation).outputSchema.parse(
        response.structuredContent,
      );
      assert.equal(cli.raw_result, null);
      assert.equal(mcp.raw_result, null);
      assert.ok(cli.normalized_result.provenance.length > 0);
      assert.deepEqual(mcp.normalized_result, cli.normalized_result);
      if (operation === "inspect_macho") {
        const delayed = cli.normalized_result.load_commands.items.find(
          ({ fields }) => fields.name === "@rpath/libdelay.dylib (offset 28)",
        );
        assert.equal(delayed?.kind, "LC_LOAD_DYLIB");
        assert.equal(delayed.fields.options, "delay-init");
        assert.equal(delayed.fields["time stamp"], undefined);
        assert.ok(
          cli.normalized_result.dependencies.items.some(
            ({ path }) => path === "@rpath/libdelay.dylib",
          ),
        );
      }
      assert.deepEqual(
        JSON.parse(response.content.find((item) => item.type === "text").text),
        response.structuredContent,
      );
      await client.ping();
      observations.push({
        operation,
        commands: cli.normalized_result.provenance.length,
        cli_bytes: Buffer.byteLength(JSON.stringify(cli)),
        mcp_bytes: Buffer.byteLength(JSON.stringify(response)),
      });
    }
  });
  assert.deepEqual(await readFile(executable), original);
  return {
    real_native_utilities: true,
    target_sha256: sha256,
    bytes_unchanged: true,
    observations,
  };
}
