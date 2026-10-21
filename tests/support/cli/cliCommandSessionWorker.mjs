import { Writable } from "node:stream";
import { access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createCliSessionFrameReader,
  encodeCliSessionFrame,
} from "./cliCommandSessionFrames.mjs";

// One-shot command sequence matches scripts/rea.mjs. Output is captured per
// command so this process can serve the next invocation without restarting.
const packageRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const { default: packageJson } = await import(
  new URL("../../../package.json", import.meta.url),
  { with: { type: "json" } }
);

const prepareCliProcess = () => {
  process.env.REA_PACKAGE_VERSION = packageJson.version;
  // Windows home lookup throws for an empty USERPROFILE. Dependencies resolve
  // home during import, before REA's own resolver can apply its account fallback.
  if (process.platform === "win32" && process.env.USERPROFILE === "") {
    delete process.env.USERPROFILE;
  }
  if (
    process.platform === "android" &&
    process.env.PLAYWRIGHT_BROWSERS_PATH === undefined
  ) {
    const cacheRoot =
      process.env.XDG_CACHE_HOME ?? join(process.env.HOME ?? ".", ".cache");
    process.env.PLAYWRIGHT_BROWSERS_PATH = join(cacheRoot, "ms-playwright");
  }
};

const runtimeFiles = [
  "dist/cli-runtime/cli.js",
  "dist/cli-runtime/cliOutput.js",
  "dist/cli-runtime/cliResultOutput.js",
];

prepareCliProcess();
if (!(await compiledRuntimeExists(runtimeFiles))) {
  process.stderr.write(
    `REA's compiled runtime is missing. Run \`npm ci && npm run build:cached\` in ${packageRoot} to install dependencies and build REA, then restart it. If this is an installed package, reinstall rea-agents.\n`,
  );
  process.exit(1);
}

const { cliConfigurationError, createCli } =
  await import("../../../dist/cli-runtime/cli.js");
const { createCliResultOutput } =
  await import("../../../dist/cli-runtime/cliResultOutput.js");
const {
  normalizeCliArguments,
  renderCliOutputArgumentError,
  renderEmptyFilteredCliOutput,
  validateCliOutputArguments,
} = await import("../../../dist/cli-runtime/cliOutput.js");

const writeFrame = (value) =>
  new Promise((resolveWrite, rejectWrite) => {
    process.stdout.write(encodeCliSessionFrame(value), (error) => {
      if (error) rejectWrite(error);
      else resolveWrite();
    });
  });

await writeFrame({ ready: true });

let chain = Promise.resolve();
const reader = createCliSessionFrameReader((value) => {
  chain = chain.then(
    () => handle(value),
    () => handle(value),
  );
});
process.stdin.on("data", (chunk) => {
  try {
    reader(chunk);
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  }
});
process.stdin.on("end", () => {
  chain.finally(() => process.exit(0));
});

async function handle(value) {
  const request = value;
  const savedEnv = { ...process.env };
  const savedCwd = process.cwd();
  try {
    if (
      request === null ||
      typeof request !== "object" ||
      !Array.isArray(request.arguments) ||
      typeof request.cwd !== "string" ||
      request.env === null ||
      typeof request.env !== "object"
    ) {
      throw new Error(
        "CLI session command is missing its arguments, cwd, or environment",
      );
    }
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, request.env);
    prepareCliProcess();
    process.chdir(request.cwd);
    const result = await runOneShot(request.arguments);
    await writeFrame({
      id: request.id,
      pid: process.pid,
      rss: process.memoryUsage().rss,
      ...result,
    });
  } catch (error) {
    const id =
      request !== null && typeof request === "object" ? request.id : undefined;
    await writeFrame({
      id,
      pid: process.pid,
      exitCode: 1,
      stdout: "",
      stderr:
        error instanceof Error ? (error.stack ?? error.message) : String(error),
      fatal: true,
    });
    process.exit(1);
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    process.chdir(savedCwd);
  }
}

async function runOneShot(args) {
  const stdoutChunks = [];
  const stderrChunks = [];
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  process.stdout.write = captureWrite(stdoutChunks);
  process.stderr.write = captureWrite(stderrChunks);
  const destination = new Writable({
    write(chunk, encoding, callback) {
      process.stdout.write(chunk, encoding, callback);
    },
  });
  destination.isTTY = process.stdout.isTTY === true;
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  let explicitExit;
  try {
    const cliArgs = normalizeCliArguments(args);
    const outputArguments = validateCliOutputArguments(cliArgs);
    const configurationError = cliConfigurationError(process.env);
    if (configurationError !== undefined && !isDoctorCommand(cliArgs)) {
      process.stderr.write(`${configurationError}\n`);
      process.exitCode = 1;
    } else if (!outputArguments.ok) {
      process.stdout.write(renderCliOutputArgumentError(outputArguments));
      process.exitCode = 1;
    } else {
      let wroteOutput = false;
      const resultOutput = createCliResultOutput(cliArgs, destination);
      try {
        await createCli(process.env, resultOutput).serve(cliArgs, {
          stdout: (output) => {
            if (resultOutput?.handled) {
              if (resultOutput.failed) process.stderr.write(output);
              return;
            }
            if (output.length > 0) wroteOutput = true;
            process.stdout.write(output);
          },
          exit: (code) => {
            explicitExit = code;
          },
        });
      } catch (cause) {
        if (wroteOutput) throw cause;
        const recovered = await resultOutput?.recoverFormattingFailure(cause);
        if (!recovered) throw cause;
        process.exitCode = 1;
      }
      if (!wroteOutput && !resultOutput?.handled) {
        const empty = renderEmptyFilteredCliOutput(cliArgs);
        if (empty) process.stdout.write(empty);
      }
    }
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }
  const exitCode =
    explicitExit ??
    (typeof process.exitCode === "number" ? process.exitCode : 0);
  process.exitCode = previousExitCode;
  return {
    exitCode,
    stdout: Buffer.concat(stdoutChunks).toString("utf8"),
    stderr: Buffer.concat(stderrChunks).toString("utf8"),
  };
}

function captureWrite(chunks) {
  return function patched(chunk, encoding, callback) {
    const encodingName = typeof encoding === "string" ? encoding : "utf8";
    chunks.push(
      Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), encodingName),
    );
    const done = typeof encoding === "function" ? encoding : callback;
    if (typeof done === "function") done();
    return true;
  };
}

function isDoctorCommand(arguments_) {
  const valuedFlags = new Set([
    "--format",
    "--filter-output",
    "--token-limit",
    "--token-offset",
  ]);
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--") return arguments_[index + 1] === "doctor";
    if (valuedFlags.has(argument)) {
      index += 1;
      continue;
    }
    if (argument.startsWith("-")) continue;
    return argument === "doctor";
  }
  return false;
}

async function compiledRuntimeExists(paths) {
  for (const path of paths) {
    try {
      await access(resolve(packageRoot, path));
    } catch (cause) {
      if (isMissing(cause)) return false;
      throw cause;
    }
  }
  return true;
}

function isMissing(cause) {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    cause.code === "ENOENT"
  );
}
