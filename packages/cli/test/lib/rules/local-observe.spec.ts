import {
  observeLocalMatchers,
  BUILTIN_LOCAL_OBSERVE_RULES,
} from "../../../src/lib/rules/local-observe";
import { parseLocalMatcherRule } from "../../../src/lib/rules/local-matcher";

// GAP2 slice 4 (the SAFE half): observe the content/command matchers against the
// REAL PreToolUse hook payload, with NO persistence. Live recording is blocked on
// the document agent's observed-rule identity/hash contract for non-path matchers,
// so this slice computes the observations a future recording slice will persist,
// proving the matchers run end-to-end against the real wire shape. Fail-open: a
// malformed payload yields no observations, never a throw.

const emDash = "—";

const emDashRule = {
  id: "no-em-dash-in-writes",
  rule: {
    kind: "content" as const,
    tools: ["Write", "Edit"],
    fields: ["content", "new_string"],
    forbiddenSubstrings: [emDash, "--"],
  },
};

const gitPushRule = {
  id: "no-unrequested-git-push",
  rule: {
    kind: "command" as const,
    tools: ["Bash"],
    fields: ["command"],
    forbiddenSequences: [["git", "push"]],
  },
};

describe("observeLocalMatchers", () => {
  it("flags an em-dash in a Write content payload as a VIOLATION observation", () => {
    const obs = observeLocalMatchers(
      { tool_name: "Write", tool_input: { content: `a ${emDash} b` } },
      [emDashRule],
    );
    expect(obs).toEqual([
      { ruleId: "no-em-dash-in-writes", result: "VIOLATION", reasonCode: "FORBIDDEN_CONTENT_MATCH" },
    ]);
  });

  it("records a COMPLIANT observation for a clean Write payload", () => {
    const obs = observeLocalMatchers(
      { tool_name: "Write", tool_input: { content: "clean, prose" } },
      [emDashRule],
    );
    expect(obs).toEqual([
      {
        ruleId: "no-em-dash-in-writes",
        result: "COMPLIANT",
        reasonCode: "COMPLIANT_NO_FORBIDDEN_CONTENT",
      },
    ]);
  });

  it("flags a literal git push in a Bash payload as a VIOLATION observation", () => {
    const obs = observeLocalMatchers(
      { tool_name: "Bash", tool_input: { command: "git push origin main" } },
      [gitPushRule],
    );
    expect(obs).toEqual([
      {
        ruleId: "no-unrequested-git-push",
        result: "VIOLATION",
        reasonCode: "FORBIDDEN_COMMAND_MATCH",
      },
    ]);
  });

  it("omits rules that do not select the call", () => {
    // A Bash call against a content (Write/Edit) rule produces no observation.
    const obs = observeLocalMatchers(
      { tool_name: "Bash", tool_input: { command: `git ${emDash}` } },
      [emDashRule],
    );
    expect(obs).toEqual([]);
  });

  it("evaluates every applicable rule in the set", () => {
    const obs = observeLocalMatchers(
      { tool_name: "Bash", tool_input: { command: "git push" } },
      [emDashRule, gitPushRule],
    );
    // Only the command rule applies to a Bash call.
    expect(obs).toEqual([
      {
        ruleId: "no-unrequested-git-push",
        result: "VIOLATION",
        reasonCode: "FORBIDDEN_COMMAND_MATCH",
      },
    ]);
  });

  it("parses a raw JSON-string payload (the real hook delivers a string)", () => {
    const obs = observeLocalMatchers(
      JSON.stringify({ tool_name: "Write", tool_input: { content: `x ${emDash} y` } }),
      [emDashRule],
    );
    expect(obs.map((o) => o.result)).toEqual(["VIOLATION"]);
  });

  it("fails open to no observations on a malformed payload", () => {
    expect(observeLocalMatchers("not json", [emDashRule])).toEqual([]);
    expect(observeLocalMatchers({ no: "tool_name" }, [emDashRule])).toEqual([]);
    expect(observeLocalMatchers(null, [emDashRule])).toEqual([]);
  });
});

describe("BUILTIN_LOCAL_OBSERVE_RULES", () => {
  it("ships a non-empty set with stable, unique ids", () => {
    expect(BUILTIN_LOCAL_OBSERVE_RULES.length).toBeGreaterThan(0);
    const ids = BUILTIN_LOCAL_OBSERVE_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every builtin rule is a well-formed local matcher rule", () => {
    for (const { rule } of BUILTIN_LOCAL_OBSERVE_RULES) {
      expect(parseLocalMatcherRule(rule).status).toBe("OK");
    }
  });

  it("includes the em-dash ban and observes it against a real Write payload", () => {
    const obs = observeLocalMatchers(
      { tool_name: "Write", tool_input: { content: `An hates ${emDash} dashes` } },
      BUILTIN_LOCAL_OBSERVE_RULES,
    );
    expect(obs.some((o) => o.result === "VIOLATION" && o.reasonCode === "FORBIDDEN_CONTENT_MATCH")).toBe(
      true,
    );
  });
});
