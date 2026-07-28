// Shared secret redactor for the mla CLI. Mirror of
// intel/app/observability/redaction.py, apps/control/src/core/services/redactor.ts
// and meetless-cli/packages/ask-core/redactor.js (the ESM plane, which exists
// because this file is CommonJS and cannot be imported by an ESM-only package).
// Principle 7 of notes/20260528-mla-logging-and-tracing-proposal.md:
// exactly one redactor, applied at the three places an operator can see
// captured content. Cross-plane parity is locked by a shared fixture test
// (packages/cli/test/lib/redactor-parity.spec.ts and its three mirrors).

export const REDACTED = "[REDACTED]";

// Order matters: env_assignment runs first so KEY=value pairs are handled
// before the token literals, which come second for cases without an = sign.
// High-entropy heuristic runs last to catch generic session tokens that the
// prefix matchers miss.
//
// Third element is the REPLACEMENT. Every pattern replaces its whole match with
// the marker except env_assignment, which keeps the variable NAME and the
// separator and replaces only the value (groups: 1 name, 2 separator, 3 value).
const PATTERNS: Array<[string, RegExp, string]> = [
  [
    "env_assignment",
    /\b([A-Z][A-Z0-9_]*_(?:TOKEN|KEY|SECRET|PASSWORD|PWD|API[_-]?KEY|ACCESS[_-]?KEY)|SECRET_[A-Z0-9_]+|PASSWORD|PASSWD|AWS_(?:ACCESS|SECRET)_(?:ACCESS_)?KEY(?:_ID)?|GH_TOKEN|GITHUB_TOKEN|OPENAI_API_KEY|ANTHROPIC_API_KEY)(\s*[:=]\s*)('[^']*'|"[^"]*"|\S+)/gim,
    // Keep the name. It is not a credential, and it is usually the primary
    // retrieval key: "OPENAI_API_KEY=[REDACTED]" still answers "which key was
    // set?", while a bare "[REDACTED]" answers nothing and makes the whole line
    // unsearchable. An earlier version replaced the entire match, so a redacted
    // command lost the one word that made it findable.
    //
    // Residual, stated plainly: the entropy sweep runs after this one and does
    // not know the name was deliberately preserved, so a name of 32+ chars
    // (uppercase + underscore clears the 2-class "full" bar) can still be eaten
    // under "full". That is the same over-redaction "full" already applies to
    // any long SCREAMING_SNAKE identifier, it is never worse than the previous
    // whole-match behaviour, and "retrieval" (3 classes) keeps such names.
    `$1$2${REDACTED}`,
  ],
  ["bearer", /\b(Bearer|Basic)\s+[A-Za-z0-9._\-+/=]+/gi, REDACTED],
  [
    "provider_token",
    /\b(sk-(?:proj-|ant-)?[A-Za-z0-9_\-]{16,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|ghs_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9\-]{10,}|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|AIza[0-9A-Za-z_\-]{35}|hf_[A-Za-z0-9]{20,}|lf_(?:sk|pk)_[A-Za-z0-9]{20,})\b/g,
    REDACTED,
  ],
  // A JWT is a live credential and must go WHOLE. The entropy heuristic cannot
  // do it: the three segments are split by "." (outside its token class), and
  // only the header clears the 32-char floor, so entropy alone yields
  // "[REDACTED].<claims>.<signature>" and leaks the claims and the signature.
  ["jwt", /\beyJ[A-Za-z0-9_\-]*\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]*/g, REDACTED],
  ["cookie", /(Set-)?Cookie:\s*[^\r\n]+/gi, REDACTED],
  [
    "pem_key",
    /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/g,
    REDACTED,
  ],
];

const ENTROPY_TOKEN = /\b[A-Za-z0-9_\-+/=]{32,}\b/g;

/**
 * Which entropy bar the generic heuristic applies. The LITERAL patterns above
 * are identical under both; only the last-resort heuristic moves.
 *
 * - "full" (default, and what every at-rest surface uses): 2+ character
 *   classes, entropy >= 3.5. Over-redaction is cheap when the destination is a
 *   database row an operator will read later.
 *
 * - "retrieval": 3+ character classes, entropy >= 4.0. For text that is itself
 *   a RETRIEVAL KEY on its way out to intel, where a "[REDACTED]" token is not
 *   a redaction but a destroyed query.
 *
 * The retrieval bar is not a guess. Measured over a 30-question corpus
 * (test/lib/redaction-fidelity.spec.ts), the "full" bar damages 12 of 20
 * realistic developer questions: deep file paths, import specifiers, stack
 * frames, URLs, branch names, 40-char git SHAs, 32-hex trace ids and
 * SCREAMING_SNAKE identifiers all clear a 2-class/3.5 bar. Raising to
 * 3 classes and 4.0 takes that to 1 of 20 while still catching every secret in
 * the corpus, including the bare ones no literal pattern covers (an
 * unprefixed AWS secret access key, a bare base64 blob).
 *
 * The residual cost, stated plainly: a PURE-HEX secret (2 classes) escapes the
 * retrieval bar. It is shape-identical to a git SHA, so no threshold separates
 * them. Such a token is still redacted at rest under "full", so it never
 * persists; the exposure is the in-flight question to our own intel service.
 *
 * - "events": the SAME literal patterns and the SAME entropy bar as "full"
 *   (2 classes, 3.5), plus one narrow exemption for path-shaped tokens. Exactly
 *   one production caller: `mla _internal redact-events`, the flush-time
 *   boundary for the hook event spool. See PATH_LIKE_EXEMPTION below for why it
 *   is a separate profile rather than a loosening of "full".
 */
export type RedactProfile = "full" | "retrieval" | "events";

const ENTROPY_BARS: Record<RedactProfile, { minClasses: number; minEntropy: number }> = {
  full: { minClasses: 2, minEntropy: 3.5 },
  retrieval: { minClasses: 3, minEntropy: 4.0 },
  // Deliberately identical to "full". The whole difference between the two
  // profiles is the path exemption below; if these ever diverge, "events" has
  // become a second retrieval bar and the reason for its existence is gone.
  events: { minClasses: 2, minEntropy: 3.5 },
};

/**
 * PATH_LIKE_EXEMPTION: contains a slash, contains a lowercase letter, contains
 * NO uppercase letter. Applied only under "events".
 *
 * Why it exists. Measured over a real captured corpus of 40 session transcripts
 * (scripts/measure-redaction-corpus.js, frozen into
 * test/fixtures/redaction-path-corpus.json): the "full" bar alters 64% of
 * captured bash-command items and eats 8,909 path-shaped spans across 1,575
 * distinct paths, while only 2.3% of those items contain any credential pattern
 * at all. The events spool is the ledger `mla review` reasons over, so a
 * redacted path is not a smaller answer, it is a wrong one: the review cannot
 * tell you which file a command touched. Under "events" all 8,909 survive and
 * the non-path-shaped spans are eaten identically (13,572 either way), which is
 * the measurement that says this exemption moved the path shape and nothing
 * else.
 *
 * Why the no-uppercase clause. A bare "contains a slash" exemption would collide
 * head-on with base64, and base64 is the shape of an AWS secret access key and
 * of most opaque session tokens. Requiring the token to be lowercase-only takes
 * the exemption away from every mixed-case blob.
 *
 * What this is NOT. "Path-shaped" is a SIGNATURE, not a proof of innocence. A
 * lowercase-and-digit secret containing a slash matches it and passes. That is
 * an ACCEPTED RESIDUAL, pinned by a test rather than argued away, and the
 * arithmetic about how rarely a random base64 generator lands in this shape is
 * a statement about generators, not a security property.
 *
 * Why a third profile instead of relaxing "full". "full" is the at-rest default,
 * the block-on-detect scanner's bar, and the fallback for an unrecognized
 * profile name. Loosening it would loosen all three at once, silently, for
 * callers that never asked.
 */
function looksPathLike(token: string): boolean {
  return token.includes("/") && /[a-z]/.test(token) && !/[A-Z]/.test(token);
}

function shannonEntropy(s: string): number {
  if (!s) return 0;
  const counts: Record<string, number> = {};
  for (const ch of s) counts[ch] = (counts[ch] ?? 0) + 1;
  const n = s.length;
  let h = 0;
  for (const c of Object.values(counts)) {
    const p = c / n;
    h -= p * Math.log2(p);
  }
  return h;
}

function looksHighEntropy(token: string, profile: RedactProfile): boolean {
  if (token.length < 32) return false;
  if (profile === "events" && looksPathLike(token)) return false;
  let lower = false,
    upper = false,
    digit = false,
    sep = false;
  for (const ch of token) {
    if (ch >= "a" && ch <= "z") lower = true;
    else if (ch >= "A" && ch <= "Z") upper = true;
    else if (ch >= "0" && ch <= "9") digit = true;
    else if ("_-+/=".includes(ch)) sep = true;
  }
  const bar = ENTROPY_BARS[profile];
  const classes = [lower, upper, digit, sep].filter(Boolean).length;
  if (classes < bar.minClasses) return false;
  return shannonEntropy(token) >= bar.minEntropy;
}

export function redact(
  text: string | null | undefined,
  profile: RedactProfile = "full",
): string | null | undefined {
  if (text === null || text === undefined || text === "") return text;
  let out = text;
  for (const [, pat, replacement] of PATTERNS) out = out.replace(pat, replacement);
  out = out.replace(ENTROPY_TOKEN, (m) => (looksHighEntropy(m, profile) ? REDACTED : m));
  return out;
}

// --- Block-on-detect secret scanner (SECRET-1) ---
//
// The agent-memory capture pipeline
// (notes/20260626-agent-memory-auto-capture-proposal.md) must BLOCK a file from
// leaving the machine when it contains a known high-risk secret, rather than
// silently redact-and-send. This reuses the parity-locked PATTERNS + entropy
// heuristic above for detection and adds directive-style secrets the
// substitution redactor does not carry.
//
// HONEST SCOPE (do not overstate to users): this blocks KNOWN secret PATTERNS
// locally; it is NOT a guarantee that "secrets cannot leave the machine." A
// novel or low-entropy credential can still pass. Returns the set of matched
// rule ids, sorted + de-duplicated; the matched secret text is NEVER returned,
// so a caller that logs findings cannot leak the secret. Empty array == clean.

// Directive-style secrets the substitution redactor intentionally omits (it
// substitutes; this one only blocks). requirepass/masterauth/masteruser are
// Redis/Sentinel config directives: a lowercase keyword + space + value, which
// the uppercase env_assignment pattern and the 32-char entropy gate both miss
// (e.g. an 8-char `requirepass <value>` slips past both).
const BLOCK_DIRECTIVE_PATTERNS: Array<[string, RegExp]> = [
  ["redis_directive", /\b(requirepass|masterauth|masteruser)\s+('[^']*'|"[^"]*"|\S+)/gi],
];

// A pure-hex token (git SHA, content hash, digest) is not a secret, and the
// agent-memory corpus is dense with them. Excluding hex from the entropy block
// keeps the dry-run from blocking nearly every file on an incidental 40-char
// hash while still catching base64/mixed-class credential blobs.
function isHexToken(token: string): boolean {
  return /^[0-9a-f]+$/i.test(token);
}

// Bump when the block-on-detect pattern set or entropy heuristic changes. The
// capture ledger stores this alongside a blocked file so a policy upgrade
// re-evaluates content blocked under an older version (RETRY-2 for blocks).
// 2026-07-26.1 added the `jwt` pattern, so content blocked (or passed) under
// 2026-06-27.1 deserves re-evaluation.
export const SECRET_SCANNER_VERSION = "2026-07-26.1";

export function scanForSecrets(text: string | null | undefined): string[] {
  if (!text) return [];
  const hits = new Set<string>();
  for (const [name, pat] of PATTERNS) {
    pat.lastIndex = 0;
    if (pat.test(text)) hits.add(name);
  }
  for (const [name, pat] of BLOCK_DIRECTIVE_PATTERNS) {
    pat.lastIndex = 0;
    if (pat.test(text)) hits.add(name);
  }
  ENTROPY_TOKEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ENTROPY_TOKEN.exec(text)) !== null) {
    const tok = m[0];
    // The block-on-detect scanner always uses the "full" bar: it gates a FILE
    // leaving the machine, where a false positive costs one blocked upload and
    // a false negative costs a live credential. It never uses "events": the
    // path exemption exists to protect a ledger's READABILITY, and this scanner
    // is not deciding readability, it is deciding whether a secret ships.
    if (!isHexToken(tok) && looksHighEntropy(tok, "full")) {
      hits.add("high_entropy_token");
      break;
    }
  }
  return [...hits].sort();
}

// --- Pre-upload credential denylist (Phase 2A/2B, proposal §4/§6) ---
//
// The LIVE capture path (Phase 2A+) must withhold a file from upload when it
// carries a KNOWN, high-confidence credential FORMAT, because the real corpus
// contains a live credential (SECRET-1). This is DELIBERATELY NOT scanForSecrets:
// it excludes the generic Shannon-entropy heuristic, which over-blocked 99.2% of
// the corpus in the Phase 0A static audit and is explicitly rejected for the
// blocking path. It runs ONLY the precision-first format matchers: provider-token
// prefixes (sk-/ghp_/AKIA/...), Authorization headers (Bearer/Basic), cookies,
// PEM private-key blocks, the Redis `requirepass`/`masterauth`/`masteruser`
// directives, and credential-named env assignments.
//
// HONEST SCOPE (do not overstate to users): a clean result means "none of these
// known formats are present," NOT "no secret exists." A novel or unformatted
// credential can still pass; that is an accepted, documented limit (§4 SECRET-1).
// Returns the matched rule ids, sorted + de-duplicated; the secret text is NEVER
// returned. Empty array == clean (eligible for upload). Reuses the parity-safe
// PATTERNS + BLOCK_DIRECTIVE_PATTERNS so the block formats stay in lockstep with
// the observe-only scanner, minus entropy.
// DERIVED, never hand-maintained. A hand-written copy of this list silently
// drifted once already: adding the `jwt` pattern made scanForCredentials able to
// return a rule id that the advertised universe did not contain, so any consumer
// treating this as "every reason a file can be blocked" would have been wrong
// and nothing failed. Deriving it makes that class of drift impossible; the
// spec pins the expected literal contents, so a NEW pattern still has to be
// acknowledged deliberately.
export const CREDENTIAL_RULE_IDS: readonly string[] = [
  ...PATTERNS.map(([name]) => name),
  ...BLOCK_DIRECTIVE_PATTERNS.map(([name]) => name),
];

export function scanForCredentials(text: string | null | undefined): string[] {
  if (!text) return [];
  const hits = new Set<string>();
  for (const [name, pat] of PATTERNS) {
    pat.lastIndex = 0;
    if (pat.test(text)) hits.add(name);
  }
  for (const [name, pat] of BLOCK_DIRECTIVE_PATTERNS) {
    pat.lastIndex = 0;
    if (pat.test(text)) hits.add(name);
  }
  return [...hits].sort();
}

/**
 * Structure-aware redaction: walk any JSON value and redact every string leaf,
 * leaving numbers, booleans, nulls and the object shape itself untouched.
 *
 * This is the sanitizer the egress registry reuses for a "redact" field, and it
 * is deliberately blind below the top level: it does not know or care what the
 * keys mean, so a newly nested string cannot escape by being somewhere the
 * policy did not anticipate.
 */
export function redactPayloadWithProfile<T>(value: T, profile: RedactProfile): T {
  if (typeof value === "string") return redact(value, profile) as unknown as T;
  if (Array.isArray(value))
    return value.map((v) => redactPayloadWithProfile(v, profile)) as unknown as T;
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactPayloadWithProfile(v, profile);
    }
    return out as unknown as T;
  }
  return value;
}

/** The at-rest default. Kept as the name every existing caller already uses. */
export function redactPayload<T>(value: T): T {
  return redactPayloadWithProfile(value, "full");
}
