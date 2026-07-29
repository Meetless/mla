// The egress policy engine: one place that decides what a request body is
// allowed to look like on the wire.
//
// WHY THIS EXISTS. Redaction used to be applied at call sites. That is a
// promise, not a boundary: every new POST is a fresh chance to forget, and the
// 2026-07-26 audit found that forgetting had already happened in five places.
// Worse, the audit itself nearly missed a sixth (lib/turn-recap-emit.ts), which
// POSTs a body to intel through an INJECTED fetch-like, so a `\bfetch\(` sweep
// does not see it. An inventory you have to keep re-deriving by grep is not a
// boundary either.
//
// So the rule is inverted. Nothing decides locally. Every body-bearing request
// resolves against ONE registry keyed on (destination service, HTTP method,
// normalized pathname), and a request with no rule cannot be sent AT ALL. The
// failure mode of forgetting is now a loud, immediate, environment-independent
// throw instead of a silent leak.
//
// DESIGN CONSTRAINTS (owner ruling, 2026-07-26). These are not preferences:
//
//   - Match on service + method + normalized PATHNAME. Not on a raw URL and not
//     on a path-and-query: a query string is attacker-influenced and would let
//     `?x=/internal/v1/auth/...` steer a rule.
//   - Every regex is anchored at BOTH ends. Anchored, `/internal/v1/kb/add`
//     matches only itself; unanchored it would also swallow /internal/v1/kb/add-and-leak.
//   - EXACTLY one rule must match. Zero fails closed (unknown route). Two or
//     more fails closed as well: overlapping rules mean the registry no longer
//     says one thing, and picking "the first" would silently pick whichever the
//     file happens to list first.
//   - Fail closed in EVERY environment. No feature flag, no dev bypass, no
//     "warn and send raw" degradation. A boundary with an off switch is a
//     boundary only when someone remembers to leave the switch alone.
//   - Top-level fields are classified EXACTLY. An unknown top-level key fails
//     closed, because a new field is precisely how content sneaks onto an
//     already-approved route.
//   - Diagnostics carry method, service and pathname. Never the body, never the
//     query string. A fail-closed error that quotes the body leaks the thing it
//     just refused to send.
//
// Deliberately NOT built here: a nested-path policy language. `fields` classifies
// TOP-LEVEL keys only; a "redact" value is walked by redact-structured.ts, which
// makes flat decisions on key NAMES and has no path syntax, no wildcard and no
// depth selector. A DSL for nested paths would be a second, subtler place to be
// wrong.
//
// TWO name-based knobs use that walker, and they are opposites:
//
//   `keyAware`        opt in to redacting BY NAME (`authorization`, `password`,
//                     `secret`) and to exempting the observability spine's own
//                     high-entropy ids. For telemetry bags, where the key is
//                     often the ONLY evidence a short value is a credential:
//                     `password: "Tr0ub4dor&3"` and a schemeless
//                     `authorization: "ZGV2Omh1bnRlcjI="` both survive every
//                     value rule, measured.
//                     Off by default because `SENSITIVE_KEY` carries an
//                     unanchored `secret`, which is right for a span-attribute
//                     bag and wrong for operator prose (a rationale field named
//                     `secretRotationPlan` should be redacted by value, not
//                     deleted by name).
//   `structuralKeys`  preserve BY NAME. Read on.
//
// `structuralKeys` is the concession that is not a DSL. Some bodies
// put a join key inside a content array, and the pair is not separable at the top
// level. intel's active-review detect is the case that forced it: its body is
// `candidates: [{canonicalPath, body, kind}]`, where `body` is a file's contents
// (must be redacted) and `canonicalPath` is the key the detection is recorded
// against (must arrive byte-exact). Measured, the `retrieval` bar eats exactly
// the paths this feature is pointed at, because a date-prefixed note path such as
// "notes/20260726-mla-redaction-fidelity-and-egress-boundary-proposal.md" is one
// 32+ char high-entropy token. Preserving the whole array would ship the file
// contents; redacting it would corrupt the join key on an unpredictable subset of
// documents, which is worse than either, because silent partial corruption is
// indistinguishable from working.
//
// So a rule may name KEYS (not paths) that are identifiers wherever they appear
// beneath its own redacted fields. There is no path syntax, no wildcard, no
// depth selector and no nesting to get wrong: it is a flat set of names, scoped
// to one row, and every use is asserted in test/lib/egress-policy.spec.ts.
//
// Both knobs run through the ONE sanitizer in redact-structured.ts, which is the
// walk Sentry's beforeSend has always used. Ruling §3 said to reuse it rather
// than grow a second one, and the reason is not tidiness: before this, the two
// planes had two different walkers over the same class of payload, so Sentry
// dropped `{"password": "Tr0ub4dor&3"}` while this boundary shipped it.

import {
  RedactProfile,
  redactPayloadWithProfile,
  scanForCredentials,
} from "../redactor";
import { redactStructured } from "../redact-structured";

// "external" is every host that is not ours (the update manifest, the upgrade
// bundle). It is in the union so an external destination is NAMED rather than
// unclassified, and it carries no rules: today every external call is a body-free
// GET, and the day one grows a body it fails closed like any other unknown route.
export type EgressService = "control" | "intel" | "external";
export type EgressMethod = "POST" | "PATCH" | "PUT";

/** How a top-level field of an approved body is treated. */
export type FieldPolicy = "redact" | "preserve";

interface EgressRuleBase {
  service: EgressService;
  method: EgressMethod;
  /** Anchored regex, tested against the NORMALIZED pathname only. */
  match: RegExp;
  /** Human note; shows up in nothing but source review. */
  note: string;
}

export type EgressRule = EgressRuleBase &
  (
    | {
        mode: "redact";
        profile: RedactProfile;
        fields: Record<string, FieldPolicy>;
        /**
         * Key NAMES (never paths) that are identifiers wherever they occur under
         * this rule's redacted fields. Use only for a value the server joins or
         * keys on, and only when it cannot be hoisted to a top-level "preserve"
         * field. Every entry needs a stated reason in the row's comment.
         */
        structuralKeys?: readonly string[];
        /**
         * Redact by KEY NAME as well as by value, and exempt the observability
         * spine's own identifiers. For telemetry bags only (analytics events,
         * agent traces), where a 7-character `password` or a 28-character
         * `authorization` clears no entropy bar and no provider prefix, and the
         * key is the only thing that says it is a credential. Do not set it on a
         * row whose fields carry operator prose.
         */
        keyAware?: boolean;
      }
    | {
        // Neither redact nor passthrough fits KB ingest. A redacted document is
        // a WRONG document, permanently, so redaction is off the table; but
        // sending unconditionally is what let a credential into the knowledge
        // base in the first place. So: scan every string leaf with the
        // high-confidence credential denylist, send verbatim when it is clean,
        // and refuse plus tell the human when it is not.
        //
        // The scan lives HERE rather than at the capture pipeline that used to
        // own it, because the pipeline is one of several producers and a
        // boundary that only some producers pass through is not a boundary.
        mode: "block_on_detect";
        why: string;
        fields: readonly string[];
      }
    | {
        // Structural only. `fields` is the exhaustive allowlist of top-level
        // keys; anything else fails closed. This is what stops a passthrough
        // route from quietly growing a `content` field.
        mode: "passthrough";
        why: string;
        fields: readonly string[];
      }
  );

export class EgressPolicyError extends Error {
  readonly service: EgressService;
  readonly method: string;
  readonly pathname: string;
  readonly reason:
    | "no_rule"
    | "ambiguous_rule"
    | "unknown_field"
    | "blocked"
    | "unanchored_rule";

  constructor(
    reason: EgressPolicyError["reason"],
    service: EgressService,
    method: string,
    pathname: string,
    detail: string,
  ) {
    // Body-free by construction: the only interpolated values are the routing
    // triple and a caller-supplied detail that callers must keep body-free.
    super(`egress ${reason}: ${method} ${service}${pathname} (${detail})`);
    this.name = "EgressPolicyError";
    this.reason = reason;
    this.service = service;
    this.method = method;
    this.pathname = pathname;
  }
}

/**
 * Turn a capture-side failure into ONE body-free warning line, or null.
 *
 * Ruling §2 splits egress failure by what the caller is: essential egress (`mla
 * ask`) fails the operation, capture-only egress drops the capture, records a
 * body-free diagnostic, and lets the primary command continue. Every
 * capture-only site in this CLI already had the first and third parts (they
 * swallow on purpose, because an intel/control outage must never break a
 * command). The middle part was missing everywhere, and the shape of the bug it
 * hides is specific:
 *
 *   An OUTAGE is transient and expected. It should stay quiet.
 *   A POLICY REFUSAL is neither. It means this repository is missing an egress
 *   rule or a field classification, so it is PERMANENT (every later run refuses
 *   identically) and, swallowed, INVISIBLE. Capture just stops, forever, and the
 *   only symptom is an absence.
 *
 * So callers route their caught error through here: an outage returns null and
 * nothing is printed, exactly as before; a refusal returns a line naming the
 * remedy. The line is body-free by construction because EgressPolicyError's
 * message only ever interpolates the routing triple and a body-free detail.
 */
export function describeEgressRefusal(
  err: unknown,
  what: string,
): string | null {
  if (!(err instanceof EgressPolicyError)) return null;
  return `warn: ${what} dropped by egress policy, not by an outage: ${err.message} Fix it in src/lib/egress/rules.ts; it will not recover on its own.`;
}

/**
 * Reduce any URL (absolute or path-only) to the pathname the registry matches.
 *
 * Drops the query string and the fragment, collapses duplicate slashes, and
 * strips a single trailing slash so `/x` and `/x/` cannot resolve to different
 * rules. A path-only input is parsed against a throwaway base, so callers may
 * pass either form.
 */
export function normalizePathname(url: string): string {
  let pathname: string;
  try {
    pathname = new URL(url, "http://policy.invalid").pathname;
  } catch {
    // Not a parseable URL. Take everything before the first ? or #, so a
    // malformed input still cannot smuggle a query string into the match.
    pathname = url.split(/[?#]/, 1)[0] ?? "";
  }
  pathname = pathname.replace(/\/{2,}/g, "/");
  if (pathname.length > 1 && pathname.endsWith("/")) {
    pathname = pathname.slice(0, -1);
  }
  return pathname;
}

/** True when a regex is anchored at both ends, which every rule must be. */
export function isAnchored(re: RegExp): boolean {
  return re.source.startsWith("^") && re.source.endsWith("$");
}

/**
 * Redact a field's subtree under one rule's key-name options.
 *
 * Delegates to the shared sanitizer (redact-structured.ts), the same walk
 * Sentry's beforeSend uses. With neither option set it is exactly
 * redactPayloadWithProfile, which is the common case; the two knobs only change
 * the handful of rows that opt in.
 *
 * A structural key preserves its value WHOLE (a nested object under one is not
 * walked), which is why `structuralKeys` is documented as being for identifier
 * leaves only.
 */
function redactField(
  value: unknown,
  profile: RedactProfile,
  structural: ReadonlySet<string>,
  keyAware: boolean,
): unknown {
  if (structural.size === 0 && !keyAware) {
    return redactPayloadWithProfile(value, profile);
  }
  return redactStructured(value, {
    profile,
    structuralKeys: structural,
    keyAware,
  });
}

/**
 * Every credential rule id that fires anywhere in a body, deduped and sorted.
 *
 * Deliberately the high-confidence DENYLIST (scanForCredentials), not the
 * entropy scanner: this decides whether to refuse a write the operator asked
 * for, so a false positive costs them a document. Returns ids, never spans.
 *
 * EXPORTED so a caller holding a refused batch can ask which of ITS parts the
 * boundary would object to, and drop only those. That question has exactly one
 * correct answer, and it is this function: a caller that re-implements the check
 * drifts from the boundary the moment either side changes, and then isolates the
 * wrong documents while reporting confidence. Read-only, ids only, no spans.
 */
export function scanLeavesForCredentials(value: unknown): string[] {
  const found = new Set<string>();
  const walk = (v: unknown): void => {
    if (typeof v === "string") {
      for (const id of scanForCredentials(v)) found.add(id);
      return;
    }
    if (Array.isArray(v)) {
      v.forEach(walk);
      return;
    }
    if (v !== null && typeof v === "object") {
      Object.values(v as Record<string, unknown>).forEach(walk);
    }
  };
  walk(value);
  return [...found].sort();
}

/**
 * Resolve the single rule governing this request, or throw.
 *
 * Throws on zero matches (unknown route) and on two-or-more (ambiguous
 * registry). Both are fail-closed by design: the caller cannot send.
 */
export function resolveRule(
  rules: readonly EgressRule[],
  service: EgressService,
  method: string,
  url: string,
): EgressRule {
  const pathname = normalizePathname(url);
  const upper = method.toUpperCase();
  const matches = rules.filter(
    (r) => r.service === service && r.method === upper && r.match.test(pathname),
  );
  // A rule whose regex is unanchored would match more than it claims, so it is
  // treated as a registry defect at USE time, not just in a test.
  for (const m of matches) {
    if (!isAnchored(m.match)) {
      throw new EgressPolicyError(
        "unanchored_rule",
        service,
        upper,
        pathname,
        `rule "${m.note}" is not anchored at both ends`,
      );
    }
  }
  if (matches.length === 0) {
    throw new EgressPolicyError(
      "no_rule",
      service,
      upper,
      pathname,
      "no egress rule; register the route before sending a body to it",
    );
  }
  if (matches.length > 1) {
    throw new EgressPolicyError(
      "ambiguous_rule",
      service,
      upper,
      pathname,
      `${matches.length} rules match: ${matches.map((m) => m.note).join(", ")}`,
    );
  }
  return matches[0];
}

/**
 * Apply the resolved rule to a parsed body and return the body to send.
 *
 * The returned value is what goes on the wire. Callers MUST send this and not
 * the input; the input is left untouched so local logic keeps working on raw
 * text (the same reason ask-core redacts in the payload builder rather than at
 * its callers).
 */
export function applyRule(
  rule: EgressRule,
  body: unknown,
  service: EgressService,
  pathname: string,
): unknown {
  // A non-object body has no top-level fields to classify. Only two shapes can
  // reach here honestly: a JSON object, or nothing. Anything else (a bare
  // string, an array) would bypass field classification entirely, so it fails
  // closed rather than being waved through.
  if (body === undefined || body === null) return body;
  if (typeof body !== "object" || Array.isArray(body)) {
    throw new EgressPolicyError(
      "unknown_field",
      service,
      rule.method,
      pathname,
      `body must be a JSON object; got ${Array.isArray(body) ? "array" : typeof body}`,
    );
  }

  const entries = Object.entries(body as Record<string, unknown>);

  if (rule.mode === "passthrough" || rule.mode === "block_on_detect") {
    const allowed = new Set(rule.fields);
    const unknown = entries.map(([k]) => k).filter((k) => !allowed.has(k));
    if (unknown.length > 0) {
      throw new EgressPolicyError(
        "unknown_field",
        service,
        rule.method,
        pathname,
        `unclassified top-level field(s): ${unknown.sort().join(", ")}`,
      );
    }
    if (rule.mode === "block_on_detect") {
      const hits = scanLeavesForCredentials(body);
      if (hits.length > 0) {
        // Rule IDS only. The matched text is the credential; naming it in an
        // error that gets logged would leak the thing this branch just refused
        // to send. The ids are what the human needs anyway.
        //
        // The remedy rides WITH the refusal. Without it the operator's next move
        // is to re-run, which refuses identically forever: this body is never
        // rewritten, so nothing changes until the SOURCE does. Say what to change.
        throw new EgressPolicyError(
          "blocked",
          service,
          rule.method,
          pathname,
          `${rule.why}; credential pattern(s) detected: ${hits.join(", ")}. ` +
            "Nothing was sent, and re-running refuses identically until the source changes: " +
            "quote the shape, not the value (replace the secret with a placeholder such as " +
            "<TOKEN>), then retry. If it is a live credential, rotate it.",
        );
      }
    }
    return body;
  }

  const structural = new Set(rule.structuralKeys ?? []);
  const out: Record<string, unknown> = {};
  const unknown: string[] = [];
  for (const [key, value] of entries) {
    const policy = rule.fields[key];
    if (policy === undefined) {
      unknown.push(key);
      continue;
    }
    // "preserve" passes the value through untouched, at any depth. "redact"
    // walks every string leaf under it, except values under a key this rule
    // declared structural; see the header note on why that is not a path DSL.
    out[key] =
      policy === "preserve"
        ? value
        : redactField(value, rule.profile, structural, rule.keyAware === true);
  }
  if (unknown.length > 0) {
    throw new EgressPolicyError(
      "unknown_field",
      service,
      rule.method,
      pathname,
      `unclassified top-level field(s): ${unknown.sort().join(", ")}`,
    );
  }
  return out;
}

/**
 * The one call a transport makes: resolve, apply, hand back the wire body.
 *
 * Throws EgressPolicyError on every fail-closed path. The CALLER decides
 * whether that throw is fatal: an essential egress (`mla ask`, a KB write) must
 * fail the operation, while a capture-only side effect must drop the capture,
 * record a body-free diagnostic, and let the primary command succeed. That
 * split lives at the caller because only the caller knows which it is.
 */
export function applyEgressPolicy(
  rules: readonly EgressRule[],
  service: EgressService,
  method: string,
  url: string,
  body: unknown,
): unknown {
  const rule = resolveRule(rules, service, method, url);
  return applyRule(rule, body, service, normalizePathname(url));
}
