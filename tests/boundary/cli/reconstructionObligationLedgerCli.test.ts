import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { createEvidence } from "../../../src/domain/evidence.js";
import { createEvidenceBundle } from "../../../src/domain/evidenceBundle.js";
import {
  MIXED_AUTHORITY_SUMMARY,
  mixedAuthorityRequest,
  readyProcessLedgerRequest,
} from "../../../src/application/ReconstructionObligationLedger.fixture.js";

const execute = promisify(execFile);

describe("reconstruction obligation ledger CLI parity", () => {
  it("reports non-canonical authenticated bundles as caller input", async () => {
    const records = ["first", "second"].map((label) =>
      createEvidence(
        undefined,
        { id: "fixture", name: "Fixture", version: "1" },
        {
          operation: "observe",
          parameters: { label },
          result: { label },
        },
      ),
    );
    const canonical = createEvidenceBundle(records);
    const input = {
      evidence_bundle: canonical,
      reviewed_obligations: [],
      manifest: { bindings: [], contradictions: [] },
    };
    const accepted = await execute(
      process.execPath,
      [
        "scripts/rea.mjs",
        "build-reconstruction-obligation-ledger",
        JSON.stringify(input),
        "--json",
      ],
      { cwd: process.cwd(), env: process.env, maxBuffer: 16 * 1_024 * 1_024 },
    );
    expect(JSON.parse(accepted.stdout)).toMatchObject({
      normalized_result: { status: "unknown", summary: { total: 0 } },
    });
    input.evidence_bundle = {
      ...canonical,
      records: [...canonical.records].reverse(),
    };
    let stdout: string;
    try {
      await execute(
        process.execPath,
        [
          "scripts/rea.mjs",
          "build-reconstruction-obligation-ledger",
          JSON.stringify(input),
          "--json",
        ],
        { cwd: process.cwd(), env: process.env, maxBuffer: 16 * 1_024 * 1_024 },
      );
      throw new Error("Expected non-canonical bundle input to fail");
    } catch (cause: unknown) {
      if (
        !(cause instanceof Error) ||
        !("stdout" in cause) ||
        typeof cause.stdout !== "string"
      )
        throw cause;
      stdout = cause.stdout;
    }
    expect(JSON.parse(stdout)).toMatchObject({
      code: "invalid_request",
      category: "invalid_input",
      retryable: false,
      details: {
        operation: "build_reconstruction_obligation_ledger",
        issues: [
          expect.objectContaining({
            message: expect.stringContaining(
              "Evidence bundle manifests are not canonical",
            ),
          }),
        ],
      },
    });
  }, 20_000);

  it("builds the same Evidence-backed empty ledger through the CLI", async () => {
    const input = {
      evidence_bundle: createEvidenceBundle([]),
      reviewed_obligations: [],
      manifest: {
        bindings: [],
        contradictions: [],
      },
    };
    const { stdout } = await execute(
      process.execPath,
      [
        "scripts/rea.mjs",
        "build-reconstruction-obligation-ledger",
        JSON.stringify(input),
        "--json",
      ],
      {
        cwd: process.cwd(),
        env: process.env,
        maxBuffer: 16 * 1_024 * 1_024,
      },
    );
    expect(JSON.parse(stdout)).toMatchObject({
      operation: "build_reconstruction_obligation_ledger",
      predicate_type: "rea.reconstruction-obligation-ledger",
      normalized_result: {
        schema: "ReconstructionObligationLedger",
        status: "unknown",
        summary: { total: 0 },
      },
    });
  }, 20_000);

  it("summarizes obligations by their cited Evidence authorities", async () => {
    const { stdout } = await execute(
      process.execPath,
      [
        "scripts/rea.mjs",
        "build-reconstruction-obligation-ledger",
        JSON.stringify(mixedAuthorityRequest()),
        "--json",
      ],
      { cwd: process.cwd(), env: process.env, maxBuffer: 16 * 1_024 * 1_024 },
    );
    const ledger = JSON.parse(stdout).normalized_result;
    expect(ledger.summary).toMatchObject(MIXED_AUTHORITY_SUMMARY);
    expect(
      ledger.obligations.map(
        (obligation: {
          readonly obligation_id: string;
          readonly authority_references: readonly {
            readonly authority: string;
            readonly state: string;
          }[];
        }) => [
          obligation.obligation_id,
          obligation.authority_references.map(
            ({ authority, state }) => `${authority}/${state}`,
          ),
        ],
      ),
    ).toEqual([
      [
        "review.mixed",
        expect.arrayContaining([
          "shipped-artifact/candidate",
          "controlled-replay/reviewed",
        ]),
      ],
      ["review.shipped", ["shipped-artifact/candidate"]],
    ]);
  }, 20_000);
});

describe("reconstruction obligation ledger CLI contradictions", () => {
  it("keeps a complete contradiction beside an entry naming absent Evidence", async () => {
    const input = readyProcessLedgerRequest();
    const obligationId = input.manifest.bindings[0]?.obligation_id;
    const [present, other] = input.evidence_bundle.records.map(
      ({ evidence_id: id }) => id,
    );
    if (
      obligationId === undefined ||
      present === undefined ||
      other === undefined
    )
      throw new Error("Expected a bound obligation and two Evidence records");
    const absent = `ev_${"f".repeat(64)}`;
    const complete = {
      obligation_id: obligationId,
      evidence_ids: [present, other],
    };
    const incomplete = {
      obligation_id: obligationId,
      evidence_ids: [present, absent],
    };
    // Each entry is its own claim; entry order must not decide the outcome.
    for (const contradictions of [
      [complete, incomplete],
      [incomplete, complete],
    ]) {
      const { stdout } = await execute(
        process.execPath,
        [
          "scripts/rea.mjs",
          "build-reconstruction-obligation-ledger",
          JSON.stringify({
            ...input,
            manifest: { ...input.manifest, contradictions },
          }),
          "--json",
        ],
        { cwd: process.cwd(), env: process.env, maxBuffer: 16 * 1_024 * 1_024 },
      );
      const ledger = JSON.parse(stdout).normalized_result;
      expect(ledger).toMatchObject({
        status: "failed",
        reports: { contradicted_obligation_ids: [obligationId] },
        obligations: [
          {
            status: "contradicted",
            diagnostics: [
              {
                code: "contradiction-evidence-missing",
                detail: `Contradiction references missing Evidence: ${absent}.`,
              },
              { code: "contradiction" },
            ],
          },
        ],
      });
    }
  }, 20_000);
});
