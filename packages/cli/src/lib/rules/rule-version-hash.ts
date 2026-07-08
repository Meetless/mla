import { createHash } from "crypto";

import { CanonicalObject, canonicalize } from "./canonical-json";
import { RuleApplicability, RulePayloadV1 } from "./types";

/**
 * The `rule-version-v1` canonical hash domain (proposal P0.36, sharpened by P0.53; RulePayloadV1
 * at §3.6).
 *
 * It computes the content identity of an ATTESTED rule version. The digest is
 *
 *     SHA-256( domainTag || 0x00 || JCS(payload) )   (lowercase hex)
 *
 * over the IMMUTABLE `RulePayloadV1` ONLY. The version ENVELOPE (ruleId, versionId,
 * lifecycleStatus, supersedesVersionId, derivedFromObservedRuleHash, attestedBy, attestedAt,
 * attestationMethod) is deliberately OUTSIDE the hash: a hash cannot include itself, and issuance
 * metadata is not enforcement-relevant (P0.16, P0.54). JCS is the repo's existing RFC 8785
 * canonicalizer (canonical-json.ts); the domain tag + single 0x00 separator (P0.53) guarantee this
 * digest can NEVER collide with an observed rule (`observed-rule-v1`), an action-input snapshot
 * (`evaluation-input-v1`), or any other hashed artifact, even when two bodies are byte-identical.
 * JCS escapes control characters, so the only raw 0x00 byte in the hash input is the separator.
 *
 * `runtimeScopeId` is INSIDE the hash (P0.51): the same rule bound to a different checkout scope is
 * a different payload with a different digest, which is what makes the payload-scope == envelope-scope
 * rule (§3.6) checkable. Because every field except `text`, `applicability`, and the carried
 * `forbiddenRootRelativePath` is fixed by the notes-location pilot contract (§2.4), two operators
 * attesting the same observed snapshot in the same runtime scope mint a byte-identical payload and the
 * same digest.
 *
 * Per-field NFC caveat (honest, P0.53). The vendored JCS primitive applies NFC to EVERY string,
 * while the contract reserves NFC for prose. For the notes-location pilot every non-prose field (the
 * tool names, the effect / strength / ceiling / policy tokens, the version tags, the relative
 * forbidden root, the runtime scope) is ASCII and therefore NFC-stable, so universal NFC is
 * byte-identical to the per-field rule and the golden vectors are contract-correct. A future payload
 * carrying a non-prose field that can hold non-NFC Unicode (for instance a forbidden path with
 * combining marks) must switch to a per-field-NFC encoder; that boundary is recorded in the ledger.
 */
export const RULE_VERSION_HASH_DOMAIN = "rule-version-v1";

/** Thrown when a payload carries a field outside the rule-version-v1 schema (fail-closed). */
export class RuleVersionHashError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuleVersionHashError";
  }
}

// The closed key sets for each object in the payload schema. Unknown fields are an error (P0.53),
// so a forward-incompatible producer cannot silently mint a hash a consumer would compute
// differently. `rationale` is the only optional top-level key; it is omitted, never null, when absent.
const RULE_PAYLOAD_KEYS = new Set([
  "text",
  "rationale",
  "applicability",
  "compliance",
  "effect",
  "strength",
  "deliveryChannels",
  "enforcementCeiling",
  "infrastructureFailurePolicy",
  "runtimeScopeId",
  "payloadSchemaVersion",
  "canonicalSerializationVersion",
]);
const COMPLIANCE_KEYS = new Set([
  "evaluatorContractVersion",
  "matcherSchemaVersion",
  "pathCanonicalizerVersion",
  "config",
]);
const COMPLIANCE_CONFIG_KEYS = new Set(["forbiddenRootRelativePath"]);
const APPLICABILITY_AMBIENT_KEYS = new Set(["mode"]);
const APPLICABILITY_ACTION_KEYS = new Set(["mode", "tools", "matcher"]);
const APPLICABILITY_TURN_KEYS = new Set(["mode", "trigger"]);
const TURN_TRIGGER_KEYS = new Set(["promptAny", "explicitPathAny"]);
const MATCHER_KEYS = new Set(["field", "glob"]);

function rejectUnknownKeys(obj: object, allowed: Set<string>, context: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      throw new RuleVersionHashError(
        `unknown field '${key}' in ${context} is outside the ${RULE_VERSION_HASH_DOMAIN} schema`,
      );
    }
  }
}

/** Sort + dedupe a SET-valued field by code unit (P0.53). The pilot's tool names and delivery
 * channels are ASCII, so code unit and code point coincide and the order matches JCS key ordering. */
function sortedDedupedSet(values: readonly string[]): string[] {
  return Array.from(new Set(values)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function buildApplicabilityPayload(a: RuleApplicability): CanonicalObject {
  if (a.mode === "ambient") {
    rejectUnknownKeys(a, APPLICABILITY_AMBIENT_KEYS, "applicability(ambient)");
    return { mode: "ambient" };
  }
  if (a.mode === "turn") {
    rejectUnknownKeys(a, APPLICABILITY_TURN_KEYS, "applicability(turn)");
    rejectUnknownKeys(a.trigger, TURN_TRIGGER_KEYS, "applicability.trigger");
    // Both trigger lists are SET-valued: the trigger fires on ANY match (OR semantics,
    // targeted-rule-injection §5.1), so order and duplicates are semantically irrelevant. Sort + dedupe
    // exactly like `tools` / `deliveryChannels` so two logically-equal triggers mint one identity. An
    // absent list is OMITTED, never null (mirrors the matcher-glob and rationale discipline).
    const trigger: { promptAny?: string[]; explicitPathAny?: string[] } = {};
    if (a.trigger.promptAny !== undefined) {
      trigger.promptAny = sortedDedupedSet(a.trigger.promptAny);
    }
    if (a.trigger.explicitPathAny !== undefined) {
      trigger.explicitPathAny = sortedDedupedSet(a.trigger.explicitPathAny);
    }
    return { mode: "turn", trigger };
  }
  rejectUnknownKeys(a, APPLICABILITY_ACTION_KEYS, "applicability(action)");
  rejectUnknownKeys(a.matcher, MATCHER_KEYS, "applicability.matcher");
  const matcher: { field: string; glob?: string } = { field: a.matcher.field };
  if (a.matcher.glob !== undefined) {
    matcher.glob = a.matcher.glob;
  }
  return {
    mode: "action",
    tools: sortedDedupedSet(a.tools),
    matcher,
  };
}

/**
 * Build the closed canonical payload for a RulePayloadV1: the exact object that gets canonicalized
 * and hashed. Rejects unknown fields at every level, applies set discipline to deliveryChannels and
 * applicability.tools, and omits an absent rationale (and matcher glob). Field NFC (prose) is applied
 * by the JCS encoder on the way out; see the per-field caveat in the file header.
 */
export function buildRuleVersionPayload(payload: RulePayloadV1): CanonicalObject {
  rejectUnknownKeys(payload, RULE_PAYLOAD_KEYS, "rule payload");
  rejectUnknownKeys(payload.compliance, COMPLIANCE_KEYS, "compliance");
  rejectUnknownKeys(payload.compliance.config, COMPLIANCE_CONFIG_KEYS, "compliance.config");

  const base = {
    text: payload.text,
    applicability: buildApplicabilityPayload(payload.applicability),
    compliance: {
      evaluatorContractVersion: payload.compliance.evaluatorContractVersion,
      matcherSchemaVersion: payload.compliance.matcherSchemaVersion,
      pathCanonicalizerVersion: payload.compliance.pathCanonicalizerVersion,
      config: { forbiddenRootRelativePath: payload.compliance.config.forbiddenRootRelativePath },
    },
    effect: payload.effect,
    strength: payload.strength,
    deliveryChannels: sortedDedupedSet(payload.deliveryChannels),
    enforcementCeiling: payload.enforcementCeiling,
    infrastructureFailurePolicy: payload.infrastructureFailurePolicy,
    runtimeScopeId: payload.runtimeScopeId,
    payloadSchemaVersion: payload.payloadSchemaVersion,
    canonicalSerializationVersion: payload.canonicalSerializationVersion,
  };
  // Absent optional: OMIT the key (never null). Present: include verbatim. Key ORDER is irrelevant
  // (JCS sorts), so a conditional spread is the canonical builder, never a mutation.
  return payload.rationale !== undefined ? { ...base, rationale: payload.rationale } : base;
}

/** The exact RFC 8785 canonical JSON string that is hashed (UTF-8). Exposed for golden vectors and
 * debugging; the digest is over these bytes prefixed by the domain. */
export function serializeRuleVersion(payload: RulePayloadV1): string {
  return canonicalize(buildRuleVersionPayload(payload));
}

/** The rule-version-v1 content hash: SHA-256(domainTag || 0x00 || JCS(payload)), lowercase hex. */
export function ruleVersionHash(payload: RulePayloadV1): string {
  const jcs = serializeRuleVersion(payload);
  const h = createHash("sha256");
  h.update(RULE_VERSION_HASH_DOMAIN, "utf8");
  h.update(Buffer.from([0x00]));
  h.update(jcs, "utf8");
  return h.digest("hex");
}
