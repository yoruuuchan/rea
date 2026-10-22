import {
  iterateUrlQueryParameters,
  parseUrlQueryParameterNames,
} from "../recordedTransportUrl.js";

/** Query parameters that page or bound a list without filtering it. */
const PAGING_PARAMETERS = new Set([
  "limit",
  "offset",
  "page",
  "per_page",
  "perpage",
  "page_size",
  "pagesize",
  "size",
  "start",
  "_start",
  "_end",
]);

/** Whether a query only pages its list: no parameters, or paging parameters alone. */
export const pagesOnly = (query: string | undefined): boolean =>
  query === undefined ||
  [...parseUrlQueryParameterNames(query)].every((name) =>
    PAGING_PARAMETERS.has(name.toLowerCase()),
  );

/** Paging parameters that bound how many items a page holds. */
const PAGE_SIZE_PARAMETERS = new Set([
  "limit",
  "per_page",
  "perpage",
  "page_size",
  "pagesize",
  "size",
]);

/** The most items a query's page holds: its smallest whole-number page-size value or `_start`–`_end` range width, or undefined without one; with `unboundedZero`, a size of zero is no bound. */
const pageLimit = (
  query: string | undefined,
  unboundedZero: boolean,
): number | undefined => {
  let size = Infinity;
  const range = { start: 0, end: Infinity };
  for (const [name, value] of iterateUrlQueryParameters(query ?? "")) {
    const key = name.toLowerCase();
    if (!/^\d+$/u.test(value)) continue;
    const number = Number(value);
    if (PAGE_SIZE_PARAMETERS.has(key)) {
      if (number > 0 || !unboundedZero) size = Math.min(size, number);
    } else if (key === "_start") range.start = number;
    else if (key === "_end") range.end = number;
  }
  const width = Math.min(size, Math.max(range.end - range.start, 0));
  return Number.isFinite(width) ? width : undefined;
};

/** The most items a line's call lists. A size of zero is no bound on a line whose own recording listed items under it, as an application reading zero as no limit does; every other size and range still bounds the page. */
export const pageBound = (
  query: string | undefined,
  recorded: number,
): number | undefined => pageLimit(query, recorded > 0);
