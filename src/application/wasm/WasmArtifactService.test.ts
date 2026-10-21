import { expect, it } from "vitest";
import { WasmArtifactService } from "./WasmArtifactService.js";
import {
  wasmArtifactFixture,
  wasmArtifactExecution,
} from "../../../tests/fixtures/wasm/artifact.js";
import { ok } from "../../domain/result.js";
it.each([
  { path: "relative" },
  { path: "/module", glue_paths: ["relative"] },
  { path: "/module", candidate_paths: ["relative"] },
  { path: "/module", fetch: true },
  ...[0, -1, 1.5, 2_147_483_648, "1000", null].map((command_timeout_ms) => ({
    path: "/module",
    command_timeout_ms,
  })),
])("rejects invalid selection before effects: %j", async (input) => {
  const service = new WasmArtifactService({
    close: () => Promise.resolve(),
    inspect: () => {
      throw new Error("Must not execute");
    },
  });
  expect(await service.inspect(input)).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisInputError" },
  });
});

it("preserves the selected command budget in provider input and Evidence", async () => {
  const value = wasmArtifactFixture();
  value.tool_profile.timeout_ms = 42_000;
  const service = new WasmArtifactService({
    close: () => Promise.resolve(),
    inspect: async (input) => {
      expect(input).toMatchObject({ command_timeout_ms: 42_000 });
      return ok(wasmArtifactExecution(value));
    },
  });
  const result = await service.inspect({
    path: value.artifact.path,
    command_timeout_ms: 42_000,
  });
  if (!result.ok) throw result.error;
  expect(result.value.parameters).toMatchObject({ command_timeout_ms: 42_000 });
  expect(result.value.normalized_result).toEqual(value);
});

it("rejects a provider report that silently changes the selected command budget", async () => {
  const value = wasmArtifactFixture();
  const service = new WasmArtifactService({
    close: () => Promise.resolve(),
    inspect: async () => ok(wasmArtifactExecution(value)),
  });
  expect(
    await service.inspect({
      path: value.artifact.path,
      command_timeout_ms: 42_000,
    }),
  ).toMatchObject({ ok: false, error: { _tag: "AnalysisOutputError" } });
});
it.each(["path", "digest", "wat", "candidates", "glue"])(
  "rejects mismatched upstream observation: %s",
  async (problem) => {
    const value = wasmArtifactFixture();
    if (problem === "path") value.artifact.path = "/different";
    if (problem === "wat") value.wat.sha256 = "b".repeat(64);
    if (problem === "candidates") value.candidates = [];
    const execution = wasmArtifactExecution(value);
    const service = new WasmArtifactService({
      close: () => Promise.resolve(),
      inspect: () =>
        Promise.resolve(
          ok({
            ...execution,
            subject: {
              path: "/artifacts/module.wasm",
              format: "file",
              sha256:
                problem === "digest" ? "b".repeat(64) : value.artifact.sha256,
            },
          }),
        ),
    });
    expect(
      await service.inspect({
        path: "/artifacts/module.wasm",
        ...(problem === "glue" ? { glue_paths: ["/glue.js"] } : {}),
      }),
    ).toMatchObject({ ok: false, error: { _tag: "AnalysisOutputError" } });
  },
);
it("cancels before provider work and delivers observed Evidence on success", async () => {
  const value = wasmArtifactFixture();
  let calls = 0;
  const service = new WasmArtifactService({
    close: () => Promise.resolve(),
    inspect: () => {
      calls++;
      return Promise.resolve(ok(wasmArtifactExecution(value)));
    },
  });
  const controller = new AbortController();
  controller.abort();
  expect(
    await service.inspect(
      { path: value.artifact.path },
      { signal: controller.signal },
    ),
  ).toMatchObject({ ok: false, error: { _tag: "AnalysisCancelledError" } });
  expect(calls).toBe(0);
  expect(await service.inspect({ path: value.artifact.path })).toMatchObject({
    ok: true,
    value: { confidence: "observed", normalized_result: value },
  });
});

it("retains completed Evidence when cancellation arrives after provider return", async () => {
  const value = wasmArtifactFixture();
  const controller = new AbortController();
  const service = new WasmArtifactService({
    close: () => Promise.resolve(),
    inspect: async () => {
      controller.abort();
      return ok(wasmArtifactExecution(value));
    },
  });

  expect(
    await service.inspect(
      { path: value.artifact.path },
      { signal: controller.signal },
    ),
  ).toMatchObject({
    ok: false,
    error: {
      _tag: "AnalysisCancelledError",
      partialObservation: { normalized_result: value },
    },
  });
});

it("preserves malformed-output failure when cancellation arrives with it", async () => {
  const value = wasmArtifactFixture();
  const controller = new AbortController();
  const malformed = { ...wasmArtifactExecution(value), result: {} };
  const service = new WasmArtifactService({
    close: () => Promise.resolve(),
    inspect: async () => {
      controller.abort();
      return ok(malformed);
    },
  });

  expect(
    await service.inspect(
      { path: value.artifact.path },
      { signal: controller.signal },
    ),
  ).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisOutputError" },
  });
});
