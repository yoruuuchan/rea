/** Assert the documented procfs allowance over strace -ff process/thread files. */
export function assertHistoricalPidReadsAreOwnershipOnly(options: {
  readonly traces: readonly { readonly pid: number; readonly text: string }[];
  readonly sentinelPid: number;
  readonly psExecutables: ReadonlySet<string>;
}): string[];
