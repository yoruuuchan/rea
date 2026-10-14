import type { JavaScriptSourceSelection } from "./javascriptSourceSelection.js";

/** Whether an inventoried path has a source extension read by the analyzer. */
export const isJavaScriptSourcePath = (path: string): boolean =>
  /\.(?:cjs|cts|mjs|mts|js|jsx|ts|tsx)$/iu.test(path);

/** Relevant file categories projected from the complete artifact inventory. */
export type JavaScriptArtifactFileKind =
  | "package-json"
  | "json"
  | "javascript"
  | "html"
  | "source-map"
  | "native-addon";

/** One content-addressed local artifact file and its text availability. */
export interface JavaScriptArtifactFile {
  readonly path: string;
  readonly container_sha256: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly inventory_artifact_id: string;
  readonly kind: JavaScriptArtifactFileKind;
  readonly unpacked: boolean;
  readonly text:
    | { readonly included: true; readonly value: string }
    | {
        readonly included: false;
        readonly reason:
          | "not-applicable"
          | "invalid-utf8"
          | "outside-analysis-scope";
      };
}

/**
 * One inventoried regular file outside the JavaScript-relevant kinds. Its presence
 * was inventoried, including unavailable or unhashed members. The source projection
 * does not read its bytes; references remain present-but-unanalyzed rather than absent.
 */
export interface JavaScriptUnanalyzedArtifactFile {
  readonly path: string;
  readonly container_sha256: string;
  readonly sha256: string | null;
  readonly bytes: number | null;
  readonly inventory_artifact_id: string | null;
  readonly limitations?: readonly string[];
}

/** Borrowed inventory lookup; metadata is materialized only for requested paths. */
export interface JavaScriptUnanalyzedArtifactLookup {
  get(path: string): JavaScriptUnanalyzedArtifactFile | undefined;
  hasDirectory(path: string, containerSha256: string | undefined): boolean;
}

/** One filesystem-backed ASAR nested beneath a directory input. */
export interface JavaScriptArtifactContainer {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly inventory_artifact_id: string;
}

/** Deterministic relevant-file projection plus explicit omissions. */
export interface JavaScriptArtifactFileSet {
  readonly files: readonly JavaScriptArtifactFile[];
  /** Borrowed inventory lookup for regular files the source projection does not read. */
  readonly unanalyzed_files?: JavaScriptUnanalyzedArtifactLookup;
  readonly containers: readonly JavaScriptArtifactContainer[];
  readonly text_bytes_read: number;
  readonly invalid_utf8_files: number;
  readonly source_selection?: JavaScriptSourceSelection;
}
