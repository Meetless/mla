import {
  CONSULT_EVIDENCE_CANONICAL_PAYLOAD_HASH,
  CONSULT_EVIDENCE_RULE_ID,
  CONSULT_EVIDENCE_RULE_VERSION_ID,
} from "./ce0-rule";
import { type Ce0Store } from "./ce0-store";
import { getLiveLocalRuleVersion } from "./local-rule-version-repo";

// GAP 3 slice 2: the runtime binding seam between the CE0 obligation and its rule identity
// (notes/20260617-evidence-consultation-forcing-function-proposal.md §4.1, the binding row at lines
// 1545-1557; notes/20260615-rules-as-node-and-action-interception-consolidated-proposal.md §3.6
// LocalRuleVersion). The prompt-submit adapter stamps {ruleId, ruleVersionId, canonicalPayloadHash} onto
// every obligation it opens, and the stop adapter claims that obligation by its ruleVersionId. Before this
// seam both read those three fields from the compile-time constants in ce0-rule.ts. This resolver makes
// the identity live-attestation-aware: when an operator has attested a LIVE consult-evidence
// LocalRuleVersion for the runtime scope (via `mla rules attest --from-code-rule consult-evidence`), the
// obligation binds to that REAL version's id + stored hash; otherwise it falls back to the frozen
// compile-time identity so CE0 keeps measuring exactly as before. Two load-bearing facts:
//
//   * Activation is workspace resolution, NOT attestation. CE0 must keep measuring on an UNARMED scope, so
//     the constants are NOT deleted -- they ARE the documented unarmed fallback. The "delete the constants"
//     framing from earlier notes is wrong: deleting them would silence unarmed CE0 measurement entirely.
//   * The canonicalPayloadHash is invariant across the two branches by construction. The code-rule registry
//     stores the SAME plain digest the constants carry, so the live row's hash equals
//     CONSULT_EVIDENCE_CANONICAL_PAYLOAD_HASH until a seed bump supersedes the version. Arming therefore
//     rotates ONLY the version id (synthetic `consult-evidence@ce0-v1` -> real ULID), which is the exact
//     distinction the offline grader uses to tell an attested-version turn from an unarmed one.
//
// The resolver is keyed by runtimeScopeId (P0.51): a LIVE version in another checkout never arms this one.

/** The obligation identity triple the adapters stamp + claim, plus whether it came from a live attestation. */
export interface ConsultEvidenceRuleBinding {
  /** The logical rule id, stable across versions. Always `consult-evidence`. */
  ruleId: string;
  /** The version identity stamped on the obligation and used to claim it at Stop. The REAL minted version
   *  id when armed; the synthetic compile-time id (`consult-evidence@ce0-v1`) when unarmed. */
  ruleVersionId: string;
  /** The payload digest stamped on the obligation. The live row's hash when armed (equal to the constant
   *  by construction until a seed bump), the constant when unarmed. */
  canonicalPayloadHash: string;
  /** True iff a LIVE consult-evidence LocalRuleVersion was found for the scope (the rule is ARMED). */
  attested: boolean;
}

/**
 * Resolve the consult-evidence obligation binding for a runtime scope. Returns the LIVE attested version's
 * id + stored hash when one exists for the scope; otherwise the frozen compile-time identity (the unarmed
 * measurement default). The two branches differ only in the version id unless a seed bump rotated the hash.
 */
export function resolveConsultEvidenceRuleBinding(
  store: Ce0Store,
  runtimeScopeId: string,
): ConsultEvidenceRuleBinding {
  const live = getLiveLocalRuleVersion(store, runtimeScopeId, CONSULT_EVIDENCE_RULE_ID);
  if (live) {
    return {
      ruleId: live.ruleId,
      ruleVersionId: live.versionId,
      canonicalPayloadHash: live.canonicalPayloadHash,
      attested: true,
    };
  }
  return {
    ruleId: CONSULT_EVIDENCE_RULE_ID,
    ruleVersionId: CONSULT_EVIDENCE_RULE_VERSION_ID,
    canonicalPayloadHash: CONSULT_EVIDENCE_CANONICAL_PAYLOAD_HASH,
    attested: false,
  };
}
