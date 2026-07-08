// R2-LOCAL accountability projection: the §2.6 "observed N, violated M" measurement.
//
// The terminal-outcome half of R2 (project a COMMITTED violation, ie "the action the deny named
// actually happened") is BLOCKED BY DESIGN: the supported Claude Code PreToolUse payload carries no
// tool_use_id (§9.10), and heuristic post correlation by timestamp / tool name / input hash / transcript
// position is FORBIDDEN because parallel identical calls make it unsound (§2.6, lines 2209-2221). So this
// module does NOT correlate anything. It projects ONLY the records MLA already owns at the moment it
// evaluates a rule at PreToolUse: the tool_attempt and the per-rule rule_evaluation_record.
//
// That projection is exactly the measurement §2.6 (lines 2224-2231) says licenses promoting a rule out of
// DRY_RUN: "you cannot justify promoting a rule from DRY_RUN to ask or deny until you can show 'this rule
// was observed N times and violated M of them.' The violation log IS that measurement." It needs no
// correlation and is not blocked. §3.7 ("Phase R2 (still local): accountability and instrumentation")
// scopes it to first-class local violation events and a console summary, which is this.
//
// The measurement is keyed on each LIVE version. A version's track record starts when it goes live: when a
// rule is superseded and re-attested, the new LIVE version's version_id is fresh, so its counts honestly
// start at zero (the old version's history is not silently inherited). Pure core over a real ce0 store.

import type { Ce0Store } from "./ce0-store";

/** The §2.6 measurement for one LIVE rule version in a runtime scope. */
export interface RuleActivitySummary {
  ruleId: string;
  versionId: string;
  /** Total intercepted attempts this version evaluated (the "observed N"). */
  observed: number;
  /** Of those, evaluations the four-state evaluator graded COMPLIANT. */
  compliant: number;
  /** Of those, evaluations graded VIOLATION (the "violated M"), regardless of enforcement mode. */
  violation: number;
  /** Of those violations, the ones whose attempt actually emitted a deny response to the harness.
   * Always <= violation: a rule running under OBSERVE counts the violation but emits no deny. */
  deniedEmitted: number;
  /** Of those violations, the ones a DENY-ceiling rule could NOT deny because enforcement degraded to
   * NONE (a deny-admission gate failed, fail-open per decision 5). This is the "alert loudly" category:
   * it is NOT a healthy observe-mode pass, it is a violation enforcement missed. Kept separate so it never
   * hides inside (violation - deniedEmitted), which would otherwise conflate it with observe-mode rules. */
  enforcementUnavailable: number;
}

interface ActivityRow {
  rule_id: string;
  version_id: string;
  observed: number;
  compliant: number;
  violation: number;
  denied_emitted: number;
  enforcement_unavailable: number;
}

/**
 * Project the §2.6 observed/violated measurement for every LIVE rule version in `runtimeScopeId`.
 *
 * Each LIVE version is LEFT JOINed to its version-arm evaluations (so a brand-new LIVE rule with no
 * activity still surfaces as an all-zero row, the floor the operator sees), and each evaluation to its
 * attempt (to tell a violation that emitted a deny from one that was only observed). The join keys on
 * rule_version_id, so observed-only arms (rule_version_id IS NULL, recorded for never-attested rules) and
 * superseded versions never inflate a LIVE version's count. Scope-isolated and ordered by ruleId so the
 * result is deterministic across runs.
 */
export function summarizeRuleActivity(
  store: Ce0Store,
  runtimeScopeId: string,
): RuleActivitySummary[] {
  const rows = store.db
    .prepare(
      `SELECT
         v.rule_id    AS rule_id,
         v.version_id AS version_id,
         COUNT(e.evaluation_id) AS observed,
         COALESCE(SUM(CASE WHEN e.result = 'COMPLIANT' THEN 1 ELSE 0 END), 0) AS compliant,
         COALESCE(SUM(CASE WHEN e.result = 'VIOLATION' THEN 1 ELSE 0 END), 0) AS violation,
         COALESCE(SUM(CASE WHEN e.effective_enforcement = 'DENY'
                            AND a.deny_emission_status = 'RESPONSE_EMITTED'
                       THEN 1 ELSE 0 END), 0) AS denied_emitted,
         COALESCE(SUM(CASE WHEN e.result = 'VIOLATION'
                            AND e.effective_enforcement = 'NONE'
                       THEN 1 ELSE 0 END), 0) AS enforcement_unavailable
       FROM local_rule_version v
       LEFT JOIN rule_evaluation_record e
              ON e.rule_version_id = v.version_id
             AND e.runtime_scope_id = v.runtime_scope_id
       LEFT JOIN tool_attempt a
              ON a.attempt_id = e.attempt_id
             AND a.runtime_scope_id = e.runtime_scope_id
       WHERE v.runtime_scope_id = ?
         AND v.lifecycle_status = 'LIVE'
       GROUP BY v.rule_id, v.version_id
       ORDER BY v.rule_id`,
    )
    .all(runtimeScopeId) as ActivityRow[];

  return rows.map((r) => ({
    ruleId: r.rule_id,
    versionId: r.version_id,
    observed: r.observed,
    compliant: r.compliant,
    violation: r.violation,
    deniedEmitted: r.denied_emitted,
    enforcementUnavailable: r.enforcement_unavailable,
  }));
}
