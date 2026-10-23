import { PROCESS_PROVIDER } from "../domain/process/processEvidenceProvider.js";
import { buildReconstructionObligationLedgerEvidence } from "./ReconstructionObligationLedgerService.js";
import { resolveReconstructionObligationLedgerRequest } from "./ReconstructionObligationLedgerRequest.js";
import { deriveReconstructionObligationCandidates } from "./ReconstructionObligationCandidates.js";
import { EMPTY_PROCESS_CAPTURE_EXAMPLE } from "../domain/process/processCaptureExample.js";
import { createEvidence, type Evidence } from "../domain/evidence.js";
import {
  createEvidenceBundle,
  type EvidenceBundle,
} from "../domain/evidenceBundle.js";
import { jsonValueSchema } from "../domain/jsonValue.js";
import {
  reconstructionObligationLedgerSchema,
  type ReconstructionObligationLedgerInput,
  type ReconstructionObligationLedger,
  type ReviewedReconstructionObligation,
} from "../domain/reconstructionObligationLedgerSchemas.js";

import {
  processCaptureSchema,
  type UnverifiedProcessCapture,
} from "../domain/process/processCapture.js";
/** Build controlled fixture Evidence used by reconstruction-ledger scenarios. */
export const proofEvidence = (id: string) =>
  createEvidence(
    undefined,
    { id: `fixture-${id}`, name: "Fixture verifier", version: "1" },
    {
      predicateType: "rea.fixture-verification",
      operation: "run_fixture_verifier",
      parameters: { id },
      result: { passed: true },
      confidence: "observed",
      authority: "controlled-replay",
    },
  );

/** Use the canonical empty process capture as a controlled Evidence example. */
export const processEvidence = (
  overrides: Partial<UnverifiedProcessCapture> = {},
) =>
  createEvidence(undefined, PROCESS_PROVIDER, {
    predicateType: "rea.process-capture",
    operation: "capture_process_scenario",
    parameters: {},
    result: jsonValueSchema.parse(
      processCaptureSchema.parse({
        ...EMPTY_PROCESS_CAPTURE_EXAMPLE,
        ...overrides,
      }),
    ),
    confidence: "observed",
    authority: "controlled-replay",
  });

/** Build verifier Evidence bound to enumerated fixture and obligation identities. */
export const boundProofEvidence = (
  id: string,
  result: {
    readonly obligation_ids: readonly string[];
    readonly fixture_ids: readonly string[];
    readonly case_kinds: readonly string[];
    readonly verifier_ids: readonly string[];
    readonly claim_ids: readonly string[];
  },
  authority: "shipped-artifact" | "controlled-replay" = "controlled-replay",
) =>
  createEvidence(
    undefined,
    { id: `proof-${id}`, name: "Reconstruction proof", version: "1" },
    {
      predicateType: "rea.reconstruction-proof",
      operation: "verify_reconstruction_obligations",
      parameters: {},
      result: {
        passed: true,
        obligation_ids: [...result.obligation_ids],
        fixture_ids: [...result.fixture_ids],
        case_kinds: [...result.case_kinds],
        verifier_ids: [...result.verifier_ids],
        claim_ids: [...result.claim_ids],
      },
      confidence: "observed",
      authority,
    },
  );

/** Build a ledger request with empty reviewed input and manifest defaults. */
export const request = (
  records: readonly Evidence[],
  overrides: Partial<ReconstructionObligationLedgerInput> = {},
): ReconstructionObligationLedgerInput => ({
  evidence_bundle: createEvidenceBundle(records),
  reviewed_obligations: [],
  manifest: { bindings: [], contradictions: [] },
  ...overrides,
});

/** Run request resolution, Evidence validation, and output parsing for a fixture. */
export const build = (
  input: ReconstructionObligationLedgerInput,
): ReconstructionObligationLedger => {
  const result = buildReconstructionObligationLedgerEvidence(input);
  if (!result.ok) throw result.error;
  return reconstructionObligationLedgerSchema.parse(
    result.value.normalized_result,
  );
};

/** Create provenance for each required case from one source Evidence record. */
export const originalCases = (
  obligation: ReconstructionObligationLedger["obligations"][number],
  evidenceId: string,
) =>
  obligation.required_case_kinds.map((caseKind) => ({
    kind: caseKind,
    evidence_id: evidenceId,
    location: `/normalized_result/cases/${caseKind}`,
  }));

/** Build a request whose packaged-process obligation closes as ready. */
export const readyProcessLedgerRequest =
  (): ReconstructionObligationLedgerInput => {
    const capture = processEvidence();
    const initial = build(request([capture]));
    const obligation = initial.obligations[0];
    if (obligation === undefined)
      throw new Error("Expected process obligation");
    const fixtureIds = obligation.required_case_kinds.map(
      (caseKind) => `packaged.${caseKind}`,
    );
    const proof = boundProofEvidence("packaged", {
      obligation_ids: [obligation.obligation_id],
      fixture_ids: fixtureIds,
      case_kinds: obligation.required_case_kinds,
      verifier_ids: ["verifier.packaged"],
      claim_ids: ["claim.process"],
    });
    return request([capture, proof], {
      manifest: {
        bindings: [
          {
            obligation_id: obligation.obligation_id,
            owner: {
              module_path: "src/processOwner.ts",
              symbol: "runProcess",
              owner_sha256: "2".repeat(64),
            },
            parser_type: null,
            original_cases: originalCases(obligation, capture.evidence_id),
            fixtures: obligation.required_case_kinds.map((caseKind) => ({
              fixture_id: `packaged.${caseKind}`,
              case_kind: caseKind,
              authority: "packaged-process",
              evidence_ids: [proof.evidence_id],
            })),
            verifier: {
              verifier_id: "verifier.packaged",
              claim_id: "claim.process",
              command: "npm run verify:package -- process",
              authority: "packaged-process",
              status: "pass",
              result_evidence_id: proof.evidence_id,
              enumerated_obligation_ids: [obligation.obligation_id],
              nondeterminism: {
                mode: "partial-order",
                specification:
                  "Startup precedes teardown; worker completion is unordered.",
              },
            },
          },
        ],
        contradictions: [],
      },
    });
  };

/** Create a minimal reviewed obligation for ledger closure scenarios. */
export const reviewedObligation = (
  obligationId: string,
  evidenceId: string,
): ReviewedReconstructionObligation => ({
  obligation_id: obligationId,
  obligation_version: 1,
  title: `Reviewed obligation ${obligationId}`,
  application_layer: "other",
  family: "reviewed",
  target: {
    artifact_sha256: null,
    application_node_id: null,
    semantic_node_id: null,
    location: `/reviewed/${obligationId}`,
  },
  required: true,
  required_case_kinds: ["positive"],
  required_original_authority: "static",
  required_fixture_authority: "unit",
  required_verifier_authority: "unit",
  requires_parser_type: false,
  dependency_obligation_ids: [],
  residual_unknown_ids: [],
  unavailable_authority: [],
  required_next_evidence: ["Bind an owner and verifier."],
  disposition: "active",
  review_evidence_ids: [evidenceId],
});

const authorityEvidence = (
  label: string,
  authority: "shipped-artifact" | "controlled-replay",
) =>
  createEvidence(
    undefined,
    { id: "fixture", name: "Fixture", version: "1" },
    {
      operation: "observe",
      parameters: { label },
      result: { present: true },
      confidence: "observed",
      authority,
    },
  );

/**
 * Request with one single-reference shipped-artifact obligation and one
 * obligation citing two shipped-artifact records and one controlled-replay
 * record. Shipped-artifact review references have candidate state while both
 * reviewed obligations have reviewed source state.
 */
export const mixedAuthorityRequest =
  (): ReconstructionObligationLedgerInput => {
    const shipped = authorityEvidence("shipped", "shipped-artifact");
    const otherShipped = authorityEvidence("other-shipped", "shipped-artifact");
    const replay = authorityEvidence("replay", "controlled-replay");
    return request([shipped, otherShipped, replay], {
      reviewed_obligations: [
        reviewedObligation("review.shipped", shipped.evidence_id),
        {
          ...reviewedObligation("review.mixed", shipped.evidence_id),
          review_evidence_ids: [
            shipped.evidence_id,
            replay.evidence_id,
            otherShipped.evidence_id,
          ],
        },
      ],
    });
  };

/** Summary buckets expected for {@link mixedAuthorityRequest}. */
export const MIXED_AUTHORITY_SUMMARY = {
  total: 2,
  by_evidence_authority: [
    { key: "shipped-artifact", count: 2 },
    { key: "controlled-replay", count: 1 },
    { key: "historical-reference", count: 0 },
    { key: "external-service", count: 0 },
    { key: "analyst-inference", count: 0 },
  ],
  by_source_state: [
    { key: "candidate", count: 0 },
    { key: "observed", count: 0 },
    { key: "reviewed", count: 2 },
    { key: "unknown", count: 0 },
  ],
} as const;

/** Resolve fixture sources through the production request owner. */
export const resolveRequest = (input: ReconstructionObligationLedgerInput) => {
  const resolved = resolveReconstructionObligationLedgerRequest(input);
  if (!resolved.ok) throw resolved.error;
  return resolved.value;
};

/** Derive candidates from fixture requests after authenticating their sources. */
export const deriveCandidates = (
  bundle: EvidenceBundle,
  reviewed: readonly ReviewedReconstructionObligation[],
) =>
  deriveReconstructionObligationCandidates(
    resolveRequest({
      evidence_bundle: bundle,
      reviewed_obligations: [...reviewed],
      manifest: { bindings: [], contradictions: [] },
    }),
  );
