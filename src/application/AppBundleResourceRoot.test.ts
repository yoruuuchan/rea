import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import {
  createAnalysisExecution,
  createAnalysisExecutionEvidence,
} from "./AnalysisProvider.js";
import { resolveAppBundleResourceRoot } from "./AppBundleExecutable.js";
import { bindExecutionTarget } from "./binary/BinarySessionExecution.js";
import type { BinaryTarget } from "../domain/binaryTargetTypes.js";

const provider = { id: "test", name: "test", version: null } as const;
const target = {
  path: "/Fixture.app/Contents/Info.plist",
  sha256: "a".repeat(64),
  kind: "artifact",
  format: "plist",
} satisfies BinaryTarget;

it("resolves resource roots without requiring or hashing CFBundleExecutable", async () => {
  const temp = await mkdtemp(join(tmpdir(), "rea-app-resource-root-"));
  try {
    const bundle = join(temp, "Fixture.app");
    const contents = join(bundle, "Contents");
    const alias = join(temp, "Selected.app");
    await mkdir(contents, { recursive: true });
    await writeFile(join(contents, "Info.plist"), "<plist><dict/></plist>");
    await symlink(bundle, alias);

    const resolved = await resolveAppBundleResourceRoot(alias);

    expect(resolved).toEqual({
      ok: true,
      value: {
        callerPath: alias,
        canonicalPath: bundle,
        infoPlistPath: join(bundle, "Contents", "Info.plist"),
        layout: "contents",
        executableSha256: null,
      },
    });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

it("resolves a flat bundle resource root without inferring executable identity", async () => {
  const temp = await mkdtemp(join(tmpdir(), "rea-ios-resource-root-"));
  try {
    const bundle = join(temp, "Fixture.app");
    await mkdir(bundle);
    await writeFile(join(bundle, "Info.plist"), "<plist><dict/></plist>");

    const resolved = await resolveAppBundleResourceRoot(bundle);

    expect(resolved).toMatchObject({
      ok: true,
      value: {
        callerPath: bundle,
        canonicalPath: bundle,
        infoPlistPath: join(bundle, "Info.plist"),
        layout: "root",
        executableSha256: null,
      },
    });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

it("distinguishes default target binding from an explicitly unbound observation", () => {
  const defaultSubject = createAnalysisExecution({ ok: true }, provider);
  const unbound = createAnalysisExecution({ ok: true }, provider, {
    subject: null,
  });

  const bound = bindExecutionTarget(
    { ok: true, value: defaultSubject },
    "inspect_plist",
    target,
  );
  const preserved = bindExecutionTarget(
    { ok: true, value: unbound },
    "inspect_plist",
    target,
  );

  expect(bound.ok && bound.value.subject).toEqual({
    path: target.path,
    sha256: target.sha256,
    format: "plist",
  });
  expect(preserved.ok && preserved.value.subject).toBeNull();
  expect(
    createAnalysisExecutionEvidence("inspect_plist", {}, unbound, "observed")
      .subject,
  ).toBeNull();
});
