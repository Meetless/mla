import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { canonicalize, sha256Hex, type CanonicalObject } from "../../../src/lib/rules/canonical-json";
import { CONSULT_EVIDENCE_CANONICAL_PAYLOAD_HASH } from "../../../src/lib/rules/ce0-rule";
import { getCodeRule, type CodeRuleDefinition } from "../../../src/lib/rules/code-rule-registry";
import { mintAttestedCodeRuleVersion } from "../../../src/lib/rules/attest-code-rule-version";
import { RuleIdentityCollisionError } from "../../../src/lib/rules/attest-rule-version";
import { openCe0Store, closeCe0Store, type Ce0Store } from "../../../src/lib/rules/ce0-store";
import {
  getLiveLocalRuleVersion,
  listLocalRuleVersionHistory,
  NoLiveVersionToSupersedeError,
} from "../../../src/lib/rules/local-rule-version-repo";

// The R1 attest writer for CODE-DEFINED rules (those the product ships in source, e.g. the CE0
// consult-evidence forcing function). It is a sibling of the canonical mintAttestedRuleVersion, NOT a
// caller of it: that writer is RulePayloadV1-only (forbidden-root / action shaped) and re-hashes the
// payload under the domain-separated rule-version-v1 digest. A code rule's payload is neither shape, and
// it must keep the PLAIN canonical hash the rest of the system already stamps on its obligations. So this
// writer stores the registry's frozen bytes + plain hash VERBATIM (the repo's fields are opaque), with
// derivedFromObservedHash null (a code rule is authored, never observed), reusing the same version
// envelope, the same MintOutcome, and the same P0.55 identity faults. A code rule's logical id is PINNED
// by its frozen payload, so the writer takes only a mode (NEW_RULE / SUCCESSOR), never a free ruleId.

const SCOPE = "/work/canon";

/** Build a synthetic code-rule definition the way the registry does: canonical bytes + plain sha256. A
 * changed payload object models a seed-version bump that rotates the frozen rule's hash. */
function defWith(ruleId: string, payload: CanonicalObject): CodeRuleDefinition {
  const serializedPayload = canonicalize(payload);
  return { ruleId, serializedPayload, canonicalPayloadHash: sha256Hex(serializedPayload) };
}

describe("mintAttestedCodeRuleVersion mints a code-defined rule onto a durable LIVE row", () => {
  let dir: string;
  let store: Ce0Store;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "attest-code-rule-"));
    store = openCe0Store(path.join(dir, "evidence.db"));
  });

  afterEach(() => {
    closeCe0Store(store);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("NEW_RULE mints a fresh LIVE version storing the frozen bytes + plain hash verbatim", () => {
    const def = defWith("ce-rule", { schemaVersion: "ce0-rule-v1", n: 1 });
    const outcome = mintAttestedCodeRuleVersion(store, {
      mode: "NEW_RULE",
      codeRule: def,
      runtimeScopeId: SCOPE,
      attestedBy: "user_an",
      attestationMethod: "HUMAN_DIRECT",
      versionId: "ver_c1",
      attestedAt: "2026-06-21T00:00:00.000Z",
    });

    expect(outcome.outcome).toBe("MINTED");
    const live = getLiveLocalRuleVersion(store, SCOPE, "ce-rule");
    expect(live?.versionId).toBe("ver_c1");
    expect(live?.ruleId).toBe("ce-rule");
    expect(live?.lifecycleStatus).toBe("LIVE");
    expect(live?.supersedesVersionId).toBeNull();
    // A code rule is authored, never observed: no observed-hash lineage.
    expect(live?.derivedFromObservedHash).toBeNull();
    // Bytes and hash are stored VERBATIM, not re-serialized or re-hashed under a domain tag.
    expect(live?.rulePayload).toBe(def.serializedPayload);
    expect(live?.canonicalPayloadHash).toBe(def.canonicalPayloadHash);
  });

  it("NEW_RULE rejects an accidental id collision and writes nothing", () => {
    mintAttestedCodeRuleVersion(store, {
      mode: "NEW_RULE",
      codeRule: defWith("ce-rule", { n: 1 }),
      runtimeScopeId: SCOPE,
      attestedBy: "user_an",
      attestationMethod: "HUMAN_DIRECT",
      versionId: "ver_c1",
      attestedAt: "2026-06-21T00:00:00.000Z",
    });

    expect(() =>
      mintAttestedCodeRuleVersion(store, {
        mode: "NEW_RULE",
        codeRule: defWith("ce-rule", { n: 2 }),
        runtimeScopeId: SCOPE,
        attestedBy: "user_an",
        attestationMethod: "HUMAN_DIRECT",
        versionId: "ver_c2",
        attestedAt: "2026-06-21T01:00:00.000Z",
      }),
    ).toThrow(RuleIdentityCollisionError);

    const history = listLocalRuleVersionHistory(store, SCOPE, "ce-rule");
    expect(history).toHaveLength(1);
    expect(history[0].versionId).toBe("ver_c1");
  });

  it("SUCCESSOR supersedes the prior LIVE when a seed bump rotates the frozen hash (exactly one LIVE)", () => {
    mintAttestedCodeRuleVersion(store, {
      mode: "NEW_RULE",
      codeRule: defWith("ce-rule", { seed: "v1" }),
      runtimeScopeId: SCOPE,
      attestedBy: "user_an",
      attestationMethod: "HUMAN_DIRECT",
      versionId: "ver_c1",
      attestedAt: "2026-06-21T00:00:00.000Z",
    });

    const outcome = mintAttestedCodeRuleVersion(store, {
      mode: "SUCCESSOR",
      codeRule: defWith("ce-rule", { seed: "v2" }),
      runtimeScopeId: SCOPE,
      attestedBy: "user_an",
      attestationMethod: "AGENT_ON_USER_REQUEST",
      versionId: "ver_c2",
      attestedAt: "2026-06-21T02:00:00.000Z",
    });

    expect(outcome.outcome).toBe("SUPERSEDED");
    if (outcome.outcome === "SUPERSEDED") {
      expect(outcome.supersededVersionId).toBe("ver_c1");
    }
    const live = getLiveLocalRuleVersion(store, SCOPE, "ce-rule");
    expect(live?.versionId).toBe("ver_c2");
    expect(live?.supersedesVersionId).toBe("ver_c1");
    const history = listLocalRuleVersionHistory(store, SCOPE, "ce-rule");
    expect(history).toHaveLength(2);
    expect(history.filter((v) => v.lifecycleStatus === "LIVE")).toHaveLength(1);
  });

  it("SUCCESSOR is an idempotent no-op when the frozen hash is unchanged (no new row)", () => {
    const def = defWith("ce-rule", { seed: "stable" });
    mintAttestedCodeRuleVersion(store, {
      mode: "NEW_RULE",
      codeRule: def,
      runtimeScopeId: SCOPE,
      attestedBy: "user_an",
      attestationMethod: "HUMAN_DIRECT",
      versionId: "ver_c1",
      attestedAt: "2026-06-21T00:00:00.000Z",
    });

    const again = mintAttestedCodeRuleVersion(store, {
      mode: "SUCCESSOR",
      codeRule: def,
      runtimeScopeId: SCOPE,
      attestedBy: "user_an",
      attestationMethod: "HUMAN_DIRECT",
      versionId: "ver_c2_unused",
      attestedAt: "2026-06-21T03:00:00.000Z",
    });

    expect(again.outcome).toBe("NOOP_IDEMPOTENT");
    expect(again.version.versionId).toBe("ver_c1");
    expect(listLocalRuleVersionHistory(store, SCOPE, "ce-rule")).toHaveLength(1);
  });

  it("SUCCESSOR of a rule with no LIVE version is refused (cannot succeed nothing)", () => {
    expect(() =>
      mintAttestedCodeRuleVersion(store, {
        mode: "SUCCESSOR",
        codeRule: defWith("ce-orphan", { seed: "x" }),
        runtimeScopeId: SCOPE,
        attestedBy: "user_an",
        attestationMethod: "HUMAN_DIRECT",
        versionId: "ver_x",
        attestedAt: "2026-06-21T00:00:00.000Z",
      }),
    ).toThrow(NoLiveVersionToSupersedeError);
    expect(listLocalRuleVersionHistory(store, SCOPE, "ce-orphan")).toHaveLength(0);
  });

  it("minting the real consult-evidence code rule carries the exact stamped hash (rebind continuity)", () => {
    const def = getCodeRule("consult-evidence");
    const outcome = mintAttestedCodeRuleVersion(store, {
      mode: "NEW_RULE",
      codeRule: def!,
      runtimeScopeId: SCOPE,
      attestedBy: "user_an",
      attestationMethod: "AGENT_ON_USER_REQUEST",
      versionId: "ver_ce_v1",
      attestedAt: "2026-06-21T00:00:00.000Z",
    });

    expect(outcome.outcome).toBe("MINTED");
    const live = getLiveLocalRuleVersion(store, SCOPE, "consult-evidence");
    // The minted row carries the SAME hash the live prompt-submit / stop adapters currently hardcode, so
    // a future rebind onto this row is a byte-for-byte swap, never a hash rotation.
    expect(live?.canonicalPayloadHash).toBe(CONSULT_EVIDENCE_CANONICAL_PAYLOAD_HASH);
  });
});
