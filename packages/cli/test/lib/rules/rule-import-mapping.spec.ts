import {
  ce0VersionsToImportRules,
  managedRuleSourceVersionId,
  managedRuleToRulePayload,
  managedRulesToImportRules,
} from "../../../src/lib/rules/rule-import-mapping";
import { ruleVersionHash } from "../../../src/lib/rules/rule-version-hash";
import { parseApplicability } from "../../../src/lib/rules/applicability";
import { makeManagedRule } from "../../../src/lib/scanner/managed-rules";
import type { LocalRuleVersionRecord } from "../../../src/lib/rules/local-rule-version-repo";
import type { TurnTrigger } from "../../../src/lib/rules/types";

// The pure G2 mapping from the two legacy local stores (managed `.meetless/rules.md` conventions and
// CE0 `local_rule_version` enforcement history) into the unified backend importer's contract. No I/O,
// no clock: every timestamp is injected, so the same input always maps to byte-identical output.

const SCOPE = "scope_a";

// A CE0 row builder. payload + hash are opaque to the repo; here we put a real JSON payload so the
// mapper's JSON.parse round-trips and a non-JSON payload can be exercised separately.
function row(over: Partial<LocalRuleVersionRecord> = {}): LocalRuleVersionRecord {
  return {
    versionId: "ver_1",
    ruleId: "rule_notes_location",
    runtimeScopeId: SCOPE,
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

describe("managedRuleToRulePayload (triple-safe, never enforces)", () => {
  it("emits exactly the closed RulePayloadV1 key set so ruleVersionHash accepts it", () => {
    const managed = makeManagedRule({ statement: "include a Mermaid diagram in design docs", strength: "MUST_FOLLOW" });
    const payload = managedRuleToRulePayload(managed, SCOPE);

    expect(payload).toEqual({
      text: "include a Mermaid diagram in design docs",
      applicability: { mode: "ambient" },
      compliance: {
        evaluatorContractVersion: "none",
        matcherSchemaVersion: "none",
        pathCanonicalizerVersion: "none",
        config: { forbiddenRootRelativePath: "" },
      },
      effect: "REQUIRE",
      strength: "MUST_FOLLOW",
      deliveryChannels: ["runtimeInject"],
      enforcementCeiling: "OBSERVE",
      infrastructureFailurePolicy: "PASS_WITH_ALERT",
      runtimeScopeId: SCOPE,
      payloadSchemaVersion: "rule-payload-v1",
      canonicalSerializationVersion: "v1",
    });
    // The strongest proof the key set is exactly right: the strict hash (which rejects unknown keys
    // at every nesting level) computes a 64-hex digest rather than throwing.
    expect(ruleVersionHash(payload)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("carries the managed rule's strength and is never action-scoped (cannot match a tool)", () => {
    const should = managedRuleToRulePayload(makeManagedRule({ statement: "prefer small PRs" }), SCOPE);
    expect(should.strength).toBe("SHOULD_FOLLOW");
    expect(should.applicability.mode).toBe("ambient");
    expect(should.enforcementCeiling).toBe("OBSERVE");
  });
});

describe("managedRuleToRulePayload turn variant (targeted-rule-injection §5.3)", () => {
  const managed = makeManagedRule({ statement: "cite the canonical privacy doc first", strength: "MUST_FOLLOW" });
  const trigger: TurnTrigger = { promptAny: ["privacy", "ACL"], explicitPathAny: ["notes/**/*.md"] };

  it("swaps ONLY applicability to {mode:turn, trigger}; every triple-safe field is unchanged", () => {
    const ambient = managedRuleToRulePayload(managed, SCOPE);
    const turn = managedRuleToRulePayload(managed, SCOPE, trigger);

    expect(turn.applicability).toEqual({ mode: "turn", trigger });
    // The rule stays exactly as incapable of asking or denying as its ambient twin: prove it by
    // comparing every field EXCEPT applicability against the ambient payload.
    expect({ ...turn, applicability: undefined }).toEqual({ ...ambient, applicability: undefined });
    expect(turn.deliveryChannels).toEqual(["runtimeInject"]);
    expect(turn.enforcementCeiling).toBe("OBSERVE");
    expect(turn.compliance.evaluatorContractVersion).toBe("none");
  });

  it("mints a payload the strict hash accepts, and the applicability round-trips through the parser", () => {
    const turn = managedRuleToRulePayload(managed, SCOPE, trigger);
    expect(ruleVersionHash(turn)).toMatch(/^[0-9a-f]{64}$/);

    const parsed = parseApplicability(turn.applicability);
    expect(parsed.status).toBe("OK");
    expect(parsed.applicability).toEqual({ mode: "turn", trigger });
  });

  it("treats the trigger lists as SETS: reorder and dupes mint the same rule identity", () => {
    const base = managedRuleToRulePayload(managed, SCOPE, {
      promptAny: ["privacy", "ACL"],
      explicitPathAny: ["notes/**/*.md"],
    });
    const shuffled = managedRuleToRulePayload(managed, SCOPE, {
      promptAny: ["ACL", "privacy", "ACL"],
      explicitPathAny: ["notes/**/*.md", "notes/**/*.md"],
    });
    expect(ruleVersionHash(shuffled)).toBe(ruleVersionHash(base));
  });

  it("omitting the trigger is byte-identical to the historical ambient payload (no regression)", () => {
    expect(managedRuleToRulePayload(managed, SCOPE, undefined)).toEqual(managedRuleToRulePayload(managed, SCOPE));
    expect(ruleVersionHash(managedRuleToRulePayload(managed, SCOPE, undefined))).toBe(
      ruleVersionHash(managedRuleToRulePayload(managed, SCOPE)),
    );
  });
});

describe("managedRulesToImportRules", () => {
  it("maps each managed rule to a one-version ACTIVE TEAM rule (no owner, no project)", () => {
    const managed = makeManagedRule({ statement: "keep notes under /notes", strength: "MUST_FOLLOW" });
    const [imported] = managedRulesToImportRules([managed], {
      runtimeScopeId: SCOPE,
      attestedAt: "2026-06-20T00:00:00.000Z",
    });

    expect(imported.sourceRuleId).toBe(managed.id);
    expect(imported.authorityScope).toBe("TEAM");
    expect(imported.ownerUserId).toBeNull();
    expect(imported.projectId).toBeNull();
    expect(imported.lifecycleStatus).toBe("ACTIVE");
    expect(imported.currentSourceVersionId).toBe(managedRuleSourceVersionId(managed.id));
    expect(imported.versions).toHaveLength(1);

    const [v] = imported.versions;
    expect(v.sourceVersionId).toBe(`mr-v1-${managed.id}`);
    expect(v.attestedByUserId).toBeNull();
    expect(v.attestedAt).toBe("2026-06-20T00:00:00.000Z");
    expect(v.canonicalPayloadHash).toBe(ruleVersionHash(managedRuleToRulePayload(managed, SCOPE)));
    expect(v.payload).toEqual(managedRuleToRulePayload(managed, SCOPE));
  });

  it("is deterministic: the same rule maps to byte-identical output across calls", () => {
    const managed = makeManagedRule({ statement: "no em dashes anywhere" });
    const a = managedRulesToImportRules([managed], { runtimeScopeId: SCOPE, attestedAt: "2026-06-20T00:00:00.000Z" });
    const b = managedRulesToImportRules([managed], { runtimeScopeId: SCOPE, attestedAt: "2026-06-20T00:00:00.000Z" });
    expect(a).toEqual(b);
  });

  it("returns an empty batch for no managed rules", () => {
    expect(managedRulesToImportRules([], { runtimeScopeId: SCOPE, attestedAt: "2026-06-20T00:00:00.000Z" })).toEqual([]);
  });
});

describe("ce0VersionsToImportRules", () => {
  it("groups by ruleId, orders oldest-first, and points current at the LIVE version", () => {
    const rows = [
      // Deliberately out of attestation order to prove the sort.
      row({ versionId: "ver_2", canonicalPayloadHash: "2".repeat(64), lifecycleStatus: "LIVE", attestedAt: "2026-06-19T01:00:00.000Z" }),
      row({ versionId: "ver_1", canonicalPayloadHash: "1".repeat(64), lifecycleStatus: "SUPERSEDED", attestedAt: "2026-06-19T00:00:00.000Z" }),
    ];
    const [imported] = ce0VersionsToImportRules(rows);

    expect(imported.sourceRuleId).toBe("rule_notes_location");
    expect(imported.authorityScope).toBe("PERSONAL");
    expect(imported.ownerUserId).toBe("operator@example.com");
    expect(imported.projectId).toBeNull();
    expect(imported.lifecycleStatus).toBe("ACTIVE");
    expect(imported.currentSourceVersionId).toBe("ver_2");
    // Oldest-first so the backend rebuilds the supersedes chain in attestation order.
    expect(imported.versions.map((v) => v.sourceVersionId)).toEqual(["ver_1", "ver_2"]);
    // Hashes and the parsed payload are carried verbatim.
    expect(imported.versions[0].canonicalPayloadHash).toBe("1".repeat(64));
    expect(imported.versions[1].payload).toEqual({ text: "keep notes under /notes", runtimeScopeId: "scope_a" });
    expect(imported.versions[0].attestedByUserId).toBe("operator@example.com");
  });

  it("maps a rule with no LIVE version to a REVOKED node with a null current pointer", () => {
    const rows = [
      row({ versionId: "ver_1", lifecycleStatus: "SUPERSEDED", attestedAt: "2026-06-19T00:00:00.000Z" }),
      row({ versionId: "ver_2", canonicalPayloadHash: "2".repeat(64), lifecycleStatus: "REVOKED", attestedAt: "2026-06-19T01:00:00.000Z" }),
    ];
    const [imported] = ce0VersionsToImportRules(rows);

    expect(imported.lifecycleStatus).toBe("REVOKED");
    expect(imported.currentSourceVersionId).toBeNull();
    // The history is still imported so a revoked legacy citation resolves after the cutover.
    expect(imported.versions.map((v) => v.sourceVersionId)).toEqual(["ver_1", "ver_2"]);
  });

  it("keeps distinct rules separate and owns each by its oldest version's attestor", () => {
    const rows = [
      row({ ruleId: "rule_b", versionId: "vb", canonicalPayloadHash: "b".repeat(64), attestedBy: "bob@example.com" }),
      row({ ruleId: "rule_a", versionId: "va", canonicalPayloadHash: "c".repeat(64), attestedBy: "alice@example.com" }),
    ];
    const imported = ce0VersionsToImportRules(rows);
    const byId = Object.fromEntries(imported.map((r) => [r.sourceRuleId, r]));
    expect(byId["rule_a"].ownerUserId).toBe("alice@example.com");
    expect(byId["rule_b"].ownerUserId).toBe("bob@example.com");
  });

  it("returns an empty batch for no rows", () => {
    expect(ce0VersionsToImportRules([])).toEqual([]);
  });

  it("throws on an unparseable rule payload rather than silently dropping a legacy rule", () => {
    expect(() => ce0VersionsToImportRules([row({ rulePayload: "{not json" })])).toThrow(/unparseable rule_payload/);
  });
});
