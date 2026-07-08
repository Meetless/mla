import { classifyContent } from "../../../src/lib/rules/content-match";
import { verdictForForbiddenContent, isEnforcementEligible } from "../../../src/lib/rules/evaluator";

// GAP2 rule-class frontier: the CONTENT matcher (the em-dash-ban class).
//
// Unlike the proposal's behavioral em-dash ban over the agent's OUTPUT TEXT
// (which is only observable at Stop, §2404-2406), a forbidden substring inside a
// Write/Edit PAYLOAD is fully observable at PreToolUse: the `content`/`new_string`
// field is right there. So both polarities are PROVABLE here, unlike Bash:
//   present forbidden needle  -> CONTAINS_FORBIDDEN -> VIOLATION
//   string with no needle     -> NO_FORBIDDEN       -> COMPLIANT (absence IS provable)
//   missing / non-string      -> INDETERMINATE      -> UNKNOWN (never a verdict)
// Exact codepoint match, no normalization: an em-dash needle (U+2014) must not be
// confused with an en-dash (U+2013) or a hyphen. This is a byte-level rule.

describe("classifyContent", () => {
  const emDash = "—"; // —
  const enDash = "–"; // –
  const needles = [emDash, "--"];

  it("flags content that contains an em-dash needle", () => {
    expect(classifyContent(`a sentence ${emDash} with an em dash`, needles)).toBe(
      "CONTAINS_FORBIDDEN",
    );
  });

  it("flags content that contains a double-hyphen needle", () => {
    expect(classifyContent("prose with -- a double dash", needles)).toBe("CONTAINS_FORBIDDEN");
  });

  it("returns NO_FORBIDDEN for clean content", () => {
    expect(classifyContent("a clean sentence, with only commas; and semicolons", needles)).toBe(
      "NO_FORBIDDEN",
    );
  });

  it("treats empty-string content as observably clean (NO_FORBIDDEN, not indeterminate)", () => {
    expect(classifyContent("", needles)).toBe("NO_FORBIDDEN");
  });

  it("returns INDETERMINATE when the value is not a string", () => {
    expect(classifyContent(7, needles)).toBe("INDETERMINATE");
    expect(classifyContent(undefined, needles)).toBe("INDETERMINATE");
    expect(classifyContent(null, needles)).toBe("INDETERMINATE");
    expect(classifyContent({ content: "x" }, needles)).toBe("INDETERMINATE");
  });

  it("returns INDETERMINATE when the forbidden-needle set is empty (nothing to look for)", () => {
    expect(classifyContent("anything at all", [])).toBe("INDETERMINATE");
  });

  it("ignores empty-string needles instead of matching everything", () => {
    // An empty needle would `.includes("")===true` on every string. It must be
    // dropped, not allowed to flag all content as forbidden.
    expect(classifyContent("perfectly clean prose", [""])).toBe("INDETERMINATE");
    expect(classifyContent("perfectly clean prose", ["", emDash])).toBe("NO_FORBIDDEN");
    expect(classifyContent(`has ${emDash} dash`, ["", emDash])).toBe("CONTAINS_FORBIDDEN");
  });

  it("does not confuse an en-dash with an em-dash (exact codepoint, no normalization)", () => {
    expect(classifyContent(`an en dash ${enDash} only`, [emDash])).toBe("NO_FORBIDDEN");
  });

  it("flags when any one of several needles is present", () => {
    expect(classifyContent("only the second -- needle here", [emDash, "--"])).toBe(
      "CONTAINS_FORBIDDEN",
    );
  });
});

describe("verdictForForbiddenContent", () => {
  it("maps CONTAINS_FORBIDDEN to an enforcement-eligible VIOLATION", () => {
    const v = verdictForForbiddenContent("CONTAINS_FORBIDDEN");
    expect(v).toEqual({ result: "VIOLATION", reasonCode: "FORBIDDEN_CONTENT_MATCH" });
    expect(isEnforcementEligible(v.result)).toBe(true);
  });

  it("maps NO_FORBIDDEN to COMPLIANT (absence is provable for fully-observable content)", () => {
    const v = verdictForForbiddenContent("NO_FORBIDDEN");
    expect(v).toEqual({ result: "COMPLIANT", reasonCode: "COMPLIANT_NO_FORBIDDEN_CONTENT" });
    expect(isEnforcementEligible(v.result)).toBe(false);
  });

  it("maps INDETERMINATE to UNKNOWN, never a verdict", () => {
    const v = verdictForForbiddenContent("INDETERMINATE");
    expect(v).toEqual({ result: "UNKNOWN", reasonCode: "CONTENT_INDETERMINATE" });
    expect(isEnforcementEligible(v.result)).toBe(false);
  });
});
