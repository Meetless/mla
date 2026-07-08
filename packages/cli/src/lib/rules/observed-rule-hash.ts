import { createHash } from "crypto";

import { CanonicalObject, canonicalize } from "./canonical-json";
import { ObservedRuleSpec, RuleApplicability } from "./types";

/**
 * The `observed-rule-v1` canonical hash domain (proposal P0.36, sharpened by P0.53).
 *
 * It computes the content identity of an OBSERVED rule: the ephemeral, un-attested
 * ObservedRuleSpec the scanner produced and the R0 evaluator reads. The digest is
 *
 *     SHA-256( domainTag || 0x00 || JCS(payload) )   (lowercase hex)
 *
 * where JCS is the repo's existing RFC 8785 canonicalizer (canonical-json.ts) and the
 * domain tag + single 0x00 separator (P0.53) guarantee this digest can NEVER collide
 * with an attested version (`rule-version-v1`), an action-input snapshot
 * (`evaluation-input-v1`), or any other hashed artifact, even when two normalized bodies
 * are byte-identical. JCS escapes control characters (a literal NUL in prose is emitted
 * as its JSON unicode escape, not as a raw byte), so the only raw 0x00 byte in the hash
 * input is the separator; the boundary between tag and payload is unambiguous.
 *
 * PROVISIONAL FIELD SET. The payload hashed here is EXACTLY today's evaluator-consumed
 * ObservedRuleSpec (text, applicability, effect, forbiddenRootRelativePath). The fuller
 * observed-rule-v1 field family from the proposal (rationale, the compliance-evaluator
 * version triple, deliveryChannels, the observed enforcementCeiling, runtimeScopeId, the
 * schema / canonical-serialization version tags) is owned by the schema/identity contract
 * the document agent has not yet committed. When that contract lands, this payload schema
 * and its golden-vector corpus rotate together. The domain-separation MACHINERY below is
 * final; the field set is what is pending. (See ObservedRuleSpec in types.ts.)
 *
 * Per-field NFC caveat (honest, P0.53). The contract says NFC is applied ONLY to prose
 * fields, while filesystem-derived and opaque values are byte-for-byte. The vendored JCS
 * primitive applies NFC to EVERY string. For the R0 notes-location pilot every non-prose
 * field (the tool names, the effect token, the matcher field and glob, the relative
 * forbidden root) is ASCII and therefore NFC-stable, so universal NFC is byte-identical to
 * the per-field rule and the golden vectors are contract-correct. When a future
 * ObservedRuleSpec carries a non-prose field that can hold non-NFC Unicode (for instance a
 * forbidden path with combining marks), this domain must switch to a per-field-NFC encoder
 * so those bytes are preserved verbatim. That boundary is recorded in the ledger.
 */
export const OBSERVED_RULE_HASH_DOMAIN = "observed-rule-v1";

/** Thrown when a spec carries a field outside the observed-rule-v1 schema (fail-closed). */
export class ObservedRuleHashError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ObservedRuleHashError";
  }
}

// The closed key sets for each object in the payload schema. Unknown fields are an error
// (P0.53), so a forward-incompatible producer cannot silently mint a hash a consumer would
// compute differently. `glob` is the only optional key; it is omitted, never null, when absent.
const OBSERVED_RULE_KEYS = new Set(["text", "applicability", "effect", "forbiddenRootRelativePath"]);
const APPLICABILITY_AMBIENT_KEYS = new Set(["mode"]);
const APPLICABILITY_ACTION_KEYS = new Set(["mode", "tools", "matcher"]);
const MATCHER_KEYS = new Set(["field", "glob"]);

function rejectUnknownKeys(obj: object, allowed: Set<string>, context: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      throw new ObservedRuleHashError(
        `unknown field '${key}' in ${context} is outside the ${OBSERVED_RULE_HASH_DOMAIN} schema`,
      );
    }
  }
}

/** Sort + dedupe a SET-valued field by code unit (P0.53). Tool names are ASCII, so code
 * unit and code point coincide; the comparison matches the JCS object-key ordering. */
function sortedDedupedSet(values: readonly string[]): string[] {
  return Array.from(new Set(values)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function buildApplicabilityPayload(a: RuleApplicability): CanonicalObject {
  if (a.mode === "ambient") {
    rejectUnknownKeys(a, APPLICABILITY_AMBIENT_KEYS, "applicability(ambient)");
    return { mode: "ambient" };
  }
  // A `turn` rule is prompt-time injection authored directly (targeted-rule-injection §5.1); it is
  // NEVER observed by the scanner nor attested via --from-observed, so it is outside the
  // observed-rule-v1 schema. Fail closed at the hash boundary rather than mint a digest for a shape
  // this domain does not define (the attest path also rejects it upstream in attest-notes-location.ts).
  if (a.mode === "turn") {
    throw new ObservedRuleHashError(
      "a turn-scoped applicability is not an observed rule; it is outside the " +
        `${OBSERVED_RULE_HASH_DOMAIN} schema`,
    );
  }
  rejectUnknownKeys(a, APPLICABILITY_ACTION_KEYS, "applicability(action)");
  rejectUnknownKeys(a.matcher, MATCHER_KEYS, "applicability.matcher");
  // Absent optional: OMIT the key (never null). Present: include verbatim.
  const matcher: { field: string; glob?: string } = { field: a.matcher.field };
  if (a.matcher.glob !== undefined) {
    matcher.glob = a.matcher.glob;
  }
  return {
    mode: "action",
    // SET discipline: sorted + deduped so two logically-equal tool sets hash identically.
    tools: sortedDedupedSet(a.tools),
    matcher,
  };
}

/**
 * Build the closed canonical payload for an ObservedRuleSpec: the exact object that gets
 * canonicalized and hashed. Rejects unknown fields, applies set discipline to `tools`, and
 * omits an absent matcher glob. Field NFC (prose) is applied by the JCS encoder on the way
 * out; see the per-field caveat in the file header.
 */
export function buildObservedRulePayload(spec: ObservedRuleSpec): CanonicalObject {
  rejectUnknownKeys(spec, OBSERVED_RULE_KEYS, "observed rule");
  return {
    text: spec.text,
    applicability: buildApplicabilityPayload(spec.applicability),
    effect: spec.effect,
    forbiddenRootRelativePath: spec.forbiddenRootRelativePath,
  };
}

/** The exact RFC 8785 canonical JSON string that is hashed (UTF-8). Exposed for golden
 * vectors and debugging; the digest is over these bytes prefixed by the domain. */
export function serializeObservedRule(spec: ObservedRuleSpec): string {
  return canonicalize(buildObservedRulePayload(spec));
}

/** The observed-rule-v1 content hash: SHA-256(domainTag || 0x00 || JCS(payload)), lowercase hex. */
export function observedRuleHash(spec: ObservedRuleSpec): string {
  const jcs = serializeObservedRule(spec);
  const h = createHash("sha256");
  h.update(OBSERVED_RULE_HASH_DOMAIN, "utf8");
  h.update(Buffer.from([0x00]));
  h.update(jcs, "utf8");
  return h.digest("hex");
}
