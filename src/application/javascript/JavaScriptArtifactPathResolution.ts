import { isBuiltin } from "node:module";
import { posix } from "node:path";

import {
  normalizeJoinedLogicalPath,
  logicalPathEscapesRoot,
} from "../../domain/artifactIdentity.js";
import type { JavaScriptArtifactFile } from "../../domain/javascript/javascriptArtifactFiles.js";
import {
  admitsCanonicalPathSyntax,
  hasScheme,
  htmlUrlText,
  looksExternal,
  percentDecodeUrlPath,
  stripQueryAndFragment,
} from "../../domain/artifactPathSyntax.js";
import {
  classifyPackageImportSpecifier,
  classifyPackageImportTargetString,
  lookupExactPackageImport,
} from "../../domain/javascript/javascriptPackageImportAliases.js";
import { typescriptEmittedSourceCandidates } from "../TypeScriptEmittedSourceCandidates.js";

type ArtifactPathResolutionContext =
  | "package-entrypoint"
  | "filesystem-expression"
  | "module-specifier"
  | "html-reference"
  | "url-reference";

type UnresolvedArtifactPathStatus =
  | "not-found"
  | "unavailable"
  | "external"
  | "rejected";

interface ArtifactPathResolutionBase {
  readonly declared_path: string;
  readonly resolution_context: ArtifactPathResolutionContext;
  readonly limitations: readonly string[];
}

/** Explicit outcome of artifact-confined path resolution. */
export type ArtifactPathResolution = ArtifactPathResolutionBase &
  (
    | {
        readonly resolved_path: string;
        readonly resolution_status: "resolved";
      }
    | {
        readonly resolved_path: null;
        readonly resolution_status: UnresolvedArtifactPathStatus;
      }
  );

/** Values needed to resolve a declaration without filesystem access. */
export interface ResolveArtifactPathInput {
  readonly declaredPath: string;
  readonly sourcePath: string;
  readonly context: ArtifactPathResolutionContext;
  readonly files: ReadonlyMap<string, JavaScriptArtifactFile>;
  readonly htmlBaseHref?: string | null;
  /** Import/require semantics; runtime resource paths omit this provenance. */
  readonly moduleKind?: "import" | "require";
}

const EXTENSIONS = [
  ".js",
  ".cjs",
  ".mjs",
  ".ts",
  ".tsx",
  ".json",
  ".html",
  ".node",
];

// A private URL namespace for logical artifact paths, including root packages.
// Encode inventory segments so filename punctuation remains literal in the base.
const PACKAGE_ARTIFACT_ROOT_URL = new URL("file:///rea-artifact/");
const packageMetadataUrl = (path: string): URL =>
  new URL(
    path.split("/").map(encodeURIComponent).join("/"),
    PACKAGE_ARTIFACT_ROOT_URL,
  );

interface PackageFileTarget {
  readonly value: string;
  /** Normalized URL retained until loader-specific validation and file lookup. */
  readonly url: URL;
}

type CandidateResolution =
  | {
      readonly resolvedPath: string;
      readonly status: "resolved";
      readonly limitations: readonly string[];
    }
  | {
      readonly resolvedPath: null;
      readonly status: UnresolvedArtifactPathStatus;
      readonly limitations: readonly string[];
    };

/** Resolve one declaration while preserving its original input identity. */
export const resolveArtifactPathByContext = (
  input: ResolveArtifactPathInput,
): ArtifactPathResolution => {
  const resolution = resolvePath(input);
  return resolution.status === "resolved"
    ? {
        declared_path: input.declaredPath,
        resolution_context: input.context,
        resolved_path: resolution.resolvedPath,
        resolution_status: resolution.status,
        limitations: resolution.limitations,
      }
    : {
        declared_path: input.declaredPath,
        resolution_context: input.context,
        resolved_path: null,
        resolution_status: resolution.status,
        limitations: resolution.limitations,
      };
};

const resolvePath = (input: ResolveArtifactPathInput): CandidateResolution => {
  // Package import keys are literal lookup identities, not artifact paths.
  // The selected target is admitted separately by resolveExportTarget.
  if (
    input.context === "module-specifier" &&
    input.declaredPath.startsWith("#")
  )
    return resolvePackageImportAlias(input, input.declaredPath);
  const rejected = rejectDeclaration(input.declaredPath);
  if (rejected !== null) return rejected;
  const candidate = contextualCandidate(input);
  if (typeof candidate !== "string") return candidate;
  const confined = confineCandidate(candidate);
  if (typeof confined !== "string") return confined;
  if (input.context === "html-reference")
    return (
      resolveFileCandidates(input, [confined]) ??
      unresolvedCandidate("not-found", [
        `The exact HTML resource ${confined} was not found among the selected application files.`,
      ])
    );
  return resolveCandidate(
    input,
    confined,
    new Set(),
    input.context === "module-specifier" &&
      input.moduleKind !== undefined &&
      (input.declaredPath.startsWith(".") || input.declaredPath.startsWith("/"))
      ? typescriptEmittedSourceCandidates(input.sourcePath, confined)
      : [],
  );
};

const rejectDeclaration = (declared: string): CandidateResolution | null => {
  if (declared.length === 0)
    return unresolvedCandidate("rejected", ["The declared path is empty."]);
  if (declared.includes("\0") || declared.includes("\\"))
    return unresolvedCandidate("rejected", [
      "NUL and backslash path syntax are not admitted for canonical artifact paths.",
    ]);
  if (!admitsCanonicalPathSyntax(declared))
    return unresolvedCandidate("rejected", [
      "Encoded dot or separator bytes are rejected before artifact path resolution.",
    ]);
  return null;
};

const contextualCandidate = (
  input: ResolveArtifactPathInput,
): string | CandidateResolution => {
  const { context } = input;
  let declared =
    context === "html-reference" ||
    context === "url-reference" ||
    (context === "module-specifier" && input.moduleKind !== "require")
      ? stripQueryAndFragment(input.declaredPath)
      : input.declaredPath;
  if (context === "html-reference") return htmlCandidate(input);
  if (context === "module-specifier") {
    const fileUrl = fileUrlPath(declared);
    if (fileUrl !== undefined) return fileUrl;
    if (hasScheme(declared))
      return unresolvedCandidate("external", [
        "URL and Node builtin schemes are outside static artifact module resolution.",
      ]);
    if (!declared.startsWith(".") && !declared.startsWith("/"))
      return bareModuleCandidate(input, declared);
    if (input.moduleKind !== "require") {
      const decoded = decodeModuleUrlPath(declared);
      if (typeof decoded !== "string") return decoded;
      declared = decoded;
    }
  } else if (looksExternal(declared))
    return unresolvedCandidate("external", [
      "URL schemes and protocol-relative URLs are outside this local artifact path context.",
    ]);
  if (context === "url-reference") {
    const decoded = percentDecodeUrlPath(declared);
    if (decoded === null)
      return unresolvedCandidate("rejected", [
        "The URL reference path percent-decodes to NUL or to bytes that are not UTF-8.",
      ]);
    declared = decoded;
  }
  return relativeCandidate(input.sourcePath, declared);
};

const decodeModuleUrlPath = (
  declared: string,
): string | CandidateResolution => {
  let decoded: string;
  try {
    decoded = decodeURIComponent(declared);
  } catch (cause: unknown) {
    void cause;
    return unresolvedCandidate("rejected", [
      "The module URL path contains malformed percent encoding.",
    ]);
  }
  return decoded.includes("\0")
    ? unresolvedCandidate("rejected", [
        "The decoded module URL path contains NUL.",
      ])
    : decoded;
};

const relativeCandidate = (sourcePath: string, declared: string): string =>
  declared.startsWith("/")
    ? declared.slice(1)
    : posix.join(posix.dirname(sourcePath), declared);

const bareModuleCandidate = (
  input: ResolveArtifactPathInput,
  declared: string,
): CandidateResolution => {
  const packageName = barePackageName(declared);
  if (packageName === null || isBuiltin(declared))
    return unresolvedCandidate("external", [
      "The bare specifier is a Node builtin or invalid package name.",
    ]);
  if (input.moduleKind === "import" && packageName.includes("%"))
    return unresolvedCandidate("rejected", [
      "Percent signs are not admitted in ES module package names.",
    ]);
  const self = commonJsSelfCandidate(input, declared);
  if (self !== null) return self;
  const subpath =
    declared === packageName ? "." : `.${declared.slice(packageName.length)}`;
  const source = input.files.get(input.sourcePath);
  let directory = posix.dirname(input.sourcePath);
  while (true) {
    const candidate = posix.join(directory, "node_modules", packageName);
    const metadata = readPackageMetadata(input, candidate);
    if (packageExportsEligible(input) && metadata.kind !== "absent")
      return resolvePackageSpecifier(input, candidate, subpath, metadata);
    if (subpath === ".") {
      const direct = resolveFileCandidates(input, fileCandidates(candidate));
      if (direct !== null) return direct;
    }
    if (hasContainerDirectory(input.files, candidate, source?.container_sha256))
      return resolvePackageSpecifier(input, candidate, subpath, metadata);
    if (directory === "." || directory === "") break;
    directory = posix.dirname(directory);
  }
  return unresolvedCandidate("external", [
    "No matching bare package was inventoried in an enclosing node_modules directory.",
  ]);
};

/**
 * Nearest same-container package.json, stopping at a `node_modules` directory
 * so a nested package cannot inherit an ancestor's map.
 */
const enclosingPackageMetadata = (
  input: ResolveArtifactPathInput,
):
  | Extract<PackageMetadata, { readonly kind: "available" | "unavailable" }>
  | { readonly kind: "none" } => {
  let directory = posix.dirname(input.sourcePath);
  while (posix.basename(directory) !== "node_modules") {
    const metadata = readPackageMetadata(input, directory);
    if (metadata.kind !== "absent") return metadata;
    if (directory === "." || directory === "") break;
    directory = posix.dirname(directory);
  }
  return { kind: "none" };
};

/**
 * Resolve an exact `#alias` against the importer's enclosing `imports` map.
 * Selected relative targets are exact files; patterns, recursive aliases, and
 * external-package targets stay unresolved without falling through.
 */
const resolvePackageImportAlias = (
  input: ResolveArtifactPathInput,
  specifier: string,
): CandidateResolution => {
  const classified = classifyPackageImportSpecifier(specifier);
  if (classified.kind === "invalid")
    return unresolvedCandidate("rejected", [
      `The package import specifier ${JSON.stringify(specifier)} is invalid; "#" and specifiers that end with "/" are not valid import aliases.`,
    ]);
  if (classified.kind === "pattern")
    return unresolvedCandidate("external", [
      `Wildcard and directory package import aliases remain unresolved; ${JSON.stringify(specifier)} is not an exact imports key.`,
    ]);
  const metadata = enclosingPackageMetadata(input);
  if (metadata.kind === "none")
    return unresolvedCandidate("external", [
      `No enclosing package.json defines package import alias ${specifier}; package import maps do not cross package scopes.`,
    ]);
  if (metadata.kind === "unavailable")
    return unresolvedCandidate("unavailable", [metadata.limitation]);
  const lookup = lookupExactPackageImport(metadata.imports, specifier);
  if (lookup.kind === "undefined-map")
    return unresolvedCandidate("external", [
      `Package metadata ${metadata.path} does not define package import alias ${specifier}.`,
    ]);
  if (lookup.kind === "missing-key")
    return unresolvedCandidate("external", [
      `Package metadata ${metadata.path} does not define package import alias ${specifier}; it declares ${lookup.declared.join(", ") || "no imports keys"}.`,
    ]);
  if (lookup.kind === "pattern-unresolved")
    return unresolvedCandidate("external", [
      `Wildcard package import aliases remain unresolved; package metadata ${metadata.path} has no exact imports key ${specifier}.`,
    ]);
  const selected = selectPackageImportTarget(
    lookup.target,
    input.moduleKind,
    metadata.path,
  );
  if (selected.status === "rejected")
    return unresolvedCandidate("rejected", [
      `Package metadata ${metadata.path}: ${selected.limitation}`,
    ]);
  if (selected.status === "unmatched")
    return unresolvedCandidate("external", [
      `Package metadata ${metadata.path} declares no imports target for alias ${specifier} under the active conditions; it declares ${selected.declared.join(", ") || "no conditions"}.`,
    ]);
  if (selected.status === "blocked")
    return unresolvedCandidate("external", [
      `Package metadata ${metadata.path} blocks import alias ${specifier} with ${selected.cause === "null" ? "an explicit null imports target" : "an empty imports target array"}.`,
    ]);
  if (selected.status === "non-relative") {
    const target = classifyPackageImportTargetString(selected.value);
    return unresolvedCandidate("external", [
      target.kind === "recursive"
        ? `Recursive package import aliases remain unresolved; package metadata ${metadata.path} maps ${specifier} to ${JSON.stringify(target.target)}.`
        : `External-package import targets remain unresolved; package metadata ${metadata.path} maps ${specifier} to ${JSON.stringify(target.target)}.`,
    ]);
  }
  return resolveExportTarget(input, metadata.path, selected, "imports");
};

const selectPackageImportTarget = (
  value: unknown,
  moduleKind: ResolveArtifactPathInput["moduleKind"],
  packagePath: string,
):
  | ({ readonly status: "value" } & PackageFileTarget)
  | { readonly status: "non-relative"; readonly value: string }
  | { readonly status: "blocked"; readonly cause: PackageTargetBlockCause }
  | { readonly status: "unmatched"; readonly declared: readonly string[] }
  | { readonly status: "rejected"; readonly limitation: string } => {
  const selected = selectExportTarget(
    value,
    packageExportConditions(moduleKind),
    packageMetadataUrl(packagePath),
    "imports",
  );
  if (selected.kind === "invalid" || selected.kind === "invalid-config")
    return { status: "rejected", limitation: selected.limitation };
  if (selected.kind === "unmatched")
    return {
      status: "unmatched",
      declared: selected.declared,
    };
  if (selected.kind === "blocked")
    return { status: "blocked", cause: selected.cause };
  if (selected.kind === "non-relative")
    return { status: "non-relative", value: selected.value };
  return {
    status: "value",
    value: selected.value,
    url: selected.url,
  };
};

/** Self references use the nearest package scope before dependency lookup. */
const commonJsSelfCandidate = (
  input: ResolveArtifactPathInput,
  declared: string,
): CandidateResolution | null => {
  if (input.moduleKind !== "require" || !input.files.has(input.sourcePath))
    return null;
  const metadata = enclosingPackageMetadata(input);
  if (metadata.kind === "none") return null;
  if (metadata.kind === "unavailable")
    return unresolvedCandidate("unavailable", [metadata.limitation]);
  if (
    metadata.name === undefined ||
    metadata.exports === undefined ||
    (declared !== metadata.name && !declared.startsWith(`${metadata.name}/`))
  )
    return null;
  const subpath =
    declared === metadata.name
      ? "."
      : `.${declared.slice(metadata.name.length)}`;
  // Self resolution does not apply the CommonJS dependency-name matcher.
  return resolvePackageExports(input, metadata.path, subpath, metadata.exports);
};

/** Package roots and exact subpaths share metadata and exports selection. */
const resolvePackageSpecifier = (
  input: ResolveArtifactPathInput,
  directory: string,
  subpath: string,
  metadata: PackageMetadata,
): CandidateResolution => {
  const exportsEligible = packageExportsEligible(input);
  if (exportsEligible && metadata.kind === "unavailable")
    return unresolvedCandidate("unavailable", [metadata.limitation]);
  const rawExports =
    exportsEligible && metadata.kind === "available"
      ? metadata.exports
      : undefined;
  if (rawExports === undefined) {
    if (subpath === ".")
      return (
        resolveFileCandidates(input, fileCandidates(directory)) ??
        resolveDirectory(input, directory, metadata, new Set())
      );
    // Preserve the trailing slash for a package directory request.
    const candidate = confineCandidate(`${directory}/${subpath.slice(2)}`);
    return typeof candidate === "string"
      ? resolveCandidate(input, candidate, new Set())
      : candidate;
  }
  return resolvePackageExports(
    input,
    posix.join(directory, "package.json"),
    subpath,
    rawExports,
  );
};

const resolvePackageExports = (
  input: ResolveArtifactPathInput,
  packagePath: string,
  subpath: string,
  rawExports: string | object,
): CandidateResolution => {
  const exported = selectPackageExport(
    rawExports,
    subpath,
    input.moduleKind,
    packagePath,
  );
  if (exported.status === "rejected")
    return unresolvedCandidate("rejected", [
      `Package metadata ${packagePath}: ${exported.limitation}`,
    ]);
  if (exported.status === "unmatched")
    return unresolvedCandidate("external", [
      `Directory package metadata ${packagePath} declares no exports target ${subpath === "." ? "for the active conditions" : `for subpath ${subpath}`}; exports encapsulation permits no file or index lookup. It declares ${exported.declared.join(", ") || "a root target only"}.`,
    ]);
  if (exported.status === "blocked")
    return unresolvedCandidate("external", [
      `Directory package metadata ${packagePath} blocks subpath ${subpath} with ${exported.cause === "null" ? "an explicit null exports target" : "an empty exports target array"}.`,
    ]);
  return resolveExportTarget(input, packagePath, exported);
};

/** An exports or import target is a URL naming one exact file for both Node loaders. */
const resolveExportTarget = (
  input: ResolveArtifactPathInput,
  packagePath: string,
  target: PackageFileTarget,
  mapKind: "exports" | "imports" = "exports",
): CandidateResolution => {
  const withTargetSource = (
    outcome: CandidateResolution,
  ): CandidateResolution => ({
    ...outcome,
    limitations: outcome.limitations.map(
      (reason) =>
        `Package metadata ${packagePath}, ${mapKind} target ${JSON.stringify(target.value)}: ${reason}`,
    ),
  });
  // Node's CommonJS finalizer checks the serialized URL, including suffixes;
  // its ESM finalizer checks only the pathname. Neither error retries arrays.
  if (input.moduleKind === "require" && /%(?:2f|5c)/iu.test(target.url.href))
    return withTargetSource(
      unresolvedCandidate("rejected", [
        "The selected package URL contains encoded separator bytes.",
      ]),
    );
  const encodedPath = target.url.pathname.slice(
    PACKAGE_ARTIFACT_ROOT_URL.pathname.length,
  );
  const rejected = rejectDeclaration(encodedPath);
  if (rejected !== null) return withTargetSource(rejected);
  const decoded = decodeModuleUrlPath(encodedPath);
  if (typeof decoded !== "string") return withTargetSource(decoded);
  const candidate = confineCandidate(decoded);
  if (typeof candidate !== "string") return withTargetSource(candidate);
  return (
    resolveFileCandidates(input, [candidate]) ??
    withTargetSource(exactPackageTargetNotFound(candidate, mapKind))
  );
};

const barePackageName = (specifier: string): string | null => {
  const segments = specifier.split("/");
  if (specifier.startsWith("@"))
    return segments.length >= 2 && segments[0] !== "" && segments[1] !== ""
      ? `${segments[0]}/${segments[1]}`
      : null;
  return segments[0] === "" ? null : (segments[0] ?? null);
};

const packageExportsEligible = (input: ResolveArtifactPathInput): boolean => {
  if (input.moduleKind !== "require") return true;
  // Node's CommonJS exports matcher excludes percent-containing package names.
  // Compare the captured name so a scoped name cannot fall back to its scope.
  const match = /^((?:@[^/\\%]+\/)?[^./\\%][^/\\%]*)(\/.*)?$/.exec(
    input.declaredPath,
  );
  return match?.[1] === barePackageName(input.declaredPath);
};

const hasContainerDirectory = (
  files: ReadonlyMap<string, JavaScriptArtifactFile>,
  candidate: string,
  containerSha256: string | undefined,
): boolean => {
  if (
    [...indexCandidates(candidate), posix.join(candidate, "package.json")].some(
      (path) => {
        const file = files.get(path);
        return (
          file !== undefined &&
          (containerSha256 === undefined ||
            file.container_sha256 === containerSha256)
        );
      },
    )
  )
    return true;
  // Inventory has files rather than directory entries. Any same-container
  // descendant establishes a package directory even without package.json.
  const prefix = `${candidate}/`;
  for (const [path, file] of files)
    if (
      path.startsWith(prefix) &&
      (containerSha256 === undefined ||
        file.container_sha256 === containerSha256)
    )
      return true;
  return false;
};

const htmlCandidate = (
  input: ResolveArtifactPathInput,
): string | CandidateResolution => {
  const declared = stripQueryAndFragment(htmlUrlText(input.declaredPath));
  if (looksExternal(declared))
    return unresolvedCandidate("external", [
      "External HTML references are not mapped to local artifact assets.",
    ]);
  const rawBase = input.htmlBaseHref;
  const base =
    rawBase === undefined || rawBase === null
      ? rawBase
      : stripQueryAndFragment(htmlUrlText(rawBase));
  if (base !== undefined && base !== null && looksExternal(base))
    return unresolvedCandidate("external", [
      "The document base href is external, so its script reference is not a local artifact path.",
    ]);
  // Removing URL tabs and newlines can join an encoded dot or separator that
  // the raw declaration split, so admit the parsed URL text again.
  if (!admitsCanonicalPathSyntax(declared))
    return unresolvedCandidate("rejected", [
      "Encoded dot or separator bytes are rejected before artifact path resolution.",
    ]);
  const declaredPath = percentDecodeUrlPath(declared);
  if (declaredPath === null)
    return unresolvedCandidate("rejected", [
      "The HTML reference path percent-decodes to NUL or to bytes that are not UTF-8.",
    ]);
  if (declaredPath.startsWith("/")) return declaredPath.slice(1);
  if (base === undefined || base === null || base === "")
    return declaredPath === ""
      ? input.sourcePath
      : posix.join(posix.dirname(input.sourcePath), declaredPath);
  // A local base href is a second untrusted path input; apply the same
  // admission rules a declared path gets so it cannot smuggle traversal or
  // separator syntax past canonicalization.
  if (!admitsCanonicalPathSyntax(base))
    return unresolvedCandidate("rejected", [
      "The document base href uses NUL, backslash, or encoded dot and separator bytes that are not admitted for canonical artifact paths.",
    ]);
  const decodedBase = percentDecodeUrlPath(base);
  if (decodedBase === null)
    return unresolvedCandidate("rejected", [
      "The document base href path percent-decodes to NUL or to bytes that are not UTF-8.",
    ]);
  const basePath = decodedBase.startsWith("/")
    ? decodedBase.slice(1)
    : posix.join(posix.dirname(input.sourcePath), decodedBase);
  if (declaredPath === "") return emptyHtmlReference(decodedBase, basePath);
  return posix.join(htmlBaseDirectory(decodedBase, basePath), declaredPath);
};

const emptyHtmlReference = (
  base: string,
  basePath: string,
): string | CandidateResolution => {
  if (!htmlBaseIsDirectory(base)) return basePath;
  const confined = confineCandidate(basePath);
  if (typeof confined !== "string") return confined;
  return unresolvedCandidate("not-found", [
    `The HTML reference resolves to directory ${confined || "."}, not an exact selected application file.`,
  ]);
};

/**
 * The directory a relative HTML reference resolves against. A base path
 * ending in "/" or in a "." or ".." segment is already a directory, because a
 * relative reference resolves against the base URL's directory and those
 * segments are dropped rather than stepped through.
 */
const htmlBaseIsDirectory = (base: string): boolean =>
  base.endsWith("/") ||
  base.endsWith("/.") ||
  base.endsWith("/..") ||
  base === "." ||
  base === "..";

const htmlBaseDirectory = (base: string, basePath: string): string =>
  htmlBaseIsDirectory(base) ? basePath : posix.dirname(basePath);

const confineCandidate = (candidate: string): string | CandidateResolution => {
  const normalized = normalizeJoinedLogicalPath(candidate);
  if (logicalPathEscapesRoot(normalized))
    return unresolvedCandidate("rejected", [
      "The resolved candidate escapes the canonical artifact root.",
    ]);
  return normalized === "." ? "" : normalized;
};

type PackageMetadata =
  | {
      readonly kind: "available";
      readonly path: string;
      readonly name: string | undefined;
      readonly exports: string | object | undefined;
      readonly imports: object | undefined;
      readonly main: unknown;
      readonly module: unknown;
    }
  | { readonly kind: "absent" }
  | { readonly kind: "unavailable"; readonly limitation: string };

const readPackageMetadata = (
  input: ResolveArtifactPathInput,
  directory: string,
): PackageMetadata => {
  const path = posix.join(directory, "package.json");
  const file = input.files.get(path);
  const source = input.files.get(input.sourcePath);
  if (
    file === undefined ||
    (source !== undefined && file.container_sha256 !== source.container_sha256)
  )
    return { kind: "absent" };
  if (!file.text.included)
    return {
      kind: "unavailable",
      limitation: `Directory package metadata ${path} was inventoried but its text is unavailable: ${file.text.reason}.`,
    };
  let value: unknown;
  try {
    value = JSON.parse(file.text.value);
  } catch (cause: unknown) {
    void cause;
    return {
      kind: "unavailable",
      limitation: `Directory package metadata ${path} is not valid package JSON.`,
    };
  }
  if (typeof value !== "object" || value === null)
    return {
      kind: "unavailable",
      limitation: `Directory package metadata ${path} is not valid package JSON.`,
    };
  const name = Reflect.get(value, "name");
  const exports = Reflect.get(value, "exports");
  const imports = Reflect.get(value, "imports");
  return {
    kind: "available",
    path,
    name: typeof name === "string" ? name : undefined,
    // Node's package reader ignores scalar root exports other than strings.
    // Nested targets retain their raw values for exports validation.
    exports:
      typeof exports === "string" ||
      (typeof exports === "object" && exports !== null)
        ? exports
        : undefined,
    // Import maps must be non-array objects; other shapes are not a map.
    imports:
      typeof imports === "object" && imports !== null && !Array.isArray(imports)
        ? imports
        : undefined,
    main: Reflect.get(value, "main"),
    module: Reflect.get(value, "module"),
  };
};

/** File and directory lookup never interprets a nested directory's exports. */
const resolveCandidate = (
  input: ResolveArtifactPathInput,
  candidate: string,
  packageChain: ReadonlySet<string>,
  emittedSourceCandidates: readonly string[] = [],
): CandidateResolution =>
  resolveFileCandidates(input, [
    ...fileCandidates(candidate),
    ...emittedSourceCandidates,
  ]) ??
  resolveDirectory(
    input,
    candidate,
    readPackageMetadata(input, candidate),
    packageChain,
  );

const resolveDirectory = (
  input: ResolveArtifactPathInput,
  directory: string,
  metadata: PackageMetadata,
  packageChain: ReadonlySet<string>,
): CandidateResolution => {
  if (metadata.kind === "absent")
    return (
      resolveFileCandidates(input, indexCandidates(directory)) ??
      notFoundCandidate()
    );
  if (metadata.kind === "unavailable")
    return unresolvedCandidate("unavailable", [metadata.limitation]);
  if (packageChain.has(metadata.path))
    return unresolvedCandidate("unavailable", [
      `Directory package entrypoint cycle includes ${metadata.path}.`,
    ]);
  const preferred = [
    metadata.main,
    ...(input.moduleKind === undefined ? [metadata.module] : []),
  ];
  const entry = preferred.find((value) => value !== undefined);
  if (entry === undefined)
    return (
      resolveFileCandidates(input, indexCandidates(directory)) ??
      notFoundCandidate()
    );
  if (typeof entry !== "string" || entry.length === 0)
    return unresolvedCandidate("unavailable", [
      `Directory package metadata ${metadata.path} is not valid package JSON.`,
    ]);
  const entryInput: ResolveArtifactPathInput = {
    declaredPath: entry,
    sourcePath: metadata.path,
    context: "package-entrypoint",
    files: input.files,
    ...(input.moduleKind === undefined ? {} : { moduleKind: input.moduleKind }),
  };
  const rejected = rejectDeclaration(entryInput.declaredPath);
  if (rejected !== null) return rejected;
  const candidate = contextualCandidate(entryInput);
  if (typeof candidate !== "string") return candidate;
  const confined = confineCandidate(candidate);
  if (typeof confined !== "string") return confined;
  const selected =
    resolveFileCandidates(entryInput, [
      ...fileCandidates(confined),
      ...indexCandidates(confined),
    ]) ?? resolveFileCandidates(input, indexCandidates(directory));
  if (selected !== null) return selected;
  return resolveCandidate(
    entryInput,
    confined,
    new Set([...packageChain, metadata.path]),
  );
};

const resolveFileCandidates = (
  input: ResolveArtifactPathInput,
  candidates: readonly string[],
): CandidateResolution | null => {
  const source = input.files.get(input.sourcePath);
  for (const path of candidates) {
    const target = input.files.get(path);
    if (
      target !== undefined &&
      (source === undefined ||
        target.container_sha256 === source.container_sha256)
    )
      return { resolvedPath: path, status: "resolved", limitations: [] };
  }
  return null;
};

const fileCandidates = (candidate: string): readonly string[] => [
  candidate,
  ...EXTENSIONS.map((extension) => `${candidate}${extension}`),
];

const indexCandidates = (candidate: string): readonly string[] =>
  EXTENSIONS.map((extension) => posix.join(candidate, `index${extension}`));

type PackageTargetBlockCause = "null" | "empty-array";

type PackageExportOutcome =
  | ({ readonly status: "value" } & PackageFileTarget)
  | { readonly status: "rejected"; readonly limitation: string }
  | { readonly status: "blocked"; readonly cause: PackageTargetBlockCause }
  | { readonly status: "unmatched"; readonly declared: readonly string[] };

/** Only exact non-directory keys participate; wildcard expansion is unsupported. */
const selectPackageExport = (
  value: unknown,
  subpath: string,
  moduleKind: ResolveArtifactPathInput["moduleKind"],
  packagePath: string,
): PackageExportOutcome => {
  let target = value;
  let declared: string[] = [];
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const keys = Object.keys(value);
    const hasSubpaths = keys.some((key) => key.startsWith("."));
    if (hasSubpaths && keys.some((key) => !key.startsWith(".")))
      return {
        status: "rejected",
        limitation:
          "The package exports configuration mixes subpath keys and condition keys.",
      };
    declared = keys;
    if (hasSubpaths) {
      if (
        subpath.endsWith("/") ||
        subpath.includes("*") ||
        !Object.hasOwn(value, subpath)
      )
        return { status: "unmatched", declared };
      target = Reflect.get(value, subpath);
    } else if (subpath !== ".") return { status: "unmatched", declared };
  } else if (subpath !== ".") return { status: "unmatched", declared };
  const selected = selectExportTarget(
    target,
    packageExportConditions(moduleKind),
    packageMetadataUrl(packagePath),
  );
  if (selected.kind === "invalid" || selected.kind === "invalid-config")
    return { status: "rejected", limitation: selected.limitation };
  if (selected.kind === "unmatched")
    return {
      status: "unmatched",
      declared: selected.declared,
    };
  if (selected.kind === "blocked")
    return { status: "blocked", cause: selected.cause };
  if (selected.kind === "non-relative")
    return {
      status: "rejected",
      limitation: `The package exports target ${JSON.stringify(selected.value)} must start with "./".`,
    };
  return {
    status: "value",
    value: selected.value,
    url: selected.url,
  };
};

type ExportTargetOutcome =
  | ({ readonly kind: "value" } & PackageFileTarget)
  | { readonly kind: "non-relative"; readonly value: string }
  | { readonly kind: "blocked"; readonly cause: PackageTargetBlockCause }
  | { readonly kind: "unmatched"; readonly declared: readonly string[] }
  | { readonly kind: "invalid"; readonly limitation: string }
  | { readonly kind: "invalid-config"; readonly limitation: string };

const invalidExportTarget = (
  value: unknown,
  reason: string,
  mapKind: "exports" | "imports" = "exports",
): ExportTargetOutcome => ({
  kind: "invalid",
  limitation: `The package ${mapKind === "imports" ? "import" : "exports"} target ${JSON.stringify(value) ?? String(value)} ${reason}.`,
});

// Node checks raw target segments before URL normalization. Compare encoded
// segment names here; full URL decoding follows array target selection.
const forbiddenExportSegment = (value: string): string | undefined =>
  value
    .slice(2)
    .split(/[\\/]/u)
    .find((raw) => {
      const segment = raw.replace(/%[0-9a-f]{2}/giu, (encoded) =>
        String.fromCharCode(Number.parseInt(encoded.slice(1), 16)),
      );
      return (
        segment === "." ||
        segment === ".." ||
        segment.toLowerCase() === "node_modules"
      );
    });

const selectStringPackageTarget = (
  value: string,
  packageUrl: URL,
  mapKind: "exports" | "imports",
): ExportTargetOutcome => {
  if (mapKind === "imports") {
    const target = classifyPackageImportTargetString(value);
    if (target.kind === "invalid")
      return invalidExportTarget(
        value,
        "cannot be parent-relative, absolute, or a URL",
        mapKind,
      );
    if (target.kind !== "relative") return { kind: "non-relative", value };
  } else if (!value.startsWith("./"))
    return invalidExportTarget(value, 'must start with "./"', mapKind);
  const forbidden = forbiddenExportSegment(value);
  if (forbidden !== undefined)
    return invalidExportTarget(
      value,
      `contains forbidden path segment ${JSON.stringify(forbidden)} before URL normalization`,
      mapKind,
    );
  // Node constructs the URL before deciding whether this array entry is an
  // invalid package target. Tabs/newlines and dot segments normalize here;
  // percent decoding and existence checks belong after target selection.
  const url = new URL(value, packageUrl);
  if (!url.pathname.startsWith(new URL(".", packageUrl).pathname))
    return invalidExportTarget(
      value,
      "escapes the package root after URL normalization",
      mapKind,
    );
  return {
    kind: "value",
    value,
    url,
  };
};

const selectArrayPackageTarget = (
  value: readonly unknown[],
  conditions: ReadonlySet<string>,
  packageUrl: URL,
  mapKind: "exports" | "imports",
): ExportTargetOutcome => {
  if (value.length === 0) return { kind: "blocked", cause: "empty-array" };
  let lastRefusal:
    | Extract<ExportTargetOutcome, { readonly kind: "invalid" | "blocked" }>
    | undefined;
  const declared = new Set<string>();
  for (const entry of value) {
    const nested = selectExportTarget(entry, conditions, packageUrl, mapKind);
    // Node's array fallback catches invalid targets, not invalid configuration.
    if (nested.kind === "invalid-config") return nested;
    if (nested.kind === "unmatched") {
      for (const condition of nested.declared) declared.add(condition);
      continue;
    }
    if (nested.kind === "invalid" || nested.kind === "blocked") {
      lastRefusal = nested;
      continue;
    }
    return nested;
  }
  return lastRefusal ?? { kind: "unmatched", declared: [...declared] };
};

/**
 * Resolve a target in Node's declared order. Explicit null blocks an active
 * condition, whereas an unmatched nested object permits the next condition.
 * An array skips unmatched and invalid entries, stops at its first string, and
 * preserves the last invalid/null outcome if no string is selected. A nonempty
 * array of unmatched conditions stays unmatched; an empty array blocks.
 */
const selectExportTarget = (
  value: unknown,
  conditions: ReadonlySet<string>,
  packageUrl: URL,
  mapKind: "exports" | "imports" = "exports",
): ExportTargetOutcome => {
  if (typeof value === "string")
    return selectStringPackageTarget(value, packageUrl, mapKind);
  if (value === null) return { kind: "blocked", cause: "null" };
  if (Array.isArray(value))
    return selectArrayPackageTarget(value, conditions, packageUrl, mapKind);
  if (typeof value !== "object")
    return invalidExportTarget(
      value,
      "must be a relative string, object, array, or null",
      mapKind,
    );
  for (const key of Object.keys(value)) {
    const numeric = Number(key);
    if (String(numeric) === key && numeric >= 0 && numeric < 0xffff_ffff)
      return {
        kind: "invalid-config",
        limitation: `The package exports configuration contains numeric condition key ${JSON.stringify(key)}.`,
      };
  }
  const declared = new Set<string>();
  for (const [condition, target] of Object.entries(value)) {
    declared.add(condition);
    if (!conditions.has(condition)) continue;
    const nested = selectExportTarget(target, conditions, packageUrl, mapKind);
    if (nested.kind !== "unmatched") return nested;
    for (const name of nested.declared) declared.add(name);
  }
  return { kind: "unmatched", declared: [...declared] };
};

/**
 * Node selects an exports target by walking the declared keys in order and
 * taking the first whose condition is active for the calling resolver.
 * "default" is always active, and "node" plus "node-addons" are active for the
 * built-in resolver that owns installed-package imports and requires. The
 * supported Node runtimes also activate "module-sync" for both loaders.
 */
const packageExportConditions = (
  moduleKind: ResolveArtifactPathInput["moduleKind"],
): ReadonlySet<string> =>
  new Set([
    "node",
    "node-addons",
    "module-sync",
    ...(moduleKind === undefined ? [] : [moduleKind]),
    "default",
  ]);

const notFoundCandidate = (): CandidateResolution => ({
  resolvedPath: null,
  status: "not-found",
  limitations: [
    "No extension, directory package, or index candidate exists in the inventoried artifact container.",
  ],
});

const exactPackageTargetNotFound = (
  path: string,
  mapKind: "exports" | "imports",
): CandidateResolution => ({
  resolvedPath: null,
  status: "not-found",
  limitations: [
    `The selected package ${mapKind === "imports" ? "import" : "exports"} target ${path} does not exist in the inventoried artifact container; ${mapKind === "imports" ? "import" : "exports"} targets are exact files, so no extension or directory index was tried.`,
  ],
});

const fileUrlPath = (value: string): string | undefined => {
  if (!value.startsWith("file://")) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "file:" || url.hostname !== "") return undefined;
    return decodeURIComponent(url.pathname).replace(/^\/+/, "");
  } catch (cause: unknown) {
    // Unparseable file URLs have no path to resolve.
    void cause;
    return undefined;
  }
};

const unresolvedCandidate = (
  status: UnresolvedArtifactPathStatus,
  limitations: readonly string[],
): CandidateResolution => ({ resolvedPath: null, status, limitations });
