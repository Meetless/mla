import { Ce0Store } from "./ce0-store";
import { insertRuleEvaluationRecord, type RuleEvaluationRecord } from "./interception-store";

// The LocalRuleVersion repository (R1), the durable home for human-attested rule versions
// (notes/20260615-rules-as-node-and-action-interception-consolidated-proposal.md §3.6 LocalRuleVersion,
// §10.1 step 6). It is a FOUNDATION: it owns the version ENVELOPE (lifecycle, lineage, attestation
// stamps) and treats rule_payload + canonical_payload_hash as OPAQUE, already-validated strings. It
// never parses the payload and never performs the ObservedRuleV1 -> RulePayloadV1 conversion or the
// hashing (the R1 attest slice does that and hands an already-validated payload + hash here). What the
// repo enforces is what the schema cannot express on its own: same-scope FK lineage, and the atomic
// one-LIVE-per-(scope, rule) supersession. The one-LIVE invariant itself, the (version_id, scope)
// uniqueness, and version immutability are real SQLite mechanisms (ux_one_live_version,
// ux_version_scope, trg_version_immutable in interception-schema.ts); this layer is the typed surface
// and the supersession transaction over them.

/** One attested rule version. `rulePayload` / `canonicalPayloadHash` are opaque to this layer. */
export interface LocalRuleVersionRecord {
  /** Immutable version identity (ULID), minted by the attest caller, not here. */
  versionId: string;
  /** Logical identity, stable across versions of the same rule. */
  ruleId: string;
  runtimeScopeId: string;
  /** Immutable canonical rule-version-v1 JSON; the SOLE authority. Opaque string here. */
  rulePayload: string;
  /** The rule-version-v1 digest computed by the attest caller. Opaque string here. */
  canonicalPayloadHash: string;
  lifecycleStatus: "LIVE" | "SUPERSEDED" | "DEPRECATED" | "REVOKED";
  attestationMethod: "HUMAN_DIRECT" | "AGENT_ON_USER_REQUEST";
  /** The accountable human, resolved from the authenticated operator by the caller. */
  attestedBy: string;
  /** FK lineage SET ON THE NEW version, pointing at the prior LIVE it replaced; null for a first version. */
  supersedesVersionId: string | null;
  /** The observed-rule-v1 hash this version was attested from; null for a hand-authored version. */
  derivedFromObservedHash: string | null;
  attestedAt: string;
}

/** A version-arm verdict: a rule_evaluation_record bound to a LocalRuleVersion (no observed arm). */
export interface VersionEvaluationInput {
  evaluationId: string;
  attemptId: string;
  runtimeScopeId: string;
  result: RuleEvaluationRecord["result"];
  eligibleEnforcement: RuleEvaluationRecord["eligibleEnforcement"];
  effectiveEnforcement: RuleEvaluationRecord["effectiveEnforcement"];
  verdictReasonCode: string;
  gateReasonCode: string | null;
  evaluatorContractVersion: string;
  ruleVersionId: string;
  canonicalPayloadHash: string;
  createdAt: string;
}

/** Raised when a version's lineage pointer would cross a runtime scope (FK lineage must stay in-scope). */
export class CrossScopeLineageError extends Error {
  constructor(
    readonly versionId: string,
    readonly runtimeScopeId: string,
    readonly supersedesVersionId: string,
  ) {
    super(
      `version ${versionId} in scope ${runtimeScopeId} cannot supersede ${supersedesVersionId}: ` +
        `the predecessor is in a different runtime scope`,
    );
    this.name = "CrossScopeLineageError";
  }
}

/** Raised when a supersession is requested but no LIVE version exists for the (scope, rule) to replace. */
export class NoLiveVersionToSupersedeError extends Error {
  constructor(
    readonly runtimeScopeId: string,
    readonly ruleId: string,
  ) {
    super(`no LIVE version for rule ${ruleId} in scope ${runtimeScopeId} to supersede`);
    this.name = "NoLiveVersionToSupersedeError";
  }
}

/** Raised when a revoke (kill switch) is requested but no LIVE version exists for the (scope, rule). */
export class NoLiveVersionToRevokeError extends Error {
  constructor(
    readonly runtimeScopeId: string,
    readonly ruleId: string,
  ) {
    super(`no LIVE version for rule ${ruleId} in scope ${runtimeScopeId} to revoke`);
    this.name = "NoLiveVersionToRevokeError";
  }
}

// ---------------------------------------------------------------------------
// local_rule_version
// ---------------------------------------------------------------------------

function mapVersionRow(row: Record<string, unknown>): LocalRuleVersionRecord {
  return {
    versionId: row.version_id as string,
    ruleId: row.rule_id as string,
    runtimeScopeId: row.runtime_scope_id as string,
    rulePayload: row.rule_payload as string,
    canonicalPayloadHash: row.canonical_payload_hash as string,
    lifecycleStatus: row.lifecycle_status as LocalRuleVersionRecord["lifecycleStatus"],
    attestationMethod: row.attestation_method as LocalRuleVersionRecord["attestationMethod"],
    attestedBy: row.attested_by as string,
    supersedesVersionId: (row.supersedes_version_id as string | null) ?? null,
    derivedFromObservedHash: (row.derived_from_observed_hash as string | null) ?? null,
    attestedAt: row.attested_at as string,
  };
}

/** Insert a version exactly as given. Same-scope FK lineage is verified BEFORE the write; everything
 * else (one-LIVE, payload uniqueness, immutability) is left to the schema. */
export function insertLocalRuleVersion(store: Ce0Store, rec: LocalRuleVersionRecord): void {
  if (rec.supersedesVersionId !== null) {
    const predecessor = getLocalRuleVersionAnyScope(store, rec.supersedesVersionId);
    if (predecessor && predecessor.runtimeScopeId !== rec.runtimeScopeId) {
      throw new CrossScopeLineageError(rec.versionId, rec.runtimeScopeId, rec.supersedesVersionId);
    }
  }
  store.db
    .prepare(
      `INSERT INTO local_rule_version
        (version_id, rule_id, runtime_scope_id, rule_payload, canonical_payload_hash,
         lifecycle_status, attestation_method, attested_by, supersedes_version_id,
         derived_from_observed_hash, attested_at)
       VALUES
        (@version_id, @rule_id, @runtime_scope_id, @rule_payload, @canonical_payload_hash,
         @lifecycle_status, @attestation_method, @attested_by, @supersedes_version_id,
         @derived_from_observed_hash, @attested_at)`,
    )
    .run({
      version_id: rec.versionId,
      rule_id: rec.ruleId,
      runtime_scope_id: rec.runtimeScopeId,
      rule_payload: rec.rulePayload,
      canonical_payload_hash: rec.canonicalPayloadHash,
      lifecycle_status: rec.lifecycleStatus,
      attestation_method: rec.attestationMethod,
      attested_by: rec.attestedBy,
      supersedes_version_id: rec.supersedesVersionId,
      derived_from_observed_hash: rec.derivedFromObservedHash,
      attested_at: rec.attestedAt,
    });
}

/** Read one version by the runtime-scope-safe composite key; null if it is absent OR in another scope. */
export function getLocalRuleVersion(
  store: Ce0Store,
  versionId: string,
  runtimeScopeId: string,
): LocalRuleVersionRecord | null {
  const row = store.db
    .prepare(`SELECT * FROM local_rule_version WHERE version_id = ? AND runtime_scope_id = ?`)
    .get(versionId, runtimeScopeId) as Record<string, unknown> | undefined;
  return row ? mapVersionRow(row) : null;
}

/** Scope-agnostic lookup used ONLY to validate lineage (a predecessor's scope). Not exported. */
function getLocalRuleVersionAnyScope(store: Ce0Store, versionId: string): LocalRuleVersionRecord | null {
  const row = store.db
    .prepare(`SELECT * FROM local_rule_version WHERE version_id = ?`)
    .get(versionId) as Record<string, unknown> | undefined;
  return row ? mapVersionRow(row) : null;
}

/** Read the current LIVE version for a (scope, rule); null when none is LIVE. */
export function getLiveLocalRuleVersion(
  store: Ce0Store,
  runtimeScopeId: string,
  ruleId: string,
): LocalRuleVersionRecord | null {
  const row = store.db
    .prepare(
      `SELECT * FROM local_rule_version
        WHERE runtime_scope_id = ? AND rule_id = ? AND lifecycle_status = 'LIVE'`,
    )
    .get(runtimeScopeId, ruleId) as Record<string, unknown> | undefined;
  return row ? mapVersionRow(row) : null;
}

/**
 * List EVERY LIVE rule version in one scope, ordered by ruleId ascending. This is the rule-driven
 * enforce dispatch's input (R4): the seam evaluates all of these against one tool attempt. The ruleId
 * ordering is the deterministic tie-break the dispatch relies on when more than one rule would deny the
 * same action (it emits the deny of the lowest ruleId and records the rest as arms). One LIVE row per
 * (scope, rule) is guaranteed by ux_one_live_version, so this never returns two versions of one rule.
 */
export function listLiveLocalRuleVersions(
  store: Ce0Store,
  runtimeScopeId: string,
): LocalRuleVersionRecord[] {
  const rows = store.db
    .prepare(
      `SELECT * FROM local_rule_version
        WHERE runtime_scope_id = ? AND lifecycle_status = 'LIVE'
        ORDER BY rule_id`,
    )
    .all(runtimeScopeId) as Record<string, unknown>[];
  return rows.map(mapVersionRow);
}

/**
 * List EVERY version (all lifecycle states) in one scope, grouped by rule and oldest-first
 * within each rule (rule_id, then attested_at, then version_id). This is the G2 importer's
 * input (rules-store-unification §7 step 2): the importer brings the FULL CE0 history into
 * the unified store, not just the LIVE versions the publish bridge projects, so a revoked or
 * superseded legacy versionId still resolves after migration (acceptance 18). The ordering is
 * the contract the import mapper depends on to rebuild each rule's supersedes chain.
 */
export function listAllLocalRuleVersionsInScope(
  store: Ce0Store,
  runtimeScopeId: string,
): LocalRuleVersionRecord[] {
  const rows = store.db
    .prepare(
      `SELECT * FROM local_rule_version
        WHERE runtime_scope_id = ?
        ORDER BY rule_id, attested_at, version_id`,
    )
    .all(runtimeScopeId) as Record<string, unknown>[];
  return rows.map(mapVersionRow);
}

/** List a rule's version history in one scope, oldest first (attested_at then version_id). */
export function listLocalRuleVersionHistory(
  store: Ce0Store,
  runtimeScopeId: string,
  ruleId: string,
): LocalRuleVersionRecord[] {
  const rows = store.db
    .prepare(
      `SELECT * FROM local_rule_version
        WHERE runtime_scope_id = ? AND rule_id = ?
        ORDER BY attested_at, version_id`,
    )
    .all(runtimeScopeId, ruleId) as Record<string, unknown>[];
  return rows.map(mapVersionRow);
}

/**
 * Atomically supersede the current LIVE version of a (scope, rule) with `successor`. In one
 * BEGIN IMMEDIATE transaction: find the current LIVE; demote it to SUPERSEDED (the only lifecycle
 * transition trg_version_immutable allows); insert `successor` as LIVE with supersedes_version_id
 * pointing at the demoted version. Demote-then-insert is deliberate: it never leaves two LIVE rows
 * for the (scope, rule), so ux_one_live_version is satisfied at every statement boundary. Throws
 * NoLiveVersionToSupersedeError when there is nothing LIVE to replace, and refuses a `successor`
 * whose supersedesVersionId is provided but does not name the actual prior LIVE. Returns the minted
 * successor with its lineage filled in.
 */
export function supersedeLiveLocalRuleVersion(
  store: Ce0Store,
  successor: LocalRuleVersionRecord,
): LocalRuleVersionRecord {
  const run = store.db.transaction((): LocalRuleVersionRecord => {
    const current = getLiveLocalRuleVersion(store, successor.runtimeScopeId, successor.ruleId);
    if (!current) {
      throw new NoLiveVersionToSupersedeError(successor.runtimeScopeId, successor.ruleId);
    }
    if (successor.supersedesVersionId !== null && successor.supersedesVersionId !== current.versionId) {
      throw new Error(
        `successor ${successor.versionId} claims to supersede ${successor.supersedesVersionId} ` +
          `but the current LIVE version is ${current.versionId}`,
      );
    }
    store.db
      .prepare(`UPDATE local_rule_version SET lifecycle_status = 'SUPERSEDED' WHERE version_id = ?`)
      .run(current.versionId);
    const minted: LocalRuleVersionRecord = {
      ...successor,
      lifecycleStatus: "LIVE",
      supersedesVersionId: current.versionId,
    };
    insertLocalRuleVersion(store, minted);
    return minted;
  });
  return run.immediate();
}

/**
 * The kill switch. Atomically disarm a (scope, rule) by flipping its current LIVE version to REVOKED
 * (the LIVE->REVOKED transition trg_version_immutable explicitly permits). After this the (scope, rule)
 * has NO LIVE version, so getLiveLocalRuleVersion returns null and the enforce seam finds NO_LIVE_VERSION
 * and fails open: enforcement stops cleanly without deleting any history. Scoped strictly to the given
 * runtime scope, so a same-rule LIVE version in another scope is never touched. Throws
 * NoLiveVersionToRevokeError when there is nothing LIVE to disarm. Returns the now-REVOKED version.
 */
export function revokeLiveLocalRuleVersion(
  store: Ce0Store,
  runtimeScopeId: string,
  ruleId: string,
): LocalRuleVersionRecord {
  const run = store.db.transaction((): LocalRuleVersionRecord => {
    const current = getLiveLocalRuleVersion(store, runtimeScopeId, ruleId);
    if (!current) {
      throw new NoLiveVersionToRevokeError(runtimeScopeId, ruleId);
    }
    store.db
      .prepare(`UPDATE local_rule_version SET lifecycle_status = 'REVOKED' WHERE version_id = ?`)
      .run(current.versionId);
    return { ...current, lifecycleStatus: "REVOKED" };
  });
  return run.immediate();
}

// ---------------------------------------------------------------------------
// rule_evaluation_record (version arm)
// ---------------------------------------------------------------------------

/** Write a version-arm verdict: a rule_evaluation_record bound to a LocalRuleVersion. The observed
 * arm is forced null here, so the schema's arm CHECK can only ever see the version arm; the composite
 * (rule_version_id, runtime_scope_id) FK rejects a verdict that references a version in another scope. */
export function insertVersionEvaluationRecord(store: Ce0Store, input: VersionEvaluationInput): void {
  insertRuleEvaluationRecord(store, {
    ...input,
    observedRuleSnapshot: null,
    observedRuleHash: null,
  });
}
