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

/**
 * Normalize to NFC, lowercase, split on anything that is not a letter, digit, or
 * combining mark, and drop 1-char tokens.
 *
 * Every clause there is load-bearing for Vietnamese, which is a first-class pilot
 * language:
 *
 *   - The letter class is UNICODE (`\p{L}`), not `a-z`. An ASCII-only class does not
 *     merely fail to index Vietnamese, it SHREDS it: every accented vowel becomes a
 *     separator, so "đăng nhập" tokenizes to ["ng", "nh"], fragments that are not
 *     words in any language and that collide with real tokens.
 *   - `.normalize("NFC")` because the SAME Vietnamese word has two encodings, and the
 *     one a macOS filesystem or an IME hands you is often NFD: a base letter plus a
 *     separate combining accent. A combining accent is `\p{M}`, not `\p{L}`, so on the
 *     class alone it would act as a SEPARATOR and re-open the exact shredding bug the
 *     `\p{L}` class closed ("đăng nhập" in NFD -> ["đa", "ng", "nha"]). NFC composes
 *     the pair back into one letter, so both encodings tokenize identically.
 *   - `\p{M}` stays in the keep-class anyway, for the marks NFC cannot compose (no
 *     precomposed code point exists). Better one intact token than two fragments.
 *
 * This is exact-token matching, so it still does not FIND Vietnamese in an
 * English-only corpus. That is honest (zero hits, offline fallback), where shredding
 * was not: it manufactured phantom terms. Diacritic folding ("dang nhap" matching
 * "đăng nhập") is a real feature, and a separate one; do not fake it here.
 */
export function tokenizeDocsQuery(text: string): string[] {
  return text
    .normalize("NFC")
    .toLowerCase()
    .split(/[^\p{L}\p{N}\p{M}]+/u)
    .filter((t) => t.length >= 2);
}

/**
 * Words that carry no signal about WHICH page answers a question, only that a human
 * asked it in a sentence. English only, on purpose: this is an English corpus, and a
 * Vietnamese stopword list here would be a list of words that cannot appear in any
 * passage anyway (they would score zero either way, so it would buy nothing and add a
 * language we would then have to keep correct).
 *
 * Why they have to go, and it is not "tidier ranking". Query terms are matched against
 * the TITLE and HEADING at 12x and 6x body weight, so "how" hitting a page titled "How
 * it works" outranks "activate" hitting the body of the activate page. Measured on the
 * real corpus, `docsSearch("how do I log in to mla and activate a workspace and fix a
 * rate limit error")` returned 100 of 101 passages, ranked substantially by the words
 * "how", "do", "to", "and", "a". That output is exactly what the CLI prints under every
 * degradation banner (corpus skew, rate limit, service down, and after an abstention),
 * so the offline fallback a user meets on our worst day was the surface most polluted.
 */
// prettier-ignore
const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "you", "your", "are", "was",
  "can", "how", "what", "when", "where", "which", "who", "why", "does", "did", "will",
  "would", "should", "could", "have", "has", "had", "get", "got", "out",
  "any", "all", "not", "but", "its", "it", "is", "in", "on", "to", "of", "do", "an",
  "at", "as", "be", "by", "or", "if", "my", "me", "we", "us",
]);

/**
 * Distinct query terms, in first-seen order (order is irrelevant to scoring but keeps
 * the term loop deterministic), minus stopwords.
 *
 * The all-stopword query keeps its terms. "how do I" is a bad query, but the honest
 * response to it is a bad ranking (the user sees pages and refines), not ZERO results,
 * which reads as "the docs do not cover this" and is a lie. Dropping to no terms would
 * also send Control's over-budget passage selection down its no-hits branch, where it
 * ships the corpus in file order.
 */
function distinctTerms(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tokenizeDocsQuery(text)) {
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  const meaningful = out.filter((t) => !STOPWORDS.has(t));
  return meaningful.length > 0 ? meaningful : out;
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

/**
 * First WHOLE-token occurrence of `term` in `haystack`, or -1.
 *
 * Substring search would anchor the snippet inside another word (query "cli" landing
 * on "client"), showing the reader a highlighted window that has nothing to do with
 * why the passage ranked. Terms come from the tokenizer, so they are letters, digits,
 * and marks only, and need no regex escaping.
 *
 * The match is case-insensitive AGAINST THE ORIGINAL, deliberately: the returned index
 * has to index the string the caller slices. Searching a `toLowerCase()` copy and
 * slicing the original is the classic off-by-N, because lowercasing is not
 * length-preserving in Unicode ("İ".toLowerCase() is TWO code units), so one Turkish
 * dotted capital anywhere earlier in the passage shifts every later index and the
 * snippet silently cuts mid-word.
 *
 * That trade leaves ONE residual, and it is the right one to keep: a term the tokenizer
 * folded out of "İ" (i + combining dot) will not match the "İ" in the original under
 * `/i`, so that hit is not found. The passage still SCORES and still ranks (scoring
 * reads the folded text, not this function); only the snippet falls back to the head of
 * the passage. A worse window on a Turkish dotted capital beats a corrupted index on
 * every other query, and the alternative (mapping folded offsets back to original ones)
 * is real machinery to buy a snippet nudge.
 */
function findTokenAt(haystack: string, term: string): number {
  const match = new RegExp(
    `(?<![\\p{L}\\p{N}\\p{M}])${term}(?![\\p{L}\\p{N}\\p{M}])`,
    "iu",
  ).exec(haystack);
  return match ? match.index : -1;
}

/** Build a short snippet around the first query-term hit in the plain text; fall
 * back to the head of the passage when no term appears in the body. */
function buildSnippet(plain: string, terms: string[]): string {
  // NFC for the same reason the tokenizer normalizes: an NFD passage would never
  // match an NFC term, so a Vietnamese hit would rank and then show a head-of-passage
  // snippet as if nothing had matched. Slicing the normalized string keeps every index
  // consistent with the string we searched.
  const collapsed = plain.normalize("NFC").replace(/\s+/g, " ").trim();
  if (!collapsed) return "";
  let hitAt = -1;
  for (const term of terms) {
    const i = findTokenAt(collapsed, term);
    if (i >= 0 && (hitAt < 0 || i < hitAt)) hitAt = i;
  }
  if (hitAt < 0) {
    return collapsed.length <= SNIPPET_MAX
      ? collapsed
      : collapsed.slice(0, SNIPPET_MAX).trimEnd() + "…";
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
 * match no query term (score 0) are excluded. A query with no tokens at all (empty,
 * punctuation, single letters) returns no hits; an all-stopword query keeps its
 * stopwords and ranks on them (see distinctTerms).
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
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.passageId < b.passageId ? -1 : a.passageId > b.passageId ? 1 : 0;
  });
  return scored.slice(0, limit);
}
