import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { NativeMacOSProvider } from "./NativeMacOSProvider.js";
import { resolveBundleResourcePlistSelection } from "./NativePlistSource.js";
import { NativeFixtureRunner } from "../../tests/fixtures/nativeCommands.js";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { writeFile } from "node:fs/promises";

it("inspects a resolved app plist without executable identity", async () => {
  const bundle = await createTestTempDirectory("rea-plist-resource-root-");
  const infoPlist = join(bundle, "Info.plist");
  await writeFile(infoPlist, '<?xml version="1.0"?><plist><dict/></plist>');
  const root = {
    callerPath: bundle,
    canonicalPath: bundle,
    infoPlistPath: infoPlist,
    layout: "root" as const,
    executableSha256: null,
  };
  expect(resolveBundleResourcePlistSelection(root, undefined)).toEqual({
    ok: true,
    value: { path: infoPlist, origin: "default" },
  });
  expect(resolveBundleResourcePlistSelection(root, "Info.plist")).toEqual({
    ok: true,
    value: { path: infoPlist, origin: "selected" },
  });
  const client = new NativeMacOSProvider(
    {},
    new NativeFixtureRunner(),
    "darwin",
  ).createBundleResourceClient(root);
  onTestFinished(async () => {
    await client.close();
  });
  const inspected = await client.execute("inspect_plist", {});
  expect(inspected.ok).toBe(true);
  if (inspected.ok)
    expect(inspected.value.result).toMatchObject({
      source_path: infoPlist,
      resource_root: {
        canonical_path: bundle,
        executable_sha256: null,
      },
    });
});
