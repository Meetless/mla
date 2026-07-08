// Shared secret redactor for the mla CLI. Mirror of
// intel/app/observability/redaction.py and apps/control/src/core/services/redactor.ts.
// Principle 7 of notes/20260528-mla-logging-and-tracing-proposal.md:
// exactly one redactor, applied at the three places an operator can see
// captured content. Cross-plane parity is locked by a shared fixture test
// (tools/meetless-agent/test/lib/redactor-parity.spec.ts).

export const REDACTED = "[REDACTED]";

// Order matters: env_assignment runs first so KEY=value pairs are redacted
// whole, not just the value half. Token literals come second for cases
// without an = sign. High-entropy heuristic runs last to catch generic
// session tokens that the prefix matchers miss.
const PATTERNS: Array<[string, RegExp]> = [
  [
    "env_assignment",
    /\b([A-Z][A-Z0-9_]*_(?:TOKEN|KEY|SECRET|PASSWORD|PWD|API[_-]?KEY|ACCESS[_-]?KEY)|SECRET_[A-Z0-9_]+|PASSWORD|PASSWD|AWS_(?:ACCESS|SECRET)_(?:ACCESS_)?KEY(?:_ID)?|GH_TOKEN|GITHUB_TOKEN|OPENAI_API_KEY|ANTHROPIC_API_KEY)\s*[:=]\s*('[^']*'|"[^"]*"|\S+)/gim,
  ],
  ["bearer", /\b(Bearer|Basic)\s+[A-Za-z0-9._\-+/=]+/gi],
  [
    "provider_token",
    /\b(sk-(?:proj-|ant-)?[A-Za-z0-9_\-]{16,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|ghs_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9\-]{10,}|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|AIza[0-9A-Za-z_\-]{35}|hf_[A-Za-z0-9]{20,}|lf_(?:sk|pk)_[A-Za-z0-9]{20,})\b/g,
  ],
  ["cookie", /(Set-)?Cookie:\s*[^\r\n]+/gi],
  [
    "pem_key",
    /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/g,
  ],
];

const ENTROPY_TOKEN = /\b[A-Za-z0-9_\-+/=]{32,}\b/g;

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

function looksHighEntropy(token: string): boolean {
  if (token.length < 32) return false;
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
  const classes = [lower, upper, digit, sep].filter(Boolean).length;
  if (classes < 2) return false;
  return shannonEntropy(token) >= 3.5;
}

export function redact(text: string | null | undefined): string | null | undefined {
  if (text === null || text === undefined || text === "") return text;
  let out = text;
  for (const [, pat] of PATTERNS) out = out.replace(pat, REDACTED);
  out = out.replace(ENTROPY_TOKEN, (m) => (looksHighEntropy(m) ? REDACTED : m));
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
export const SECRET_SCANNER_VERSION = "2026-06-27.1";

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
    if (!isHexToken(tok) && looksHighEntropy(tok)) {
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
export const CREDENTIAL_RULE_IDS = [
  "env_assignment",
  "bearer",
  "provider_token",
  "cookie",
  "pem_key",
  "redis_directive",
] as const;

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

export function redactPayload<T>(value: T): T {
  if (typeof value === "string") return redact(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactPayload(v)) as unknown as T;
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactPayload(v);
    }
    return out as unknown as T;
  }
  return value;
}
