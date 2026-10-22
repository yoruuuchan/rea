import { expect, it, vi } from "vitest";
import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { LocalWebScriptArtifacts } from "./assets/LocalWebScriptArtifacts.js";
import { closeWebArtifactResources } from "./WebArtifactCleanup.js";

it("closes a shared script/resource scope once", async () => {
  const resources = new ArtifactResourceScope();
  const close = vi.spyOn(resources, "close").mockResolvedValue();
  const scripts = new LocalWebScriptArtifacts(
    "trace_web_module_imports",
    resources,
  );

  await closeWebArtifactResources("web-module-artifacts", resources, scripts);

  expect(close).toHaveBeenCalledTimes(1);
});

it.each([
  ["web-module-artifacts", "trace_web_module_imports", "web module artifacts"],
  [
    "web-source-location-artifacts",
    "trace_web_source_location",
    "web source-location artifacts",
  ],
] as const)(
  "attempts both cleanup owners and retries them for %s",
  async (owner, operation, resource) => {
    const resources = new ArtifactResourceScope();
    let resourceCloseCalls = 0;
    resources.addCloseHook(async () => {
      resourceCloseCalls++;
      if (resourceCloseCalls === 1)
        throw new Error("artifact close refused once");
    });
    const scripts = new LocalWebScriptArtifacts(
      "trace_web_module_imports",
      new ArtifactResourceScope(),
    );
    let scriptCloseCalls = 0;
    vi.spyOn(scripts, "close").mockImplementation(async () => {
      scriptCloseCalls++;
      if (scriptCloseCalls === 1) throw new Error("script close refused once");
    });

    await expect(
      closeWebArtifactResources(owner, resources, scripts),
    ).rejects.toMatchObject({
      operation,
      cleanupResources: [resource, "web scripts"],
      diagnostics: {
        failures: [
          {
            message: "artifact close refused once",
            resource: [resource],
          },
          {
            message: "script close refused once",
            resource: ["web scripts"],
          },
        ],
      },
    });
    expect(resourceCloseCalls).toBe(1);
    expect(scriptCloseCalls).toBe(1);

    await closeWebArtifactResources(owner, resources, scripts);
    expect(resourceCloseCalls).toBe(2);
    expect(scriptCloseCalls).toBe(2);
  },
);
