import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { openCe0Store, closeCe0Store, type Ce0Store } from "../../../src/lib/rules/ce0-store";
import { convertNotesLocationSnapshot } from "../../../src/lib/rules/attest-notes-location";
import {
  mintAttestedRuleVersion,
  RuleIdentityCollisionError,
} from "../../../src/lib/rules/attest-rule-version";
import {
  getLiveLocalRuleVersion,
  listLocalRuleVersionHistory,
  NoLiveVersionToSupersedeError,
} from "../../../src/lib/rules/local-rule-version-repo";
import { serializeObservedRule } from "../../../src/lib/rules/observed-rule-hash";
import { RulePayloadV1 } from "../../../src/lib/rules/types";

// The canonical R1 attest writer (proposal §2.4 INV-ATTEST-CHOOSES-LOGICAL-IDENTITY, P0.55). Unlike
// the notes-location pilot adapter, the logical identity is CHOSEN by the operator, never hardcoded
// and never inferred from a rule file's presence (INV-PRESENCE-IS-NOT-ATTESTATION, P0.3):
//   --new-rule  mints a fresh ruleId, supersedes nothing, and is REJECTED on an accidental id
//               collision rather than silently versioning the wrong rule;
//   --rule <id> declares the candidate a SUCCESSOR of an existing logical rule: ruleId = <id>,
//               supersedesVersionId = priorLiveVersionId (lineage points backward, new -> old).
// The writer runs against one real ce0 database (no mock store), and the version envelope
// (lifecycle, lineage, attestation stamps, one-LIVE-per-(scope, rule)) is owned by the A.4 repo.

const SCOPE = "/work/canon";

/** A valid, admitted RulePayloadV1 for an arbitrary prose text (the converter is just a payload factory
 * here; the writer treats the payload as opaque except for its runtimeScopeId and its digest). */
function payloadFor(text: string): RulePayloadV1 {
  const snapshot = serializeObservedRule({
    text,
    applicability: { mode: "action", tools: ["Write", "Edit"], matcher: { field: "file_path", glob: "*.md" } },
    effect: "PROHIBIT",
    forbiddenRootRelativePath: "notes",
  });
  const conversion = convertNotesLocationSnapshot(snapshot, SCOPE);
  if (!conversion.admitted) throw new Error("fixture must be admitted");
  return conversion.payload;
}

describe("mintAttestedRuleVersion chooses the logical identity (canonical R1 writer)", () => {
  let dir: string;
  let store: Ce0Store;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "attest-rule-"));
    store = openCe0Store(path.join(dir, "evidence.db"));
  });

  afterEach(() => {
    closeCe0Store(store);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("--new-rule mints a fresh logical rule as LIVE with no predecessor", () => {
    const outcome = mintAttestedRuleVersion(store, {
      identity: { mode: "NEW_RULE", ruleId: "rule-alpha" },
      payload: payloadFor("alpha rule text"),
      observedRuleHash: "obs_alpha",
      attestedBy: "user_an",
      attestationMethod: "HUMAN_DIRECT",
      versionId: "ver_a1",
      attestedAt: "2026-06-19T00:00:00.000Z",
    });

    expect(outcome.outcome).toBe("MINTED");
    const live = getLiveLocalRuleVersion(store, SCOPE, "rule-alpha");
    expect(live?.versionId).toBe("ver_a1");
    expect(live?.ruleId).toBe("rule-alpha");
    expect(live?.lifecycleStatus).toBe("LIVE");
    expect(live?.supersedesVersionId).toBeNull();
    expect(live?.derivedFromObservedHash).toBe("obs_alpha");
  });

  it("--new-rule rejects an accidental id collision and writes nothing", () => {
    mintAttestedRuleVersion(store, {
      identity: { mode: "NEW_RULE", ruleId: "rule-alpha" },
      payload: payloadFor("alpha rule text"),
      observedRuleHash: "obs_alpha",
      attestedBy: "user_an",
      attestationMethod: "HUMAN_DIRECT",
      versionId: "ver_a1",
      attestedAt: "2026-06-19T00:00:00.000Z",
    });

    expect(() =>
      mintAttestedRuleVersion(store, {
        identity: { mode: "NEW_RULE", ruleId: "rule-alpha" },
        payload: payloadFor("a different rule entirely"),
        observedRuleHash: "obs_other",
        attestedBy: "user_an",
        attestationMethod: "HUMAN_DIRECT",
        versionId: "ver_a2",
        attestedAt: "2026-06-19T01:00:00.000Z",
      }),
    ).toThrow(RuleIdentityCollisionError);

    // The collision left the original sole version untouched; nothing was versioned over it.
    const history = listLocalRuleVersionHistory(store, SCOPE, "rule-alpha");
    expect(history).toHaveLength(1);
    expect(history[0].versionId).toBe("ver_a1");
  });

  it("--rule <id> supersedes the prior LIVE of the named rule with backward lineage (exactly one LIVE)", () => {
    mintAttestedRuleVersion(store, {
      identity: { mode: "NEW_RULE", ruleId: "rule-beta" },
      payload: payloadFor("beta v1"),
      observedRuleHash: "obs_beta_1",
      attestedBy: "user_an",
      attestationMethod: "HUMAN_DIRECT",
      versionId: "ver_b1",
      attestedAt: "2026-06-19T00:00:00.000Z",
    });

    const outcome = mintAttestedRuleVersion(store, {
      identity: { mode: "SUCCESSOR", ruleId: "rule-beta" },
      payload: payloadFor("beta v2 revised"),
      observedRuleHash: "obs_beta_2",
      attestedBy: "user_an",
      attestationMethod: "AGENT_ON_USER_REQUEST",
      versionId: "ver_b2",
      attestedAt: "2026-06-19T02:00:00.000Z",
    });

    expect(outcome.outcome).toBe("SUPERSEDED");
    if (outcome.outcome === "SUPERSEDED") {
      expect(outcome.supersededVersionId).toBe("ver_b1");
    }
    const live = getLiveLocalRuleVersion(store, SCOPE, "rule-beta");
    expect(live?.versionId).toBe("ver_b2");
    expect(live?.supersedesVersionId).toBe("ver_b1");
    const history = listLocalRuleVersionHistory(store, SCOPE, "rule-beta");
    expect(history).toHaveLength(2);
    expect(history.filter((v) => v.lifecycleStatus === "LIVE")).toHaveLength(1);
  });

  it("--rule <id> is idempotent when the payload hash is unchanged (no new row)", () => {
    const payload = payloadFor("gamma stable");
    mintAttestedRuleVersion(store, {
      identity: { mode: "NEW_RULE", ruleId: "rule-gamma" },
      payload,
      observedRuleHash: "obs_gamma",
      attestedBy: "user_an",
      attestationMethod: "HUMAN_DIRECT",
      versionId: "ver_g1",
      attestedAt: "2026-06-19T00:00:00.000Z",
    });

    const again = mintAttestedRuleVersion(store, {
      identity: { mode: "SUCCESSOR", ruleId: "rule-gamma" },
      payload,
      observedRuleHash: "obs_gamma",
      attestedBy: "user_an",
      attestationMethod: "HUMAN_DIRECT",
      versionId: "ver_g2_unused",
      attestedAt: "2026-06-19T03:00:00.000Z",
    });

    expect(again.outcome).toBe("NOOP_IDEMPOTENT");
    expect(again.version.versionId).toBe("ver_g1");
    expect(listLocalRuleVersionHistory(store, SCOPE, "rule-gamma")).toHaveLength(1);
  });

  it("--rule <id> of a rule with no LIVE version is refused (cannot succeed nothing)", () => {
    expect(() =>
      mintAttestedRuleVersion(store, {
        identity: { mode: "SUCCESSOR", ruleId: "rule-missing" },
        payload: payloadFor("orphan successor"),
        observedRuleHash: "obs_missing",
        attestedBy: "user_an",
        attestationMethod: "HUMAN_DIRECT",
        versionId: "ver_x",
        attestedAt: "2026-06-19T00:00:00.000Z",
      }),
    ).toThrow(NoLiveVersionToSupersedeError);
    expect(listLocalRuleVersionHistory(store, SCOPE, "rule-missing")).toHaveLength(0);
  });

  it("chooses identity independently of the payload (same payload, two distinct NEW rules)", () => {
    const payload = payloadFor("shared payload content");
    mintAttestedRuleVersion(store, {
      identity: { mode: "NEW_RULE", ruleId: "rule-one" },
      payload,
      observedRuleHash: "obs_shared",
      attestedBy: "user_an",
      attestationMethod: "HUMAN_DIRECT",
      versionId: "ver_one",
      attestedAt: "2026-06-19T00:00:00.000Z",
    });
    mintAttestedRuleVersion(store, {
      identity: { mode: "NEW_RULE", ruleId: "rule-two" },
      payload,
      observedRuleHash: "obs_shared",
      attestedBy: "user_an",
      attestationMethod: "HUMAN_DIRECT",
      versionId: "ver_two",
      attestedAt: "2026-06-19T00:00:00.000Z",
    });

    const one = getLiveLocalRuleVersion(store, SCOPE, "rule-one");
    const two = getLiveLocalRuleVersion(store, SCOPE, "rule-two");
    expect(one?.ruleId).toBe("rule-one");
    expect(two?.ruleId).toBe("rule-two");
    // Same payload -> same digest, yet two separate logical rules: identity was chosen, not derived.
    expect(one?.canonicalPayloadHash).toBe(two?.canonicalPayloadHash);
  });
});
