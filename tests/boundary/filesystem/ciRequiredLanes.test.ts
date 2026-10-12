import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";
import { executeWorkflowFixture } from "../../support/workflowGit.js";

const workflow = async (filename = "ci.yml") =>
  z
    .object({
      jobs: z.record(
        z.string(),
        z
          .object({
            needs: z.union([z.string(), z.array(z.string())]).optional(),
          })
          .passthrough(),
      ),
    })
    .parse(
      parse(
        await readFile(
          new URL(`../../../.github/workflows/${filename}`, import.meta.url),
          "utf8",
        ),
      ),
    );

it("binds SQLite compatibility jobs to the build's prepared runtime artifact and root layout", async () => {
  const steps = z.array(
    z.object({
      uses: z.string().optional(),
      with: z
        .object({ name: z.string().optional(), path: z.string().optional() })
        .optional(),
    }),
  );
  const uploads = steps.parse((await workflow()).jobs.build?.steps).filter(
    (step) =>
      step.uses?.startsWith("actions/upload-artifact@") &&
      step.with?.path
        ?.split(/\r?\n/u)
        .map((path) => path.trim())
        .includes("dist/"),
  );
  expect(uploads).toHaveLength(1);
  const name = z.string().min(1).parse(uploads[0]?.with?.name);
  const downloads = steps
    .parse((await workflow("sqlite-runtime.yml")).jobs.sqlite?.steps)
    .filter((step) => step.uses?.startsWith("actions/download-artifact@"));
  expect(downloads).toHaveLength(1);
  expect(downloads[0]?.with).toEqual({ name, path: "." });
});

const requiredNeeds = async () => {
  const { jobs } = await workflow();
  return { jobs, needs: z.array(z.string()).parse(jobs.required?.needs) };
};

it("makes the required gate wait for every CI lane, including future additions", async () => {
  const { jobs, needs } = await requiredNeeds();
  expect(new Set(needs)).toEqual(
    new Set(Object.keys(jobs).filter((name) => name !== "required")),
  );
});

it.each([
  ["true", "success", true],
  ["true", "failure", false],
  ["true", "cancelled", false],
  ["true", "skipped", false],
  ["true", "missing", false],
  ["false", "skipped", true],
] as const)(
  "enforces the SQLite required gate for code=%s and result=%s",
  async (code, result, passes) => {
    const workflow = await requiredNeeds();
    // GitHub exposes only direct dependencies in the required job's needs context.
    const needs: Record<
      string,
      { result: string; outputs?: Record<string, string> }
    > = Object.fromEntries(
      workflow.needs.map((name) => [name, { result: "success" }]),
    );
    needs.changes = { result: "success", outputs: { code } };
    if (result === "missing") delete needs["sqlite-runtime"];
    else if ("sqlite-runtime" in needs) needs["sqlite-runtime"] = { result };
    const execution = executeWorkflowFixture(
      process.execPath,
      [
        fileURLToPath(
          new URL("../../../scripts/ci/required.mjs", import.meta.url),
        ),
      ],
      { env: { ...process.env, CI_JOBS: JSON.stringify(needs) } },
    );
    if (passes) await expect(execution).resolves.toMatchObject({ stderr: "" });
    else
      await expect(execution).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining("sqlite-runtime"),
      });
  },
);
