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

// ---------------------------------------------------------------------------
// classifyCommandAllOf: the CONJUNCTIVE form (F2, 2026-08-07).
//
// classifyCommand is disjunctive: ANY listed run fires it. That is right for
// "never `git push`", where the operation IS the run. It is wrong for the class
// this was added for: `comp-credit.cjs --apply` is dangerous only when BOTH the
// script and the mutating flag are present, and they are never contiguous
// (`node tools/billing/comp-credit.cjs --account X --apply`). Encoding that
// disjunctively would warn on every `--apply` in the repo, and a rule that cries
// wolf trains the operator to scroll past the banner that currently works.
//
// The soundness argument is inherited, with ONE addition that is the whole
// reason this is not a loop over classifyCommand: every needle must land in the
// SAME segment. `comp-credit.cjs --dry-run ; echo --apply` satisfies both
// needles across two statements and performs neither operation together.
import { classifyCommandAllOf } from "../../../src/lib/rules/command-match";

describe("classifyCommandAllOf", () => {
  const compApply = [["comp-credit.cjs"], ["--apply"]];

  it("matches when every required run is present in one segment", () => {
    expect(
      classifyCommandAllOf("node tools/billing/comp-credit.cjs --account acc_1 --apply", compApply),
    ).toBe("MATCHES_FORBIDDEN");
  });

  it("is order-independent within the segment", () => {
    expect(classifyCommandAllOf("node --apply comp-credit.cjs", compApply)).toBe("MATCHES_FORBIDDEN");
  });

  it("does NOT match when only some required runs are present", () => {
    expect(
      classifyCommandAllOf("node tools/billing/comp-credit.cjs --account acc_1 --dry-run", compApply),
    ).toBe("NO_MATCH");
    expect(classifyCommandAllOf("node tools/other.cjs --apply", compApply)).toBe("NO_MATCH");
  });

  it("does NOT match an unrelated command", () => {
    expect(classifyCommandAllOf("git status", compApply)).toBe("NO_MATCH");
  });

  // The property that makes the conjunction sound. Two statements are two
  // operations; satisfying one needle in each proves nothing about either.
  it("does NOT match when the needles land in DIFFERENT segments", () => {
    expect(classifyCommandAllOf("node comp-credit.cjs --dry-run ; echo --apply", compApply)).toBe(
      "NO_MATCH",
    );
    expect(classifyCommandAllOf("node comp-credit.cjs --dry-run && true --apply", compApply)).toBe(
      "NO_MATCH",
    );
  });

  // Inherited from the tokenizer, restated here because these are the three
  // guarantees the conjunction rests on and a regression in any one of them is
  // a false positive on a governed WARN.
  it("inherits quote, comment and separator immunity", () => {
    expect(classifyCommandAllOf('echo "comp-credit.cjs --apply"', compApply)).toBe("NO_MATCH");
    expect(classifyCommandAllOf("ls # comp-credit.cjs --apply", compApply)).toBe("NO_MATCH");
  });

  it("matches a multi-token required run", () => {
    expect(
      classifyCommandAllOf("node comp-credit.cjs --account acc_1 --apply", [
        ["--account", "acc_1"],
        ["--apply"],
      ]),
    ).toBe("MATCHES_FORBIDDEN");
  });

  it("agrees with classifyCommand on a single required run", () => {
    expect(classifyCommandAllOf("git push origin main", [["git", "push"]])).toBe("MATCHES_FORBIDDEN");
    expect(classifyCommandAllOf("git status", [["git", "push"]])).toBe("NO_MATCH");
  });

  it("returns INDETERMINATE for a non-string command", () => {
    expect(classifyCommandAllOf(7, compApply)).toBe("INDETERMINATE");
    expect(classifyCommandAllOf(undefined, compApply)).toBe("INDETERMINATE");
    expect(classifyCommandAllOf(null, compApply)).toBe("INDETERMINATE");
  });

  // A dropped needle would WEAKEN a conjunction (fewer things to satisfy), so
  // unlike the disjunctive form an unusable entry can never be filtered out and
  // the rest silently enforced. Any malformed needle makes the whole rule
  // unevaluable, which degrades to UNKNOWN and never warns.
  it("returns INDETERMINATE when ANY required sequence is unusable", () => {
    expect(classifyCommandAllOf("node comp-credit.cjs --apply", [])).toBe("INDETERMINATE");
    expect(classifyCommandAllOf("node comp-credit.cjs --apply", [["comp-credit.cjs"], []])).toBe(
      "INDETERMINATE",
    );
    expect(
      classifyCommandAllOf("node comp-credit.cjs --apply", [["comp-credit.cjs"], [""]]),
    ).toBe("INDETERMINATE");
  });
});

// SCRIPT IDENTITY. The first draft of the comp-credit rule could never have
// fired: the real invocation is `node tools/billing/comp-credit.cjs --apply`, so
// the token is the PATH, and exact token equality against a bare `comp-credit.cjs`
// misses it. Pinning a full relative path instead would be worse -- the same
// script run from another cwd, or by absolute path, would walk straight past a
// rule An believes is armed, which is the failure mode this whole plane exists to
// close.
//
// So a needle token carrying NO slash is matched against the command token's
// POSIX basename. That is exactly the question "which script is this", it needs
// no regex, and it is stable across cwd. A needle that DOES carry a slash keeps
// exact equality: an author who wrote a location meant the location, and silently
// relaxing that would broaden a rule its attester never agreed to.
describe("classifyCommandAllOf: script identity by basename", () => {
  const compApply = [["comp-credit.cjs"], ["--apply"]];

  it("matches the script through a relative path", () => {
    expect(classifyCommandAllOf("node tools/billing/comp-credit.cjs --apply", compApply)).toBe(
      "MATCHES_FORBIDDEN",
    );
  });

  it("matches the script through an absolute path and through ./", () => {
    expect(classifyCommandAllOf("node /Users/an/meetless/comp-credit.cjs --apply", compApply)).toBe(
      "MATCHES_FORBIDDEN",
    );
    expect(classifyCommandAllOf("node ./comp-credit.cjs --apply", compApply)).toBe(
      "MATCHES_FORBIDDEN",
    );
  });

  it("does NOT match a DIFFERENT file whose name merely contains the needle", () => {
    expect(classifyCommandAllOf("node tools/comp-credit.cjs.bak --apply", compApply)).toBe(
      "NO_MATCH",
    );
    expect(classifyCommandAllOf("node tools/comp-credit-v2.cjs --apply", compApply)).toBe(
      "NO_MATCH",
    );
  });

  // The escape hatch, and the reason basename matching is not simply always on.
  it("a needle that CARRIES a slash demands exact token equality", () => {
    const pinned = [["tools/billing/comp-credit.cjs"], ["--apply"]];
    expect(classifyCommandAllOf("node tools/billing/comp-credit.cjs --apply", pinned)).toBe(
      "MATCHES_FORBIDDEN",
    );
    expect(classifyCommandAllOf("node /abs/elsewhere/comp-credit.cjs --apply", pinned)).toBe(
      "NO_MATCH",
    );
  });

  // A flag is not a path. Basename semantics must not reach tokens that carry no
  // separator on either side, or `--apply` would start matching `x/--apply`.
  it("leaves flag and bare-word needles on exact equality", () => {
    expect(classifyCommandAllOf("node comp-credit.cjs --apply-later", compApply)).toBe("NO_MATCH");
    expect(classifyCommandAllOf("node comp-credit.cjs x/--apply", compApply)).toBe("NO_MATCH");
  });
});

// HEREDOC BODIES ARE DATA, NOT CODE.
//
// Found the only way this could have been found: the comp-credit rule fired, in
// this session, on a `git commit -F - <<EOF` whose MESSAGE quoted the
// invocation it governs. The commit touched no ledger. It was the rule's first
// contact with real traffic and its first verdict was wrong.
//
// The module header already rests its soundness on inline data being opaque:
// "quotes collapse a run into ONE token, so `echo \"git push\"` is not a match."
// A heredoc is the same construct wearing different syntax, and it was simply
// missed. The tokenizer read the body as a statement and found a contiguous run
// inside a string literal that happens to span lines.
//
// This matters more than the ordinary false positive because of WHO writes
// heredocs: an agent committing, writing a note, or piping JSON. Governed rules
// quote the very commands they govern, so the noisiest possible input is
// precisely the material this plane exists to produce, and a rule that cries
// wolf on it trains the operator to scroll past the banner that works.
describe("tokenizeCommand: heredoc bodies are data", () => {
  // The TERMINATOR is consumed too, and that is deliberate: `EOF` on its own
  // line is heredoc syntax, not a command. Leaving it as a bare token would put
  // an operator-chosen word into the token stream where a needle could collide
  // with it.
  it("emits no tokens for an unquoted heredoc body", () => {
    expect(tokenizeCommand("cat <<EOF\ngit push origin main\nEOF")).toEqual([["cat", "<<EOF"]]);
  });

  // Quoting the delimiter controls whether the BODY is expanded; it never moves
  // where the body ends, so both forms terminate identically and normalize to
  // the same operator token.
  it("emits no tokens for a quoted heredoc delimiter", () => {
    expect(tokenizeCommand("cat <<'EOF'\ngit push\nEOF")).toEqual([["cat", "<<EOF"]]);
    expect(tokenizeCommand('cat <<"EOF"\ngit push\nEOF')).toEqual([["cat", "<<EOF"]]);
  });

  // `<<-` strips leading TABS from the body and from the terminator, which is
  // why the terminator match is on the trimmed line.
  it("handles the tab-stripping <<- form", () => {
    expect(tokenizeCommand("cat <<-EOF\n\tgit push\n\tEOF")).toEqual([["cat", "<<-EOF"]]);
  });

  it("resumes reading real code AFTER the terminator", () => {
    const segs = tokenizeCommand("cat <<EOF\ngit push\nEOF\ngit status");
    expect(segs[segs.length - 1]).toEqual(["git", "status"]);
  });

  // An unterminated heredoc runs to the end of input. Consuming the rest is the
  // safe direction: it can only cause a MISS (UNKNOWN), never a false match.
  it("consumes to end of input when the terminator never arrives", () => {
    expect(tokenizeCommand("cat <<EOF\ngit push")).toEqual([["cat", "<<EOF"]]);
  });

  // A here-STRING is one word of data.
  it("treats a here-string operand as data", () => {
    expect(tokenizeCommand("cat <<< git")).toEqual([["cat", "<<<"]]);
  });

  // A single `<` is an ordinary redirect and its operand is a real FILE path,
  // not data. Nothing about that changes.
  it("leaves a plain input redirect alone", () => {
    expect(tokenizeCommand("cat < notes.txt")).toEqual([["cat", "<", "notes.txt"]]);
  });
});

describe("classify* : a command that QUOTES an invocation is not that invocation", () => {
  const compApply = [["comp-credit.cjs"], ["--apply"]];

  // The exact shape that misfired in session on 2026-08-07.
  it("does NOT match the invocation quoted inside a commit-message heredoc", () => {
    const cmd =
      "git commit -F - <<'EOF'\n" +
      "feat: governed billing\n\n" +
      "  node tools/billing/comp-credit.cjs --account X --amount 200 --apply\n" +
      "EOF";
    expect(classifyCommandAllOf(cmd, compApply)).toBe("NO_MATCH");
  });

  it("does NOT match a heredoc that writes a script containing the invocation", () => {
    const cmd = "cat > run.sh <<'SH'\nnode comp-credit.cjs --apply\nSH";
    expect(classifyCommandAllOf(cmd, compApply)).toBe("NO_MATCH");
  });

  // And the guard on the guard: the REAL invocation must still fire, including
  // when it follows a heredoc in the same command.
  it("STILL matches the real invocation after a heredoc closes", () => {
    const cmd = "cat <<'EOF'\nnothing\nEOF\nnode tools/billing/comp-credit.cjs --apply";
    expect(classifyCommandAllOf(cmd, compApply)).toBe("MATCHES_FORBIDDEN");
  });

  it("the disjunctive form inherits the same immunity", () => {
    expect(classifyCommand("git commit -F - <<'EOF'\ngit push origin main\nEOF", [["git", "push"]])).toBe(
      "NO_MATCH",
    );
  });
});
