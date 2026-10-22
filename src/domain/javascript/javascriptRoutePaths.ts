/** URL route syntax, independent of filesystem path normalization. */
export const routePath = (
  value: string,
  options: { relative?: boolean; navigation?: boolean } = {},
): string | undefined => {
  const end = options.navigation ? value.search(/[?#]/u) : -1;
  const path = end < 0 ? value : value.slice(0, end);
  if (!path || /[\u0000-\u0020\u007f\\]/u.test(path) || path.startsWith("//"))
    return;
  if (!path.startsWith("/") && !options.relative) return;
  if (/^[a-z][a-z0-9+.-]*:/iu.test(path)) return;
  return path.startsWith("/") ? path : `/${path}`;
};

export type NextAppRoutePath =
  | { readonly kind: "known"; readonly path: string }
  | { readonly kind: "unknown"; readonly reason: string };

/** Classify a page filename without treating missing routing context as absence. */
export const classifyNextAppRoutePath = (
  raw: string,
): NextAppRoutePath | undefined => {
  if (raw.includes("\\")) return;
  let value = raw;
  if (raw.includes("://")) {
    try {
      value = new URL(raw).pathname;
    } catch {
      return;
    }
  }
  // A deployment prefix may itself contain an `app` segment. Only the chunk
  // path following Next's asset boundary can describe an App Router module.
  const assetRoot = value.indexOf("/_next/");
  if (assetRoot >= 0) value = value.slice(assetRoot + "/_next/".length);
  const match =
    /(?:^|\/)app\/(?:(.*?)\/)?page(?:-([^/?#]+)\.js|\.(?:[cm]?jsx?|tsx?)|)(?:[?#].*)?$/u.exec(
      value,
    );
  if (!match) return;
  if (match[2] !== undefined && !/(?:^|\/)static\/chunks\/app\//u.test(value))
    return;
  const encodedSegments = (match[1] ?? "").split("/");
  // A private folder excludes the whole page, including intercepted ancestors.
  // Test before decoding: %5F names are public URLs.
  if (encodedSegments.some((segment) => segment.startsWith("_"))) return;
  const segments: string[] = [];
  for (const encoded of encodedSegments) {
    let segment: string;
    try {
      segment = decodeURIComponent(encoded);
    } catch {
      return;
    }
    if (/^\([^)]*\)$/u.test(segment) || segment.startsWith("@")) continue;
    // Intercepted routes need a parent routing context that a filename does not establish.
    if (segment.startsWith("("))
      return {
        kind: "unknown",
        reason:
          "An intercepted Next page route requires parent routing context unavailable from its filename.",
      };
    if (segment.includes("/") || segment === "." || segment === "..") return;
    const optional = /^\[\[\.\.\.([^\]]+)\]\]$/u.exec(segment);
    const catchAll = /^\[\.\.\.([^\]]+)\]$/u.exec(segment);
    const parameter = /^\[([^\]]+)\]$/u.exec(segment);
    segments.push(
      optional
        ? `:${optional[1]}*`
        : catchAll
          ? `:${catchAll[1]}+`
          : parameter
            ? `:${parameter[1]}`
            : segment,
    );
  }
  const path = routePath(`/${segments.filter(Boolean).join("/")}`);
  return path === undefined ? undefined : { kind: "known", path };
};

export const nextScriptBasePath = (source: string): string | undefined => {
  let path = source;
  if (/^https?:\/\//iu.test(source)) {
    try {
      path = new URL(source).pathname;
    } catch {
      return;
    }
  } else if (!source.startsWith("/")) return;
  const at = path.indexOf("/_next/");
  return at < 0 ? undefined : path.slice(0, at);
};
