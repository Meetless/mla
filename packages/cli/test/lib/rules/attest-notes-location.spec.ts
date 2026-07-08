import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { openCe0Store, closeCe0Store, type Ce0Store } from "../../../src/lib/rules/ce0-store";
import {
  NOTES_LOCATION_RULE_ID,
  convertNotesLocationSnapshot,
  mintAttestedNotesLocationVersion,
} from "../../../src/lib/rules/attest-notes-location";
import {
  getLiveLocalRuleVersion,
  listLocalRuleVersionHistory,
} from "../../../src/lib/rules/local-rule-version-repo";
import { observedRuleHash, serializeObservedRule } from "../../../src/lib/rules/observed-rule-hash";
import { ruleVersionHash, serializeRuleVersion } from "../../../src/lib/rules/rule-version-hash";
import { ObservedRuleSpec } from "../../../src/lib/rules/types";

// Slice 7 (Phase B.7): the ObservedRuleSpec -> RulePayloadV1 conversion + the §2.4 pilot admission
// gate + the mint-or-supersede orchestration behind `mla rules attest --from-observed <hash>`
// (proposal §2.4 conversion table lines 921-945, the admission gate lines 2076-2085, the worked
// attest flow lines 2037-2069). The conversion is a PURE function of the four observed fields plus
// the active runtime scope; the mint runs against one real ce0 database (no mock store), and the
// version envelope (lifecycle, lineage, attestation stamps) is owned by the A.4 repo.

const PILOT_SCOPE = "/work/meetless";
// The exact slice-6 golden for the pilot payload in scope /work/meetless (rule-version-v1-corpus.json,
// label notes-location-pilot-deny). The conversion of the pilot OBSERVED snapshot MUST reproduce it.
const PILOT_GOLDEN_HASH = "fd308638e6132f94d1f61c1b5769cda7c4f886331a92ed79a4bec0f4e4a7b665";

const PILOT_TEXT =
  "Notes and design docs MUST go in the standalone vault, never the repo notes directory.";

/** The exact normalized observed-rule-v1 snapshot R0 freezes for the notes-location pilot. */
function pilotObservedSpec(over: Partial<ObservedRuleSpec> = {}): ObservedRuleSpec {
  return {
    text: PILOT_TEXT,
    applicability: { mode: "action", tools: ["Write", "Edit"], matcher: { field: "file_path", glob: "*.md" } },
    effect: "PROHIBIT",
    forbiddenRootRelativePath: "notes",
    ...over,
  };
}

/** The canonical JSON string the A.3 resolver hands the attest caller. */
function pilotSnapshot(over: Partial<ObservedRuleSpec> = {}): string {
  return serializeObservedRule(pilotObservedSpec(over));
}

describe("convertNotesLocationSnapshot admits the pilot snapshot and reproduces the §2.4 payload", () => {
  it("admits the exact pilot snapshot and the payload reproduces the slice-6 golden hash", () => {
    const result = convertNotesLocationSnapshot(pilotSnapshot(), PILOT_SCOPE);
    expect(result.admitted).toBe(true);
    if (!result.admitted) return;
    // Cross-slice anchor: the conversion of the OBSERVED pilot hashes to the slice-6 golden VERSION hash.
    expect(ruleVersionHash(result.payload)).toBe(PILOT_GOLDEN_HASH);
  });

  it("fixes every non-observed field exactly per the §2.4 conversion table", () => {
    const result = convertNotesLocationSnapshot(pilotSnapshot(), PILOT_SCOPE);
    expect(result.admitted).toBe(true);
    if (!result.admitted) return;
    const p = result.payload;
    expect(p.text).toBe(PILOT_TEXT); // verbatim
    expect(p.rationale).toBeUndefined(); // omitted (observed spec carries none)
    expect(p.applicability).toEqual({
      mode: "action",
      tools: ["Edit", "Write"], // verbatim from the stored snapshot (serializeObservedRule sorts the SET)
      matcher: { field: "file_path", glob: "*.md" },
    });
    expect(p.effect).toBe("PROHIBIT");
    expect(p.strength).toBe("MUST_FOLLOW"); // fixed, descriptive only
    expect(p.deliveryChannels).toEqual(["preToolUse"]); // fixed
    expect(p.enforcementCeiling).toBe("DENY"); // fixed ceiling the human attests
    expect(p.infrastructureFailurePolicy).toBe("PASS_WITH_ALERT"); // v1-locked
    expect(p.runtimeScopeId).toBe(PILOT_SCOPE); // runtime binding from the argument
    expect(p.compliance).toEqual({
      evaluatorContractVersion: "four-state-evaluator-v1",
      matcherSchemaVersion: "action-applicability-v1",
      pathCanonicalizerVersion: "notes-path-v1",
      config: { forbiddenRootRelativePath: "notes" }, // the IMMUTABLE forbidden root AS CONTENT (P0.63)
    });
    expect(p.payloadSchemaVersion).toBe("rule-payload-v1");
    expect(p.canonicalSerializationVersion).toBe("v1");
  });

  it("binds runtimeScopeId from the argument (the same observed rule in another scope is a different payload)", () => {
    const here = convertNotesLocationSnapshot(pilotSnapshot(), PILOT_SCOPE);
    const there = convertNotesLocationSnapshot(pilotSnapshot(), "/work/other-checkout");
    expect(here.admitted && there.admitted).toBe(true);
    if (!here.admitted || !there.admitted) return;
    expect(there.payload.runtimeScopeId).toBe("/work/other-checkout");
    expect(ruleVersionHash(there.payload)).not.toBe(ruleVersionHash(here.payload));
  });

  it("admits regardless of tool order or duplicates (tools is a SET)", () => {
    const result = convertNotesLocationSnapshot(
      pilotSnapshot({ applicability: { mode: "action", tools: ["Edit", "Write", "Edit"], matcher: { field: "file_path", glob: "*.md" } } }),
      PILOT_SCOPE,
    );
    expect(result.admitted).toBe(true);
    if (!result.admitted) return;
    expect(ruleVersionHash(result.payload)).toBe(PILOT_GOLDEN_HASH);
  });
});

describe("convertNotesLocationSnapshot REFUSES anything the single pilot cannot enforce (§2.4 gate)", () => {
  it("rejects an ambient rule (not action-scoped)", () => {
    const snapshot = serializeObservedRule({
      text: PILOT_TEXT,
      applicability: { mode: "ambient" },
      effect: "PROHIBIT",
      forbiddenRootRelativePath: "notes",
    });
    const result = convertNotesLocationSnapshot(snapshot, PILOT_SCOPE);
    expect(result.admitted).toBe(false);
    if (result.admitted) return;
    expect(result.reason).toBe("NOT_ACTION_SCOPED");
  });

  it("rejects a tools set that is not exactly {Write, Edit}", () => {
    const tooFew = convertNotesLocationSnapshot(
      pilotSnapshot({ applicability: { mode: "action", tools: ["Write"], matcher: { field: "file_path", glob: "*.md" } } }),
      PILOT_SCOPE,
    );
    const tooMany = convertNotesLocationSnapshot(
      pilotSnapshot({ applicability: { mode: "action", tools: ["Write", "Edit", "Read"], matcher: { field: "file_path", glob: "*.md" } } }),
      PILOT_SCOPE,
    );
    expect(tooFew.admitted).toBe(false);
    expect(tooMany.admitted).toBe(false);
    if (!tooFew.admitted) expect(tooFew.reason).toBe("TOOLS_NOT_WRITE_EDIT");
    if (!tooMany.admitted) expect(tooMany.reason).toBe("TOOLS_NOT_WRITE_EDIT");
  });

  it("rejects an effect other than PROHIBIT", () => {
    const result = convertNotesLocationSnapshot(pilotSnapshot({ effect: "REQUIRE" }), PILOT_SCOPE);
    expect(result.admitted).toBe(false);
    if (result.admitted) return;
    expect(result.reason).toBe("EFFECT_NOT_PROHIBIT");
  });

  it("rejects a forbidden root other than 'notes'", () => {
    const result = convertNotesLocationSnapshot(
      pilotSnapshot({ forbiddenRootRelativePath: "secrets" }),
      PILOT_SCOPE,
    );
    expect(result.admitted).toBe(false);
    if (result.admitted) return;
    expect(result.reason).toBe("FORBIDDEN_ROOT_UNSUPPORTED");
  });

  it("rejects an out-of-schema top-level field (the observed-rule-v1 schema is closed, fail closed)", () => {
    const snapshot =
      '{"text":"x","applicability":{"mode":"action","tools":["Edit","Write"],"matcher":{"field":"file_path","glob":"*.md"}},"effect":"PROHIBIT","forbiddenRootRelativePath":"notes","surprise":1}';
    const result = convertNotesLocationSnapshot(snapshot, PILOT_SCOPE);
    expect(result.admitted).toBe(false);
    if (result.admitted) return;
    expect(result.reason).toBe("UNKNOWN_FIELD");
  });

  it("rejects an unsupported matcher (a key outside the field/glob matcher)", () => {
    const snapshot =
      '{"text":"x","applicability":{"mode":"action","tools":["Edit","Write"],"matcher":{"field":"file_path","regex":"x"}},"effect":"PROHIBIT","forbiddenRootRelativePath":"notes"}';
    const result = convertNotesLocationSnapshot(snapshot, PILOT_SCOPE);
    expect(result.admitted).toBe(false);
    if (result.admitted) return;
    expect(result.reason).toBe("UNKNOWN_FIELD");
  });

  it("rejects an unparseable snapshot", () => {
    const result = convertNotesLocationSnapshot("not json{", PILOT_SCOPE);
    expect(result.admitted).toBe(false);
    if (result.admitted) return;
    expect(result.reason).toBe("SNAPSHOT_UNPARSEABLE");
  });
});

describe("mintAttestedNotesLocationVersion writes the LIVE version (real ce0 store)", () => {
  let dir: string;
  let store: Ce0Store;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "attest-notes-"));
    store = openCe0Store(path.join(dir, "evidence.db"));
  });

  afterEach(() => {
    closeCe0Store(store);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function admittedPilotPayload(over: Partial<ObservedRuleSpec> = {}) {
    const result = convertNotesLocationSnapshot(pilotSnapshot(over), PILOT_SCOPE);
    if (!result.admitted) throw new Error("fixture must be admitted");
    return result.payload;
  }

  it("mints the FIRST version in scope as LIVE with no predecessor", () => {
    const payload = admittedPilotPayload();
    const outcome = mintAttestedNotesLocationVersion(store, {
      payload,
      observedRuleHash: observedRuleHash(pilotObservedSpec()),
      attestedBy: "user_an",
      attestationMethod: "HUMAN_DIRECT",
      versionId: "ver_first",
      attestedAt: "2026-06-19T00:00:00.000Z",
    });
    expect(outcome.outcome).toBe("MINTED");
    const live = getLiveLocalRuleVersion(store, PILOT_SCOPE, NOTES_LOCATION_RULE_ID);
    expect(live).not.toBeNull();
    expect(live?.versionId).toBe("ver_first");
    expect(live?.ruleId).toBe(NOTES_LOCATION_RULE_ID);
    expect(live?.lifecycleStatus).toBe("LIVE");
    expect(live?.supersedesVersionId).toBeNull();
    expect(live?.derivedFromObservedHash).toBe(observedRuleHash(pilotObservedSpec()));
    expect(live?.attestedBy).toBe("user_an");
    expect(live?.attestationMethod).toBe("HUMAN_DIRECT");
    // The stored payload + hash are exactly the rule-version-v1 serialization + digest.
    expect(live?.rulePayload).toBe(serializeRuleVersion(payload));
    expect(live?.canonicalPayloadHash).toBe(ruleVersionHash(payload));
  });

  it("is idempotent: re-attesting the identical payload is a no-op (one row, same version)", () => {
    const payload = admittedPilotPayload();
    const first = mintAttestedNotesLocationVersion(store, {
      payload,
      observedRuleHash: observedRuleHash(pilotObservedSpec()),
      attestedBy: "user_an",
      attestationMethod: "HUMAN_DIRECT",
      versionId: "ver_first",
      attestedAt: "2026-06-19T00:00:00.000Z",
    });
    expect(first.outcome).toBe("MINTED");
    const second = mintAttestedNotesLocationVersion(store, {
      payload,
      observedRuleHash: observedRuleHash(pilotObservedSpec()),
      attestedBy: "user_an",
      attestationMethod: "HUMAN_DIRECT",
      versionId: "ver_second_should_not_be_used",
      attestedAt: "2026-06-19T01:00:00.000Z",
    });
    expect(second.outcome).toBe("NOOP_IDEMPOTENT");
    expect(second.version.versionId).toBe("ver_first");
    expect(listLocalRuleVersionHistory(store, PILOT_SCOPE, NOTES_LOCATION_RULE_ID)).toHaveLength(1);
  });

  it("supersedes the prior LIVE version when the payload changes (exactly one LIVE, lineage set)", () => {
    const v1 = admittedPilotPayload();
    mintAttestedNotesLocationVersion(store, {
      payload: v1,
      observedRuleHash: observedRuleHash(pilotObservedSpec()),
      attestedBy: "user_an",
      attestationMethod: "HUMAN_DIRECT",
      versionId: "ver_first",
      attestedAt: "2026-06-19T00:00:00.000Z",
    });
    // A new observed snapshot (edited prose) produces a different payload + hash.
    const editedSpec = pilotObservedSpec({ text: PILOT_TEXT + " (revised)" });
    const v2result = convertNotesLocationSnapshot(serializeObservedRule(editedSpec), PILOT_SCOPE);
    expect(v2result.admitted).toBe(true);
    if (!v2result.admitted) return;
    const outcome = mintAttestedNotesLocationVersion(store, {
      payload: v2result.payload,
      observedRuleHash: observedRuleHash(editedSpec),
      attestedBy: "user_an",
      attestationMethod: "AGENT_ON_USER_REQUEST",
      versionId: "ver_second",
      attestedAt: "2026-06-19T02:00:00.000Z",
    });
    expect(outcome.outcome).toBe("SUPERSEDED");
    if (outcome.outcome === "SUPERSEDED") {
      expect(outcome.supersededVersionId).toBe("ver_first");
    }
    const live = getLiveLocalRuleVersion(store, PILOT_SCOPE, NOTES_LOCATION_RULE_ID);
    expect(live?.versionId).toBe("ver_second");
    expect(live?.supersedesVersionId).toBe("ver_first");
    const history = listLocalRuleVersionHistory(store, PILOT_SCOPE, NOTES_LOCATION_RULE_ID);
    expect(history).toHaveLength(2);
    expect(history.filter((v) => v.lifecycleStatus === "LIVE")).toHaveLength(1);
  });
});
