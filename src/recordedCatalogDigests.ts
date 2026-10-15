import type { CatalogDigests } from "./catalogIdentity.js";

/**
 * Digests of the default catalog (full input and output schemas), recorded
 * from the compiled contracts by `scripts/record-catalog-digests.mjs` after
 * compilation. Source runs leave this undefined and compute them on first use.
 */
export const RECORDED_CATALOG_DIGESTS: CatalogDigests | undefined = undefined;
