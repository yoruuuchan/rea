import { execFile } from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { expect, it } from "vitest";

import {
  PYTHON_39_MAGIC,
  cArchiveExecutable,
  pyzArchive,
} from "../../src/artifacts/pyinstaller/CArchive.fixture.js";
import { artifactInspectionResultSchema } from "../../src/domain/artifactInspection.js";
import { artifactExtractionResultSchema } from "../../src/domain/artifactGraph.js";
import { parseEvidence } from "../../src/domain/evidence.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";

const execute = promisify(execFile);
const cli = fileURLToPath(new URL("../../scripts/rea.mjs", import.meta.url));

const onefile = async (
  magic = PYTHON_39_MAGIC,
  marker = false,
  compressPyz = false,
): Promise<string> => {
  const directory = await createTestTempDirectory("rea-pyinstaller-cli-");
  const path = join(directory, "hello");
  await writeFile(
    path,
    cArchiveExecutable({
      layout: "2.1",
      pythonVersion: 314,
      pythonLibrary: "libpython3.14.dylib",
      trailer: Buffer.from("signature"),
      members: [
        ...(marker
          ? [
              {
                name: "pyimod00_crypto_key",
                typeCode: "m",
                payload: Buffer.from("key"),
                compress: false,
              },
            ]
          : []),
        {
          name: "pyi-contents-directory _internal",
          typeCode: "o",
          payload: Buffer.alloc(0),
          compress: false,
        },
        {
          name: "../shared/app:assets/data.bin",
          typeCode: "d",
          payload: Buffer.alloc(0),
          compress: false,
        },
        {
          name: "hello",
          typeCode: "s",
          payload: Buffer.from("print('hi')"),
          compress: true,
        },
        {
          name: "PYZ.pyz",
          typeCode: "z",
          payload: pyzArchive({
            magic,
            modules: [
              { name: "app", typeCode: 0, body: Buffer.from("app-body") },
            ],
          }),
          compress: compressPyz,
        },
      ],
    }),
  );
  return path;
};

it("lists CArchive members and the Python version through inspect-artifact", async () => {
  const path = await onefile();
  const result = await execute(process.execPath, [
    cli,
    "inspect-artifact",
    path,
    "--json",
  ]);
  const inspection = artifactInspectionResultSchema.parse(
    parseEvidence(JSON.parse(result.stdout)).normalized_result,
  );
  expect(inspection.subject.root_format).toBe("pyinstaller");
  expect(inspection.next_probes).toEqual([]);
  const inventory = inspection.substeps[0]?.evidence.normalized_result;
  expect(inventory?.manifest.root_format).toBe("pyinstaller");
  const root = inventory?.occurrences.find(
    (occurrence) => occurrence.logical_path === ".",
  );
  expect(root?.format_metadata).toMatchObject({
    kind: "pyinstaller",
    python_version_raw: 314,
    python_major: 3,
    python_minor: 14,
    runtime_option_count: 1,
    external_dependency_count: 1,
  });
  expect(
    inventory?.occurrences.find(
      (item) =>
        item.entry_kind === "metadata" &&
        item.format_metadata?.kind === "pyinstaller-entry" &&
        item.format_metadata.type_code === "o",
    ),
  ).toMatchObject({
    artifact_id: null,
    format_metadata: {
      source_name: "pyi-contents-directory _internal",
      type_code: "o",
    },
  });
  expect(
    inventory?.occurrences.map((occurrence) => occurrence.logical_path),
  ).toEqual(expect.arrayContaining(["hello", "PYZ.pyz", "PYZ.pyz/app.pyc"]));
  expect(
    inventory?.occurrences.find(
      (row) =>
        row.format_metadata?.kind === "pyinstaller-entry" &&
        row.format_metadata.type_code === "d",
    ),
  ).toMatchObject({
    entry_kind: "metadata",
    artifact_id: null,
    format_metadata: {
      dependency_archive: "../shared/app",
      dependency_member: "assets/data.bin",
      dependency_status: "unresolved",
    },
  });
});

it("extracts CArchive members through extract-artifact", async () => {
  const path = await onefile();
  const result = await execute(process.execPath, [
    cli,
    "extract-artifact",
    path,
    "--json",
  ]);
  const extracted = artifactExtractionResultSchema.parse(
    parseEvidence(JSON.parse(result.stdout)).normalized_result,
  );
  const hello = extracted.artifacts.find(
    (artifact) => artifact.relative_path === "hello",
  );
  expect(hello).toBeDefined();
  expect(await readFile(join(extracted.output_root, "hello"))).toHaveLength(
    hello?.bytes_written ?? 0,
  );
  expect(
    await readFile(join(extracted.output_root, "PYZ.pyz", "app.pyc")),
  ).toHaveLength(16 + Buffer.from("app-body").length);
  expect(await readFile(join(extracted.output_root, "hello"))).toEqual(
    Buffer.from("print('hi')"),
  );
  expect(await readdir(extracted.output_root)).not.toContain("__pyinstaller__");
  expect(
    extracted.artifacts.some((item) =>
      item.relative_path.includes("pyi-contents-directory"),
    ),
  ).toBe(false);
});

it("reports unknown traversal through the CLI for an opaque PYZ", async () => {
  const path = await onefile(Buffer.alloc(4), true, true);
  const result = await execute(process.execPath, [
    cli,
    "inspect-artifact",
    path,
    "--json",
  ]);
  const inspection = artifactInspectionResultSchema.parse(
    parseEvidence(JSON.parse(result.stdout)).normalized_result,
  );
  const inventory = inspection.substeps[0]?.evidence.normalized_result;
  expect(inventory?.coverage.status).toBe("unknown");
  expect(inventory?.limitations.join(" ")).toContain("opaque");
  const opaque = inventory?.occurrences.find(
    (row) => row.logical_path === "PYZ.pyz",
  );
  expect(opaque).toMatchObject({
    encrypted: false,
    hash_status: "verified",
    artifact_id: expect.any(String),
    source_location: null,
  });
  expect(opaque?.format_metadata).toMatchObject({
    pyz_python_magic: "00000000",
    pyz_status: "opaque",
    encryption_source: "carchive-marker",
    compression_flag: 1,
  });
});
