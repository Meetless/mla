// GENERATED - DO NOT EDIT. Vendored byte-for-byte from packages/utils/src/docs-search.ts
// by packages/utils/scripts/gen-docs-corpus.ts. The CLI cannot import @meetless/utils, so
// the shared lexical search is copied here; edit the utils source and re-run
// `pnpm --filter @meetless/utils docs-corpus:gen`. `gen-docs-corpus --check` fails on drift.

/**
 * Deterministic lexical search over the mla documentation corpus.
 *
 * ONE implementation, TWO consumers that never share a module at runtime:
 *   - Control imports it (via `@meetless/utils`) to pick candidate passages for
 *     `mla docs ask` (proposal §7.3 step 6: "the same lexical scoring that powers
 *     `mla docs search`").
 *   - the mla CLI vendors a BYTE-IDENTICAL copy at `src/lib/docs-search.ts` (the
 *     CLI cannot depend on @meetless/utils). The corpus generator writes both copies
 *     from this file, and `gen-docs-corpus --check` fails CI on any drift, so the two
 *     surfaces cannot diverge silently.
 *
 * This module is intentionally SELF-CONTAINED: it has zero imports and takes a
 * structural passage shape, so the vendored copy is valid unchanged in the CLI's
 * separate tsconfig. Do not add imports here; that would break byte-identical
 * vendoring. No embeddings, no async, no I/O: a scan over ~100 passages is free and
 * fully deterministic (identical query + identical corpus => identical ranking).
 */

/** The minimal passage fields the scorer reads. Both DocsPassage (utils) and the
 * CLI's loaded corpus rows satisfy this structurally. */
export interface DocsSearchable {
  passageId: string;
  slug: string;
  title: string;
  headingPath: string[];
  plain: string;
}

export interface DocsSearchHit {
  passageId: string;
  slug: string;
  title: string;
  headingPath: string[];
  score: number;
  snippet: string;
}

export interface DocsSearchOptions {
  /** Maximum hits to return. Default 10. */
  limit?: number;
}

/** Field weights. Title and heading matches dominate body frequency so a page
 * whose heading names the term outranks one that merely mentions it in prose. */
const TITLE_WEIGHT = 12;
const HEADING_WEIGHT = 6;
const BODY_WEIGHT = 1;
/** A single term's body contribution is capped so one term repeated many times
 * cannot dominate coverage of several distinct query terms. */
const BODY_TERM_CAP = 4;
const DEFAULT_LIMIT = 10;
const SNIPPET_MAX = 180;

/** Lowercase, split on non-alphanumeric, drop tokens shorter than 2 chars. */
export function tokenizeDocsQuery(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2);
}

/** Distinct query terms, in first-seen order (order is irrelevant to scoring but
 * keeps the term loop deterministic). */
function distinctTerms(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tokenizeDocsQuery(text)) {
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

function countOccurrences(haystackTokens: string[], term: string): number {
  let n = 0;
  for (const tok of haystackTokens) if (tok === term) n++;
  return n;
}

function scorePassage(passage: DocsSearchable, terms: string[]): number {
  const titleTokens = tokenizeDocsQuery(passage.title);
  const headingTokens = tokenizeDocsQuery(passage.headingPath.join(" "));
  const bodyTokens = tokenizeDocsQuery(passage.plain);
  let score = 0;
  for (const term of terms) {
    if (titleTokens.includes(term)) score += TITLE_WEIGHT;
    if (headingTokens.includes(term)) score += HEADING_WEIGHT;
    const bodyHits = countOccurrences(bodyTokens, term);
    if (bodyHits > 0) score += BODY_WEIGHT * Math.min(bodyHits, BODY_TERM_CAP);
  }
  return score;
}

/** Build a short snippet around the first query-term hit in the plain text; fall
 * back to the head of the passage when no term appears in the body. */
function buildSnippet(plain: string, terms: string[]): string {
  const collapsed = plain.replace(/\s+/g, " ").trim();
  if (!collapsed) return "";
  const lower = collapsed.toLowerCase();
  let hitAt = -1;
  for (const term of terms) {
    const i = lower.indexOf(term);
    if (i >= 0 && (hitAt < 0 || i < hitAt)) hitAt = i;
  }
  if (hitAt < 0) {
    return collapsed.length <= SNIPPET_MAX ? collapsed : collapsed.slice(0, SNIPPET_MAX).trimEnd() + "…";
  }
  const start = Math.max(0, hitAt - 40);
  const end = Math.min(collapsed.length, start + SNIPPET_MAX);
  let snippet = collapsed.slice(start, end).trim();
  if (start > 0) snippet = "…" + snippet;
  if (end < collapsed.length) snippet = snippet + "…";
  return snippet;
}

/**
 * Rank passages against a free-text query. Deterministic: results are sorted by
 * descending score, then ascending `passageId` as a stable tiebreak. Passages that
 * match no query term (score 0) are excluded. An empty or all-stopword query
 * returns no hits.
 */
export function docsSearch(
  passages: readonly DocsSearchable[],
  query: string,
  options: DocsSearchOptions = {},
): DocsSearchHit[] {
  const terms = distinctTerms(query);
  if (terms.length === 0) return [];
  const limit = options.limit ?? DEFAULT_LIMIT;

  const scored: DocsSearchHit[] = [];
  for (const p of passages) {
    const score = scorePassage(p, terms);
    if (score <= 0) continue;
    scored.push({
      passageId: p.passageId,
      slug: p.slug,
      title: p.title,
      headingPath: p.headingPath,
      score,
      snippet: buildSnippet(p.plain, terms),
    });
  }
  scored.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.passageId < b.passageId ? -1 : a.passageId > b.passageId ? 1 : 0));
  return scored.slice(0, limit);
}
