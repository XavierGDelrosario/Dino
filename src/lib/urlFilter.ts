// =========================================================
// Chunking for PostgREST list filters (`.in(...)` / `or=(...in.(...))`).
//
// PostgREST puts filter VALUES in the query string of a GET, so a big list
// becomes a huge URL. Past some length the request fails outright — either the
// server rejects it (414 URI Too Long) or the client can't send it at all
// ("TypeError: error sending request", which is how it shows up from Deno).
//
// This is not hypothetical and not rare. It is the cause of quality report #3
// ("Paragraph reader didn't detect words"): a 712-char Japanese paste produced
// 161 unique lookup keys, the edge function's cache read inlined all of them, and
// the request never left. The batch threw, the caller's catch swallowed it, and
// EVERY word in the paragraph rendered grey — a total failure that looks like a
// dictionary-coverage problem. Prod's error_log shows it recurring since.
//
// Why budget by ENCODED BYTES rather than by a fixed item count (the older
// per-chunk-item approach this replaced): a UUID has a fixed encoded length, but a
// dictionary term does not. Percent-encoded Japanese costs ~9 bytes per CHARACTER
// (漢 → %E6%BC%A2), so 100 Japanese terms can be an order of magnitude larger than
// 100 ASCII ones. Counting items silently gives a different budget per language;
// counting bytes is what actually bounds the URL. This is now the SINGLE chunking
// mechanism — both the dictionary read (repository.ts) and the per-user state read
// (userWords.ts getUserWordStates) route through it.
// =========================================================

/**
 * Bytes of encoded filter values allowed per request. Deliberately conservative:
 * the whole URL also carries the host, column filters, ordering, and PostgREST's
 * own syntax, and intermediaries (proxies, CDNs) impose their own limits well
 * below what an origin server might accept.
 */
export const URL_FILTER_BUDGET_BYTES = 3000;

/** Per-value syntax overhead: surrounding quotes, the separating comma, and the
 *  percent-encoding of those characters. Small, but it compounds over a long list. */
const PER_VALUE_OVERHEAD = 4;

/**
 * Split `values` so each chunk's encoded size stays within the budget.
 *
 * `repeats` = how many times the list appears in ONE url. The dictionary cache
 * read matches `input.in.(…),input_reading.in.(…)`, i.e. the same list twice, so
 * its effective budget is half — get this wrong and the fix silently under-chunks.
 *
 * OUTPUT: chunks in input order; every value appears exactly once. A single value
 * larger than the whole budget still gets its own chunk (it can't be split, and
 * dropping it would silently lose a lookup).
 */
export function chunkForUrlFilter(
  values: string[],
  opts: { budgetBytes?: number; repeats?: number } = {},
): string[][] {
  const budget = Math.max(1, (opts.budgetBytes ?? URL_FILTER_BUDGET_BYTES) / (opts.repeats ?? 1));
  const chunks: string[][] = [];
  let current: string[] = [];
  let size = 0;
  for (const value of values) {
    const cost = encodeURIComponent(value).length + PER_VALUE_OVERHEAD;
    if (current.length > 0 && size + cost > budget) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(value);
    size += cost;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}
