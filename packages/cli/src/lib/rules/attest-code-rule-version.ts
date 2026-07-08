import { RuleIdentityCollisionError, type MintOutcome } from "./attest-rule-version";
import { Ce0Store } from "./ce0-store";
import { type CodeRuleDefinition } from "./code-rule-registry";
import {
  getLiveLocalRuleVersion,
  insertLocalRuleVersion,
  listLocalRuleVersionHistory,
  NoLiveVersionToSupersedeError,
  supersedeLiveLocalRuleVersion,
  type LocalRuleVersionRecord,
} from "./local-rule-version-repo";

// The R1 attest writer for CODE-DEFINED rules (the rules the product ships in source, e.g. the CE0
// consult-evidence forcing function). It is a deliberate SIBLING of the canonical mintAttestedRuleVersion,
// not a caller of it, and it touches neither that writer nor the LIVE enforce path:
//
//   * mintAttestedRuleVersion is RulePayloadV1-only (forbidden-root / action shaped) and re-hashes its
//     payload under the domain-separated rule-version-v1 digest. A code rule is neither shape.
//   * A code rule must keep the PLAIN canonical hash the rest of the system already stamps on its
//     obligations (e.g. CONSULT_EVIDENCE_CANONICAL_PAYLOAD_HASH). So this writer stores the registry's
//     frozen bytes + plain hash VERBATIM (the repo's rule_payload / canonical_payload_hash are opaque),
//     never re-serializing or re-hashing.
//
// The version envelope (lifecycle, one-LIVE-per-(scope, rule), supersession transaction, immutability) is
// the A.4 repo's, reused unchanged; the P0.55 identity faults (RuleIdentityCollisionError,
// NoLiveVersionToSupersedeError) and the MintOutcome are the canonical writer's, reused unchanged. The
// only thing that differs is the source of the bytes. A code rule's logical id is PINNED by its frozen
// payload (the payload embeds its own ruleId), so this writer takes a MODE, never a free operator-chosen
// ruleId; the ~12 lines of identity/lineage branching are duplicated rather than extracted to keep the
// canonical writer byte-for-byte untouched (minimal blast radius over DRY for a capability still behind
// an explicit go).

/** The inputs to a code-rule mint, after the caller resolved the registry entry and the operator. */
export interface MintAttestedCodeRuleVersionInput {
  /** Whether this is the FIRST version of the code rule, or a SUCCESSOR after a seed bump rotated its
   *  frozen hash. The logical id is NOT chosen here: it is `codeRule.ruleId`. */
  mode: "NEW_RULE" | "SUCCESSOR";
  /** The resolved registry entry: the frozen bytes + plain hash to store verbatim. */
  codeRule: CodeRuleDefinition;
  /** The project/checkout scope this version binds to (the code-rule payload carries no scope of its own). */
  runtimeScopeId: string;
  /** The accountable human, resolved from the authenticated operator (never a free arg, P0.55). */
  attestedBy: string;
  attestationMethod: LocalRuleVersionRecord["attestationMethod"];
  /** The minted version identity (ULID), supplied by the caller so the mint is deterministic in tests. */
  versionId: string;
  attestedAt: string;
}

/**
 * Mint the LIVE version of a code-defined rule. NEW_RULE refuses an id already present in the scope (a
 * collision is an operator error, never a silent re-version); SUCCESSOR supersedes the prior LIVE in the
 * repo's single transaction, and a re-attest whose frozen hash already matches the LIVE version is an
 * idempotent no-op. The stored bytes and hash are the registry's, verbatim; lineage to an observed
 * snapshot is null because a code rule is authored, not observed.
 */
export function mintAttestedCodeRuleVersion(
  store: Ce0Store,
  input: MintAttestedCodeRuleVersionInput,
): MintOutcome {
  const ruleId = input.codeRule.ruleId;
  const scope = input.runtimeScopeId;
  const canonicalPayloadHash = input.codeRule.canonicalPayloadHash;

  const buildRecord = (supersedesVersionId: string | null): LocalRuleVersionRecord => ({
    versionId: input.versionId,
    ruleId,
    runtimeScopeId: scope,
    rulePayload: input.codeRule.serializedPayload,
    canonicalPayloadHash,
    lifecycleStatus: "LIVE",
    attestationMethod: input.attestationMethod,
    attestedBy: input.attestedBy,
    supersedesVersionId,
    derivedFromObservedHash: null,
    attestedAt: input.attestedAt,
  });

  if (input.mode === "NEW_RULE") {
    if (listLocalRuleVersionHistory(store, scope, ruleId).length > 0) {
      throw new RuleIdentityCollisionError(scope, ruleId);
    }
    const record = buildRecord(null);
    insertLocalRuleVersion(store, record);
    return { outcome: "MINTED", version: record };
  }

  const current = getLiveLocalRuleVersion(store, scope, ruleId);
  if (!current) {
    throw new NoLiveVersionToSupersedeError(scope, ruleId);
  }
  if (current.canonicalPayloadHash === canonicalPayloadHash) {
    return { outcome: "NOOP_IDEMPOTENT", version: current };
  }
  const minted = supersedeLiveLocalRuleVersion(store, buildRecord(current.versionId));
  return { outcome: "SUPERSEDED", version: minted, supersededVersionId: current.versionId };
}
