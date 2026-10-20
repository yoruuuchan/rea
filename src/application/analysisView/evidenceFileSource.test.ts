import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { analysisViewCaptureEvidence } from "../../../tests/fixtures/analysisView.js";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { ArtifactResourceScope } from "../../artifacts/ArtifactResourceScope.js";
import { AnalysisCancelledError } from "../../domain/analysisErrorCore.js";
import { JsonInputPhysicalReadFailure } from "../JsonInputFile.js";
import { failFileReadAfterAbort } from "../../../tests/support/failFileReadAfterAbort.js";
import { holdFirstFileRead } from "../../../tests/support/holdFirstFileRead.js";
import {
  estimateJsonValueBytes,
  readEvidenceFileSource,
  requireAuthenticationHeadroom,
} from "./evidenceFileSource.js";

describe("evidence-file source", () => {
  it("estimates parsed JSON at no less than its UTF-16 text", () => {
    const text = "x".repeat(1000);
    expect(estimateJsonValueBytes(text)).toBeGreaterThanOrEqual(2000);
    expect(
      estimateJsonValueBytes({ outer: [text, { inner: text }] }),
    ).toBeGreaterThan(2 * estimateJsonValueBytes(text));
  });

  it("refuses authentication when live heap headroom cannot hold its copies", () => {
    const value = { normalized_result: "y".repeat(10_000) };
    expect(
      requireAuthenticationHeadroom(value, "/tmp/capture.json", 1024),
    ).toMatchObject({
      ok: false,
      error: {
        _tag: "AnalysisResourceConstraintError",
        resource: "memory",
        reportedLimits: {
          input_path: "/tmp/capture.json",
          available_heap_bytes: 1024,
        },
      },
    });
    expect(
      requireAuthenticationHeadroom(value, "/tmp/capture.json", 1 << 30),
    ).toEqual({ ok: true, value: undefined });
  });

  it("refuses a cancelled request before reading and reads within the caller's resource scope", async () => {
    const controller = new AbortController();
    const reason = new JsonInputPhysicalReadFailure(
      new Error("opaque caller reason with physical-failure shape"),
    );
    controller.abort(reason);
    const cancelled = await readEvidenceFileSource(
      "/nonexistent/capture.json",
      {
        signal: controller.signal,
      },
    );
    expect(cancelled).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisCancelledError" },
    });
    if (cancelled.ok || !(cancelled.error instanceof AnalysisCancelledError))
      throw new Error("Expected cancelled analysis-view read");
    expect(cancelled.error.cause).toBe(reason);
    const path = join(
      await createTestTempDirectory("rea-evidence-file-source-"),
      "capture.json",
    );
    const parent = analysisViewCaptureEvidence();
    await writeFile(path, JSON.stringify(parent));
    const resources = new ArtifactResourceScope();
    const read = await readEvidenceFileSource(path, { resources });
    await resources.close();
    if (!read.ok) throw read.error;
    expect(read.value).toEqual(JSON.parse(JSON.stringify(parent)));
  });
});

describe("evidence-file read failure provenance", () => {
  it("keeps a physical null read cause after the analysis-view request aborts", async () => {
    const root = await createTestTempDirectory("rea-view-late-io-");
    const path = join(root, "capture.json");
    await writeFile(path, JSON.stringify(analysisViewCaptureEvidence()));
    const controller = new AbortController();
    await failFileReadAfterAbort(
      path,
      controller,
      new Error("later abort"),
      null,
    );
    try {
      const result = await readEvidenceFileSource(path, {
        signal: controller.signal,
      });
      expect(result).toMatchObject({
        ok: false,
        error: { _tag: "EvidenceFileError", reason: "io", path },
      });
      if (result.ok) throw new Error("Expected physical JSON read failure");
      expect(result.error.cause).toBeNull();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("preserves identical physical and abort causes for analysis-view reads", async () => {
    const root = await createTestTempDirectory("rea-view-identical-abort-");
    const path = join(root, "capture.json");
    await writeFile(path, JSON.stringify(analysisViewCaptureEvidence()));
    const controller = new AbortController();
    const physical = Object.assign(new Error("descriptor EIO"), {
      code: "EIO",
    });
    await failFileReadAfterAbort(path, controller, physical, physical);
    try {
      const result = await readEvidenceFileSource(path, {
        signal: controller.signal,
      });
      expect(result).toMatchObject({
        ok: false,
        error: { _tag: "EvidenceFileError", reason: "io" },
      });
      if (result.ok) throw new Error("Expected physical JSON read failure");
      expect(result.error.cause).toBe(physical);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("preserves the caller cancellation reason during an analysis-view read", async () => {
    const root = await createTestTempDirectory("rea-view-read-cancel-");
    const path = join(root, "capture.json");
    await writeFile(path, JSON.stringify(analysisViewCaptureEvidence()));
    const reader = await holdFirstFileRead(path);
    const controller = new AbortController();
    const reason = new Error("stop analysis-view read");
    try {
      const pending = readEvidenceFileSource(path, {
        signal: controller.signal,
      });
      await reader.firstRead;
      controller.abort(reason);
      reader.release();
      const result = await pending;
      expect(result).toMatchObject({
        ok: false,
        error: {
          _tag: "AnalysisCancelledError",
          operation: "inspect_analysis_view",
        },
      });
      if (result.ok || !(result.error instanceof AnalysisCancelledError))
        throw new Error("Expected cancelled analysis-view read");
      expect(result.error.cause).toBe(reason);
    } finally {
      controller.abort(reason);
      reader.release();
      vi.restoreAllMocks();
    }
  });

  it("does not treat a caller reason with physical-read shape as a physical read", async () => {
    const root = await createTestTempDirectory("rea-view-opaque-cancel-");
    const path = join(root, "capture.json");
    await writeFile(path, JSON.stringify(analysisViewCaptureEvidence()));
    const reader = await holdFirstFileRead(path);
    const controller = new AbortController();
    const reason = new JsonInputPhysicalReadFailure(
      new Error("opaque caller reason with physical-failure shape"),
    );
    try {
      const pending = readEvidenceFileSource(path, {
        signal: controller.signal,
      });
      await reader.firstRead;
      controller.abort(reason);
      reader.release();
      const result = await pending;
      expect(result).toMatchObject({
        ok: false,
        error: { _tag: "AnalysisCancelledError", cause: reason },
      });
      if (result.ok || !(result.error instanceof AnalysisCancelledError))
        throw new Error(
          "Expected caller cancellation, not physical I/O failure",
        );
      expect(result.error.cause).toBe(reason);
    } finally {
      controller.abort(reason);
      reader.release();
      vi.restoreAllMocks();
    }
  });
});
