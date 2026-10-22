import { symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createPythonPycService } from "../../../src/composition/pythonPyc.js";
import { pythonPycFixture } from "../../../src/python/PythonPyc.fixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

describe("Python pyc stable filesystem boundary", () => {
  it("reports non-file and malformed pyc selections as caller input errors", async () => {
    const root = await createTestTempDirectory("rea-python-pyc-files-");
    const path = join(root, "sample.pyc");
    const alias = join(root, "alias.pyc");
    const malformed = join(root, "malformed.pyc");
    await writeFile(path, pythonPycFixture());
    await writeFile(malformed, Buffer.from("not a pyc"));
    await symlink(path, alias);
    const service = createPythonPycService();
    for (const [candidate, reason] of [
      [root, "invalid_format"],
      [alias, "invalid_format"],
      [malformed, "invalid_format"],
      [join(root, "missing.pyc"), "invalid_value"],
      [join(path, "child.pyc"), "invalid_value"],
    ] as const) {
      const result = await service.inspect({ path: candidate });
      if (result.ok) throw new Error("Expected file acquisition failure");
      expect(result.error).toMatchObject({
        _tag: "AnalysisInputError",
        operation: "inspect_python_pyc",
        issues: [
          {
            path: ["path"],
            reason,
            message: expect.any(String),
          },
        ],
      });
    }
  });

  it("returns typed resource and cancellation failures", async () => {
    const root = await createTestTempDirectory("rea-python-pyc-budget-");
    const path = join(root, "sample.pyc");
    const bytes = pythonPycFixture("py311", { nested: true });
    await writeFile(path, bytes);
    const service = createPythonPycService();
    const tooSmall = await service.inspect({ path, max_file_bytes: 16 });
    if (tooSmall.ok) throw new Error("Expected resource budget failure");
    expect(tooSmall.error._tag).toBe("AnalysisResourceConstraintError");
    const tooFewObjects = await service.inspect({ path, max_objects: 1 });
    if (tooFewObjects.ok) throw new Error("Expected object budget failure");
    expect(tooFewObjects.error._tag).toBe("AnalysisResourceConstraintError");
    const cancelled = await service.inspect(
      { path },
      { signal: AbortSignal.abort() },
    );
    if (cancelled.ok) throw new Error("Expected cancellation");
    expect(cancelled.error._tag).toBe("AnalysisCancelledError");
  });
});
