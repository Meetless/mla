/**
 * Egress secret redactor, ESM plane.
 *
 * FOURTH MIRROR of the one parity-locked redactor (principle 7 of
 * notes/20260528-mla-logging-and-tracing-proposal.md). The other three are
 *   - meetless-cli/packages/cli/src/lib/redactor.ts   (TypeScript, CommonJS build)
 *   - apps/control/src/core/services/redactor.ts      (TypeScript, control)
 *   - intel/app/observability/redaction.py            (Python)
 * and the four are locked together by hand-mirrored PARITY_CASES fixtures:
 * redactor.test.js (here), redactor-parity.spec.ts (x2), test_redaction_parity.py.
 * Change a pattern in one, change it in all four IN THE SAME COMMIT.
 *
 * Why a fourth copy instead of importing one of the three: `mla` compiles to
 * CommonJS and loads this package through a bundled CJS artifact or a
 * `new Function("u", "return import(u)")` true-dynamic import (see
 * packages/cli/src/commands/ask.ts). Its redactor is imported synchronously by
 * 17 CJS modules, so it cannot become ESM-only, and this package is
 * deliberately dependency-free, so it cannot reach back into the CLI. The
 * duplication is the price of the CJS/ESM boundary; the shared fixture is what
 * makes drift loud instead of silent.
 *
 * ONLY `redact` is mirrored. The block-on-detect scanners (scanForSecrets,
 * scanForCredentials) and redactPayload live on the CLI plane alone because
 * nothing here gates a file upload or walks a payload tree. The parity fixture
 * covers exactly what is mirrored.
 */

export const REDACTED = "[REDACTED]";

// Order matters: env_assignment runs first so KEY=value pairs are handled
// before the token literals, which come second for cases without an = sign.
// High-entropy heuristic runs last to catch generic session tokens that the
// prefix matchers miss.
//
// Third element is the REPLACEMENT. Every pattern replaces its whole match with
// the marker except env_assignment, which keeps the variable NAME and the
// separator and replaces only the value (groups: 1 name, 2 separator, 3 value).
const PATTERNS = [
  [
    "env_assignment",
    /\b([A-Z][A-Z0-9_]*_(?:TOKEN|KEY|SECRET|PASSWORD|PWD|API[_-]?KEY|ACCESS[_-]?KEY)|SECRET_[A-Z0-9_]+|PASSWORD|PASSWD|AWS_(?:ACCESS|SECRET)_(?:ACCESS_)?KEY(?:_ID)?|GH_TOKEN|GITHUB_TOKEN|OPENAI_API_KEY|ANTHROPIC_API_KEY)(\s*[:=]\s*)('[^']*'|"[^"]*"|\S+)/gim,
    // Keep the name. It is not a credential, and it is usually the primary
    // retrieval key: "OPENAI_API_KEY=[REDACTED]" still answers "which key was
    // set?", while a bare "[REDACTED]" answers nothing. Residual: the entropy
    // sweep runs after and does not know the name was deliberately preserved,
    // so a 32+ char name can still be eaten under "full" (never worse than the
    // previous whole-match behaviour; "retrieval" keeps such names).
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
 *   a redaction but a destroyed query. Measured over a 30-question corpus
 *   (packages/cli/test/lib/redaction-fidelity.spec.ts): the "full" bar damages
 *   12 of 20 realistic developer questions, the retrieval bar 1 of 20, while
 *   still catching every secret in that corpus.
 *
 * - "events": the SAME literal patterns and the SAME entropy bar as "full",
 *   plus the narrow path-shape exemption below. Its only production caller is
 *   `mla _internal redact-events` on the CLI plane; it is mirrored here so this
 *   file stays a literal mirror of packages/cli/src/lib/redactor.ts and the
 *   parity fixture can compare the two byte-for-byte.
 */
const ENTROPY_BARS = {
  full: { minClasses: 2, minEntropy: 3.5 },
  retrieval: { minClasses: 3, minEntropy: 4.0 },
  // Deliberately identical to "full". The whole difference between the two
  // profiles is the path exemption below.
  events: { minClasses: 2, minEntropy: 3.5 },
};

/**
 * PATH_LIKE_EXEMPTION: contains a slash, contains a lowercase letter, contains
 * NO uppercase letter. Applied only under "events".
 *
 * The "full" bar alters 64% of the captured bash-command items in the real
 * corpus and eats 8,909 path-shaped spans, while only 2.3% of those items
 * contain any credential pattern, which leaves the review ledger unable to say
 * which file a command touched. The no-uppercase clause keeps the exemption
 * away from base64, which is the shape of an AWS secret access key.
 *
 * ACCEPTED RESIDUAL, stated rather than argued away: a lowercase-and-digit
 * secret containing a slash matches this shape and passes. "Path-shaped" is a
 * signature, not a proof of innocence.
 */
function looksPathLike(token) {
  return token.includes("/") && /[a-z]/.test(token) && !/[A-Z]/.test(token);
}

function shannonEntropy(s) {
  if (!s) return 0;
  const counts = Object.create(null);
  for (const ch of s) counts[ch] = (counts[ch] ?? 0) + 1;
  const n = s.length;
  let h = 0;
  for (const c of Object.values(counts)) {
    const p = c / n;
    h -= p * Math.log2(p);
  }
  return h;
}

function looksHighEntropy(token, profile) {
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
  // The ONE deliberate difference from the typed planes: an unknown profile
  // name falls back to the STRICTER bar instead of throwing. The TS planes get
  // this for free from `profile: RedactProfile`; a JS caller has no such
  // guard, and a typo must never silently disable redaction.
  const bar = ENTROPY_BARS[profile] ?? ENTROPY_BARS.full;
  const classes = [lower, upper, digit, sep].filter(Boolean).length;
  if (classes < bar.minClasses) return false;
  return shannonEntropy(token) >= bar.minEntropy;
}

/**
 * @param {string|null|undefined} text
 * @param {"full"|"retrieval"|"events"} [profile]
 * @returns {string|null|undefined}
 */
export function redact(text, profile = "full") {
  if (text === null || text === undefined || text === "") return text;
  let out = text;
  for (const [, pat, replacement] of PATTERNS) out = out.replace(pat, replacement);
  out = out.replace(ENTROPY_TOKEN, (m) => (looksHighEntropy(m, profile) ? REDACTED : m));
  return out;
}
