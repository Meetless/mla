import { Ce0Store } from "./ce0-store";
import {
  getLiveLocalRuleVersion,
  insertLocalRuleVersion,
  listLocalRuleVersionHistory,
  NoLiveVersionToSupersedeError,
  supersedeLiveLocalRuleVersion,
  type LocalRuleVersionRecord,
} from "./local-rule-version-repo";
import { ruleVersionHash, serializeRuleVersion } from "./rule-version-hash";
import { RulePayloadV1 } from "./types";

// The canonical R1 attest writer (proposal §2.4 INV-ATTEST-CHOOSES-LOGICAL-IDENTITY, P0.55). Where the
// notes-location pilot hardcodes a single logical id, this writer takes the operator's EXPLICIT
// identity choice and never infers it from a rule file's presence (INV-PRESENCE-IS-NOT-ATTESTATION,
// P0.3) or from a proposedRuleId hint (P0.49):
//
//   { mode: "NEW_RULE",  ruleId }  mint a fresh logical rule (supersedes nothing). An accidental id
//                                  COLLISION is rejected, never silently versioned onto the wrong rule.
//   { mode: "SUCCESSOR", ruleId }  version an EXISTING logical rule: ruleId = the existing id,
//                                  supersedesVersionId = the prior LIVE version (lineage points
//                                  backward, new -> old, never forward).
//
// The serialization and the rule-version-v1 digest are computed HERE from the payload so the stored row
// can never disagree with its hash. The version envelope (lifecycle, one-LIVE-per-(scope, rule), the
// supersession transaction, version immutability) is owned by the A.4 repo; this layer only chooses the
// identity and the lineage. attest != enforce (P0.20): the version is minted at its attested ceiling
// regardless of any runtime deny-admission gate; effective enforcement is a separate step.

/** The P0.55 logical-identity choice, made by the operator (`--new-rule` / `--rule <id>`), never here. */
export type AttestIdentity =
  | { mode: "NEW_RULE"; ruleId: string }
  | { mode: "SUCCESSOR"; ruleId: string };

/** The inputs a caller hands the canonical mint after converting, confirming, and resolving the operator. */
export interface MintAttestedRuleVersionInput {
  /** The chosen logical identity (P0.55); the SOLE authority for ruleId + lineage. */
  identity: AttestIdentity;
  /** The admitted, frozen payload (the SOLE source of the stored serialization + hash). */
  payload: RulePayloadV1;
  /** The observed-rule-v1 hash this version was attested from; null for a hand-authored version. */
  observedRuleHash: string | null;
  /** The accountable human, resolved from the authenticated operator (never a free arg, P0.55). */
  attestedBy: string;
  attestationMethod: LocalRuleVersionRecord["attestationMethod"];
  /** The minted version identity (ULID), supplied by the caller so the mint is deterministic in tests. */
  versionId: string;
  attestedAt: string;
}

/** The outcome of an attest mint: a first version of a rule, a supersession, or an idempotent no-op. */
export type MintOutcome =
  | { outcome: "MINTED"; version: LocalRuleVersionRecord }
  | { outcome: "SUPERSEDED"; version: LocalRuleVersionRecord; supersededVersionId: string }
  | { outcome: "NOOP_IDEMPOTENT"; version: LocalRuleVersionRecord };

/**
 * Raised when `--new-rule` names a logical id that already exists in the scope. P0.55 requires an
 * accidental collision to be rejected rather than silently versioning the wrong rule; the operator must
 * either choose `--rule <id>` to version the existing rule deliberately, or pick a fresh id.
 */
export class RuleIdentityCollisionError extends Error {
  constructor(
    readonly runtimeScopeId: string,
    readonly ruleId: string,
  ) {
    super(
      `cannot mint a NEW rule '${ruleId}' in scope ${runtimeScopeId}: a version with that logical id ` +
        `already exists; use --rule ${ruleId} to version it deliberately, or choose a fresh id`,
    );
    this.name = "RuleIdentityCollisionError";
  }
}

/**
 * Mint the LIVE version the operator's identity choice selects (proposal §2.4, P0.55). For NEW_RULE the
 * fresh logical id must not collide with any existing version in the scope (rejected, not silently
 * versioned). For SUCCESSOR the prior LIVE version of the named rule is superseded in the A.4 repo's
 * single BEGIN IMMEDIATE transaction (supersede-first so the one-LIVE partial unique index never trips),
 * and a re-attest whose hash already matches that LIVE version is an idempotent no-op (P1.3).
 */
export function mintAttestedRuleVersion(store: Ce0Store, input: MintAttestedRuleVersionInput): MintOutcome {
  const scope = input.payload.runtimeScopeId;
  const ruleId = input.identity.ruleId;
  const canonicalPayloadHash = ruleVersionHash(input.payload);

  const buildRecord = (supersedesVersionId: string | null): LocalRuleVersionRecord => ({
    versionId: input.versionId,
    ruleId,
    runtimeScopeId: scope,
    rulePayload: serializeRuleVersion(input.payload),
    canonicalPayloadHash,
    lifecycleStatus: "LIVE",
    attestationMethod: input.attestationMethod,
    attestedBy: input.attestedBy,
    supersedesVersionId,
    derivedFromObservedHash: input.observedRuleHash,
    attestedAt: input.attestedAt,
  });

  if (input.identity.mode === "NEW_RULE") {
    // A NEW logical rule must occupy a free id: any version (any lifecycle) under this (scope, ruleId)
    // means the id is already taken, so minting "new" here would silently version the wrong rule.
    if (listLocalRuleVersionHistory(store, scope, ruleId).length > 0) {
      throw new RuleIdentityCollisionError(scope, ruleId);
    }
    const record = buildRecord(null);
    insertLocalRuleVersion(store, record);
    return { outcome: "MINTED", version: record };
  }

  // SUCCESSOR: declare this version the successor of an existing logical rule's prior LIVE version.
  const current = getLiveLocalRuleVersion(store, scope, ruleId);
  if (!current) {
    // A successor needs a prior LIVE version to point back at; there is none for this rule.
    throw new NoLiveVersionToSupersedeError(scope, ruleId);
  }
  if (current.canonicalPayloadHash === canonicalPayloadHash) {
    return { outcome: "NOOP_IDEMPOTENT", version: current };
  }
  const minted = supersedeLiveLocalRuleVersion(store, buildRecord(current.versionId));
  return { outcome: "SUPERSEDED", version: minted, supersededVersionId: current.versionId };
}
