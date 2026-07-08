/**
 * Status-fallback warning synthesis for the MCP /v1/ask wrapper.
 *
 * Originally a single shortcut inside `server.js::statusFallback`; extracted
 * so the rule is testable in isolation and so server.js stays a thin MCP
 * adapter.
 *
 * Track A6 fix (proposal §A6): the previous implementation counted every
 * result row (notes + diffs + threads) against the `minResults` threshold
 * for the SHIPPED status filter. Because `note_status` is a NOTE-ONLY
 * concept (diffs carry a workflow status, threads carry no lifecycle at
 * all), any mixed-corpus answer with fewer than three citations would fire
 * `fell back to UNKNOWN; only N of 3 found in SHIPPED` even when the cited
 * notes were correctly SHIPPED. The warning then appeared on the majority
 * of successful answers and was ignored by the operator, defeating its
 * purpose.
 *
 * The new rule: only NOTE results are weighed against the threshold, and
 * the warning fires only when at least one returned note carries a status
 * outside the wanted set (i.e., we genuinely had to expand to UNKNOWN to
 * surface anything). Pure-ops answers (no notes returned) get no warning
 * because the SHIPPED filter is moot for them. Mixed answers where every
 * returned note IS in the wanted set get no warning because the filter
 * worked even if minResults wasn't met (the result set is just small).
 *
 * Bug #4 fix (2026-05-20 ladder eval): the warning is now gated on the
 * caller having EXPLICITLY supplied a non-empty `filters.statuses`. The
 * previous implicit `{SHIPPED}` default fired on essentially every plain
 * notes answer, because (a) the MCP wrapper's answer/search modes never
 * inject a `statuses` filter, and (b) notes ingest with no lifecycle
 * status (normalized to UNKNOWN). With no explicit status target there is
 * nothing to "fall back" from, so the warning is suppressed. The A6 use
 * case (caller passes `statuses:["SHIPPED"]` and we widen to UNKNOWN) is
 * unchanged.
 */

const DEFAULT_MIN = 3;

/**
 * Decide whether the answer's result set warrants the synthetic
 * "fell back to UNKNOWN" warning.
 *
 * @param {Array<{docType?: string, status?: string}>} results
 * @param {{statuses?: string[]}|null|undefined} filters
 * @param {number|undefined} minResults
 * @returns {{results: Array, warnings: string[]}}
 */
export function statusFallback(results, filters, minResults) {
  const safeResults = Array.isArray(results) ? results : [];

  // Bug #4: only an EXPLICIT, non-empty status filter establishes a target
  // to fall back from. With no explicit target (the wrapper's default for
  // plain answer/search queries) the warning is meaningless noise, since
  // notes carry no lifecycle status.
  const explicit =
    filters && Array.isArray(filters.statuses) && filters.statuses.length > 0;
  if (!explicit) {
    return { results: safeResults, warnings: [] };
  }
  const wantedStatuses = filters.statuses.map((s) => String(s).toUpperCase());
  const threshold = Number.isFinite(minResults) && minResults > 0 ? minResults : DEFAULT_MIN;

  // Caller explicitly opted into UNKNOWN -- expansion is the desired
  // behavior, not a fallback worth warning about.
  if (wantedStatuses.includes("UNKNOWN")) {
    return { results: safeResults, warnings: [] };
  }

  const noteResults = safeResults.filter(
    (r) => String((r && r.docType) || "").toLowerCase() === "note",
  );

  // No notes returned at all -- the answer is operational (diffs/threads).
  // The SHIPPED filter is a NOTE concept; it cannot have "fallen back" if
  // no note was in scope to begin with.
  if (noteResults.length === 0) {
    return { results: safeResults, warnings: [] };
  }

  // Enough notes to satisfy the threshold -- filter worked.
  if (noteResults.length >= threshold) {
    return { results: safeResults, warnings: [] };
  }

  const wantedSet = new Set(wantedStatuses);
  const fellBack = noteResults.some(
    (r) => !wantedSet.has(String((r && r.status) || "UNKNOWN").toUpperCase()),
  );
  if (!fellBack) {
    return { results: safeResults, warnings: [] };
  }

  return {
    results: safeResults,
    warnings: [
      `fell back to UNKNOWN; only ${noteResults.length} of ${threshold} found in ${wantedStatuses.join(",")}`,
    ],
  };
}
