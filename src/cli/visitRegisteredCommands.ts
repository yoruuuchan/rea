import { Cli } from "incur";

import type { CliInstance } from "./types.js";

type CommandMap = NonNullable<ReturnType<typeof Cli.toCommands.get>>;
type CommandEntry = CommandMap extends Map<string, infer Entry> ? Entry : never;
export type RegisteredCommand = Extract<CommandEntry, { run: unknown }>;

// Incur types its router key without vars, env, or globals; accept any CLI.
const registeredCommands: WeakMap<object, CommandMap> = Cli.toCommands;

/** Visit ordinary commands in map order, children before each group's root. */
export const visitRegisteredCommands = (
  cli: CliInstance,
  visit: (command: RegisteredCommand, path: string) => void,
): void => {
  const commands = registeredCommands.get(cli);
  if (commands !== undefined) visitCommands(commands, [], visit);
};

const visitCommands = (
  commands: CommandMap,
  parents: readonly string[],
  visit: (command: RegisteredCommand, path: string) => void,
): void => {
  for (const [name, entry] of commands) {
    const path = [...parents, name];
    if ("_group" in entry) {
      visitCommands(entry.commands, path, visit);
      if (entry.root !== undefined) visit(entry.root, path.join(" "));
    } else if (!("_alias" in entry) && !("_fetch" in entry)) {
      visit(entry, path.join(" "));
    }
  }
};
