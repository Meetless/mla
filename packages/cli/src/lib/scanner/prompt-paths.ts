// Explicit prompt-path extraction + containment (targeted-rule-injection §4.7).
//
// The scoped-rule matcher needs the repo-relative paths a user NAMED in their prompt, so a
// scoped MUST whose glob matches one of them can be promoted to REQUIRED this turn. This is
// deliberately NOT a parser: it tokenizes on whitespace, strips the punctuation that wraps a
// path in prose (backticks, quotes, brackets, a trailing comma/period, a `:line:col` suffix, a
// leading `@` mention sigil), and keeps only tokens that (a) look like a path and (b) provably
// stay inside the repo.
//
// Containment is a security boundary, not a nicety: an explicit path controls which scoped
// MUST rules become required, so a `../` escape or an absolute path outside the repo must
// never survive to the matcher. When a token cannot be proven repo-relative it is dropped,
// not guessed. A spurious in-repo token (e.g. `e.g` read as a path) is harmless: it simply
// matches no real glob and is inert.
//
// PURE: no I/O, no filesystem probing. "Accept not-yet-existing files" is a direct consequence
// (we never stat) and is required so a rule can be surfaced for a file the prompt is about to
// create. The one job is lexical normalization to repo root + containment.

import { posix } from "node:path";

// Characters that wrap a path in prose. Stripped from both ends, repeatedly, so `("file.ts")`
// or `<file.ts>` unwrap fully before the path-shape test.
const WRAP_CHARS = new Set(["`", '"', "'", "(", ")", "[", "]", "{", "}", "<", ">"]);
// Sigils that PREFIX a path but never suffix one. `@notes/foo.md` is how a Claude Code user
// names a file (the harness's own file-mention syntax), and it is by far the most common way an
// explicit path actually arrives in a prompt, so leaving the `@` attached made `explicitPathAny`
// unmatchable in exactly the case it exists for. Leading-only: a trailing `@` is not a mention.
// A false positive here stays inert by the module contract above (`@meetless/mla` normalizes to
// `meetless/mla`, which matches no real glob).
const LEAD_SIGILS = new Set(["@"]);
// Sentence punctuation that trails a path token in prose. A trailing `/` is NOT here: it is a
// meaningful directory marker (`apps/control/` must keep its slash to match `apps/control/**`).
const TRAILING_PUNCT = new Set([",", ".", ";", ":", "!", "?"]);
// A file-extension suffix: a dot, an alpha lead, then up to 7 more alphanumerics, at the end.
// Lets a bare filename (`README.md`) qualify as a path even with no directory separator.
const EXT_RE = /\.[A-Za-z][A-Za-z0-9]{0,7}$/;
// A `:line` or `:line:col` editor suffix (`file.ts:42`, `file.ts:42:7`). Numeric only, so a
// real path segment (which never starts a component with a bare number after a colon) is safe.
const LINE_COL_RE = /:\d+(?::\d+)?$/;

export interface ExtractOptions {
  // The absolute git toplevel. Required to relativize (and contain) an absolute path token.
  // Absent -> absolute tokens are dropped (cannot prove containment), relative tokens still work.
  repoRoot?: string;
}

/**
 * Extract the repo-relative paths named explicitly in a prompt, in first-seen order, deduped.
 * Every returned path is lexically normalized, contained to the repo (no `..` escape, no
 * absolute-outside), and carries a trailing slash iff the source token did (directory intent).
 */
export function extractExplicitPaths(prompt: string, opts: ExtractOptions = {}): string[] {
  if (!prompt) return [];
  const repoRoot = opts.repoRoot ? posix.normalize(opts.repoRoot.replace(/\/+$/, "")) : undefined;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of prompt.split(/\s+/)) {
    const p = normalizeToken(raw, repoRoot);
    if (p === null || seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

/** Clean one whitespace-delimited token into a contained repo-relative path, or null to drop it. */
function normalizeToken(raw: string, repoRoot: string | undefined): string | null {
  let t = strip(raw);
  if (!t) return null;

  // Drop the editor `:line:col` suffix, then reject any token that STILL contains a colon.
  // A repo-relative POSIX path never contains `:`, so a survivor is a URL scheme (`http://`),
  // a Windows drive (`C:\`), or junk. This one check subsumes the "reject URL-like" rule.
  t = t.replace(LINE_COL_RE, "");
  if (!t || t.includes(":")) return null;

  const hadTrailingSlash = t.length > 1 && t.endsWith("/");

  if (t.startsWith("/")) {
    // Absolute: keep only if it resolves INSIDE the repo, then relativize. Without a repoRoot
    // we cannot prove containment, so we drop it rather than guess.
    if (!repoRoot) return null;
    const rel = posix.relative(repoRoot, posix.normalize(t));
    if (rel === "" || rel === ".." || rel.startsWith("../") || posix.isAbsolute(rel)) return null;
    t = rel;
  }

  // Path-shape gate: a token is a path only if it has a separator or a file extension. This is
  // what keeps ordinary words ("fix", "the", "control") from being read as paths.
  if (!t.includes("/") && !EXT_RE.test(t)) return null;

  let norm = posix.normalize(t);
  if (hadTrailingSlash && !norm.endsWith("/")) norm += "/";

  // Containment: after normalization nothing may escape the repo root or collapse to nothing.
  if (norm === "" || norm === "." || norm === ".." || norm.startsWith("../") || norm.startsWith("/")) {
    return null;
  }
  return norm;
}

/**
 * Strip wrapping chars and trailing sentence punctuation from both ends, repeatedly, plus any
 * leading mention sigil. Order does not matter: the loop runs to a fixed point, so `(@file.ts)`
 * and `@"file.ts"` both unwrap fully.
 */
function strip(raw: string): string {
  let t = raw.trim();
  let changed = true;
  while (changed && t.length > 0) {
    changed = false;
    if (WRAP_CHARS.has(t[0]) || LEAD_SIGILS.has(t[0])) {
      t = t.slice(1);
      changed = true;
    }
    if (t.length > 0) {
      const last = t[t.length - 1];
      if (WRAP_CHARS.has(last) || TRAILING_PUNCT.has(last)) {
        t = t.slice(0, -1);
        changed = true;
      }
    }
  }
  return t;
}
