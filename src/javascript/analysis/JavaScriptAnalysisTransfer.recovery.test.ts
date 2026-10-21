import { expect, it } from "vitest";
import { AnalysisResourceConstraintError } from "../../domain/analysisErrorCore.js";
import { analyzeJavaScriptSemantics } from "../../domain/javascript/javascriptSemanticAnalysis.js";
import { projectJavaScriptModuleSemantics } from "../../domain/javascript/javascriptModuleSemanticIr.js";
import { projectAnalysisError } from "../../domain/analysisErrorProjection.js";
import {
  javaScriptForwardedTransferRemediation,
  javaScriptTransferCeilingRemediation,
  measureJavaScriptModuleTransfer,
} from "./JavaScriptAnalysisTransfer.js";

it("distinguishes the adjustable transfer file ceiling from the fixed record and maximum ceilings", () => {
  const ir = analyzeJavaScriptSemantics(
    "export function add(value) { return value + 1; }",
  );
  const module = projectJavaScriptModuleSemantics(ir);
  const measured = measureJavaScriptModuleTransfer(module);
  let caught: unknown;
  try {
    measureJavaScriptModuleTransfer(module, measured.bytes - 1);
  } catch (cause) {
    caught = cause;
  }
  if (!(caught instanceof AnalysisResourceConstraintError))
    throw new Error("Expected a transfer ceiling refusal");
  const projected = projectAnalysisError(caught);
  expect(projected.message).toContain("no runtime override");
  expect(projected.message).toContain(
    String(caught.reportedLimits?.transfer_file_bytes),
  );
  expect(projected.remediation.action).toContain("no runtime override");
  expect(projected.remediation.action).toContain("max_heap_mb");
  expect(projected.remediation.action).toContain("8388608");
  expect(projected.remediation.action).toContain("2147483648");
  expect(projected.remediation.action).toContain("NODE_OPTIONS");
  expect(projected.remediation.action).toContain("--max-old-space-size=<MiB>");
  expect(projected.remediation.action).toContain(
    "Selecting fewer source_paths can",
  );
  expect(projected.remediation.action).not.toContain(
    "Selecting fewer source_paths does not raise them",
  );
  expect(projected.remediation.action).not.toContain("get_evidence_bundle");
  expect(projected.message).toContain("can rise until the maximum");
  const forwarded = javaScriptForwardedTransferRemediation(
    caught.reportedLimits,
  );
  expect(forwarded).toContain("NODE_OPTIONS");
  expect(forwarded).toContain("Selecting fewer source_paths can");
  const recordOnly = javaScriptForwardedTransferRemediation({
    transfer_record_bytes: 8_388_608,
  });
  expect(recordOnly).toContain("NODE_OPTIONS");
  expect(recordOnly).toContain("can be lower than the maximum");
  expect(recordOnly).not.toContain(
    "The effective transfer file ceiling is the 2147483648-byte maximum",
  );
});

it("keeps the 2 GiB transfer file maximum fixed", () => {
  const remediation = javaScriptTransferCeilingRemediation(2_147_483_648);
  expect(remediation).toContain("2147483648");
  expect(remediation).toContain("no runtime override");
  expect(remediation).not.toContain("NODE_OPTIONS");
  expect(remediation).toContain(
    "Selecting fewer source_paths does not raise the record ceiling",
  );
});
