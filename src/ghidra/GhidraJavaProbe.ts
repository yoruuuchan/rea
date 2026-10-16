import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { constants, accessSync, statSync } from "node:fs";
import { posix, win32 } from "node:path";
import { err, ok, type Result } from "../domain/result.js";
import type { AnalysisCapturedOutput } from "../domain/analysisErrorBase.js";

/**
 * Bound the Java version probe so a chatty or hostile JVM cannot force an
 * unbounded in-memory capture. Well-behaved JVMs print a few kilobytes for
 * `-XshowSettings:properties`; the same 1 MiB budget used for other Java
 * listings leaves ample headroom. A probe that exceeds the budget yields no
 * observation and is reported through the existing failed-probe path.
 */
const JAVA_PROBE_MAX_OUTPUT_BYTES = 1024 * 1024;

/** Parsed identity of the JDK selected for Ghidra. */
export interface GhidraJavaObservation {
  readonly version: string;
  readonly major: number;
  readonly home: string;
  readonly bits: number | null;
  /** Present when Java reported a bitness value that could not be parsed exactly. */
  readonly unparsedBits?: string;
  readonly runtime: "jdk" | "jre";
  readonly vmName?: string;
  /**
   * Observed JVM os.arch property, which Ghidra uses to select its native
   * decompiler directory. Omitted when the probe cannot establish it.
   */
  readonly osArch?: string;
  /**
   * Observed JVM os.name property, which Ghidra uses with os.arch to select
   * its native decompiler OS directory. Omitted when the probe cannot
   * establish it.
   */
  readonly osName?: string;
}

/** Expected probe failures retain their producing process facts. */
export interface GhidraJavaProbeFailure {
  readonly _tag: "GhidraJavaProbeFailure";
  readonly code:
    | "runtime_missing"
    | "runtime_unavailable"
    | "version_unresolved";
  readonly detail: string;
  readonly processErrorCode?: string;
  readonly output?: AnalysisCapturedOutput;
  readonly properties?: {
    readonly version: string | null;
    readonly home: string | null;
    readonly vmName: string | null;
    readonly osArch: string | null;
    readonly osName: string | null;
    readonly bits: number | null;
  };
}

const JAVA_DIAGNOSTIC_STREAM_BYTES = 8192;
const capturedProbeOutput = (
  observed: SpawnSyncReturns<Buffer>,
): AnalysisCapturedOutput => {
  const stdout = observed.stdout ?? Buffer.alloc(0);
  const stderr = observed.stderr ?? Buffer.alloc(0);
  return {
    stdout: stdout.subarray(0, JAVA_DIAGNOSTIC_STREAM_BYTES).toString("utf8"),
    stderr: stderr.subarray(0, JAVA_DIAGNOSTIC_STREAM_BYTES).toString("utf8"),
    truncated:
      stdout.length > JAVA_DIAGNOSTIC_STREAM_BYTES ||
      stderr.length > JAVA_DIAGNOSTIC_STREAM_BYTES ||
      (observed.error !== undefined &&
        "code" in observed.error &&
        observed.error.code === "ENOBUFS"),
    stdout_bytes: stdout.length,
    stderr_bytes: stderr.length,
    exit_code: observed.status,
    signal: observed.signal,
  };
};

const executablePath = (path: string): boolean => {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
};
export const probeGhidraJava = (
  command: string,
  environment: NodeJS.ProcessEnv,
): Result<GhidraJavaObservation, GhidraJavaProbeFailure> => {
  const observed = spawnSync(
    command,
    [
      "-Dstdout.encoding=UTF-8",
      "-Dstderr.encoding=UTF-8",
      // JDK 17/18 use the legacy names; JDK 19+ use the names above.
      "-Dsun.stdout.encoding=UTF-8",
      "-Dsun.stderr.encoding=UTF-8",
      "-XX:-UsePerfData",
      "-XshowSettings:properties",
      "-version",
    ],
    {
      encoding: "buffer",
      env: environment,
      timeout: 5_000,
      maxBuffer: JAVA_PROBE_MAX_OUTPUT_BYTES,
      windowsHide: true,
    },
  );
  if (observed.error !== undefined || observed.status !== 0) {
    const code =
      observed.error !== undefined && "code" in observed.error
        ? observed.error.code
        : undefined;
    return err({
      _tag: "GhidraJavaProbeFailure",
      code: code === "ENOENT" ? "runtime_missing" : "runtime_unavailable",
      ...(typeof code === "string" ? { processErrorCode: code } : {}),
      detail: `${command}: ${observed.error?.message ?? `Java exited ${String(observed.status)}${observed.signal === null ? "" : ` (${observed.signal})`}`}`,
      output: capturedProbeOutput(observed),
    });
  }
  const output = `${observed.stdout ?? ""}\n${observed.stderr ?? ""}`;
  const version = javaProperty(output, "java.version") || null;
  const home = javaProperty(output, "java.home") || null;
  const vmName = javaProperty(output, "java.vm.name");
  const osArch = javaProperty(output, "os.arch");
  const osName = javaProperty(output, "os.name");
  const reportedBits = javaProperty(output, "sun.arch.data.model");
  const parsedBits =
    reportedBits !== null && /^\d+$/.test(reportedBits)
      ? Number(reportedBits)
      : null;
  const bits =
    parsedBits !== null && Number.isSafeInteger(parsedBits) ? parsedBits : null;
  const major = version === null ? undefined : javaMajor(version);
  if (version === null || home === null || major === undefined)
    return err({
      _tag: "GhidraJavaProbeFailure",
      code: "version_unresolved",
      detail: `${command}: successful Java probe did not establish a valid java.version and nonempty java.home`,
      output: capturedProbeOutput(observed),
      properties: { version, home, vmName, osArch, osName, bits },
    });
  return ok({
    version,
    major,
    home,
    ...(vmName === null ? {} : { vmName }),
    ...(osArch === null ? {} : { osArch }),
    ...(osName === null ? {} : { osName }),
    bits,
    ...(reportedBits === null || bits !== null
      ? {}
      : { unparsedBits: reportedBits }),
    runtime: executablePath(
      (process.platform === "win32" ? win32 : posix).join(
        home,
        "bin",
        process.platform === "win32" ? "javac.exe" : "javac",
      ),
    )
      ? "jdk"
      : "jre",
  });
};
const javaProperty = (output: string, name: string): string | null =>
  new RegExp(
    `^[ \\t]*${name.replaceAll(".", "\\.")}[ \\t]*=[ \\t]*([^\\r\\n]*?)[ \\t]*\\r?$`,
    "mu",
  ).exec(output)?.[1] ?? null;

// Runtime.Version's numeric/pre-release/build grammar; Java 8 used 1.8.0_... .
// https://docs.oracle.com/en/java/javase/24/docs/api/java.base/java/lang/Runtime.Version.html
const javaMajor = (version: string): number | undefined => {
  const legacy =
    /^1\.([1-8])(?:\.[0-9]+)*(?:_[0-9]+)?(?:-[-a-zA-Z0-9.]+)?$/u.exec(version);
  if (legacy?.[1] !== undefined) return Number(legacy[1]);
  const modern =
    /^(?<number>[1-9][0-9]*(?:(?:\.0)*\.[1-9][0-9]*)*)(?:(?:-[a-zA-Z0-9]+)?\+(?<build>0|[1-9][0-9]*)(?:-[-a-zA-Z0-9.]+)?|-[a-zA-Z0-9]+(?:-[-a-zA-Z0-9.]+)?|\+-[-a-zA-Z0-9.]+)?$/u.exec(
      version,
    );
  const number = modern?.groups?.number;
  if (number === undefined) return undefined;
  const parts = number.split(".").map(Number);
  const build = modern?.groups?.build;
  // Runtime.Version parses numeric components and the build as Java integers.
  if (
    [...parts, ...(build === undefined ? [] : [Number(build)])].some(
      (value) => !Number.isSafeInteger(value) || value > 0x7fffffff,
    )
  )
    return undefined;
  return parts[0];
};
