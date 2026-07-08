import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { openCe0Store, closeCe0Store, type Ce0Store } from "../../../src/lib/rules/ce0-store";
import {
  insertToolAttempt,
  insertRuleEvaluationRecord,
  type ToolAttemptRecord,
  type RuleEvaluationRecord,
} from "../../../src/lib/rules/interception-store";
import {
  insertLocalRuleVersion,
  type LocalRuleVersionRecord,
} from "../../../src/lib/rules/local-rule-version-repo";
import { summarizeRuleActivity } from "../../../src/lib/rules/rule-activity";

// R2-LOCAL accountability projection (proposal §2.6 / §3.7 "still local"). The committed-violation
// terminal-outcome half of R2 is BLOCKED (the supported PreToolUse payload carries no tool_use_id and
// heuristic post correlation is forbidden, §9.10), but the measurement §2.6 calls the reason observe is
// worth shipping IS local and needs no correlation: "this rule was observed N times and violated M of
// them." summarizeRuleActivity projects exactly that over the records MLA already owns at PreToolUse
// (tool_attempt + rule_evaluation_record), keyed on each LIVE version. Real ce0 store, no mock store.

const SCOPE = "/work/meetless";
const OTHER_SCOPE = "/work/other";

let dir: string;
let store: Ce0Store;
let seq = 0;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "rule-activity-"));
  store = openCe0Store(path.join(dir, "evidence.db"));
  seq = 0;
});

afterEach(() => {
  closeCe0Store(store);
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Version ids are the table PK, so the same ruleId LIVE in two scopes needs two distinct ids. */
function verId(ruleId: string, scope = SCOPE): string {
  return `ver_${ruleId}@${scope}`;
}

function liveVersion(ruleId: string, scope = SCOPE): LocalRuleVersionRecord {
  return {
    versionId: verId(ruleId, scope),
    ruleId,
    runtimeScopeId: scope,
    rulePayload: "{}",
    canonicalPayloadHash: "c".repeat(64),
    lifecycleStatus: "LIVE",
    attestationMethod: "AGENT_ON_USER_REQUEST",
    attestedBy: "user_an",
    supersedesVersionId: null,
    derivedFromObservedHash: "a".repeat(64),
    attestedAt: "2026-06-19T00:00:00.000Z",
  };
}

/** Record one intercepted attempt and its single version-arm verdict against a rule's LIVE version. */
function record(
  ruleId: string,
  result: RuleEvaluationRecord["result"],
  effective: RuleEvaluationRecord["effectiveEnforcement"],
  scope = SCOPE,
): void {
  const versionId = verId(ruleId, scope);
  seq += 1;
  const attemptId = `att_${seq}`;
  const denied = effective === "DENY";
  const attempt: ToolAttemptRecord = {
    attemptId,
    runtimeScopeId: scope,
    sessionId: "sess_1",
    toolName: "Write",
    evaluationInputSnapshot: "{}",
    evaluationInputHash: "b".repeat(64),
    aggregateDecision: denied ? "DENY" : "NO_DECISION",
    denyEmissionStatus: denied ? "RESPONSE_EMITTED" : "NOT_APPLICABLE",
    inputAuthorityConfigHash: null,
    createdAt: "2026-06-19T00:00:00.000Z",
  };
  insertToolAttempt(store, attempt);
  const evaluation: RuleEvaluationRecord = {
    evaluationId: `eval_${seq}`,
    attemptId,
    runtimeScopeId: scope,
    result,
    eligibleEnforcement: effective === "DENY" ? "DENY" : "OBSERVE",
    effectiveEnforcement: effective,
    verdictReasonCode: result === "VIOLATION" ? "FORBIDDEN_PATH_MATCH" : "COMPLIANT_OUTSIDE_FORBIDDEN_ROOT",
    gateReasonCode: null,
    evaluatorContractVersion: "four-state-evaluator-v1",
    observedRuleSnapshot: null,
    observedRuleHash: null,
    ruleVersionId: versionId,
    canonicalPayloadHash: "c".repeat(64),
    createdAt: "2026-06-19T00:00:00.000Z",
  };
  insertRuleEvaluationRecord(store, evaluation);
}

/**
 * Record a VIOLATION a DENY-ceiling rule could NOT deny because a deny-admission gate failed: the rule was
 * eligible for DENY, but enforcement degraded to NONE (fail-open, decision 5). No deny is emitted, so the
 * attempt stays NO_DECISION / NOT_APPLICABLE. This is the "alert loudly" category that must not hide inside
 * the plain violation count.
 */
function failOpenViolation(ruleId: string, scope = SCOPE): void {
  const versionId = verId(ruleId, scope);
  seq += 1;
  const attemptId = `att_${seq}`;
  const attempt: ToolAttemptRecord = {
    attemptId,
    runtimeScopeId: scope,
    sessionId: "sess_1",
    toolName: "Write",
    evaluationInputSnapshot: "{}",
    evaluationInputHash: "b".repeat(64),
    aggregateDecision: "NO_DECISION",
    denyEmissionStatus: "NOT_APPLICABLE",
    inputAuthorityConfigHash: null,
    createdAt: "2026-06-19T00:00:00.000Z",
  };
  insertToolAttempt(store, attempt);
  const evaluation: RuleEvaluationRecord = {
    evaluationId: `eval_${seq}`,
    attemptId,
    runtimeScopeId: scope,
    result: "VIOLATION",
    eligibleEnforcement: "DENY",
    effectiveEnforcement: "NONE",
    verdictReasonCode: "FORBIDDEN_PATH_MATCH",
    gateReasonCode: "RULE_ENFORCEMENT_UNAVAILABLE",
    evaluatorContractVersion: "four-state-evaluator-v1",
    observedRuleSnapshot: null,
    observedRuleHash: null,
    ruleVersionId: versionId,
    canonicalPayloadHash: "c".repeat(64),
    createdAt: "2026-06-19T00:00:00.000Z",
  };
  insertRuleEvaluationRecord(store, evaluation);
}

describe("summarizeRuleActivity: the §2.6 observed/violated measurement over LIVE versions", () => {
  it("counts observed, compliant, violation, and emitted denies for a LIVE version", () => {
    insertLocalRuleVersion(store, liveVersion("notes-location-v1"));
    record("notes-location-v1", "COMPLIANT", "OBSERVE");
    record("notes-location-v1", "COMPLIANT", "OBSERVE");
    record("notes-location-v1", "VIOLATION", "DENY");

    const summary = summarizeRuleActivity(store, SCOPE);

    expect(summary).toHaveLength(1);
    expect(summary[0]).toMatchObject({
      ruleId: "notes-location-v1",
      versionId: verId("notes-location-v1"),
      observed: 3,
      compliant: 2,
      violation: 1,
      deniedEmitted: 1,
    });
  });

  it("separates a violation enforced under OBSERVE from a denied violation (deniedEmitted < violation)", () => {
    insertLocalRuleVersion(store, liveVersion("audit-v1"));
    // Two violations: one only OBSERVED (observe-mode rule), one actually DENIED.
    record("audit-v1", "VIOLATION", "OBSERVE");
    record("audit-v1", "VIOLATION", "DENY");

    const summary = summarizeRuleActivity(store, SCOPE);

    expect(summary[0]).toMatchObject({ observed: 2, violation: 2, deniedEmitted: 1 });
  });

  it("counts a DENY-eligible violation that effectively enforced NONE as enforcementUnavailable (fail-open)", () => {
    insertLocalRuleVersion(store, liveVersion("notes-location-v1"));
    // The honest accounting invariant (P0.60, "fail open, alert loudly"): a violation a DENY-ceiling rule
    // could not deny because a deny-admission gate failed is RULE_ENFORCEMENT_UNAVAILABLE (effective NONE),
    // NOT an observe-mode pass. It must be visible as its own count, not hidden in (violation - denied).
    record("notes-location-v1", "VIOLATION", "DENY"); // enforced
    failOpenViolation("notes-location-v1"); // eligible DENY, but effective NONE

    const summary = summarizeRuleActivity(store, SCOPE);

    expect(summary[0]).toMatchObject({
      observed: 2,
      violation: 2,
      deniedEmitted: 1,
      enforcementUnavailable: 1,
    });
  });

  it("does NOT count an observe-mode violation as enforcementUnavailable", () => {
    insertLocalRuleVersion(store, liveVersion("audit-v1"));
    record("audit-v1", "VIOLATION", "OBSERVE");

    const summary = summarizeRuleActivity(store, SCOPE);

    expect(summary[0]).toMatchObject({ violation: 1, deniedEmitted: 0, enforcementUnavailable: 0 });
  });

  it("reports a LIVE rule with zero activity as all-zero (the floor the operator still sees)", () => {
    insertLocalRuleVersion(store, liveVersion("brand-new-v1"));

    const summary = summarizeRuleActivity(store, SCOPE);

    expect(summary).toHaveLength(1);
    expect(summary[0]).toMatchObject({
      ruleId: "brand-new-v1",
      observed: 0,
      compliant: 0,
      violation: 0,
      deniedEmitted: 0,
    });
  });

  it("isolates by runtime scope (another scope's records never inflate this scope's count)", () => {
    insertLocalRuleVersion(store, liveVersion("notes-location-v1", SCOPE));
    insertLocalRuleVersion(store, liveVersion("notes-location-v1", OTHER_SCOPE));
    record("notes-location-v1", "VIOLATION", "DENY", SCOPE);
    record("notes-location-v1", "COMPLIANT", "OBSERVE", OTHER_SCOPE);

    const here = summarizeRuleActivity(store, SCOPE);

    expect(here).toHaveLength(1);
    expect(here[0]).toMatchObject({ observed: 1, violation: 1, deniedEmitted: 1, compliant: 0 });
  });

  it("orders results deterministically by ruleId", () => {
    insertLocalRuleVersion(store, liveVersion("zzz-v1"));
    insertLocalRuleVersion(store, liveVersion("aaa-v1"));

    const summary = summarizeRuleActivity(store, SCOPE);

    expect(summary.map((s) => s.ruleId)).toEqual(["aaa-v1", "zzz-v1"]);
  });
});
