import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { BaseSequencer, type TestSpecification } from "vitest/node";
import { z } from "zod";

const reportSchema = z.object({
  version: z.literal(1),
  success: z.literal(true),
  files: z.array(z.unknown()),
});
const fileSchema = z.object({
  name: z.string(),
  durationMs: z.number().finite().positive(),
});

export function parseTestDurations(
  contents: string,
  root: string,
): Map<string, number> | undefined {
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
  const report = reportSchema.safeParse(value);
  if (!report.success) return undefined;

  const durations = new Map<string, number>();
  for (const value of report.data.files) {
    const result = fileSchema.safeParse(value);
    if (!result.success) continue;
    const { name, durationMs } = result.data;
    const path = relative(root, resolve(root, name));
    if (
      path === "" ||
      path === ".." ||
      path.startsWith(".." + sep) ||
      isAbsolute(path)
    )
      continue;
    const key = path.split(sep).join("/");
    durations.set(key, Math.max(durations.get(key) ?? 0, durationMs));
  }
  return durations.size ? durations : undefined;
}

export async function readTestDurations(
  historyPath: string,
  root: string,
): Promise<Map<string, number> | undefined> {
  try {
    return parseTestDurations(await readFile(historyPath, "utf8"), root);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return undefined;
    throw error;
  }
}

type TimedItem<T> = { item: T; key: string; duration: number | undefined };

// process-boundary runs its files one at a time. Other projects overlap up to
// the runner worker cap, so equal file-duration sums are not equal wall time.
const PARALLEL_TEST_WORKERS = 2;

export function estimatedShardCost(
  project: string,
  durationMs: number,
): number {
  if (project === "process-boundary") return durationMs;
  return durationMs / PARALLEL_TEST_WORKERS;
}

/** Weight raw durations, filling gaps from the raw median before worker sharing. */
export function weightFileDurations(
  entries: readonly { project: string; duration: number | undefined }[],
): (number | undefined)[] {
  const known = entries
    .flatMap(({ duration }) => (duration === undefined ? [] : [duration]))
    .sort((left, right) => left - right);
  if (!known.length) return entries.map(() => undefined);
  const lower = known[Math.floor((known.length - 1) / 2)]!;
  const median = lower + (known[Math.floor(known.length / 2)]! - lower) / 2;
  return entries.map(({ project, duration }) =>
    estimatedShardCost(project, duration ?? median),
  );
}

/** Distribute the longest files first, retaining every discovered specification. */
export function allocateByDuration<T>(
  items: readonly TimedItem<T>[],
  shardCount: number,
): T[][] | undefined {
  if (!Number.isInteger(shardCount) || shardCount < 1)
    throw new RangeError("shardCount must be a positive integer");
  const known = items
    .flatMap(({ duration }) => (duration === undefined ? [] : [duration]))
    .sort((left, right) => left - right);
  if (!known.length) return undefined;
  const lower = known[Math.floor((known.length - 1) / 2)]!;
  const median = lower + (known[Math.floor(known.length / 2)]! - lower) / 2;
  const ordered = items.toSorted(
    (left, right) =>
      (right.duration ?? median) - (left.duration ?? median) ||
      (left.key < right.key ? -1 : left.key > right.key ? 1 : 0),
  );
  const shards = Array.from({ length: shardCount }, () => ({
    duration: 0,
    items: [] as T[],
  }));
  for (const entry of ordered) {
    const lightest = shards.reduce((left, right) =>
      right.duration < left.duration ? right : left,
    );
    lightest.items.push(entry.item);
    lightest.duration += entry.duration ?? median;
  }
  return shards.map(({ items }) => items);
}

export class CiTestSequencer extends BaseSequencer {
  override async shard(
    files: TestSpecification[],
  ): Promise<TestSpecification[]> {
    const historyPath = process.env.REA_CI_TEST_HISTORY;
    const shard = this.ctx.config.shard;
    if (!historyPath || !shard) return super.shard(files);
    const root = this.ctx.config.root;
    const durations = await readTestDurations(historyPath, root);
    if (!durations) return super.shard(files);

    const timed = files.map((item) => {
      const path = relative(root, resolve(root, item.moduleId))
        .split(sep)
        .join("/");
      return {
        item,
        key: path + "\0" + item.project.name + "\0" + item.pool,
        project: item.project.name,
        duration: durations.get(path),
      };
    });
    const costs = weightFileDurations(timed);
    const weighted = timed.map((entry, index) => ({
      item: entry.item,
      key: entry.key,
      duration: costs[index],
    }));
    const shards = allocateByDuration(weighted, shard.count);
    return shards ? shards[shard.index - 1]! : super.shard(files);
  }
}
