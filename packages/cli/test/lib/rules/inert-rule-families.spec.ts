import { canonicalize } from "../../../src/lib/rules/canonical-json";
import { CONSULT_EVIDENCE_RULE_PAYLOAD } from "../../../src/lib/rules/ce0-rule";
import { isInertNonEnforcingRule } from "../../../src/lib/rules/inert-rule-families";

// The generalized-R4 inert-family registry (proposal section 2.0, P0.13 INV-CONFLICT-NEVER-SILENTLY-
// DENIES). The R4 enforce dispatch must distinguish THREE classes of LIVE rule, not two: an ENFORCEABLE
// family rule (a PROHIBIT forbidden-root rule it faces), a provably INERT rule (one whose maximum
// authority on a tool attempt is RECORD_ONLY, so it imposes no effect and CANNOT conflict, and is safe to
// skip), and a genuinely UNKNOWN rule (still fails open the whole attempt). This predicate owns the
// middle class: it is the seam that lets a CE0 consult-evidence RECORD_ONLY rule coexist in the same
// scope as the live notes-location DENY pilot WITHOUT disarming it.
//
// The recognition is POSITIVE and NARROW by construction: each inert family is named by its EXACT schema,
// and within a recognized schema the predicate re-derives that its ceiling is RECORD_ONLY. The dangerous
// inversion ("anything we do not understand is inert") is precisely what this must never become; an
// unrecognized payload returns false so the dispatch's fail-open boundary is preserved.

describe("isInertNonEnforcingRule recognizes provably non-enforcing rule families", () => {
  it("recognizes the real frozen CE0 consult-evidence payload as inert (anti-drift continuity)", () => {
    // Parse the payload from its canonical bytes, exactly as the live row stores and the dispatch reads
    // it. This pins the predicate to the ACTUAL shipped rule, so a future rename of the schema tag or the
    // ceiling field cannot silently stop recognizing the live row.
    const payload = JSON.parse(canonicalize(CONSULT_EVIDENCE_RULE_PAYLOAD));
    expect(isInertNonEnforcingRule(payload)).toBe(true);
  });

  it("recognizes a ce0-rule-v1 payload whose ceiling is RECORD_ONLY", () => {
    expect(isInertNonEnforcingRule({ schemaVersion: "ce0-rule-v1", responseCeiling: "RECORD_ONLY" })).toBe(true);
  });

  it("does NOT recognize a ce0-rule-v1 payload whose ceiling is AUTO_CORRECT (checks the ceiling, not just the schema)", () => {
    // The load-bearing safety test. A CE2 AUTO_CORRECT version of the SAME schema CAN steer / inject, so
    // it is no longer inert and must NOT be skipped: recognizing it as inert would let an enforcing rule
    // slip past the R4 conflict guard.
    expect(isInertNonEnforcingRule({ schemaVersion: "ce0-rule-v1", responseCeiling: "AUTO_CORRECT" })).toBe(false);
  });

  it("does NOT recognize a ce0-rule-v1 payload missing the ceiling field", () => {
    expect(isInertNonEnforcingRule({ schemaVersion: "ce0-rule-v1" })).toBe(false);
  });

  it("does NOT recognize an unknown schema (the fail-open boundary for the unknown is preserved)", () => {
    expect(isInertNonEnforcingRule({ schemaVersion: "some-future-rule-v9", responseCeiling: "RECORD_ONLY" })).toBe(false);
  });

  it("does NOT recognize a PROHIBIT forbidden-root rule payload (an enforcing rule is never inert)", () => {
    const enforcing = {
      effect: "PROHIBIT",
      applicability: { mode: "action" },
      compliance: { config: { forbiddenRootRelativePath: "notes" } },
    };
    expect(isInertNonEnforcingRule(enforcing)).toBe(false);
  });

  it("returns false for null, undefined, and non-object payloads", () => {
    expect(isInertNonEnforcingRule(null)).toBe(false);
    expect(isInertNonEnforcingRule(undefined)).toBe(false);
    expect(isInertNonEnforcingRule("ce0-rule-v1")).toBe(false);
    expect(isInertNonEnforcingRule(42)).toBe(false);
  });
});
