// F1b (notes/20260808-mla-in-this-session-measured-and-a-fix-proposal.md §4): did a
// distinctive span of an injected snippet come back out in what the agent wrote?
//
// This is the only signal that can see the push path's actual success mode on turns 7 and 8
// of session 85d97591, where the agent read the injected snippet inline, changed course, and
// never opened the file or called an evidence tool. It is ALSO a heuristic, and the recap
// keeps it out of the engaged set for exactly that reason: text reappearing proves the text
// reached the output, not that it helped. An agent quoting a snippet to explain why it is
// obsolete produces an identical signal.
//
// Design target is precision. The window is a verbatim run of ECHO_NGRAM consecutive words
// carrying at least MIN_CONTENT_TOKENS distinct non-stopword terms: long enough that English
// does not produce it by accident, short enough that a quoted sentence clears it. Everything
// it misses is acceptable. A false positive is not, because this number is one we would then
// quote at ourselves.

/** Consecutive words that must match verbatim. Eight is a quotation, not a coincidence. */
export const ECHO_NGRAM = 8;

/** Distinct non-stopword terms an n-gram must carry to count. Blocks runs of pure filler. */
export const MIN_CONTENT_TOKENS = 4;

/** Hard input caps, so a pathological snippet cannot blow a Stop-hook budget. */
const MAX_SNIPPET_CHARS = 500_000;
const MAX_OUTPUT_CHARS = 500_000;

// Deliberately small: this list only has to stop "and then it was that there is not one of
// the things" from reading as a quotation, and every word added to it is a word that can no
// longer contribute to a real match.
const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "from", "had", "has", "have",
  "he", "her", "his", "i", "if", "in", "into", "is", "it", "its", "not", "of", "on", "one",
  "or", "she", "so", "than", "that", "the", "their", "them", "then", "there", "these", "they",
  "this", "to", "was", "we", "were", "what", "when", "which", "who", "will", "with", "you",
]);

export interface EchoScanItem {
  source_id: string;
  text: string;
}

// Lowercase, and collapse every run of non-alphanumerics to a single space. Markdown
// punctuation, list bullets and line wrapping are formatting, not content: an agent that
// re-wraps a quoted sentence has still quoted it. Underscores survive as word characters so
// `is_claim_trusted_for_generation` stays one token rather than becoming five.
function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, " ")
    .trim()
    .split(" ")
    .filter((t) => t.length > 0);
}

function isContentToken(t: string): boolean {
  return t.length >= 3 && !STOPWORDS.has(t);
}

// Every ECHO_NGRAM-length window of `tokens`, joined. Used to build the OUTPUT's window set
// once (O(output)) so each snippet is then a set of O(1) lookups rather than a scan.
function windows(tokens: string[]): string[] {
  if (tokens.length < ECHO_NGRAM) return [];
  const out: string[] = [];
  for (let i = 0; i + ECHO_NGRAM <= tokens.length; i++) {
    out.push(tokens.slice(i, i + ECHO_NGRAM).join(" "));
  }
  return out;
}

/**
 * The offered ids whose snippet is verbatim-quoted somewhere in `output`.
 *
 * Order follows `items`, deduped. An empty result means "the scan ran and saw no quotation",
 * which is a real observation; the caller records it as such so a turn where the scan never
 * ran stays distinguishable from a turn where it found nothing.
 */
export function scanEchoes(items: EchoScanItem[], output: string): string[] {
  if (!items.length || !output) return [];
  const outTokens = tokenize(output.slice(0, MAX_OUTPUT_CHARS));
  if (outTokens.length < ECHO_NGRAM) return [];
  const outWindows = new Set(windows(outTokens));

  const hit: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (!item.source_id || !item.text || seen.has(item.source_id)) continue;
    const tokens = tokenize(item.text.slice(0, MAX_SNIPPET_CHARS));
    if (tokens.length < ECHO_NGRAM) continue;
    for (let i = 0; i + ECHO_NGRAM <= tokens.length; i++) {
      const slice = tokens.slice(i, i + ECHO_NGRAM);
      // Cheap gate first: a window of filler is discarded before the set lookup.
      const content = new Set(slice.filter(isContentToken));
      if (content.size < MIN_CONTENT_TOKENS) continue;
      if (outWindows.has(slice.join(" "))) {
        hit.push(item.source_id);
        seen.add(item.source_id);
        break;
      }
    }
  }
  return hit;
}
