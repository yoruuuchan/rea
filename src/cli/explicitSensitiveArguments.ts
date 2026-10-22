import { AsyncLocalStorage } from "node:async_hooks";

import { Errors, Formatter, z, type MiddlewareHandler } from "incur";

import {
  cliOutputValueRejection,
  splitIncurBuiltinArguments,
  type IncurBuiltinArgumentSplit,
} from "../cliOutput.js";
import { redactExplicitText } from "../domain/explicitSensitiveValues.js";
import type { CliInstance } from "./types.js";
import { visitRegisteredCommands } from "./visitRegisteredCommands.js";

/** Repeatable option whose literals the command and its CLI diagnostics exclude. */
export const explicitSensitiveValueOptions = {
  sensitiveValue: z
    .array(z.string().min(1))
    .default([])
    .describe(
      "Literal string values explicitly marked sensitive; repeat as needed",
    ),
};

const OPTION =
  "sensitiveValue" satisfies keyof typeof explicitSensitiveValueOptions;
/** Incur accepts the schema key and its kebab-case spelling. */
const FLAGS = ["--sensitive-value", "--sensitiveValue"] as const;

/**
 * Read declarations from the tokens Incur leaves for command parsing. Incur
 * rejects a malformed token before it reaches later declarations, so this scan
 * is independent of parse success. A token following a declaration flag counts
 * as declared even where the command parser would bind it to another option.
 */
const declaredSensitiveValues = (
  command: IncurBuiltinArgumentSplit["command"],
): readonly string[] => {
  const values = new Set<string>();
  for (let index = 0; index < command.length; index += 1) {
    const token = command[index]!;
    const flag = FLAGS.find(
      (candidate) => token === candidate || token.startsWith(`${candidate}=`),
    );
    if (flag === undefined) continue;
    if (token !== flag) values.add(token.slice(flag.length + 1));
    else if (index + 1 < command.length) {
      values.add(command[index + 1]!);
      index += 1;
    }
  }
  values.delete("");
  return [...values];
};

type ServeOptions = NonNullable<Parameters<CliInstance["serve"]>[1]>;

/**
 * Incur rejects an output value in its builtin pass, before command resolution
 * and outside any middleware, then renders the message it built. Report that
 * same first rejection here so the whole message follows the declarations,
 * as parser failures do; the code and Incur's rendering stay unchanged. It
 * precedes command resolution, so declarations apply whichever command follows.
 */
const reportDeclaredOutputRejection = (
  arguments_: readonly string[],
  outputValues: IncurBuiltinArgumentSplit["outputValues"],
  values: readonly string[],
  options: ServeOptions,
): boolean => {
  const rejection = outputValues
    .map(({ flag, index }) => cliOutputValueRejection(flag, arguments_[index]!))
    .find((message) => message !== undefined);
  if (rejection === undefined) return false;
  const error = {
    code: "UNKNOWN",
    message: redactExplicitText(rejection, values),
  };
  // Incur has not seen --format or --json yet, so only a TTY selects prose.
  const output =
    process.stdout.isTTY === true
      ? `Error: ${error.message}`
      : Formatter.format(error, "toon");
  (options.stdout ?? ((text: string) => process.stdout.write(text)))(
    output.endsWith("\n") ? output : `${output}\n`,
  );
  (options.exit ?? ((code: number) => process.exit(code)))(1);
  return true;
};

/** Keep the thrown type, code and exit status; exclude declared literals from text. */
const withoutDeclaredText = (
  error: unknown,
  values: readonly string[],
): unknown => {
  const text = (value: string): string => redactExplicitText(value, values);
  if (!(error instanceof Error)) {
    const description = String(error);
    return text(description) === description ? error : text(description);
  }
  const message = text(error.message);
  if (error instanceof Errors.ValidationError) {
    // Paths and expectations name the command's own schema.
    const fieldErrors = error.fieldErrors.map((field) => ({
      ...field,
      received: text(field.received),
      message: text(field.message),
    }));
    return message === error.message &&
      fieldErrors.every(
        (field, index) =>
          field.received === error.fieldErrors[index]!.received &&
          field.message === error.fieldErrors[index]!.message,
      )
      ? error
      : new Errors.ValidationError({ message, fieldErrors });
  }
  if (error instanceof Errors.IncurError) {
    const hint = error.hint === undefined ? undefined : text(error.hint);
    return message === error.message && hint === error.hint
      ? error
      : new Errors.IncurError({
          code: error.code,
          message,
          ...(hint === undefined ? {} : { hint }),
          retryable: error.retryable,
          ...(error.exitCode === undefined ? {} : { exitCode: error.exitCode }),
        });
  }
  if (message === error.message) return error;
  return error instanceof Errors.ParseError
    ? new Errors.ParseError({ message })
    : new Error(message);
};

/**
 * Apply `--sensitive-value` declarations to diagnostics produced before the
 * command's own service sees them: rejected output values and the parse,
 * validation and thrown failures of every command that accepts the option.
 * Diagnostic text is redacted whole; codes, keys and rendering stay intact.
 * Returns the serve step; command results keep their own redaction owners.
 */
export const excludeDeclaredSensitiveArguments = (
  cli: CliInstance,
): ((
  arguments_: readonly string[],
  options: ServeOptions,
  serve: (arguments_: string[], options: ServeOptions) => Promise<void>,
) => Promise<void>) => {
  const declarations = new AsyncLocalStorage<readonly string[]>();
  const excludeFromFailures: MiddlewareHandler = async (_context, next) => {
    const values = declarations.getStore();
    if (values === undefined) return next();
    try {
      await next();
    } catch (error) {
      throw withoutDeclaredText(error, values);
    }
  };
  visitRegisteredCommands(cli, (command) => {
    if (
      command.options instanceof z.ZodObject &&
      Object.hasOwn(command.options.shape, OPTION)
    )
      // Outermost, so later command middleware failures are covered as well
      // as the parsing and run that Incur executes inside the chain.
      command.middleware = [excludeFromFailures, ...(command.middleware ?? [])];
  });
  return async (arguments_, options, serve) => {
    const split = splitIncurBuiltinArguments(arguments_);
    const values = declaredSensitiveValues(split.command);
    if (values.length === 0) return serve([...arguments_], options);
    if (
      reportDeclaredOutputRejection(
        arguments_,
        split.outputValues,
        values,
        options,
      )
    )
      return;
    return declarations.run(values, () => serve([...arguments_], options));
  };
};
