import { canonicalize, sha256Hex } from "../../../src/lib/rules/canonical-json";
import {
  CONSULT_EVIDENCE_CANONICAL_PAYLOAD_HASH,
  CONSULT_EVIDENCE_RULE_ID,
  CONSULT_EVIDENCE_RULE_PAYLOAD,
} from "../../../src/lib/rules/ce0-rule";
import { getCodeRule } from "../../../src/lib/rules/code-rule-registry";

// The code-rule registry resolves a code-DEFINED rule (one whose payload is frozen in source, not
// observed from a directive scan) into the opaque (serializedPayload, canonicalPayloadHash) the
// LocalRuleVersion repo stores verbatim. It is the seam that lets an operator attest a rule the
// product ships (e.g. the CE0 consult-evidence forcing function) onto a durable LIVE row WITHOUT
// re-expressing it as a forbidden-root RulePayloadV1 (which it is not).
//
// The load-bearing invariant: the registry hands over the EXACT bytes + the EXACT plain-sha256 hash
// the rest of the system already stamps on its obligations (CONSULT_EVIDENCE_CANONICAL_PAYLOAD_HASH).
// That continuity is what makes a future rebind of the live adapters onto the minted row a clean swap
// rather than a hash break.

describe("getCodeRule resolves a code-defined rule to opaque payload bytes + plain hash", () => {
  it("resolves consult-evidence to its frozen ce0-rule identity", () => {
    const def = getCodeRule("consult-evidence");
    expect(def).not.toBeNull();
    expect(def?.ruleId).toBe(CONSULT_EVIDENCE_RULE_ID);
  });

  it("hands over the EXACT canonical hash obligations are already stamped with (continuity)", () => {
    const def = getCodeRule("consult-evidence");
    // The minted row must carry the same hash the prompt-submit / stop adapters currently hardcode, so
    // the eventual rebind onto the live row is a byte-for-byte swap, not a hash rotation.
    expect(def?.canonicalPayloadHash).toBe(CONSULT_EVIDENCE_CANONICAL_PAYLOAD_HASH);
  });

  it("stores a self-verifying row: plain sha256 of the serialized payload equals the stored hash", () => {
    const def = getCodeRule("consult-evidence");
    // The repo treats both fields as opaque, so the registry is the only place their consistency is
    // guaranteed. A reader can re-derive the hash from the bytes with a PLAIN sha256 (no domain tag),
    // exactly as ce0-rule.ts computes CONSULT_EVIDENCE_CANONICAL_PAYLOAD_HASH.
    expect(def?.serializedPayload).toBe(canonicalize(CONSULT_EVIDENCE_RULE_PAYLOAD));
    expect(sha256Hex(def!.serializedPayload)).toBe(def!.canonicalPayloadHash);
  });

  it("returns null for an unknown code-rule name (refuses to fabricate a rule)", () => {
    expect(getCodeRule("no-such-rule")).toBeNull();
  });
});
