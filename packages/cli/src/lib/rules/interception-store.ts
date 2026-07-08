import { Ce0Store } from "./ce0-store";

// The typed writers/readers over the two R0 interception tables (tool_attempt and
// rule_evaluation_record), mirroring the accessor patterns in ce0-store.ts: named-param
// inserts, a row mapper per table, and SELECT-by-primary-key reads. The schema, with all
// its CHECKs, the runtime-scope-safe composite foreign key, and the append-only triggers,
// is defined in interception-schema.ts and proven against raw SQL in interception-schema.spec.ts;
// this layer is only the camelCase<->snake_case translation and the typed surface the durable
// R0 observation slice writes through.
//
// Both tables persist created_at as an ISO timestamp TEXT (the interception schema's convention),
// unlike the CE0 forcing-function tables which use INTEGER milliseconds. Nullable columns map to
// `string | null` and are passed through verbatim so the schema CHECKs (not this layer) decide
// which null combinations are legal.

/** One locally-minted attempt per intercepted PreToolUse call. */
export interface ToolAttemptRecord {
  attemptId: string;
  runtimeScopeId: string;
  sessionId: string;
  toolName: string;
  /** Canonical evaluation-input-v1 JSON: the snapshot a later replay recomputes the verdict from. */
  evaluationInputSnapshot: string;
  evaluationInputHash: string;
  aggregateDecision: "NO_DECISION" | "DENY";
  denyEmissionStatus: "NOT_APPLICABLE" | "DECISION_RECORDED" | "RESPONSE_EMITTED";
  inputAuthorityConfigHash: string | null;
  createdAt: string;
}

/** One verdict per applicable rule per attempt. The observed arm (R0) carries the frozen
 * observed-rule snapshot + hash inline with rule_version_id NULL; the version arm (R1)
 * references local_rule_version instead. */
export interface RuleEvaluationRecord {
  evaluationId: string;
  attemptId: string;
  runtimeScopeId: string;
  result: "COMPLIANT" | "VIOLATION" | "UNKNOWN";
  eligibleEnforcement: "OBSERVE" | "ASK" | "DENY";
  effectiveEnforcement: "NONE" | "OBSERVE" | "ASK" | "DENY";
  verdictReasonCode: string;
  gateReasonCode: string | null;
  evaluatorContractVersion: string;
  observedRuleSnapshot: string | null;
  observedRuleHash: string | null;
  ruleVersionId: string | null;
  canonicalPayloadHash: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// tool_attempt
// ---------------------------------------------------------------------------

export function insertToolAttempt(store: Ce0Store, rec: ToolAttemptRecord): void {
  store.db
    .prepare(
      `INSERT INTO tool_attempt
        (attempt_id, runtime_scope_id, session_id, tool_name, evaluation_input_snapshot,
         evaluation_input_hash, aggregate_decision, deny_emission_status,
         input_authority_config_hash, created_at)
       VALUES
        (@attempt_id, @runtime_scope_id, @session_id, @tool_name, @evaluation_input_snapshot,
         @evaluation_input_hash, @aggregate_decision, @deny_emission_status,
         @input_authority_config_hash, @created_at)`,
    )
    .run({
      attempt_id: rec.attemptId,
      runtime_scope_id: rec.runtimeScopeId,
      session_id: rec.sessionId,
      tool_name: rec.toolName,
      evaluation_input_snapshot: rec.evaluationInputSnapshot,
      evaluation_input_hash: rec.evaluationInputHash,
      aggregate_decision: rec.aggregateDecision,
      deny_emission_status: rec.denyEmissionStatus,
      input_authority_config_hash: rec.inputAuthorityConfigHash,
      created_at: rec.createdAt,
    });
}

function mapAttemptRow(row: Record<string, unknown>): ToolAttemptRecord {
  return {
    attemptId: row.attempt_id as string,
    runtimeScopeId: row.runtime_scope_id as string,
    sessionId: row.session_id as string,
    toolName: row.tool_name as string,
    evaluationInputSnapshot: row.evaluation_input_snapshot as string,
    evaluationInputHash: row.evaluation_input_hash as string,
    aggregateDecision: row.aggregate_decision as ToolAttemptRecord["aggregateDecision"],
    denyEmissionStatus: row.deny_emission_status as ToolAttemptRecord["denyEmissionStatus"],
    inputAuthorityConfigHash: (row.input_authority_config_hash as string | null) ?? null,
    createdAt: row.created_at as string,
  };
}

export function getToolAttempt(store: Ce0Store, attemptId: string): ToolAttemptRecord | null {
  const row = store.db
    .prepare(`SELECT * FROM tool_attempt WHERE attempt_id = ?`)
    .get(attemptId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return mapAttemptRow(row);
}

/**
 * Advance a committed deny from DECISION_RECORDED to RESPONSE_EMITTED, the SINGLE mutation
 * trg_attempt_frozen permits on tool_attempt (interception-schema.ts). The deny pilot (slice 10)
 * persists the DECISION_RECORDED row and COMMITS it BEFORE emitting the deny response, then calls this
 * to mark the response emitted. A crash between the deny commit and this advance therefore leaves an
 * honest DECISION_RECORDED row (recoverable, never NO_DECISION) per R1-4. The WHERE clause touches ONLY
 * a row still held at DENY / DECISION_RECORDED, so it changes nothing but deny_emission_status (the
 * trigger's one allowed delta) and a re-run or a wrong-state row is a harmless no-op, never an abort.
 */
export function advanceDenyEmissionToResponseEmitted(store: Ce0Store, attemptId: string): void {
  store.db
    .prepare(
      `UPDATE tool_attempt
          SET deny_emission_status = 'RESPONSE_EMITTED'
        WHERE attempt_id = ?
          AND aggregate_decision = 'DENY'
          AND deny_emission_status = 'DECISION_RECORDED'`,
    )
    .run(attemptId);
}

/**
 * Count the committed denies still held at DECISION_RECORDED: a deny whose decision was committed but
 * whose response was never advanced to RESPONSE_EMITTED. These are the honest crash-window leftovers of
 * the deny pilot (a crash between the deny commit and advanceDenyEmissionToResponseEmitted), recoverable
 * and never lost (R1-4). `mla doctor` surfaces this count (P0.60 honest deny-emission accounting) so an
 * operator can see whether the hook is recording denials it never emitted; a non-zero count is honest,
 * not corruption, so it never goes RED.
 */
export function countDenyDecisionsAwaitingEmission(store: Ce0Store): number {
  const row = store.db
    .prepare(
      `SELECT COUNT(*) AS n
         FROM tool_attempt
        WHERE aggregate_decision = 'DENY'
          AND deny_emission_status = 'DECISION_RECORDED'`,
    )
    .get() as { n: number };
  return row.n;
}

/**
 * Count the violations that ALREADY failed open: a VIOLATION whose effective enforcement degraded to NONE
 * because a deny-admission gate fired (RULE_ENFORCEMENT_UNAVAILABLE, decision 5). Unlike a crash-window
 * emission leftover, this is NOT recoverable: the prohibited action already passed un-governed. A version
 * arm only reaches effective NONE on a gated DENY, and an observed arm always enforces OBSERVE, so
 * (result = VIOLATION AND effective_enforcement = NONE) is exactly the historical fail-open set (the same
 * condition the `mla rules activity` enforcementUnavailable column reports). `mla doctor` surfaces this
 * count so an operator can confirm at a glance whether enforcement has ever silently missed on this box.
 */
export function countFailOpenEnforcementViolations(store: Ce0Store): number {
  const row = store.db
    .prepare(
      `SELECT COUNT(*) AS n
         FROM rule_evaluation_record
        WHERE result = 'VIOLATION'
          AND effective_enforcement = 'NONE'`,
    )
    .get() as { n: number };
  return row.n;
}

// ---------------------------------------------------------------------------
// rule_evaluation_record
// ---------------------------------------------------------------------------

export function insertRuleEvaluationRecord(store: Ce0Store, rec: RuleEvaluationRecord): void {
  store.db
    .prepare(
      `INSERT INTO rule_evaluation_record
        (evaluation_id, attempt_id, runtime_scope_id, result, eligible_enforcement,
         effective_enforcement, verdict_reason_code, gate_reason_code, evaluator_contract_version,
         observed_rule_snapshot, observed_rule_hash, rule_version_id, canonical_payload_hash,
         created_at)
       VALUES
        (@evaluation_id, @attempt_id, @runtime_scope_id, @result, @eligible_enforcement,
         @effective_enforcement, @verdict_reason_code, @gate_reason_code, @evaluator_contract_version,
         @observed_rule_snapshot, @observed_rule_hash, @rule_version_id, @canonical_payload_hash,
         @created_at)`,
    )
    .run({
      evaluation_id: rec.evaluationId,
      attempt_id: rec.attemptId,
      runtime_scope_id: rec.runtimeScopeId,
      result: rec.result,
      eligible_enforcement: rec.eligibleEnforcement,
      effective_enforcement: rec.effectiveEnforcement,
      verdict_reason_code: rec.verdictReasonCode,
      gate_reason_code: rec.gateReasonCode,
      evaluator_contract_version: rec.evaluatorContractVersion,
      observed_rule_snapshot: rec.observedRuleSnapshot,
      observed_rule_hash: rec.observedRuleHash,
      rule_version_id: rec.ruleVersionId,
      canonical_payload_hash: rec.canonicalPayloadHash,
      created_at: rec.createdAt,
    });
}

function mapEvaluationRow(row: Record<string, unknown>): RuleEvaluationRecord {
  return {
    evaluationId: row.evaluation_id as string,
    attemptId: row.attempt_id as string,
    runtimeScopeId: row.runtime_scope_id as string,
    result: row.result as RuleEvaluationRecord["result"],
    eligibleEnforcement: row.eligible_enforcement as RuleEvaluationRecord["eligibleEnforcement"],
    effectiveEnforcement: row.effective_enforcement as RuleEvaluationRecord["effectiveEnforcement"],
    verdictReasonCode: row.verdict_reason_code as string,
    gateReasonCode: (row.gate_reason_code as string | null) ?? null,
    evaluatorContractVersion: row.evaluator_contract_version as string,
    observedRuleSnapshot: (row.observed_rule_snapshot as string | null) ?? null,
    observedRuleHash: (row.observed_rule_hash as string | null) ?? null,
    ruleVersionId: (row.rule_version_id as string | null) ?? null,
    canonicalPayloadHash: (row.canonical_payload_hash as string | null) ?? null,
    createdAt: row.created_at as string,
  };
}

export function getRuleEvaluationRecord(
  store: Ce0Store,
  evaluationId: string,
): RuleEvaluationRecord | null {
  const row = store.db
    .prepare(`SELECT * FROM rule_evaluation_record WHERE evaluation_id = ?`)
    .get(evaluationId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return mapEvaluationRow(row);
}

/** List one attempt's evaluation records, ordered by evaluation_id so a re-read is stable. */
export function listEvaluationsForAttempt(
  store: Ce0Store,
  attemptId: string,
): RuleEvaluationRecord[] {
  const rows = store.db
    .prepare(`SELECT * FROM rule_evaluation_record WHERE attempt_id = ? ORDER BY evaluation_id`)
    .all(attemptId) as Record<string, unknown>[];
  return rows.map(mapEvaluationRow);
}

// ---------------------------------------------------------------------------
// observed-rule listing (the read behind `mla rules list`)
// ---------------------------------------------------------------------------

/** One distinct observed rule R0 has recorded in a runtime scope, summarized for the operator. */
export interface ObservedRuleListing {
  /** The observed-rule-v1 content hash that groups every observation of this rule. */
  observedRuleHash: string;
  /** The scanned directive prose, read from the latest observation's frozen snapshot. */
  ruleText: string;
  /** The verdict of the most recent observation. */
  latestResult: RuleEvaluationRecord["result"];
  /** When that most recent observation was recorded (ISO timestamp). */
  latestObservedAt: string;
  /** How many times this rule has been observed in this scope. */
  observationCount: number;
  /** Whether a LocalRuleVersion in THIS scope was attested from this observed hash. */
  hasLocalVersion: boolean;
}

/**
 * List the observed rules R0 has recorded in ONE runtime scope, one row per distinct
 * observed_rule_hash. The observed arm is identified by a non-null observed_rule_hash (the version
 * arm carries none). For each rule it reports the latest verdict and timestamp (the newest row by
 * created_at then evaluation_id, both descending, so a deterministic single row wins), the total
 * observation count, and whether a LocalRuleVersion in this same scope derives from that observed
 * hash. A pure read that NEVER crosses runtime scopes (proposal §2.3 / P0.51) and never infers a
 * logical rule id. Rows are ordered by observed_rule_hash so the listing is stable across reads.
 */
export function listObservedRulesInScope(
  store: Ce0Store,
  runtimeScopeId: string,
): ObservedRuleListing[] {
  const rows = store.db
    .prepare(
      `WITH observed AS (
         SELECT
           observed_rule_hash,
           observed_rule_snapshot,
           result,
           created_at,
           ROW_NUMBER() OVER (
             PARTITION BY observed_rule_hash
             ORDER BY created_at DESC, evaluation_id DESC
           ) AS rn,
           COUNT(*) OVER (PARTITION BY observed_rule_hash) AS observation_count
         FROM rule_evaluation_record
         WHERE runtime_scope_id = @scope
           AND observed_rule_hash IS NOT NULL
       )
       SELECT
         o.observed_rule_hash     AS observed_rule_hash,
         o.observed_rule_snapshot AS observed_rule_snapshot,
         o.result                 AS result,
         o.created_at             AS created_at,
         o.observation_count      AS observation_count,
         EXISTS (
           SELECT 1 FROM local_rule_version v
           WHERE v.runtime_scope_id = @scope
             AND v.derived_from_observed_hash = o.observed_rule_hash
         )                        AS has_local_version
       FROM observed o
       WHERE o.rn = 1
       ORDER BY o.observed_rule_hash`,
    )
    .all({ scope: runtimeScopeId }) as Record<string, unknown>[];
  return rows.map((row) => ({
    observedRuleHash: row.observed_rule_hash as string,
    ruleText: observedRuleText(row.observed_rule_snapshot as string),
    latestResult: row.result as RuleEvaluationRecord["result"],
    latestObservedAt: row.created_at as string,
    observationCount: row.observation_count as number,
    hasLocalVersion: (row.has_local_version as number) === 1,
  }));
}

/** Read the directive prose from a frozen observed-rule-v1 snapshot; "" when none is present. */
function observedRuleText(snapshot: string): string {
  const parsed = JSON.parse(snapshot) as { text?: unknown };
  return typeof parsed.text === "string" ? parsed.text : "";
}

// ---------------------------------------------------------------------------
// observed-snapshot resolution (the read behind R1 `mla rules attest --from-observed`)
// ---------------------------------------------------------------------------

/**
 * The outcome of resolving a single observed-rule snapshot by (runtime scope, observed hash).
 * A typed result, not a thrown error, so the attest caller can render each cardinality precisely:
 * a NOT_FOUND means there is nothing to attest, a COLLISION means the (scope, hash) is corrupt and
 * the resolver REFUSES to pick one, and FOUND carries the exact frozen snapshot plus how many
 * observations agreed on it.
 */
export type ObservedSnapshotResolution =
  | {
      kind: "FOUND";
      observedRuleHash: string;
      /** The exact canonical observed-rule-v1 JSON every matching observation agreed on, byte-for-byte. */
      observedRuleSnapshot: string;
      /** How many observations in this scope carried this hash (>= 1; all byte-identical). */
      observationCount: number;
    }
  | { kind: "NOT_FOUND"; runtimeScopeId: string; observedRuleHash: string }
  | {
      kind: "COLLISION";
      runtimeScopeId: string;
      observedRuleHash: string;
      /** How many DISTINCT snapshot bodies share this one (scope, hash). Always >= 2 here. */
      distinctSnapshotCount: number;
    };

/**
 * Resolve the EXACT observed-rule snapshot R0 recorded under one (runtime scope, observed hash), the
 * read R1 attestation builds on (proposal §10.1 step 6, §2.4). It scans ONLY rule_evaluation_record
 * rows in the given scope whose observed_rule_hash matches (the observed arm; the version arm carries
 * a null hash), grouping by the snapshot body so byte-identical observations collapse. Cardinality is
 * explicit and never guesses: zero groups is NOT_FOUND (nothing to attest); exactly one group is
 * FOUND with that snapshot and the observation count; two or more DISTINCT groups under the same
 * (scope, hash) is a COLLISION that refuses to pick one (hash corruption). It NEVER crosses a runtime
 * scope (the WHERE pins scope) and NEVER infers a logical rule id (it returns the frozen snapshot, no
 * rule identity).
 */
export function resolveObservedSnapshotInScope(
  store: Ce0Store,
  runtimeScopeId: string,
  observedRuleHash: string,
): ObservedSnapshotResolution {
  const groups = store.db
    .prepare(
      `SELECT observed_rule_snapshot AS snapshot, COUNT(*) AS n
         FROM rule_evaluation_record
        WHERE runtime_scope_id = @scope
          AND observed_rule_hash = @hash
          AND observed_rule_snapshot IS NOT NULL
        GROUP BY observed_rule_snapshot
        ORDER BY observed_rule_snapshot`,
    )
    .all({ scope: runtimeScopeId, hash: observedRuleHash }) as { snapshot: string; n: number }[];

  if (groups.length === 0) {
    return { kind: "NOT_FOUND", runtimeScopeId, observedRuleHash };
  }
  if (groups.length > 1) {
    return { kind: "COLLISION", runtimeScopeId, observedRuleHash, distinctSnapshotCount: groups.length };
  }
  return {
    kind: "FOUND",
    observedRuleHash,
    observedRuleSnapshot: groups[0].snapshot,
    observationCount: groups[0].n,
  };
}
