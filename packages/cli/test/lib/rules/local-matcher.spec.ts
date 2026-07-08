import { evaluateLocalMatcher, parseLocalMatcherRule } from "../../../src/lib/rules/local-matcher";
import { ToolCall } from "../../../src/lib/rules/evaluator";

// GAP2 slice 3: the observe-only dispatcher that turns the pure CONTENT and
// COMMAND matchers into a per-tool-call verdict.
//
// Why a SIBLING type (LocalMatcherRule), not an extension of RuleApplicability:
// RuleApplicability is inside canonicalPayloadHash (attested-rule identity). These
// matchers are OBSERVE-ONLY in this slice and are never attested, so they must not
// enter the hashed payload (that would risk the existing notes-path golden vectors
// and the document agent's still-open schema contract). Promotion to an attested,
// enforceable rule is a deliberately future slice that, when that contract lands,
// adds a discriminated matcher kind to RuleApplicability ADDITIVELY.
//
// The dispatcher is pure and synchronous (no I/O, unlike the notes-path adapter):
// it selects by tool membership, reads the named payload field(s), classifies, and
// maps to the four-state verdict. A rule that does not select the call returns null
// (nothing observed), distinct from an applied rule that returns UNKNOWN.

const emDash = "—";

describe("evaluateLocalMatcher (content)", () => {
  const rule = {
    kind: "content" as const,
    tools: ["Write", "Edit"],
    fields: ["content", "new_string"],
    forbiddenSubstrings: [emDash, "--"],
  };

  const call = (toolName: string, toolInput: Record<string, unknown>): ToolCall => ({
    toolName,
    toolInput,
  });

  it("returns null when the tool is not in the rule's tool list", () => {
    expect(evaluateLocalMatcher(call("Bash", { command: `git ${emDash}` }), rule)).toBeNull();
  });

  it("flags an em-dash in a Write content field as a VIOLATION", () => {
    expect(evaluateLocalMatcher(call("Write", { content: `a ${emDash} b` }), rule)).toEqual({
      result: "VIOLATION",
      reasonCode: "FORBIDDEN_CONTENT_MATCH",
    });
  });

  it("flags an em-dash in an Edit new_string field as a VIOLATION", () => {
    expect(
      evaluateLocalMatcher(call("Edit", { old_string: "x", new_string: `y ${emDash} z` }), rule),
    ).toEqual({ result: "VIOLATION", reasonCode: "FORBIDDEN_CONTENT_MATCH" });
  });

  it("returns COMPLIANT for a clean Write content field (absence is provable)", () => {
    expect(
      evaluateLocalMatcher(call("Write", { content: "clean prose, with commas" }), rule),
    ).toEqual({ result: "COMPLIANT", reasonCode: "COMPLIANT_NO_FORBIDDEN_CONTENT" });
  });

  it("does not let an absent sibling field drag a clean field down to UNKNOWN", () => {
    // Write carries `content` but not `new_string`; the clean content must win over
    // the absent field's INDETERMINATE.
    expect(evaluateLocalMatcher(call("Write", { content: "all clean here" }), rule)).toEqual({
      result: "COMPLIANT",
      reasonCode: "COMPLIANT_NO_FORBIDDEN_CONTENT",
    });
  });

  it("returns UNKNOWN when no named field carries a string", () => {
    expect(evaluateLocalMatcher(call("Write", { unrelated: 5 }), rule)).toEqual({
      result: "UNKNOWN",
      reasonCode: "CONTENT_INDETERMINATE",
    });
  });
});

describe("evaluateLocalMatcher (command)", () => {
  const rule = {
    kind: "command" as const,
    tools: ["Bash"],
    fields: ["command"],
    forbiddenSequences: [["git", "push"]],
  };

  const bash = (command: unknown): ToolCall => ({ toolName: "Bash", toolInput: { command } });

  it("returns null for a non-Bash tool", () => {
    expect(evaluateLocalMatcher({ toolName: "Write", toolInput: { content: "git push" } }, rule)).toBeNull();
  });

  it("flags a literal `git push` token run as a VIOLATION", () => {
    expect(evaluateLocalMatcher(bash("git push origin main"), rule)).toEqual({
      result: "VIOLATION",
      reasonCode: "FORBIDDEN_COMMAND_MATCH",
    });
  });

  it("returns UNKNOWN (opaque), never COMPLIANT, for a non-matching command", () => {
    expect(evaluateLocalMatcher(bash("git status"), rule)).toEqual({
      result: "UNKNOWN",
      reasonCode: "COMMAND_NO_MATCH_OPAQUE",
    });
  });

  it("returns UNKNOWN when the command field is missing", () => {
    expect(evaluateLocalMatcher(bash(undefined), rule)).toEqual({
      result: "UNKNOWN",
      reasonCode: "COMMAND_INDETERMINATE",
    });
  });
});

describe("parseLocalMatcherRule", () => {
  it("accepts a well-formed content rule", () => {
    const res = parseLocalMatcherRule({
      kind: "content",
      tools: ["Write", "Edit"],
      fields: ["content", "new_string"],
      forbiddenSubstrings: [emDash, "--"],
    });
    expect(res.status).toBe("OK");
    expect(res.rule).toEqual({
      kind: "content",
      tools: ["Write", "Edit"],
      fields: ["content", "new_string"],
      forbiddenSubstrings: [emDash, "--"],
    });
  });

  it("accepts a well-formed command rule", () => {
    const res = parseLocalMatcherRule({
      kind: "command",
      tools: ["Bash"],
      fields: ["command"],
      forbiddenSequences: [["git", "push"]],
    });
    expect(res.status).toBe("OK");
    expect(res.rule).toEqual({
      kind: "command",
      tools: ["Bash"],
      fields: ["command"],
      forbiddenSequences: [["git", "push"]],
    });
  });

  it("rejects a non-object", () => {
    expect(parseLocalMatcherRule(null).status).toBe("INVALID");
    expect(parseLocalMatcherRule("content").status).toBe("INVALID");
  });

  it("rejects an unknown kind", () => {
    expect(
      parseLocalMatcherRule({ kind: "path", tools: ["Write"], fields: ["file_path"] }).status,
    ).toBe("INVALID");
  });

  it("rejects empty or non-string tools", () => {
    expect(
      parseLocalMatcherRule({ kind: "content", tools: [], fields: ["content"], forbiddenSubstrings: [emDash] })
        .status,
    ).toBe("INVALID");
    expect(
      parseLocalMatcherRule({
        kind: "content",
        tools: [5],
        fields: ["content"],
        forbiddenSubstrings: [emDash],
      }).status,
    ).toBe("INVALID");
  });

  it("rejects empty fields", () => {
    expect(
      parseLocalMatcherRule({ kind: "content", tools: ["Write"], fields: [], forbiddenSubstrings: [emDash] })
        .status,
    ).toBe("INVALID");
  });

  it("rejects a content rule with no usable forbidden substring", () => {
    expect(
      parseLocalMatcherRule({ kind: "content", tools: ["Write"], fields: ["content"], forbiddenSubstrings: [] })
        .status,
    ).toBe("INVALID");
    expect(
      parseLocalMatcherRule({
        kind: "content",
        tools: ["Write"],
        fields: ["content"],
        forbiddenSubstrings: [""],
      }).status,
    ).toBe("INVALID");
  });

  it("rejects a command rule with no usable forbidden sequence", () => {
    expect(
      parseLocalMatcherRule({ kind: "command", tools: ["Bash"], fields: ["command"], forbiddenSequences: [] })
        .status,
    ).toBe("INVALID");
    expect(
      parseLocalMatcherRule({
        kind: "command",
        tools: ["Bash"],
        fields: ["command"],
        forbiddenSequences: [[]],
      }).status,
    ).toBe("INVALID");
  });
});
