// The ONE structure-aware redaction walk.
//
// `redact()` reads a string and knows nothing about where it came from. That is
// enough for prose and it is NOT enough for telemetry, because telemetry ships
// the key next to the value and the key is often the only evidence that the value
// is a credential. Measured against the real redactor, every one of these leaves
// verbatim:
//
//     { "password":      "Tr0ub4dor&3"      }   11 chars
//     { "authorization": "ZGV2Omh1bnRlcjI=" }   a Basic credential with the
//                                               scheme in a sibling field, which
//                                               is how header bags flatten
//     { "x-api-key":     "sk-local-dev-1234" }
//     { "cookie":        "session=abc123"   }
//
// None carries a scheme or provider prefix the value rules recognize, and none
// reaches the 32-char entropy bar. (A value WITH its scheme, "Basic ZGV2...", is
// caught by value alone; the leak is specifically the schemeless case, so the
// examples above are the measured ones rather than the obvious ones.) All of them
// used to leave this process through the egress boundary verbatim while the
// Sentry plane dropped them, because the two planes had two different walkers.
// Ruling §3 said to reuse the existing structure-aware sanitizer for events and
// Sentry payloads rather than grow a second one, so this module IS that
// sanitizer, lifted out of observability.ts unchanged in behavior and given one
// more caller.
//
// WHAT IT IS NOT. There is no path syntax, no wildcard, no depth selector: a key
// name means the same thing wherever it appears in the subtree. §3 forbade a
// nested-path policy language and this is not one. Three flat name-based
// decisions, in this order:
//
//   1. structuralKeys  caller-declared, rule-scoped. Preserves the value WHOLE
//                      (not walked): a join key the server matches byte for byte.
//   2. SENSITIVE_KEY   the value is a credential because of what it is called.
//                      Collapses the whole subtree to [REDACTED].
//   3. SAFE_IDENTIFIER_KEY  a non-secret high-entropy identifier (trace/span/run
//                      id, git sha, release) that the entropy heuristic would
//                      otherwise eat. Passes verbatim.
//
// Everything else is redacted by value at the caller's profile. Over-redaction is
// the safe failure mode and the default.
//
// KEY-AWARENESS IS OPT-IN (`keyAware`), and deliberately so. `SENSITIVE_KEY`
// carries an unanchored `secret` and `\btoken\b`, which is right for a telemetry
// bag and wrong for operator prose: a governance rationale with a field named
// `secretRotationPlan` should be redacted by VALUE, not deleted by NAME. Off, the
// walk is exactly the value-only behavior every non-telemetry egress row had
// before, so turning it on is a decision a rule author makes per row.

import { REDACTED, RedactProfile, redact } from "./redactor";

// Keys whose VALUE is always a credential regardless of entropy (breadcrumb data,
// contexts, extra, tags, request headers, exception and stack vars, span
// attributes, event properties). This is the §9 Sentry-redaction invariant
// (Finding K / Patch P7) generalized to every structured payload: never ship an
// Authorization header, an access or refresh token, a PKCE codeVerifier, a
// control token or an INTERNAL_API_KEY off the machine, even with telemetry on.
//
// Bare `code` is deliberately ABSENT: it collides with error, status and language
// codes. The one-time login-grant `code` is 64-hex high-entropy, so the
// value-based entropy heuristic catches it instead.
//
// `\btoken\b` does NOT match `tokens`, `input_tokens` or `token_count` (`s` and
// `_` are both word characters, so the trailing boundary fails). LLM token counts
// therefore survive, which is what the analytics events rule needs.
export const SENSITIVE_KEY =
  /(authorization|access[_-]?token|refresh[_-]?token|code[_-]?verifier|control[_-]?token|internal[_-]?api[_-]?key|\bapi[_-]?key\b|x-api-key|secret|passw(?:or)?d|\bbearer\b|cookie|\btoken\b)/i;

// Keys carrying NON-secret high-entropy identifiers (trace/span/event/run ids,
// git sha, build version, environment). These are exactly the strings the entropy
// heuristic would otherwise nuke, and they are the whole point of the
// observability spine: the cross-plane trace-id join and release correlation.
// Exempt them from value redaction; everything else high-entropy stays redacted.
export const SAFE_IDENTIFIER_KEY =
  /^(x-)?(trace|span|event|run)[_-]?id$|^trace_source$|^release$|^dist$|^sha$|^environment$|^mla_version$|^platform$/i;

export interface StructuredRedactOptions {
  /** Value-redaction bar. Defaults to the at-rest `full` profile. */
  profile?: RedactProfile;
  /**
   * Rule-scoped key names preserved WHOLE wherever they appear. For a value the
   * server joins or keys on and that cannot be hoisted to a top-level preserve.
   * The registry test forbids an entry that also matches SENSITIVE_KEY, so the
   * precedence below never has to arbitrate a real contradiction.
   */
  structuralKeys?: ReadonlySet<string>;
  /**
   * Apply SENSITIVE_KEY and SAFE_IDENTIFIER_KEY. Off by default; see the header
   * for why this is a per-caller decision rather than a global one.
   */
  keyAware?: boolean;
}

function walk(
  value: unknown,
  keyHint: string | undefined,
  profile: RedactProfile,
  structural: ReadonlySet<string>,
  keyAware: boolean,
): unknown {
  if (keyHint !== undefined) {
    // SENSITIVE first, so a mistaken structural declaration cannot preserve a
    // credential. The registry test makes that collision unreachable; this
    // ordering is what keeps it unreachable at runtime too.
    if (keyAware && SENSITIVE_KEY.test(keyHint)) return REDACTED;
    if (structural.has(keyHint)) return value;
  }
  if (typeof value === "string") {
    if (keyAware && keyHint !== undefined && SAFE_IDENTIFIER_KEY.test(keyHint)) {
      return value;
    }
    return redact(value, profile);
  }
  // An array inherits its parent's key: `headers.cookie` is as sensitive as a
  // list of cookies, and `tags: [...]` under a safe key is a list of safe ids.
  if (Array.isArray(value)) {
    return value.map((v) => walk(v, keyHint, profile, structural, keyAware));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = walk(v, k, profile, structural, keyAware);
    }
    return out;
  }
  // Numbers, booleans, null, undefined: nothing to redact and nothing to lose.
  return value;
}

/**
 * Redact a structured payload. Pure; returns a new tree and never mutates the
 * input. Idempotent, because `[REDACTED]` is not itself redactable.
 */
export function redactStructured<T>(
  value: T,
  opts: StructuredRedactOptions = {},
): T {
  return walk(
    value,
    undefined,
    opts.profile ?? "full",
    opts.structuralKeys ?? new Set<string>(),
    opts.keyAware ?? false,
  ) as T;
}
