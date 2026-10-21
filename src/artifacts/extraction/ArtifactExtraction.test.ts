import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import { ArtifactReaderFailure } from "../ArtifactReader.js";
import { ArtifactResourceScope } from "../ArtifactResourceScope.js";
import { OwnedFileHandle } from "../../filesystem/OwnedFileHandle.js";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { extractArtifact } from "./ArtifactExtraction.js";

vi.mock("../pyinstaller/CArchiveLayout.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  containsPyInstallerArchive: () =>
    Promise.reject(new ArtifactReaderFailure("format", "detection failed")),
}));

it("keeps the detection error primary and reports a failed detection close", async () => {
  const directory = await createTestTempDirectory("rea-extraction-detect-");
  const path = join(directory, "target.elf");
  await writeFile(path, Buffer.from("not an archive"));
  const resourceScope = new ArtifactResourceScope();
  const originalClose = OwnedFileHandle.prototype.close;
  const closeFailure = new Error("detection close failed");
  let attempts = 0;
  const close = vi
    .spyOn(OwnedFileHandle.prototype, "close")
    .mockImplementation(async function (this: OwnedFileHandle) {
      attempts += 1;
      if (attempts === 1) throw closeFailure;
      await originalClose.call(this);
    });
  try {
    await expect(
      extractArtifact({
        inputPath: path,
        inputFormat: "elf",
        outputRoot: join(directory, "out"),
        environment: process.env,
        integrityPolicy: "fail",
        resourceScope,
      }),
    ).rejects.toMatchObject({
      reason: "format",
      message: "detection failed",
      cleanup: { reason: closeFailure.message },
    });
    await resourceScope.close();
    expect(attempts).toBe(2);
  } finally {
    close.mockRestore();
    await resourceScope.close().catch(() => undefined);
  }
});
