import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { openCe0Store, closeCe0Store, type Ce0Store } from "../../../src/lib/rules/ce0-store";
import {
  insertToolAttempt,
  getRuleEvaluationRecord,
  type ToolAttemptRecord,
} from "../../../src/lib/rules/interception-store";
import {
  insertLocalRuleVersion,
  getLocalRuleVersion,
  getLiveLocalRuleVersion,
  listLiveLocalRuleVersions,
  listAllLocalRuleVersionsInScope,
  listLocalRuleVersionHistory,
  supersedeLiveLocalRuleVersion,
  revokeLiveLocalRuleVersion,
  insertVersionEvaluationRecord,
  CrossScopeLineageError,
  NoLiveVersionToSupersedeError,
  NoLiveVersionToRevokeError,
  type LocalRuleVersionRecord,
} from "../../../src/lib/rules/local-rule-version-repo";

// Phase A.4: the LocalRuleVersion repository foundation
// (notes/20260615-rules-as-node-and-action-interception-consolidated-proposal.md §10.1 step 6, the
// LocalRuleVersion type at §3.6). The repo treats rule_payload + canonical_payload_hash as OPAQUE,
// already-validated strings: it never parses the payload and never invents the ObservedRuleV1 ->
// RulePayloadV1 conversion (that is the R1 attest slice). What it owns is the durable envelope: the
// one-LIVE-per-(scope, rule) supersession transaction, FK lineage, scope isolation, and the
// version arm of rule_evaluation_record. It runs against one real ce0 database, no mock store.

let dir: string;
let store: Ce0Store;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "lrv-repo-"));
  store = openCe0Store(path.join(dir, "evidence.db"));
});

afterEach(() => {
  closeCe0Store(store);
  fs.rmSync(dir, { recursive: true, force: true });
});

// A LIVE first version in scope_a for rule_notes_location. payload + hash are opaque to the repo.
function version(over: Partial<LocalRuleVersionRecord> = {}): LocalRuleVersionRecord {
  return {
    versionId: "ver_1",
    ruleId: "rule_notes_location",
    runtimeScopeId: "scope_a",
    rulePayload: '{"text":"keep notes under /notes","runtimeScopeId":"scope_a"}',
    canonicalPayloadHash: "1".repeat(64),
    lifecycleStatus: "LIVE",
    attestationMethod: "HUMAN_DIRECT",
    attestedBy: "operator@example.com",
    supersedesVersionId: null,
    derivedFromObservedHash: "a".repeat(64),
    attestedAt: "2026-06-19T00:00:00.000Z",
    ...over,
  };
}

function attempt(over: Partial<ToolAttemptRecord> = {}): ToolAttemptRecord {
  return {
    attemptId: "att_1",
    runtimeScopeId: "scope_a",
    sessionId: "sess_1",
    toolName: "Write",
    evaluationInputSnapshot: "{}",
    evaluationInputHash: "e".repeat(64),
    aggregateDecision: "NO_DECISION",
    denyEmissionStatus: "NOT_APPLICABLE",
    inputAuthorityConfigHash: null,
    createdAt: "2026-06-19T00:00:00.000Z",
    ...over,
  };
}

describe("insert + read by (version id, scope)", () => {
  it("round-trips every column of a first version", () => {
    const rec = version();
    insertLocalRuleVersion(store, rec);
    expect(getLocalRuleVersion(store, "ver_1", "scope_a")).toEqual(rec);
  });

  it("returns null for an unknown version id", () => {
    expect(getLocalRuleVersion(store, "nope", "scope_a")).toBeNull();
  });

  it("never reads a version that exists only in another scope", () => {
    insertLocalRuleVersion(store, version({ runtimeScopeId: "scope_b" }));
    expect(getLocalRuleVersion(store, "ver_1", "scope_a")).toBeNull();
    expect(getLocalRuleVersion(store, "ver_1", "scope_b")).not.toBeNull();
  });
});

describe("current LIVE by (scope, rule)", () => {
  it("returns the LIVE version, or null when none is LIVE", () => {
    expect(getLiveLocalRuleVersion(store, "scope_a", "rule_notes_location")).toBeNull();
    insertLocalRuleVersion(store, version());
    expect(getLiveLocalRuleVersion(store, "scope_a", "rule_notes_location")?.versionId).toBe("ver_1");
  });

  it("rejects a second LIVE version for the same (scope, rule) [one-LIVE index]", () => {
    insertLocalRuleVersion(store, version({ versionId: "ver_1", canonicalPayloadHash: "1".repeat(64) }));
    expect(() =>
      insertLocalRuleVersion(store, version({ versionId: "ver_2", canonicalPayloadHash: "2".repeat(64) })),
    ).toThrow();
  });
});

describe("all LIVE versions in a scope (the rule-driven dispatch's input)", () => {
  it("returns every LIVE rule in the scope, ordered by ruleId, excluding non-LIVE lifecycles", () => {
    // Three distinct logical rules in scope_a, inserted out of ruleId order to prove the sort.
    insertLocalRuleVersion(
      store,
      version({ ruleId: "rule_secrets", versionId: "ver_s", canonicalPayloadHash: "5".repeat(64) }),
    );
    insertLocalRuleVersion(
      store,
      version({ ruleId: "rule_notes_location", versionId: "ver_n", canonicalPayloadHash: "1".repeat(64) }),
    );
    insertLocalRuleVersion(
      store,
      version({ ruleId: "rule_assets", versionId: "ver_a", canonicalPayloadHash: "3".repeat(64) }),
    );
    // A REVOKED rule in the same scope must NOT appear (no LIVE version).
    insertLocalRuleVersion(
      store,
      version({
        ruleId: "rule_revoked",
        versionId: "ver_r",
        canonicalPayloadHash: "9".repeat(64),
        lifecycleStatus: "REVOKED",
      }),
    );

    const live = listLiveLocalRuleVersions(store, "scope_a");
    expect(live.map((v) => v.ruleId)).toEqual(["rule_assets", "rule_notes_location", "rule_secrets"]);
    expect(live.every((v) => v.lifecycleStatus === "LIVE")).toBe(true);
  });

  it("is scope-isolated: a LIVE rule in another scope is never returned", () => {
    insertLocalRuleVersion(store, version({ runtimeScopeId: "scope_a", versionId: "ver_a", ruleId: "r1" }));
    insertLocalRuleVersion(
      store,
      version({
        runtimeScopeId: "scope_b",
        versionId: "ver_b",
        ruleId: "r1",
        canonicalPayloadHash: "2".repeat(64),
      }),
    );
    const live = listLiveLocalRuleVersions(store, "scope_a");
    expect(live.map((v) => v.versionId)).toEqual(["ver_a"]);
  });

  it("returns an empty array for a scope with no LIVE versions", () => {
    expect(listLiveLocalRuleVersions(store, "scope_empty")).toEqual([]);
  });
});

// The G2 importer's CE0 input: the FULL version history (every lifecycle state, not just LIVE),
// grouped by rule and ordered oldest-first within each rule, so the backend can rebuild the
// supersedes chain in attestation order. A revoked / superseded legacy version must be carried so a
// historical citation still resolves after the cutover.
describe("all versions in a scope (the G2 importer's input)", () => {
  it("returns every lifecycle state, grouped by rule and oldest-first within each rule", () => {
    // rule_notes_location: ver_1 (SUPERSEDED) -> ver_2 (LIVE), attested out of insert order.
    insertLocalRuleVersion(store, version({ versionId: "ver_1", canonicalPayloadHash: "1".repeat(64) }));
    supersedeLiveLocalRuleVersion(
      store,
      version({
        versionId: "ver_2",
        canonicalPayloadHash: "2".repeat(64),
        attestedAt: "2026-06-19T01:00:00.000Z",
      }),
    );
    // A second rule whose only version is REVOKED: it MUST still appear (history, not just LIVE).
    insertLocalRuleVersion(
      store,
      version({
        ruleId: "rule_revoked",
        versionId: "ver_r",
        canonicalPayloadHash: "9".repeat(64),
        lifecycleStatus: "REVOKED",
      }),
    );

    const all = listAllLocalRuleVersionsInScope(store, "scope_a");
    // Ordered by ruleId, then attestedAt, then versionId: the two notes versions oldest-first, then revoked.
    expect(all.map((v) => v.versionId)).toEqual(["ver_1", "ver_2", "ver_r"]);
    expect(all.map((v) => v.lifecycleStatus)).toEqual(["SUPERSEDED", "LIVE", "REVOKED"]);
  });

  it("is scope-isolated and returns an empty array for an unknown scope", () => {
    insertLocalRuleVersion(store, version({ runtimeScopeId: "scope_b", versionId: "ver_b" }));
    expect(listAllLocalRuleVersionsInScope(store, "scope_a")).toEqual([]);
    expect(listAllLocalRuleVersionsInScope(store, "scope_b").map((v) => v.versionId)).toEqual(["ver_b"]);
  });
});

describe("supersede the current LIVE in one transaction", () => {
  it("demotes the prior LIVE to SUPERSEDED and makes the successor the only LIVE, preserving lineage", () => {
    insertLocalRuleVersion(store, version({ versionId: "ver_1", canonicalPayloadHash: "1".repeat(64) }));

    const successor = version({
      versionId: "ver_2",
      canonicalPayloadHash: "2".repeat(64),
      attestedAt: "2026-06-19T01:00:00.000Z",
    });
    const minted = supersedeLiveLocalRuleVersion(store, successor);

    expect(minted.lifecycleStatus).toBe("LIVE");
    expect(minted.supersedesVersionId).toBe("ver_1");
    expect(getLocalRuleVersion(store, "ver_1", "scope_a")?.lifecycleStatus).toBe("SUPERSEDED");
    expect(getLiveLocalRuleVersion(store, "scope_a", "rule_notes_location")?.versionId).toBe("ver_2");
  });

  it("throws NoLiveVersionToSupersedeError when there is no current LIVE", () => {
    expect(() => supersedeLiveLocalRuleVersion(store, version({ versionId: "ver_2" }))).toThrow(
      NoLiveVersionToSupersedeError,
    );
    // The failed transaction left nothing behind.
    expect(listLocalRuleVersionHistory(store, "scope_a", "rule_notes_location")).toEqual([]);
  });

  it("rejects a successor whose supersedesVersionId contradicts the actual prior LIVE", () => {
    insertLocalRuleVersion(store, version({ versionId: "ver_1" }));
    expect(() =>
      supersedeLiveLocalRuleVersion(store, version({ versionId: "ver_2", supersedesVersionId: "ver_999" })),
    ).toThrow();
    // The prior LIVE is untouched after the rejected supersession.
    expect(getLiveLocalRuleVersion(store, "scope_a", "rule_notes_location")?.versionId).toBe("ver_1");
  });
});

// The kill switch (the safety net behind `mla rules revoke`). Revoking flips the current LIVE version
// to REVOKED, which is a transition trg_version_immutable explicitly allows. After a revoke the
// (scope, rule) has NO LIVE version, so getLiveLocalRuleVersion returns null and the enforce seam
// finds NO_LIVE_VERSION and fails open: enforcement stops cleanly. This is the answer to "what's the
// harm" of wiring the deny live: an operator can always disarm a rule in one local, audited write.
describe("revoke the current LIVE (the kill switch)", () => {
  it("flips the current LIVE to REVOKED, leaving no LIVE version for the (scope, rule)", () => {
    insertLocalRuleVersion(store, version({ versionId: "ver_1" }));

    const revoked = revokeLiveLocalRuleVersion(store, "scope_a", "rule_notes_location");

    expect(revoked.versionId).toBe("ver_1");
    expect(revoked.lifecycleStatus).toBe("REVOKED");
    expect(getLocalRuleVersion(store, "ver_1", "scope_a")?.lifecycleStatus).toBe("REVOKED");
    expect(getLiveLocalRuleVersion(store, "scope_a", "rule_notes_location")).toBeNull();
  });

  it("throws NoLiveVersionToRevokeError when there is no current LIVE to disarm", () => {
    expect(() => revokeLiveLocalRuleVersion(store, "scope_a", "rule_notes_location")).toThrow(
      NoLiveVersionToRevokeError,
    );
  });

  it("revokes only the LIVE version, leaving SUPERSEDED history untouched", () => {
    insertLocalRuleVersion(store, version({ versionId: "ver_1", canonicalPayloadHash: "1".repeat(64) }));
    supersedeLiveLocalRuleVersion(
      store,
      version({ versionId: "ver_2", canonicalPayloadHash: "2".repeat(64), attestedAt: "2026-06-19T01:00:00.000Z" }),
    );

    revokeLiveLocalRuleVersion(store, "scope_a", "rule_notes_location");

    expect(getLocalRuleVersion(store, "ver_1", "scope_a")?.lifecycleStatus).toBe("SUPERSEDED");
    expect(getLocalRuleVersion(store, "ver_2", "scope_a")?.lifecycleStatus).toBe("REVOKED");
    expect(getLiveLocalRuleVersion(store, "scope_a", "rule_notes_location")).toBeNull();
  });

  it("never revokes a LIVE version of the same rule in another scope", () => {
    insertLocalRuleVersion(store, version({ runtimeScopeId: "scope_a", versionId: "ver_a" }));
    insertLocalRuleVersion(store, version({ runtimeScopeId: "scope_b", versionId: "ver_b" }));

    revokeLiveLocalRuleVersion(store, "scope_a", "rule_notes_location");

    expect(getLiveLocalRuleVersion(store, "scope_a", "rule_notes_location")).toBeNull();
    expect(getLiveLocalRuleVersion(store, "scope_b", "rule_notes_location")?.versionId).toBe("ver_b");
  });
});

describe("version history", () => {
  it("lists a rule's versions in this scope ordered by attestation time then id", () => {
    insertLocalRuleVersion(store, version({ versionId: "ver_1", canonicalPayloadHash: "1".repeat(64) }));
    supersedeLiveLocalRuleVersion(
      store,
      version({ versionId: "ver_2", canonicalPayloadHash: "2".repeat(64), attestedAt: "2026-06-19T01:00:00.000Z" }),
    );
    const history = listLocalRuleVersionHistory(store, "scope_a", "rule_notes_location");
    expect(history.map((v) => v.versionId)).toEqual(["ver_1", "ver_2"]);
    expect(history.map((v) => v.lifecycleStatus)).toEqual(["SUPERSEDED", "LIVE"]);
  });

  it("never lists a same-rule version from another scope", () => {
    insertLocalRuleVersion(store, version({ runtimeScopeId: "scope_a", versionId: "ver_a" }));
    insertLocalRuleVersion(store, version({ runtimeScopeId: "scope_b", versionId: "ver_b" }));
    expect(listLocalRuleVersionHistory(store, "scope_a", "rule_notes_location").map((v) => v.versionId)).toEqual([
      "ver_a",
    ]);
  });
});

describe("cross-scope lineage is rejected", () => {
  it("refuses to insert a version whose supersedesVersionId lives in another scope", () => {
    insertLocalRuleVersion(store, version({ runtimeScopeId: "scope_b", versionId: "ver_b", lifecycleStatus: "SUPERSEDED" }));
    expect(() =>
      insertLocalRuleVersion(
        store,
        version({ runtimeScopeId: "scope_a", versionId: "ver_a", supersedesVersionId: "ver_b" }),
      ),
    ).toThrow(CrossScopeLineageError);
  });
});

describe("immutable lifecycle (trigger-enforced) the repo relies on", () => {
  it("rejects a direct mutation of an immutable column", () => {
    insertLocalRuleVersion(store, version({ versionId: "ver_1" }));
    expect(() =>
      store.db.prepare(`UPDATE local_rule_version SET rule_payload = '{}' WHERE version_id = 'ver_1'`).run(),
    ).toThrow();
  });

  it("rejects an illegal lifecycle transition (SUPERSEDED back to LIVE)", () => {
    insertLocalRuleVersion(store, version({ versionId: "ver_1", lifecycleStatus: "SUPERSEDED" }));
    expect(() =>
      store.db
        .prepare(`UPDATE local_rule_version SET lifecycle_status = 'LIVE' WHERE version_id = 'ver_1'`)
        .run(),
    ).toThrow();
  });
});

describe("the version arm of rule_evaluation_record", () => {
  it("writes a verdict bound to a LIVE version with the observed arm null", () => {
    insertLocalRuleVersion(store, version({ versionId: "ver_1", canonicalPayloadHash: "1".repeat(64) }));
    insertToolAttempt(store, attempt());

    insertVersionEvaluationRecord(store, {
      evaluationId: "eval_v",
      attemptId: "att_1",
      runtimeScopeId: "scope_a",
      result: "VIOLATION",
      eligibleEnforcement: "DENY",
      effectiveEnforcement: "DENY",
      verdictReasonCode: "FORBIDDEN_PATH_MATCH",
      gateReasonCode: null,
      evaluatorContractVersion: "four-state-evaluator-v1",
      ruleVersionId: "ver_1",
      canonicalPayloadHash: "1".repeat(64),
      createdAt: "2026-06-19T00:00:00.000Z",
    });

    const got = getRuleEvaluationRecord(store, "eval_v");
    expect(got?.ruleVersionId).toBe("ver_1");
    expect(got?.canonicalPayloadHash).toBe("1".repeat(64));
    expect(got?.observedRuleHash).toBeNull();
    expect(got?.observedRuleSnapshot).toBeNull();
  });

  it("rejects a version-arm verdict that references a version in another scope", () => {
    insertLocalRuleVersion(store, version({ runtimeScopeId: "scope_b", versionId: "ver_b" }));
    insertToolAttempt(store, attempt({ runtimeScopeId: "scope_a" }));
    expect(() =>
      insertVersionEvaluationRecord(store, {
        evaluationId: "eval_x",
        attemptId: "att_1",
        runtimeScopeId: "scope_a",
        result: "VIOLATION",
        eligibleEnforcement: "DENY",
        effectiveEnforcement: "DENY",
        verdictReasonCode: "FORBIDDEN_PATH_MATCH",
        gateReasonCode: null,
        evaluatorContractVersion: "four-state-evaluator-v1",
        ruleVersionId: "ver_b",
        canonicalPayloadHash: "1".repeat(64),
        createdAt: "2026-06-19T00:00:00.000Z",
      }),
    ).toThrow();
  });
});
