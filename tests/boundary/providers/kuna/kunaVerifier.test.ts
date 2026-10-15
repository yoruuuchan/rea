import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { expect, it as test } from "vitest";

import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";
import { fakeKunaCalls, writeFakeKuna } from "./fakeKuna.js";

const it = test.skipIf(process.platform === "win32");

it.each([
  { populated: false, names: "main", reason: "No caller-built targets" },
  { populated: true, names: "typo", reason: "No caller-built targets" },
  {
    populated: true,
    names: "main,typo",
    reason: "Requested functions were not found",
  },
])(
  "rejects an unverified caller matrix: $names, populated=$populated",
  async ({ populated, names, reason }) => {
    const root = await createTestTempDirectory("rea-kuna-verifier-selection-");
    const kuna = await writeFakeKuna(root);
    const targets = join(root, "targets");
    await mkdir(targets);
    if (populated) {
      const flavor = join(targets, "linux");
      await mkdir(flavor);
      await writeFile(join(flavor, "program"), "not analyzed");
      await writeFile(join(flavor, "program.stripped"), "not analyzed");
    }
    // Only symbol discovery is simulated; no provider workflow should start.
    const nm = join(root, "nm");
    await writeFile(
      nm,
      `#!${process.execPath}\nprocess.stdout.write("00001000 T main\\n");\n`,
      {
        mode: 0o755,
      },
    );
    const result = spawnSync(
      process.execPath,
      [
        "scripts/verify-real-kuna.mjs",
        "--targets",
        targets,
        "--functions",
        names,
        "--compare-ghidra",
      ],
      {
        encoding: "utf8",
        timeout: 10_000,
        env: {
          PATH: process.env.PATH,
          HOME: root,
          REA_KUNA_COMMAND: kuna,
          REA_NM: nm,
          REA_CC: join(root, "compiler-must-not-run"),
          GHIDRA_INSTALL_DIR: join(root, "ghidra-must-not-run"),
        },
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(reason);
    expect(result.stderr).not.toContain("compiler-must-not-run");
    expect((await fakeKunaCalls(kuna)).map(({ argv }) => argv)).toEqual([
      ["--version"],
    ]);
  },
);

it.each([
  { rejectClose: false, rejectRead: true },
  { rejectClose: true, rejectRead: false },
  { rejectClose: true, rejectRead: true },
])(
  "reports failure-path lineage (cleanup rejection: $rejectClose, read rejection: $rejectRead)",
  async ({ rejectClose, rejectRead }) => {
    const root = await createTestTempDirectory("rea-kuna-verifier-cleanup-");
    const kuna = await writeFakeKuna(root, {
      functions: [
        { name: "rea_checksum", addr: "0x1000" },
        { name: "rea_classify", addr: "0x1040" },
      ],
    });
    const nm = join(root, "nm");
    // The host compiler creates a real fixture, but provider output and symbol
    // discovery are simulated to isolate the verifier's cleanup contract.
    await writeFile(
      nm,
      `#!${process.execPath}\nprocess.stdout.write("00001000 T rea_checksum\\n00001040 T rea_classify\\n");\n`,
      { mode: 0o755 },
    );
    const proxy = join(root, "proxy.mjs");
    const cacheRecord = join(root, "cache-path");
    await writeFile(
      proxy,
      `
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
const backend = spawn(process.execPath, [${JSON.stringify(resolve("scripts/rea.mjs"))}, "--mcp"], { stdio: ["pipe", "pipe", "ignore"] });
const exited = new Promise((resolve, reject) => { backend.once("error", reject); backend.once("exit", resolve); });
backend.stdout.pipe(process.stdout);
const input = createInterface({ input: process.stdin });
for await (const line of input) {
  const message = JSON.parse(line);
  const name = message.params?.name;
  if (name === "close_binary" && ${rejectClose}) {
    const marker = join(process.env.REA_KUNA_CACHE_DIR, "staging", "retained-marker");
    await mkdir(marker, { recursive: true });
    await writeFile(join(marker, "evidence"), "retained cleanup owner");
    await writeFile(${JSON.stringify(cacheRecord)}, process.env.REA_KUNA_CACHE_DIR);
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { isError: true, content: [{ type: "text", text: "injected cleanup rejection" }] } }) + "\\n");
  } else if (name === "list_procedures" && ${rejectRead}) {
    // A verification failure with successful provider cleanup must still
    // produce lineage evidence; it need not retain an otherwise clean root.
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { isError: true, content: [{ type: "text", text: "injected verification failure" }] } }) + "\\n");
  } else backend.stdin.write(line + "\\n");
}
backend.stdin.end();
await exited;
`,
    );
    const reportPath = join(root, "report.json");
    const result = spawnSync(
      process.execPath,
      [
        "scripts/verify-real-kuna.mjs",
        "--entrypoint",
        proxy,
        "--report",
        reportPath,
      ],
      {
        encoding: "utf8",
        timeout: 25_000,
        env: {
          PATH: process.env.PATH,
          HOME: root,
          REA_KUNA_COMMAND: kuna,
          REA_NM: nm,
        },
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    expect(report).toMatchObject({
      status: "failed",
      cleanup: rejectClose ? "incomplete" : "complete",
      verifier_run: {
        process_lineage: { status: "verified", descendants: [] },
      },
    });
    expect(JSON.stringify(report.failures)).toContain(
      rejectClose
        ? "injected cleanup rejection"
        : "injected verification failure",
    );
    if (rejectRead)
      expect(JSON.stringify(report.failures)).toContain(
        "injected verification failure",
      );
    if (rejectClose) {
      const cache = await readFile(cacheRecord, "utf8");
      expect(cache).toBe(join(report.retained_workspace, "cache"));
      try {
        expect(
          await readFile(
            join(cache, "staging", "retained-marker", "evidence"),
            "utf8",
          ),
        ).toBe("retained cleanup owner");
      } finally {
        // The test owns this injected file; production intentionally retains it.
        await rm(report.retained_workspace, { recursive: true, force: true });
      }
    } else expect(report.retained_workspace).toBeUndefined();
  },
);
