import { tokenizeCommand, classifyCommand } from "../../../src/lib/rules/command-match";
import { verdictForForbiddenCommand, isEnforcementEligible } from "../../../src/lib/rules/evaluator";

// GAP2 rule-class frontier: the COMMAND matcher (the git/prisma class).
//
// The proposal declares Bash PATH enforcement out of v1 because a shell string is
// opaque: cp/mv/python/redirection/eval can perform an effect without the literal
// tokens appearing, so you can never prove a command is SAFE. This matcher covers
// the decidable HALF the proposal left on the table: a POSITIVE literal match.
//
// If the contiguous unquoted, uncommented words "git push" appear as consecutive
// tokens, the command performs that operation. Opacity can only ADD effects, never
// remove that literal one, so a positive match is a sound VIOLATION. The asymmetry
// is the whole point:
//   forbidden token run present -> MATCHES_FORBIDDEN -> VIOLATION
//   no run / not a string       -> NO_MATCH / INDETERMINATE -> UNKNOWN (never COMPLIANT)
// There is deliberately NO COMPLIANT outcome: a non-match cannot prove the command
// won't push (an alias, a script, eval, or $VAR expansion could). Observe-only in
// this slice: it never denies until a tokenized pattern is human-attested.
//
// Quotes and comments are honored so the tokenizer cannot be fooled into a false
// positive: `echo "git push"` is one quoted token, `ls # git push` is a comment.
// Statement separators (newline ; | & and parens) break a token run, so `git ;
// push` is two statements, not the `git push` invocation.

describe("tokenizeCommand", () => {
  it("splits a simple command into one segment of tokens", () => {
    expect(tokenizeCommand("git push")).toEqual([["git", "push"]]);
    expect(tokenizeCommand("git push origin main")).toEqual([["git", "push", "origin", "main"]]);
  });

  it("collapses a double-quoted run into a single token", () => {
    expect(tokenizeCommand('echo "git push"')).toEqual([["echo", "git push"]]);
  });

  it("collapses a single-quoted run into a single token", () => {
    expect(tokenizeCommand("echo 'git push'")).toEqual([["echo", "git push"]]);
  });

  it("strips a trailing comment at a word boundary", () => {
    expect(tokenizeCommand("ls # git push")).toEqual([["ls"]]);
  });

  it("keeps a hash that is inside a word, not a comment", () => {
    expect(tokenizeCommand("echo abc#def")).toEqual([["echo", "abc#def"]]);
  });

  it("breaks statements on && ; | and newlines", () => {
    expect(tokenizeCommand("git status && git push")).toEqual([
      ["git", "status"],
      ["git", "push"],
    ]);
    expect(tokenizeCommand("git status; git push")).toEqual([
      ["git", "status"],
      ["git", "push"],
    ]);
    expect(tokenizeCommand("cat foo | grep bar")).toEqual([
      ["cat", "foo"],
      ["grep", "bar"],
    ]);
    expect(tokenizeCommand("git\npush")).toEqual([["git"], ["push"]]);
  });

  it("yields no segments for empty or whitespace-only input", () => {
    expect(tokenizeCommand("")).toEqual([]);
    expect(tokenizeCommand("   \t  ")).toEqual([]);
  });
});

describe("classifyCommand", () => {
  const gitPush = [["git", "push"]];

  it("matches a forbidden run at the start of a segment", () => {
    expect(classifyCommand("git push", gitPush)).toBe("MATCHES_FORBIDDEN");
    expect(classifyCommand("git push origin main", gitPush)).toBe("MATCHES_FORBIDDEN");
  });

  it("matches a forbidden run in the middle of a segment", () => {
    expect(classifyCommand("npx prisma migrate deploy", [["prisma", "migrate", "deploy"]])).toBe(
      "MATCHES_FORBIDDEN",
    );
  });

  it("does NOT match when the run is broken by a quote", () => {
    expect(classifyCommand('echo "git push"', gitPush)).toBe("NO_MATCH");
  });

  it("does NOT match when the run is inside a comment", () => {
    expect(classifyCommand("ls # git push", gitPush)).toBe("NO_MATCH");
  });

  it("does NOT match when a statement separator splits the run", () => {
    expect(classifyCommand("git status; push", gitPush)).toBe("NO_MATCH");
    expect(classifyCommand("git\npush", gitPush)).toBe("NO_MATCH");
  });

  it("does NOT match a different subcommand", () => {
    expect(classifyCommand("git status", gitPush)).toBe("NO_MATCH");
    expect(classifyCommand("prisma migrate dev", [["prisma", "migrate", "deploy"]])).toBe(
      "NO_MATCH",
    );
  });

  it("matches when any one of several forbidden sequences is present", () => {
    expect(classifyCommand("git push", [["prisma", "db", "push"], ["git", "push"]])).toBe(
      "MATCHES_FORBIDDEN",
    );
  });

  it("returns INDETERMINATE for a non-string command", () => {
    expect(classifyCommand(7, gitPush)).toBe("INDETERMINATE");
    expect(classifyCommand(undefined, gitPush)).toBe("INDETERMINATE");
    expect(classifyCommand(null, gitPush)).toBe("INDETERMINATE");
  });

  it("returns INDETERMINATE when there is no usable forbidden sequence", () => {
    expect(classifyCommand("git push", [])).toBe("INDETERMINATE");
    expect(classifyCommand("git push", [[]])).toBe("INDETERMINATE");
    expect(classifyCommand("git push", [["", ""]])).toBe("INDETERMINATE");
  });
});

describe("verdictForForbiddenCommand", () => {
  it("maps MATCHES_FORBIDDEN to an enforcement-eligible VIOLATION", () => {
    const v = verdictForForbiddenCommand("MATCHES_FORBIDDEN");
    expect(v).toEqual({ result: "VIOLATION", reasonCode: "FORBIDDEN_COMMAND_MATCH" });
    expect(isEnforcementEligible(v.result)).toBe(true);
  });

  it("maps NO_MATCH to UNKNOWN (opaque), never COMPLIANT", () => {
    const v = verdictForForbiddenCommand("NO_MATCH");
    expect(v).toEqual({ result: "UNKNOWN", reasonCode: "COMMAND_NO_MATCH_OPAQUE" });
    expect(isEnforcementEligible(v.result)).toBe(false);
  });

  it("maps INDETERMINATE to UNKNOWN", () => {
    const v = verdictForForbiddenCommand("INDETERMINATE");
    expect(v).toEqual({ result: "UNKNOWN", reasonCode: "COMMAND_INDETERMINATE" });
    expect(isEnforcementEligible(v.result)).toBe(false);
  });
});
