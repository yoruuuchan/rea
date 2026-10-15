import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** One function the fake exports; `error` renders Kuna's failed-function header. */
export interface FakeKunaFunction {
  readonly name: string;
  readonly addr: string;
  readonly error?: string;
}

/** Scripted behavior of the fake `kuna` executable for one test. */
export interface FakeKunaBehavior {
  /** Text printed by `--version`; `exit` fails the probe instead. */
  readonly version?:
    | { readonly stdout: string }
    | { readonly exit: number }
    | { readonly ignoreTerm: true };
  readonly inventory?: "ok" | "not-json" | "hang";
  readonly project?:
    | "ok"
    | "exit-failure"
    | "hang"
    | "miscounted"
    | "silent"
    | "block-manifest";
  readonly functions?: readonly FakeKunaFunction[];
  /** Extra `.asm` bytes, for capacity tests. */
  readonly asmPadding?: number;
  /** Extra C comment bytes inside each exported body, for buffered-read capacity. */
  readonly cPadding?: number;
  readonly decompile?: "ok" | "hang";
  /** Milliseconds `functions --json` takes before printing. */
  readonly inventoryDelayMs?: number;
  /** Milliseconds the export takes before writing its files. */
  readonly delayMs?: number;
}

/**
 * The fake reads its behavior from `<script>.json` and appends one line per
 * invocation to `<script>.calls`. REA gives Kuna children no PATH, so the
 * shebang names this Node binary directly. Output formats follow Kuna 1.833:
 * `functions --json` and the `// Function:` headers of `render_c`.
 */
const SCRIPT = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const behavior = JSON.parse(fs.readFileSync(__filename + ".json", "utf8"));
fs.appendFileSync(__filename + ".calls", JSON.stringify({ pid: process.pid, argv: process.argv.slice(2), home: process.env.HOME, xdg: process.env.XDG_CACHE_HOME, path: process.env.PATH ?? null }) + "\n");
const args = process.argv.slice(2);
const functions = behavior.functions ?? [{ name: "main", addr: "0x1000" }, { name: "helper", addr: "0x1040" }];
const hang = () => setInterval(() => {}, 1000);
if (args[0] === "--version") {
  const version = behavior.version ?? { stdout: "kuna 1.833\n" };
  if ("exit" in version) { process.stderr.write("version probe failed\n"); process.exit(version.exit); }
  if ("ignoreTerm" in version) { process.on("SIGTERM", () => {}); hang(); }
  else process.stdout.write(version.stdout);
} else if (args[0] === "functions") {
  const mode = behavior.inventory ?? "ok";
  if (mode === "hang") hang();
  else if (mode === "not-json") process.stdout.write("functions: 2\n");
  else {
    const listed = [...functions, { name: "puts", addr: "0x2000" }].map((fn) => ({ name: fn.name, address: parseInt(fn.addr, 16), address_hex: fn.addr, aliases: [], object_location: null, size: fn.name === "puts" ? 0 : 16 }));
    setTimeout(() => process.stdout.write(JSON.stringify({ binary: args[1], count: listed.length, total: listed.length, error: null, functions: listed }, null, 2) + "\n"), behavior.inventoryDelayMs ?? 0);
  }
} else if (args[0] === "decompile-project") {
  const input = args[1];
  const output = args[args.indexOf("-o") + 1];
  const stem = path.basename(input);
  const mode = behavior.project ?? "ok";
  if (mode === "hang") hang();
  else if (mode === "exit-failure") { process.stderr.write("error: not in recognized object file format\n"); process.exit(1); }
  else setTimeout(() => {
    fs.mkdirSync(output, { recursive: true });
    let c = '#include "' + stem + '.h"\n\n';
    functions.forEach((fn, index) => {
      c += fn.error === undefined
        ? "// Function: " + fn.name + " @ " + fn.addr + "\nint " + fn.name + "(void)\n{\n  return " + index + ";\n" + (behavior.cPadding ? "  /*" + "x".repeat(behavior.cPadding) + "*/\n" : "") + "}\n\n"
        : "// Function: " + fn.name + " @ " + fn.addr + "  (error: " + fn.error + ")\n\n";
    });
    fs.writeFileSync(path.join(output, stem + ".c"), c);
    fs.writeFileSync(path.join(output, stem + ".h"), "#pragma once\n");
    let asm = "; kuna decompile-project — " + stem + "\n\n; --- code section 0x1000..0x2000 ---\n\n";
    functions.forEach((fn) => { asm += fn.name + ":  ; " + fn.addr + "\n  " + fn.addr.slice(2).padStart(8, "0") + ": c3     RET\n\n"; });
    asm += "; --- data ---\n\ndat_3000:  ; 0x3000 = dat_3000\n  00003000: 00\n\ng_table:  ; 0x3010\n  00003010: 01\n" + "x".repeat(behavior.asmPadding ?? 0);
    fs.writeFileSync(path.join(output, stem + ".asm"), asm);
    fs.writeFileSync(path.join(output, "README.md"), "# " + stem + "\n");
    // Occupy the manifest path so REA's publication write fails.
    if (mode === "block-manifest") fs.mkdirSync(path.join(output, "..", "manifest.json"));
    const failed = functions.filter((fn) => fn.error !== undefined).length;
    const reported = mode === "miscounted" ? functions.length + 1 : functions.length - failed;
    if (mode !== "silent") process.stdout.write("wrote " + output + ": " + stem + ".c (" + c.length + " bytes); functions: " + reported + " ok, " + failed + " failed\n");
  }, behavior.delayMs ?? 0);
} else if (args[0] === "decompile") {
  // decompile <input> <0xaddr> --addr: the single-function path.
  const fn = functions.find((candidate) => candidate.addr === args[2]);
  if (behavior.decompile === "hang") hang();
  else if (fn === undefined) { process.stderr.write("error: no function at " + args[2] + "\n"); process.exit(1); }
  else process.stdout.write("int " + fn.name + "(void) // single-function\n{\n  return 0;\n}\n");
} else {
  process.stderr.write("unexpected command\n");
  process.exit(2);
}
`;

/** Write a fake `kuna` into a directory and return its path. */
export const writeFakeKuna = async (
  directory: string,
  behavior: FakeKunaBehavior = {},
): Promise<string> => {
  const path = join(directory, "kuna");
  await writeFile(path, `#!${process.execPath}\n${SCRIPT}`, { mode: 0o755 });
  await writeFile(`${path}.json`, JSON.stringify(behavior));
  return path;
};

/** Replace the scripted behavior of an existing fake. */
export const setFakeKunaBehavior = (
  path: string,
  behavior: FakeKunaBehavior,
): Promise<void> => writeFile(`${path}.json`, JSON.stringify(behavior));

/** Invocations the fake recorded, oldest first. */
export const fakeKunaCalls = async (
  path: string,
): Promise<
  readonly {
    readonly pid: number;
    readonly argv: readonly string[];
    readonly home: string;
    readonly xdg: string;
    readonly path: string | null;
  }[]
> => {
  const text = await readFile(`${path}.calls`, "utf8").catch(() => "");
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as never);
};
