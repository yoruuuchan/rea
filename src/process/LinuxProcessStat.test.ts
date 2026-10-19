import { expect, it } from "vitest";

import { parseLinuxProcessStat } from "./LinuxProcessStat.js";

const statRecord = (
  options: {
    readonly pid?: string;
    readonly command?: string;
    readonly state?: string;
    readonly parentPid?: string;
    readonly processGroupId?: string;
    readonly sessionId?: string;
    readonly startTime?: string;
  } = {},
): string => {
  const fields = [
    options.state ?? "S",
    options.parentPid ?? "17",
    options.processGroupId ?? "18",
    options.sessionId ?? "19",
  ];
  while (fields.length < 19) fields.push("0");
  fields.push(options.startTime ?? "987654");
  return `${options.pid ?? "42"} (${options.command ?? "worker"}) ${fields.join(" ")}`;
};

it("parses command names containing parentheses and retains native relation facts", () => {
  expect(
    parseLinuxProcessStat(statRecord({ command: "worker ) old ) name" })),
  ).toEqual({
    pid: 42,
    startTime: "987654",
    lifecycle: "non-zombie",
    parentPid: 17,
    processGroupId: 18,
    sessionId: 19,
  });
});

it("accepts zero parent, process-group, and session IDs as native facts", () => {
  expect(
    parseLinuxProcessStat(
      statRecord({ parentPid: "0", processGroupId: "0", sessionId: "0" }),
    ),
  ).toMatchObject({ parentPid: 0, processGroupId: 0, sessionId: 0 });
});

it("distinguishes zombie lifecycle and rejects malformed or missing identity fields", () => {
  expect(parseLinuxProcessStat(statRecord({ state: "Z" }))?.lifecycle).toBe(
    "zombie",
  );
  expect(parseLinuxProcessStat("(worker) S 1 2 3")).toBeUndefined();
  expect(parseLinuxProcessStat(statRecord({ pid: "0" }))).toBeUndefined();
  expect(parseLinuxProcessStat(statRecord({ state: "??" }))).toBeUndefined();
  expect(parseLinuxProcessStat(statRecord({ startTime: "not-a-number" }))).toBe(
    undefined,
  );
});
