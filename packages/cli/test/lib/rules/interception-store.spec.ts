import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { openCe0Store, closeCe0Store, type Ce0Store } from "../../../src/lib/rules/ce0-store";
import {
  insertToolAttempt,
  getToolAttempt,
  insertRuleEvaluationRecord,
  getRuleEvaluationRecord,
  listEvaluationsForAttempt,
  listObservedRulesInScope,
  resolveObservedSnapshotInScope,
  advanceDenyEmissionToResponseEmitted,
  countDenyDecisionsAwaitingEmission,
  countFailOpenEnforcementViolations,
  type ToolAttemptRecord,
  type RuleEvaluationRecord,
} from "../../../src/lib/rules/interception-store";
import {
  insertLocalRuleVersion,
  type LocalRuleVersionRecord,
} from "../../../src/lib/rules/local-rule-version-repo";

// Persistence slice 3: the typed writers/readers over the two R0 interception tables
// (notes/20260615-rules-as-node-and-action-interception-consolidated-proposal.md §10.1).
// The schema itself (CHECKs, FKs, triggers) is proven in interception-schema.spec.ts against
// raw SQL; THIS suite proves the typed layer round-trips every column faithfully, surfaces the
// runtime-scope-safe composite foreign key, and lists an attempt's evaluations deterministically.
// It runs against the one real ce0 database opened by the canonical opener (no mock DB).

let dir: string;
let store: Ce0Store;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "interception-store-"));
  store = openCe0Store(path.join(dir, "evidence.db"));
});

afterEach(() => {
  closeCe0Store(store);
  fs.rmSync(dir, { recursive: true, force: true });
});

// A valid R0 tool_attempt in scope_a. Each test overrides only what it exercises.
function attempt(over: Partial<ToolAttemptRecord> = {}): ToolAttemptRecord {
  return {
    attemptId: "att_1",
    runtimeScopeId: "scope_a",
    sessionId: "sess_1",
    toolName: "Write",
    evaluationInputSnapshot: '{"toolName":"Write","target":{"kind":"RUNTIME_RELATIVE","path":"notes/x.md"}}',
    evaluationInputHash: "a".repeat(64),
    aggregateDecision: "NO_DECISION",
    denyEmissionStatus: "NOT_APPLICABLE",
    inputAuthorityConfigHash: null,
    createdAt: "2026-06-19T00:00:00.000Z",
    ...over,
  };
}

// A valid R0 OBSERVED-arm evaluation row: it carries the frozen observed-rule snapshot + hash
// inline and references no attested version (rule_version_id / canonical_payload_hash NULL).
function observedEval(over: Partial<RuleEvaluationRecord> = {}): RuleEvaluationRecord {
  return {
    evaluationId: "eval_1",
    attemptId: "att_1",
    runtimeScopeId: "scope_a",
    result: "VIOLATION",
    eligibleEnforcement: "OBSERVE",
    effectiveEnforcement: "OBSERVE",
    verdictReasonCode: "FORBIDDEN_PATH_MATCH",
    gateReasonCode: null,
    evaluatorContractVersion: "four-state-evaluator-v1",
    observedRuleSnapshot: '{"effect":"PROHIBIT","forbiddenRootRelativePath":"notes"}',
    observedRuleHash: "b".repeat(64),
    ruleVersionId: null,
    canonicalPayloadHash: null,
    createdAt: "2026-06-19T00:00:00.000Z",
    ...over,
  };
}

describe("tool_attempt typed round-trip", () => {
  it("inserts and reads back every column", () => {
    const rec = attempt();
    insertToolAttempt(store, rec);
    expect(getToolAttempt(store, rec.attemptId)).toEqual(rec);
  });

  it("round-trips a non-null input_authority_config_hash", () => {
    const rec = attempt({ inputAuthorityConfigHash: "c".repeat(64) });
    insertToolAttempt(store, rec);
    expect(getToolAttempt(store, rec.attemptId)?.inputAuthorityConfigHash).toBe("c".repeat(64));
  });

  it("returns null for an unknown attempt id", () => {
    expect(getToolAttempt(store, "nope")).toBeNull();
  });
});

describe("rule_evaluation_record typed round-trip (observed arm)", () => {
  beforeEach(() => insertToolAttempt(store, attempt()));

  it("inserts and reads back every column of the observed arm", () => {
    const rec = observedEval();
    insertRuleEvaluationRecord(store, rec);
    expect(getRuleEvaluationRecord(store, rec.evaluationId)).toEqual(rec);
  });

  it("round-trips a COMPLIANT observed verdict", () => {
    const rec = observedEval({
      evaluationId: "eval_compliant",
      result: "COMPLIANT",
      verdictReasonCode: "COMPLIANT_OUTSIDE_FORBIDDEN_ROOT",
    });
    insertRuleEvaluationRecord(store, rec);
    const got = getRuleEvaluationRecord(store, rec.evaluationId);
    expect(got?.result).toBe("COMPLIANT");
    expect(got?.verdictReasonCode).toBe("COMPLIANT_OUTSIDE_FORBIDDEN_ROOT");
  });

  it("returns null for an unknown evaluation id", () => {
    expect(getRuleEvaluationRecord(store, "nope")).toBeNull();
  });
});

describe("the runtime-scope-safe composite foreign key is enforced through the writer", () => {
  it("rejects an evaluation row whose parent attempt does not exist", () => {
    expect(() => insertRuleEvaluationRecord(store, observedEval())).toThrow();
  });

  it("rejects an evaluation row that points at the right attempt id but the wrong scope", () => {
    insertToolAttempt(store, attempt());
    expect(() =>
      insertRuleEvaluationRecord(store, observedEval({ runtimeScopeId: "scope_b" })),
    ).toThrow();
  });
});

describe("listEvaluationsForAttempt", () => {
  it("returns an attempt's evaluations ordered by evaluation_id, and only that attempt's", () => {
    insertToolAttempt(store, attempt({ attemptId: "att_1" }));
    insertToolAttempt(store, attempt({ attemptId: "att_2" }));
    insertRuleEvaluationRecord(store, observedEval({ evaluationId: "eval_b", attemptId: "att_1", observedRuleHash: "1".repeat(64) }));
    insertRuleEvaluationRecord(store, observedEval({ evaluationId: "eval_a", attemptId: "att_1", observedRuleHash: "2".repeat(64) }));
    insertRuleEvaluationRecord(store, observedEval({ evaluationId: "eval_other", attemptId: "att_2" }));

    const got = listEvaluationsForAttempt(store, "att_1");
    expect(got.map((e) => e.evaluationId)).toEqual(["eval_a", "eval_b"]);
  });

  it("returns an empty array for an attempt with no evaluations", () => {
    insertToolAttempt(store, attempt());
    expect(listEvaluationsForAttempt(store, "att_1")).toEqual([]);
  });
});

describe("listObservedRulesInScope", () => {
  // A canonical observed-rule-v1 snapshot carrying the scanned directive prose (the "rule text").
  const snap = (text: string, forbidden = "notes"): string =>
    JSON.stringify({
      text,
      applicability: { tools: ["Write"] },
      effect: "PROHIBIT",
      forbiddenRootRelativePath: forbidden,
    });

  // Raw insert of a LIVE attested version (the A.4 repository is not built yet; this is a schema
  // fixture so the hasLocalVersion join can be exercised independently).
  function insertLiveVersion(over: { runtimeScopeId?: string; derivedFromObservedHash: string }): void {
    store.db
      .prepare(
        `INSERT INTO local_rule_version
           (version_id, rule_id, runtime_scope_id, rule_payload, canonical_payload_hash,
            lifecycle_status, attestation_method, attested_by, derived_from_observed_hash, attested_at)
         VALUES (@vid, @rid, @scope, @payload, @hash, 'LIVE', 'HUMAN_DIRECT', @by, @obs, @at)`,
      )
      .run({
        vid: "ver_" + over.derivedFromObservedHash.slice(0, 8),
        rid: "rule_notes_location",
        scope: over.runtimeScopeId ?? "scope_a",
        payload: '{"text":"x"}',
        hash: "f".repeat(64),
        by: "operator@example.com",
        obs: over.derivedFromObservedHash,
        at: "2026-06-19T00:00:00.000Z",
      });
  }

  it("returns one row per observed hash with latest verdict, count, and timestamp", () => {
    const h = "1".repeat(64);
    insertToolAttempt(store, attempt({ attemptId: "att_1" }));
    insertToolAttempt(store, attempt({ attemptId: "att_2" }));
    // Two observations of the SAME observed rule (same hash); the later VIOLATION must win.
    insertRuleEvaluationRecord(
      store,
      observedEval({
        evaluationId: "eval_early",
        attemptId: "att_1",
        observedRuleHash: h,
        observedRuleSnapshot: snap("keep notes under /notes"),
        result: "COMPLIANT",
        createdAt: "2026-06-19T00:00:00.000Z",
      }),
    );
    insertRuleEvaluationRecord(
      store,
      observedEval({
        evaluationId: "eval_late",
        attemptId: "att_2",
        observedRuleHash: h,
        observedRuleSnapshot: snap("keep notes under /notes"),
        result: "VIOLATION",
        createdAt: "2026-06-19T03:00:00.000Z",
      }),
    );

    expect(listObservedRulesInScope(store, "scope_a")).toEqual([
      {
        observedRuleHash: h,
        ruleText: "keep notes under /notes",
        latestResult: "VIOLATION",
        latestObservedAt: "2026-06-19T03:00:00.000Z",
        observationCount: 2,
        hasLocalVersion: false,
      },
    ]);
  });

  it("orders distinct observed rules by hash and counts each independently", () => {
    const h1 = "a".repeat(64);
    const h2 = "b".repeat(64);
    insertToolAttempt(store, attempt({ attemptId: "att_1" }));
    insertRuleEvaluationRecord(
      store,
      observedEval({ evaluationId: "e2", attemptId: "att_1", observedRuleHash: h2, observedRuleSnapshot: snap("two") }),
    );
    insertRuleEvaluationRecord(
      store,
      observedEval({ evaluationId: "e1", attemptId: "att_1", observedRuleHash: h1, observedRuleSnapshot: snap("one") }),
    );
    const got = listObservedRulesInScope(store, "scope_a");
    expect(got.map((r) => r.observedRuleHash)).toEqual([h1, h2]);
    expect(got.map((r) => r.observationCount)).toEqual([1, 1]);
  });

  it("never returns observed rules from another runtime scope", () => {
    insertToolAttempt(store, attempt({ attemptId: "att_a", runtimeScopeId: "scope_a" }));
    insertToolAttempt(store, attempt({ attemptId: "att_b", runtimeScopeId: "scope_b" }));
    insertRuleEvaluationRecord(
      store,
      observedEval({ evaluationId: "e_a", attemptId: "att_a", runtimeScopeId: "scope_a", observedRuleHash: "a".repeat(64), observedRuleSnapshot: snap("a") }),
    );
    insertRuleEvaluationRecord(
      store,
      observedEval({ evaluationId: "e_b", attemptId: "att_b", runtimeScopeId: "scope_b", observedRuleHash: "c".repeat(64), observedRuleSnapshot: snap("b") }),
    );
    expect(listObservedRulesInScope(store, "scope_a").map((r) => r.observedRuleHash)).toEqual([
      "a".repeat(64),
    ]);
  });

  it("reports hasLocalVersion=true only when a version in this scope derives from that observed hash", () => {
    const attested = "d".repeat(64);
    const bare = "e".repeat(64);
    insertToolAttempt(store, attempt({ attemptId: "att_1" }));
    insertRuleEvaluationRecord(
      store,
      observedEval({ evaluationId: "e_att", attemptId: "att_1", observedRuleHash: attested, observedRuleSnapshot: snap("attested") }),
    );
    insertRuleEvaluationRecord(
      store,
      observedEval({ evaluationId: "e_bare", attemptId: "att_1", observedRuleHash: bare, observedRuleSnapshot: snap("bare") }),
    );
    insertLiveVersion({ runtimeScopeId: "scope_a", derivedFromObservedHash: attested });

    const byHash = new Map(listObservedRulesInScope(store, "scope_a").map((r) => [r.observedRuleHash, r]));
    expect(byHash.get(attested)?.hasLocalVersion).toBe(true);
    expect(byHash.get(bare)?.hasLocalVersion).toBe(false);
  });

  it("does not count a version derived from the same hash in a DIFFERENT scope", () => {
    const h = "9".repeat(64);
    insertToolAttempt(store, attempt({ attemptId: "att_1", runtimeScopeId: "scope_a" }));
    insertRuleEvaluationRecord(
      store,
      observedEval({ evaluationId: "e1", attemptId: "att_1", runtimeScopeId: "scope_a", observedRuleHash: h, observedRuleSnapshot: snap("x") }),
    );
    insertLiveVersion({ runtimeScopeId: "scope_b", derivedFromObservedHash: h });
    expect(listObservedRulesInScope(store, "scope_a")[0]?.hasLocalVersion).toBe(false);
  });

  it("returns an empty array for a scope with no observations", () => {
    expect(listObservedRulesInScope(store, "scope_empty")).toEqual([]);
  });
});

describe("resolveObservedSnapshotInScope", () => {
  // Resolve the EXACT observed-rule snapshot by the composite key (active runtime_scope_id,
  // observed_rule_hash) against rule_evaluation_record, the read behind R1 `mla rules attest
  // --from-observed <hash>` (proposal §10.1 step 6). Cardinality is explicit: zero rows are a typed
  // not-found, N byte-identical observations resolve to the one snapshot (the idempotent-observation
  // case), and >1 NON-identical snapshot under one (scope, hash) is a typed corruption / collision
  // that refuses to pick one. It NEVER searches another scope and NEVER infers a logical rule id.
  const snap = (text: string): string =>
    JSON.stringify({ text, applicability: { tools: ["Write"] }, effect: "PROHIBIT", forbiddenRootRelativePath: "notes" });

  it("returns NOT_FOUND when no observation in this scope carries that hash", () => {
    insertToolAttempt(store, attempt());
    insertRuleEvaluationRecord(store, observedEval({ observedRuleHash: "1".repeat(64), observedRuleSnapshot: snap("x") }));

    expect(resolveObservedSnapshotInScope(store, "scope_a", "9".repeat(64))).toEqual({
      kind: "NOT_FOUND",
      runtimeScopeId: "scope_a",
      observedRuleHash: "9".repeat(64),
    });
  });

  it("returns FOUND with the single snapshot and observation count for exactly one observation", () => {
    const h = "1".repeat(64);
    insertToolAttempt(store, attempt());
    insertRuleEvaluationRecord(store, observedEval({ observedRuleHash: h, observedRuleSnapshot: snap("keep notes under /notes") }));

    expect(resolveObservedSnapshotInScope(store, "scope_a", h)).toEqual({
      kind: "FOUND",
      observedRuleHash: h,
      observedRuleSnapshot: snap("keep notes under /notes"),
      observationCount: 1,
    });
  });

  it("resolves N byte-identical observations to the one snapshot (idempotent observation)", () => {
    const h = "2".repeat(64);
    insertToolAttempt(store, attempt({ attemptId: "att_1" }));
    insertToolAttempt(store, attempt({ attemptId: "att_2" }));
    insertRuleEvaluationRecord(store, observedEval({ evaluationId: "e1", attemptId: "att_1", observedRuleHash: h, observedRuleSnapshot: snap("same") }));
    insertRuleEvaluationRecord(store, observedEval({ evaluationId: "e2", attemptId: "att_2", observedRuleHash: h, observedRuleSnapshot: snap("same") }));

    expect(resolveObservedSnapshotInScope(store, "scope_a", h)).toEqual({
      kind: "FOUND",
      observedRuleHash: h,
      observedRuleSnapshot: snap("same"),
      observationCount: 2,
    });
  });

  it("returns COLLISION when two NON-identical snapshots share one (scope, hash)", () => {
    const h = "3".repeat(64);
    insertToolAttempt(store, attempt({ attemptId: "att_1" }));
    insertToolAttempt(store, attempt({ attemptId: "att_2" }));
    insertRuleEvaluationRecord(store, observedEval({ evaluationId: "e1", attemptId: "att_1", observedRuleHash: h, observedRuleSnapshot: snap("one") }));
    insertRuleEvaluationRecord(store, observedEval({ evaluationId: "e2", attemptId: "att_2", observedRuleHash: h, observedRuleSnapshot: snap("two") }));

    expect(resolveObservedSnapshotInScope(store, "scope_a", h)).toEqual({
      kind: "COLLISION",
      runtimeScopeId: "scope_a",
      observedRuleHash: h,
      distinctSnapshotCount: 2,
    });
  });

  it("never resolves a snapshot from another runtime scope", () => {
    const h = "4".repeat(64);
    insertToolAttempt(store, attempt({ attemptId: "att_b", runtimeScopeId: "scope_b" }));
    insertRuleEvaluationRecord(
      store,
      observedEval({ evaluationId: "e_b", attemptId: "att_b", runtimeScopeId: "scope_b", observedRuleHash: h, observedRuleSnapshot: snap("foreign") }),
    );

    expect(resolveObservedSnapshotInScope(store, "scope_a", h)).toEqual({
      kind: "NOT_FOUND",
      runtimeScopeId: "scope_a",
      observedRuleHash: h,
    });
  });
});

// P0.60 honest deny-emission accounting: an admitted deny commits a DECISION_RECORDED row BEFORE it
// emits the response, then advances it to RESPONSE_EMITTED. A crash in that window leaves an honest
// DECISION_RECORDED row (recoverable, never lost). `mla doctor` surfaces how many denies are stuck in
// that window so an operator can see if the hook is recording denials it never managed to emit.
describe("countDenyDecisionsAwaitingEmission (P0.60 honest deny-emission accounting)", () => {
  it("returns 0 on an empty store", () => {
    expect(countDenyDecisionsAwaitingEmission(store)).toBe(0);
  });

  it("counts only DENY attempts still held at DECISION_RECORDED", () => {
    // A deny that crashed after the decision commit but before the emit advance: still awaiting.
    insertToolAttempt(
      store,
      attempt({ attemptId: "att_stuck", aggregateDecision: "DENY", denyEmissionStatus: "DECISION_RECORDED" }),
    );
    // A deny that completed the round trip: NOT awaiting.
    insertToolAttempt(
      store,
      attempt({ attemptId: "att_emitted", aggregateDecision: "DENY", denyEmissionStatus: "DECISION_RECORDED" }),
    );
    advanceDenyEmissionToResponseEmitted(store, "att_emitted");
    // A pass-through attempt: never a deny, never awaiting.
    insertToolAttempt(
      store,
      attempt({ attemptId: "att_pass", aggregateDecision: "NO_DECISION", denyEmissionStatus: "NOT_APPLICABLE" }),
    );
    expect(countDenyDecisionsAwaitingEmission(store)).toBe(1);
  });
});

// A LIVE version-arm parent so a version-arm fail-open evaluation can reference it (the composite FK).
function liveVersion(versionId: string, scope = "scope_a"): LocalRuleVersionRecord {
  return {
    versionId,
    ruleId: "notes-location-v1",
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

// A version-arm evaluation (rule_version_id set; observed snapshot/hash null; canonical hash set).
function versionEval(over: Partial<RuleEvaluationRecord> = {}): RuleEvaluationRecord {
  return {
    evaluationId: "eval_v",
    attemptId: "att_1",
    runtimeScopeId: "scope_a",
    result: "VIOLATION",
    eligibleEnforcement: "DENY",
    effectiveEnforcement: "DENY",
    verdictReasonCode: "FORBIDDEN_PATH_MATCH",
    gateReasonCode: null,
    evaluatorContractVersion: "four-state-evaluator-v1",
    observedRuleSnapshot: null,
    observedRuleHash: null,
    ruleVersionId: "ver_a",
    canonicalPayloadHash: "c".repeat(64),
    createdAt: "2026-06-19T00:00:00.000Z",
    ...over,
  };
}

describe("countFailOpenEnforcementViolations (historical fail-open visibility)", () => {
  it("returns 0 on an empty store", () => {
    expect(countFailOpenEnforcementViolations(store)).toBe(0);
  });

  it("counts only VIOLATIONs whose enforcement degraded to NONE, never denied or observed ones", () => {
    insertLocalRuleVersion(store, liveVersion("ver_a"));

    // (1) A fail-open: a DENY-ceiling violation enforcement could not deny (effective NONE). COUNTED.
    insertToolAttempt(
      store,
      attempt({ attemptId: "att_fo", aggregateDecision: "NO_DECISION", denyEmissionStatus: "NOT_APPLICABLE" }),
    );
    insertRuleEvaluationRecord(
      store,
      versionEval({
        evaluationId: "ev_fo",
        attemptId: "att_fo",
        eligibleEnforcement: "DENY",
        effectiveEnforcement: "NONE",
        gateReasonCode: "RULE_ENFORCEMENT_UNAVAILABLE",
      }),
    );

    // (2) A clean DENY: violation enforced. NOT counted.
    insertToolAttempt(
      store,
      attempt({ attemptId: "att_dn", aggregateDecision: "DENY", denyEmissionStatus: "RESPONSE_EMITTED" }),
    );
    insertRuleEvaluationRecord(
      store,
      versionEval({ evaluationId: "ev_dn", attemptId: "att_dn", effectiveEnforcement: "DENY" }),
    );

    // (3) An observed-arm violation: effective OBSERVE, never a fail-open. NOT counted.
    insertToolAttempt(
      store,
      attempt({ attemptId: "att_ob", aggregateDecision: "NO_DECISION", denyEmissionStatus: "NOT_APPLICABLE" }),
    );
    insertRuleEvaluationRecord(
      store,
      observedEval({ evaluationId: "ev_ob", attemptId: "att_ob", effectiveEnforcement: "OBSERVE" }),
    );

    expect(countFailOpenEnforcementViolations(store)).toBe(1);
  });
});
