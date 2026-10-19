import assert from "node:assert/strict";

const ownershipPsArguments =
  '["ps", "-axo", "pid=,ppid=,pgid=,uid=,stat=,command="]';

/**
 * Allow only the procfs paths used by the process-ownership scan: ps may
 * inspect its process-table fields, and its caller's thread group may read
 * native identity and UID records. With strace -ff, libuv worker threads get
 * separate files; follow CLONE_THREAD edges, never ordinary child-process
 * edges. strace cannot distinguish the purpose of a stat/status read inside
 * the same Node thread group, so this is deliberately limited to those two
 * files; provider Python/GDB children remain outside the permit.
 */
export const assertHistoricalPidReadsAreOwnershipOnly = ({
  traces,
  sentinelPid,
  psExecutables,
}) => {
  const processGroups = new Map();
  const findGroup = (pid) => {
    const parent = processGroups.get(pid);
    if (parent === undefined) {
      processGroups.set(pid, pid);
      return pid;
    }
    if (parent === pid) return pid;
    const root = findGroup(parent);
    processGroups.set(pid, root);
    return root;
  };
  const joinThreadGroup = (left, right) => {
    const leftRoot = findGroup(left);
    const rightRoot = findGroup(right);
    if (leftRoot !== rightRoot) processGroups.set(rightRoot, leftRoot);
  };

  const cloneEvents = [];
  for (const trace of traces) {
    let unfinished;
    for (const rawLine of trace.text.split("\n")) {
      const line = rawLine.trimStart();
      const start = /^(clone3?|fork|vfork)\((.*)<unfinished \.\.\.>$/u.exec(
        line,
      );
      if (start !== null) {
        unfinished = { name: start[1], text: start[2] };
        continue;
      }
      const resumed = /^<\.\.\. (clone3?|fork|vfork) resumed>(.*)$/u.exec(line);
      if (resumed !== null && resumed[1] === unfinished?.name) {
        cloneEvents.push({
          parentPid: trace.pid,
          text: `${unfinished.text}${resumed[2]}`,
        });
        unfinished = undefined;
        continue;
      }
      const complete =
        /^(clone3?|fork|vfork)\((.*\)) = (\d+)(?:<[^>]*>)?$/u.exec(line);
      if (complete !== null)
        cloneEvents.push({
          parentPid: trace.pid,
          childPid: Number(complete[3]),
          text: complete[2],
        });
    }
  }

  for (const event of cloneEvents) {
    const childPid =
      event.childPid ?? /\) = (\d+)(?:<[^>]*>)?$/u.exec(event.text)?.[1];
    if (childPid === undefined) continue;
    event.childPid = Number(childPid);
    if (/\bCLONE_THREAD\b/u.test(event.text))
      joinThreadGroup(event.parentPid, event.childPid);
  }

  const psPids = new Set();
  for (const trace of traces) {
    const successfulPsExec = trace.text.split("\n").some((line) => {
      const executable = /^execve\("([^"]+)"/u.exec(line)?.[1];
      return (
        executable !== undefined &&
        psExecutables.has(executable) &&
        line.includes(ownershipPsArguments) &&
        line.endsWith(" = 0")
      );
    });
    if (successfulPsExec) psPids.add(trace.pid);
  }

  const psParentGroups = new Set(
    cloneEvents
      .filter(({ childPid }) => childPid !== undefined && psPids.has(childPid))
      .map(({ parentPid }) => findGroup(parentPid)),
  );

  const ownershipReads = [];
  const pidPrefix = `/proc/${sentinelPid}/`;
  for (const trace of traces) {
    const isPsProcess = psPids.has(trace.pid);
    const isOwnershipProcessThread = psParentGroups.has(findGroup(trace.pid));
    const pidReads = trace.text
      .split("\n")
      .filter((line) => line.includes(pidPrefix));
    for (const line of pidReads) {
      const psAllowedPath = new RegExp(
        `/proc/${sentinelPid}/(?:stat|status|cmdline|wchan|environ)"`,
        "u",
      ).test(line);
      const ownershipThreadPath = new RegExp(
        `/proc/${sentinelPid}/(?:stat|status)"`,
        "u",
      ).test(line);
      const psRead = isPsProcess && psAllowedPath;
      const ownershipThreadRead =
        isOwnershipProcessThread && ownershipThreadPath;
      assert.ok(
        psRead || ownershipThreadRead,
        `Historical PID caused a provider lookup in trace.${trace.pid}: ${line}`,
      );
      ownershipReads.push(line);
    }
  }
  return ownershipReads;
};
