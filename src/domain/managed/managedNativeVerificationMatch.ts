import { basename } from "node:path";

import { digestCanonicalValue } from "../canonicalDigest.js";
import type { Evidence } from "../evidence.js";
import type { ManagedNativeObservationFacts } from "./managedNativeVerificationSource.js";
import type { ManagedNativeBoundaryInspection } from "./managedArtifact.js";
import type {
  ManagedNativeVerificationResult,
  NativeSymbol,
  PinvokeVerification,
} from "./managedNativeVerificationSchemas.js";

type PinvokeImport = ManagedNativeBoundaryInspection["pinvoke_imports"][number];
type VerifiedPinvoke = {
  readonly verification: PinvokeVerification;
};

export const collectNativeSymbols = (
  observations: readonly ManagedNativeObservationFacts[],
): {
  readonly symbols: readonly NativeSymbol[];
  readonly accepted: number;
  readonly unsupported: number;
} => {
  const symbols: NativeSymbol[] = [];
  let accepted = 0;
  let unsupported = 0;
  for (const observation of observations) {
    if (!observation.supported) {
      unsupported += 1;
    } else {
      accepted += 1;
      symbols.push(...observation.symbols);
    }
  }
  return { symbols, accepted, unsupported };
};

const normalizedSymbolName = (native: NativeSymbol): string =>
  native.source === "macho-export" && native.name.startsWith("_")
    ? native.name.slice(1)
    : native.name;

const sameSymbolName = (expected: string, native: NativeSymbol): boolean =>
  expected === normalizedSymbolName(native);

const normalizeModule = (value: string): string =>
  basename(value)
    .toLowerCase()
    .replace(/\.(dll|dylib|so|node|exe)$/u, "");

/** A declared module identity, or null when normalization leaves no name. */
const declaredModuleIdentity = (scope: string | null): string | null => {
  if (scope === null || scope.trim().length === 0) return null;
  const identity = normalizeModule(scope);
  return identity.length > 0 ? identity : null;
};

const nativeModuleIdentities = (value: string): ReadonlySet<string> => {
  const filename = basename(value).toLowerCase();
  const stem = normalizeModule(filename);
  const identities = new Set([stem]);
  if (/\.(dylib|so)$/u.test(filename) && stem.startsWith("lib"))
    identities.add(stem.slice("lib".length));
  identities.delete("");
  return identities;
};

const moduleCompatible = (
  scope: string | null,
  symbol: NativeSymbol,
): boolean => {
  const expected = declaredModuleIdentity(scope);
  if (expected === null) return false;
  return [symbol.module_name, symbol.module_path]
    .filter(
      (value): value is string =>
        value !== null && normalizeModule(value).length > 0,
    )
    .some((value) => nativeModuleIdentities(value).has(expected));
};

const hasModuleIdentity = (symbol: NativeSymbol): boolean =>
  [symbol.module_name, symbol.module_path].some(
    (value) => value !== null && normalizeModule(value).length > 0,
  );

const candidateNames = (
  managed: Pick<
    PinvokeImport,
    "import_name" | "char_set" | "call_convention" | "no_mangle"
  >,
): readonly string[] => {
  const names = new Set<string>([managed.import_name]);
  if (!managed.no_mangle) {
    if (managed.char_set === "unicode") names.add(`${managed.import_name}W`);
    if (managed.char_set === "ansi") names.add(`${managed.import_name}A`);
    if (managed.call_convention === "stdcall") {
      names.add(`_${managed.import_name}`);
      names.add(`_${managed.import_name}@0`);
    }
  }
  return [...names];
};

type PinvokeMatchField =
  | "status"
  | "basis"
  | "confidence"
  | "matched_native"
  | "candidates";
type PinvokeMatch<
  Verification extends PinvokeVerification = PinvokeVerification,
> = Verification extends PinvokeVerification
  ? Pick<Verification, PinvokeMatchField>
  : never;

interface PinvokeCandidateMatch {
  readonly match: PinvokeMatch;
}

const matchPinvoke = (
  managed: PinvokeImport,
  symbols: readonly NativeSymbol[],
  supportedNativeEvidence: number,
): PinvokeCandidateMatch => {
  const names = candidateNames(managed);
  const allCandidates = symbols.filter((symbol) =>
    names.some((name) => sameSymbolName(name, symbol)),
  );
  const [first, ...remaining] = allCandidates;
  if (first === undefined)
    return {
      match: {
        status: "unresolved",
        basis:
          supportedNativeEvidence > 0
            ? "no-native-candidate"
            : "unsupported-native-evidence",
        confidence: "unknown",
        matched_native: null,
        candidates: [],
      },
    };

  const candidates: [NativeSymbol, ...NativeSymbol[]] = [first, ...remaining];
  const scopeKnown = declaredModuleIdentity(managed.import_scope_name) !== null;
  const exact = candidates.find(
    (symbol) =>
      managed.import_name === normalizedSymbolName(symbol) &&
      moduleCompatible(managed.import_scope_name, symbol),
  );
  const decorated = candidates.find((symbol) =>
    moduleCompatible(managed.import_scope_name, symbol),
  );
  const selected =
    exact ??
    decorated ??
    (scopeKnown
      ? candidates.find((symbol) => !hasModuleIdentity(symbol))
      : undefined) ??
    first;
  if (exact !== undefined)
    return {
      match: {
        status: "verified",
        basis:
          selected.source === "macho-export"
            ? "exact-export-name"
            : "exact-function-name",
        confidence: "observed",
        matched_native: selected,
        candidates,
      },
    };
  if (decorated !== undefined)
    return {
      match: {
        basis: "decorated-name-candidate",
        status: "inferred",
        confidence: "inferred",
        matched_native: selected,
        candidates,
      },
    };
  if (!scopeKnown || !hasModuleIdentity(selected))
    return {
      match: {
        status: "unresolved",
        basis: "module-identity-unknown",
        confidence: "unknown",
        matched_native: selected,
        candidates,
      },
    };
  return {
    match: {
      status: "contradicted",
      basis: "module-mismatch",
      confidence: "unknown",
      matched_native: selected,
      candidates,
    },
  };
};

const pinvokeLimitations = (
  match: PinvokeMatch,
  managed: PinvokeImport,
): string[] => [
  ...(managed.import_scope_name === null ||
  managed.import_scope_name.trim().length === 0
    ? ["Managed declaration does not name an import scope/module."]
    : []),
  ...(match.status === "inferred"
    ? [
        "Native symbol matched a decorated candidate rather than the exact declared import name.",
      ]
    : []),
  ...(match.status === "contradicted"
    ? [
        "A symbol name candidate exists, but the supplied native Evidence module identity does not match the managed import scope.",
      ]
    : []),
  ...(match.status === "unresolved"
    ? match.basis === "module-identity-unknown"
      ? [
          "A native name candidate exists, but a required module identity is unavailable; module correspondence is unknown.",
        ]
      : [
          "No supplied native export/function Evidence matched this declared import.",
        ]
    : []),
];

interface VerifyPinvokeContext {
  readonly item: PinvokeImport;
  readonly managedEvidenceId: string;
  readonly native: {
    readonly symbols: readonly NativeSymbol[];
    readonly accepted: number;
  };
}

type PinvokeVerificationContext = Pick<
  PinvokeVerification,
  "item_id" | "managed" | "evidence_links" | "limitations"
>;

export const verifyPinvoke = ({
  item,
  managedEvidenceId,
  native,
}: VerifyPinvokeContext): VerifiedPinvoke => {
  const managed = {
    token: item.token,
    member_token: item.member_token,
    member_name: item.member_name,
    import_name: item.import_name,
    import_scope_name: item.import_scope_name,
    no_mangle: item.no_mangle,
    char_set: item.char_set,
    call_convention: item.call_convention,
    declaration_verification: item.verification,
  };
  const selection = matchPinvoke(item, native.symbols, native.accepted);
  const limitations = pinvokeLimitations(selection.match, item);
  const context: PinvokeVerificationContext = {
    item_id: `mnv_pinvoke_${digestCanonicalValue(
      {
        managedEvidenceId,
        token: item.token,
        importName: item.import_name,
        importScope: item.import_scope_name,
        candidates: selection.match.candidates,
      },
      "Managed/native verification",
    )}`,
    managed,
    evidence_links: [
      managedEvidenceId,
      ...new Set(selection.match.candidates.map(({ evidence_id: id }) => id)),
    ],
    limitations,
  };
  return {
    verification: { ...context, ...selection.match },
  };
};

const countStatuses = (
  items: readonly PinvokeVerification[],
): Pick<
  ManagedNativeVerificationResult["summary"],
  "verified" | "inferred" | "unresolved" | "contradicted"
> => ({
  verified: items.filter(({ status }) => status === "verified").length,
  inferred: items.filter(({ status }) => status === "inferred").length,
  unresolved: items.filter(({ status }) => status === "unresolved").length,
  contradicted: items.filter(({ status }) => status === "contradicted").length,
});

interface VerificationResultInput {
  readonly managedEvidence: Evidence;
  readonly managed: ManagedNativeBoundaryInspection;
  readonly native: {
    readonly symbols: readonly NativeSymbol[];
    readonly accepted: number;
    readonly unsupported: number;
  };
  readonly pinvokeImports: readonly PinvokeVerification[];
  readonly nativeObservationCount: number;
  readonly nativeEvidenceIds: readonly string[];
}

export const buildVerificationResult = ({
  managedEvidence,
  managed,
  native,
  pinvokeImports,
  nativeObservationCount,
  nativeEvidenceIds,
}: VerificationResultInput): Omit<
  ManagedNativeVerificationResult,
  "verification_id"
> => {
  const counts = countStatuses(pinvokeImports);
  const nativeBodyUnresolved = managed.native_implementations.filter(
    ({ boundary_kind: kind }) => kind !== "pinvoke",
  ).length;
  const coverage: ManagedNativeVerificationResult["coverage"] = {
    status:
      managed.coverage.state === "complete" && native.unsupported === 0
        ? "complete-within-inputs"
        : "partial",
  };
  return {
    algorithm: {
      name: "rea-managed-native-verification" as const,
      token_identity: "build-local" as const,
      token_to_address_mapping: "not-inferred" as const,
    },
    managed_boundary: {
      evidence_id: managedEvidence.evidence_id,
      artifact_sha256: managed.artifact.sha256,
      artifact_path: managed.artifact.path,
      mvid: managed.module?.mvid ?? null,
      metadata_status: managed.metadata.status,
      pinvoke_imports_total: managed.pinvoke_imports.length,
      native_implementations_total: managed.native_implementations.length,
      coverage_state: managed.coverage.state,
    },
    native_observations: {
      total: nativeObservationCount,
      accepted: native.accepted,
      unsupported: native.unsupported,
      symbols: native.symbols.length,
    },
    summary: {
      ...counts,
      native_body_unresolved: nativeBodyUnresolved,
    },
    pinvoke_imports: [...pinvokeImports],
    native_implementations: {
      unresolved: nativeBodyUnresolved,
      reason:
        "Managed metadata tokens and RVAs are not translated to native provider addresses by this workflow; C++/CLI, ReadyToRun, and native-body mappings require explicit provider-supported bridge evidence.",
    },
    coverage,
    evidence_links: [managedEvidence.evidence_id, ...nativeEvidenceIds],
    limitations: [
      "P/Invoke verification checks declared import names against supplied native export or function-name Evidence only.",
      "A matching native symbol verifies that a candidate export/function was observed; it does not prove CLR binding, marshaling behavior, call reachability, or runtime loading.",
      "Missing supplied native symbols are reported as unresolved, not proof that a dependency cannot exist.",
      "Managed metadata tokens and method RVAs are not interpreted as native addresses.",
      ...(managed.coverage.state === "complete"
        ? []
        : ["Managed boundary input is partial or unavailable."]),
      ...(native.unsupported === 0
        ? []
        : [
            "Some native Evidence operations were unsupported by this workflow.",
          ]),
    ],
  };
};
