import { Writable } from "node:stream";
import { createInterface } from "node:readline";

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

const MAX_STDOUT_CHARS = 16 * 1024 * 1024;

const writeMessage = (message) => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

// One CLI instance serves every command. A fresh instance per command retains
// its command registrations after the call returns; production exits instead.
const outputParts = [];
let outputCharacters = 0;
const destination = new Writable({
  write(chunk, _encoding, callback) {
    const text = Buffer.isBuffer(chunk)
      ? chunk.toString("utf8")
      : String(chunk);
    outputCharacters += text.length;
    if (outputCharacters > MAX_STDOUT_CHARS) {
      callback(new Error("Compiled CLI stdout exceeded 16 MiB"));
      return;
    }
    outputParts.push(text);
    callback();
  },
});
Object.defineProperty(destination, "isTTY", { value: false });
const resultOutput = createCliResultOutput(["--json"], destination);
const cli = createCli(process.env, resultOutput);

const resetOutput = () => {
  outputParts.length = 0;
  outputCharacters = 0;
};

const runCommand = async (args) => {
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  resetOutput();
  try {
    const cliArgs = normalizeCliArguments(args);
    const outputArguments = validateCliOutputArguments(cliArgs);
    if (!outputArguments.ok)
      return {
        exitCode: 1,
        stdout: renderCliOutputArgumentError(outputArguments),
      };
    const configurationError = cliConfigurationError(process.env);
    if (configurationError !== undefined)
      return { exitCode: 1, stdout: "", error: configurationError };

    let wroteOutput = false;
    let explicitExit;
    try {
      await cli.serve(cliArgs, {
        stdout: (output) => {
          if (resultOutput?.handled) return;
          if (output.length === 0) return;
          wroteOutput = true;
          destination.write(output);
        },
        exit: (code) => {
          explicitExit = code;
        },
      });
    } catch (cause) {
      return {
        exitCode: 1,
        stdout: outputParts.join(""),
        error:
          cause instanceof Error
            ? (cause.stack ?? cause.message)
            : String(cause),
      };
    }
    if (!wroteOutput && !resultOutput?.handled) {
      const empty = renderEmptyFilteredCliOutput(cliArgs);
      if (empty !== undefined) destination.write(empty);
    }
    // logCliCommand reports some failures only through process.exitCode.
    return {
      exitCode:
        explicitExit ??
        (typeof process.exitCode === "number" ? process.exitCode : 0),
      stdout: outputParts.join(""),
    };
  } finally {
    process.exitCode = previousExitCode;
  }
};

const acceptRequest = async (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch (cause) {
    writeMessage({
      id: -1,
      exitCode: 1,
      stdout: "",
      error: cause instanceof Error ? cause.message : String(cause),
    });
    return;
  }
  const args = request?.args;
  if (
    typeof request?.id !== "number" ||
    !Array.isArray(args) ||
    args.some((argument) => typeof argument !== "string")
  ) {
    writeMessage({
      id: typeof request?.id === "number" ? request.id : -1,
      exitCode: 1,
      stdout: "",
      error: "Compiled CLI session expected an id and string arguments",
    });
    return;
  }
  writeMessage({ id: request.id, ...(await runCommand(args)) });
};

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
writeMessage({ ready: true });
for await (const line of lines) {
  if (line.trim().length === 0) continue;
  await acceptRequest(line);
}
