/** Native process facts parsed from one Linux `/proc/<pid>/stat` record. */
export interface LinuxProcessStat {
  readonly pid: number;
  readonly startTime: string;
  readonly lifecycle: "non-zombie" | "zombie";
  readonly parentPid: number;
  readonly processGroupId: number;
  readonly sessionId: number;
}

/**
 * Parse the changing command field by its final `)`, then validate the native
 * identity and relation fields. Zero is valid for the native group/session
 * facts; callers may impose narrower admission rules for their own purpose.
 */
export const parseLinuxProcessStat = (
  value: string,
): LinuxProcessStat | undefined => {
  const commandStart = value.indexOf("(");
  const commandEnd = value.lastIndexOf(")");
  if (commandStart <= 0 || commandEnd <= commandStart) return undefined;

  const pidText = value.slice(0, commandStart).trim();
  if (!/^\d+$/u.test(pidText)) return undefined;
  const pid = Number(pidText);
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;

  const fields = value
    .slice(commandEnd + 1)
    .trim()
    .split(/\s+/u);
  const state = fields[0];
  const parentPidText = fields[1];
  const processGroupIdText = fields[2];
  const sessionIdText = fields[3];
  const startTime = fields[19];
  if (
    state === undefined ||
    !/^[A-Za-z]$/u.test(state) ||
    parentPidText === undefined ||
    !/^\d+$/u.test(parentPidText) ||
    processGroupIdText === undefined ||
    !/^\d+$/u.test(processGroupIdText) ||
    sessionIdText === undefined ||
    !/^\d+$/u.test(sessionIdText) ||
    startTime === undefined ||
    !/^\d+$/u.test(startTime)
  )
    return undefined;

  const parentPid = Number(parentPidText);
  const processGroupId = Number(processGroupIdText);
  const sessionId = Number(sessionIdText);
  if (
    !Number.isSafeInteger(parentPid) ||
    !Number.isSafeInteger(processGroupId) ||
    !Number.isSafeInteger(sessionId)
  )
    return undefined;

  return {
    pid,
    startTime,
    lifecycle: state === "Z" ? "zombie" : "non-zombie",
    parentPid,
    processGroupId,
    sessionId,
  };
};
