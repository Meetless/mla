import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { openCe0Store, closeCe0Store, type Ce0Store } from "../../src/lib/rules/ce0-store";
import {
  insertToolAttempt,
  insertRuleEvaluationRecord,
  type ToolAttemptRecord,
  type RuleEvaluationRecord,
} from "../../src/lib/rules/interception-store";
import {
  insertLocalRuleVersion,
  type LocalRuleVersionRecord,
} from "../../src/lib/rules/local-rule-version-repo";
import { runRulesActivity } from "../../src/commands/rules";

// `mla rules activity`: the R2-LOCAL accountability projection (proposal §2.6 / §3.7 "still local"). It
// surfaces, per LIVE rule in the ACTIVE runtime scope, the §2.6 measurement that licenses promoting a
// rule out of DRY_RUN: observed N, compliant, violated M, denied. No correlation, no backend call. A thin
// IO shell over summarizeRuleActivity, exercised end to end against one real ce0 store (no mock store).

let dir: string;
let dbPath: string;
let store: Ce0Store;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "rules-activity-cmd-"));
  dbPath = path.join(dir, "ce0.db");
  store = openCe0Store(dbPath);
});

afterEach(() => {
  closeCe0Store(store);
  fs.rmSync(dir, { recursive: true, force: true });
});

const SCOPE = "scope_a";

function liveVersion(ruleId: string, scope = SCOPE): LocalRuleVersionRecord {
  return {
    versionId: `ver_${ruleId}`,
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

let seq = 0;
function record(
  versionId: string,
  result: RuleEvaluationRecord["result"],
  effective: RuleEvaluationRecord["effectiveEnforcement"],
  scope = SCOPE,
): void {
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
    eligibleEnforcement: denied ? "DENY" : "OBSERVE",
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

function deps(scope = SCOPE) {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    deps: {
      storePath: dbPath,
      resolveRuntimeScopeId: () => scope,
      out: (line: string) => out.push(line),
      err: (line: string) => err.push(line),
    },
  };
}

beforeEach(() => {
  seq = 0;
});

describe("mla rules activity (text)", () => {
  it("prints the §2.6 observed/violated measurement per LIVE rule and exits 0", async () => {
    insertLocalRuleVersion(store, liveVersion("notes-location-v1"));
    record("ver_notes-location-v1", "COMPLIANT", "OBSERVE");
    record("ver_notes-location-v1", "COMPLIANT", "OBSERVE");
    record("ver_notes-location-v1", "VIOLATION", "DENY");
    const { out, deps: d } = deps();

    const code = await runRulesActivity([], d);

    expect(code).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("scope_a");
    expect(text).toContain("notes-location-v1");
    expect(text).toContain("observed");
    // The four counts the measurement reports: observed 3, compliant 2, violation 1, denied 1.
    expect(text).toMatch(/observed[^\n]*3/);
    expect(text).toMatch(/violat[^\n]*1/i);
    expect(text).toMatch(/deni[^\n]*1/i);
  });

  it("surfaces the fail-open category (enforcement-unavailable) as its own count, not hidden in violations", async () => {
    insertLocalRuleVersion(store, liveVersion("notes-location-v1"));
    record("ver_notes-location-v1", "VIOLATION", "DENY"); // enforced
    record("ver_notes-location-v1", "VIOLATION", "NONE"); // enforcement degraded to NONE (fail-open)
    const { out, deps: d } = deps();

    const code = await runRulesActivity([], d);

    expect(code).toBe(0);
    const text = out.join("\n");
    expect(text).toMatch(/enforcement-unavailable[^\n]*1/i);
  });

  it("reports a scope with no LIVE rules without error", async () => {
    const { out, err, deps: d } = deps("scope_empty");

    const code = await runRulesActivity([], d);

    expect(code).toBe(0);
    expect(err).toEqual([]);
    expect(out.join("\n").toLowerCase()).toContain("no live rule");
  });
});

describe("mla rules activity --json", () => {
  it("emits a machine-readable object with the scope and per-rule measurement", async () => {
    insertLocalRuleVersion(store, liveVersion("notes-location-v1"));
    record("ver_notes-location-v1", "VIOLATION", "DENY");
    const { out, deps: d } = deps();

    const code = await runRulesActivity(["--json"], d);

    expect(code).toBe(0);
    const parsed = JSON.parse(out.join("\n"));
    expect(parsed.runtimeScopeId).toBe("scope_a");
    expect(parsed.rules).toEqual([
      {
        ruleId: "notes-location-v1",
        versionId: "ver_notes-location-v1",
        observed: 1,
        compliant: 0,
        violation: 1,
        deniedEmitted: 1,
        enforcementUnavailable: 0,
      },
    ]);
  });

  it("emits an empty rules array for a scope with no LIVE rules", async () => {
    const { out, deps: d } = deps("scope_empty");

    const code = await runRulesActivity(["--json"], d);

    expect(code).toBe(0);
    expect(JSON.parse(out.join("\n"))).toEqual({ runtimeScopeId: "scope_empty", rules: [] });
  });
});
