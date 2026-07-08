import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  CONSULT_EVIDENCE_CANONICAL_PAYLOAD_HASH,
  CONSULT_EVIDENCE_RULE_ID,
  CONSULT_EVIDENCE_RULE_VERSION_ID,
} from "../../../src/lib/rules/ce0-rule";
import { getCodeRule } from "../../../src/lib/rules/code-rule-registry";
import { mintAttestedCodeRuleVersion } from "../../../src/lib/rules/attest-code-rule-version";
import { openCe0Store, closeCe0Store, type Ce0Store } from "../../../src/lib/rules/ce0-store";
import { resolveConsultEvidenceRuleBinding } from "../../../src/lib/rules/consult-evidence-binding";

// The runtime binding seam (GAP 3 slice 2): the obligation triple the CE0 prompt-submit / stop adapters
// stamp -- {ruleId, ruleVersionId, canonicalPayloadHash} -- is resolved HERE from the durable store rather
// than read from compile-time constants. When an operator has attested a LIVE consult-evidence
// LocalRuleVersion for the runtime scope, the obligation binds to that real version's id + hash (the rule
// is ARMED). When no live row exists (the default, unarmed measurement state), it falls back to the
// frozen compile-time identity so CE0 keeps measuring exactly as before. The payload hash is invariant
// across the two branches by construction (the registry stores the same plain digest the constants carry),
// so arming a rule rotates ONLY the version id, never the hash, unless a seed bump superseded the version.

const SCOPE = "/work/canon";
const OTHER_SCOPE = "/work/elsewhere";

describe("resolveConsultEvidenceRuleBinding resolves the obligation triple from the durable store", () => {
  let dir: string;
  let store: Ce0Store;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ce-binding-"));
    store = openCe0Store(path.join(dir, "evidence.db"));
  });

  afterEach(() => {
    closeCe0Store(store);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("falls back to the frozen compile-time identity when no live version is attested (unarmed)", () => {
    const binding = resolveConsultEvidenceRuleBinding(store, SCOPE);

    expect(binding).toEqual({
      ruleId: CONSULT_EVIDENCE_RULE_ID,
      ruleVersionId: CONSULT_EVIDENCE_RULE_VERSION_ID,
      canonicalPayloadHash: CONSULT_EVIDENCE_CANONICAL_PAYLOAD_HASH,
      attested: false,
    });
  });

  it("binds to the LIVE attested version's id + hash when one exists for the scope (armed)", () => {
    const minted = mintAttestedCodeRuleVersion(store, {
      mode: "NEW_RULE",
      codeRule: getCodeRule("consult-evidence")!,
      runtimeScopeId: SCOPE,
      attestedBy: "user_an",
      attestationMethod: "AGENT_ON_USER_REQUEST",
      versionId: "ver_ce_live_1",
      attestedAt: "2026-06-22T00:00:00.000Z",
    });
    expect(minted.outcome).toBe("MINTED");

    const binding = resolveConsultEvidenceRuleBinding(store, SCOPE);

    // The version id is the REAL minted version, never the synthetic constant; the hash is the live row's
    // (here equal to the constant by construction, which is exactly why a rebind is a clean swap).
    expect(binding.ruleId).toBe(CONSULT_EVIDENCE_RULE_ID);
    expect(binding.ruleVersionId).toBe("ver_ce_live_1");
    expect(binding.ruleVersionId).not.toBe(CONSULT_EVIDENCE_RULE_VERSION_ID);
    expect(binding.canonicalPayloadHash).toBe(CONSULT_EVIDENCE_CANONICAL_PAYLOAD_HASH);
    expect(binding.attested).toBe(true);
  });

  it("is keyed by runtime scope: a live version in another scope does not arm this scope (P0.51)", () => {
    mintAttestedCodeRuleVersion(store, {
      mode: "NEW_RULE",
      codeRule: getCodeRule("consult-evidence")!,
      runtimeScopeId: OTHER_SCOPE,
      attestedBy: "user_an",
      attestationMethod: "HUMAN_DIRECT",
      versionId: "ver_ce_other",
      attestedAt: "2026-06-22T00:00:00.000Z",
    });

    const binding = resolveConsultEvidenceRuleBinding(store, SCOPE);

    expect(binding.ruleVersionId).toBe(CONSULT_EVIDENCE_RULE_VERSION_ID);
    expect(binding.attested).toBe(false);
  });
});
