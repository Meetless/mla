// Phase 5B: resolve a turn's `outcome` from DETERMINISTIC, SESSION-OWNED evidence.
//
// notes/20260805-did-mla-help-...md §2: every observation the session_local
// provider ever served carried `outcome: "unknown"`, because collect_recent_turns
// hardcodes that literal. So the corpus accumulated goals with no verdicts, which
// is exactly the shape that cannot answer "what did we decide".
//
// The attribution rule, and it is the whole design: the capture spool and the
// touched-file set are keyed by THIS session id, so they are session-owned by
// construction. We never read the git log, never diff "commits since session
// start", and never use a timestamp window. Ten or more sessions share this
// working tree; a commit in that window belongs to whoever made it. Omission
// beats false attribution, so a turn with no session-owned evidence stays
// `unknown` and stays suppressed by the self-echo guard.
//
// The enum is intel's (models.py RecentTurnSummary): applied | reverted | blocked
// | unknown. No new state is introduced.
import { execFileSync } from "child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const COMMON = join(__dirname, "../../src/hooks-template/common.sh");

interface WireTurn {
  turn_id: string;
  sequence: number;
  user_goal: string;
  assistant_summary: string;
  touched_files: string[];
  commands_run: string[];
  outcome: string;
  low_trust: boolean;
}

function collect(opts: { turns: { seq: number; goal: string; outcome?: string }[]; spool?: string[]; touched?: string[] }): WireTurn[] {
  const home = mkdtempSync(join(tmpdir(), "mla-outcome-"));
  const queue = join(home, "queue");
  mkdirSync(queue, { recursive: true });
  const sid = "outcome_probe";
  writeFileSync(
    join(queue, `${sid}.turns`),
    opts.turns
      .map((t) => {
        // An explicit `outcome` on the ledger row is the ONLY blocked signal the
        // producer honors: `blocked` is never derived, only preserved when something
        // upstream recorded it (review 2026-08-20). Absent it, the row is the ordinary
        // {turn_id, sequence, user_goal} shape record_session_turn writes today.
        const row: Record<string, unknown> = { turn_id: `${sid}:${t.seq}`, sequence: t.seq, user_goal: t.goal };
        if (t.outcome !== undefined) row.outcome = t.outcome;
        return JSON.stringify(row);
      })
      .join("\n") + "\n",
  );
  if (opts.spool) writeFileSync(join(queue, `${sid}.jsonl`), opts.spool.join("\n") + "\n");
  const touched = JSON.stringify(opts.touched ?? []);
  const out = execFileSync(
    "bash",
    [
      "-c",
      `set -a; MEETLESS_HOME="${home}"; source "${COMMON}" >/dev/null 2>&1; TOUCHED_FILES_JSON='${touched}' collect_recent_turns "${sid}"`,
    ],
    { encoding: "utf8", env: { ...process.env, MEETLESS_HOME: home, HOME: home } },
  );
  return JSON.parse(out.trim() || "[]");
}

const bash = (command: string) => JSON.stringify({ event: "tool_used_bash", payload: { command } });
const said = (narration: string) => JSON.stringify({ event: "assistant_message", payload: { narration } });

const GOAL = [{ seq: 1, goal: "suppress goal-only observations" }];

describe("deterministic turn outcome", () => {
  // ------------------------------------------------------------------------------------
  // An's review (2026-08-20) REJECTED the loose "touched a file => applied" rule and the
  // proposal's inference machinery (no-commit=>blocked, restore-to-HEAD proof, goal/path
  // matching, HEAD comparison). `applied` means an UNAMBIGUOUS TURN-OWNED COMMIT with no
  // revert ambiguity; a mixed commit/revert, a research-only turn, or an uncommitted edit
  // is `unknown`; a pure revert is `reverted`; `blocked` is honored only from an explicit
  // recorded signal, never derived. The conservative table, driven only by the
  // session-owned commands the turn ran (plus the explicit row signal), is below.
  // ------------------------------------------------------------------------------------

  it("SEAM-3 SHAPE: a turn that committed one sub-task AND reverted its goal-work is UNKNOWN, goal omitted", () => {
    // The exact defect F1 exists for: goal names the reverted seam-3 work, the commit
    // landed a DIFFERENT sub-task's files. Pairing them as `applied` is the false
    // attribution. Mixed commit/revert => unknown, and the misleading goal is dropped so
    // it is never associated with the unrelated committed files.
    const [t] = collect({
      turns: [{ seq: 4, goal: "Make active seeding resolve through the stable lineage" }],
      spool: [bash("GIT_INDEX_FILE=$IDX git commit -F .git/COMMIT_EDITMSG"), bash("git checkout -- seed_claims_live.py")],
      touched: ["tools/mla-helpfulness/analyze.py"],
    });
    expect(t.outcome).toBe("unknown");
    expect(t.user_goal).toBe(""); // dropped: never pair a goal with files that do not implement it
    // The files are still described (as committed-this-turn), only the goal pairing is gone.
    expect(t.touched_files).toEqual(["tools/mla-helpfulness/analyze.py"]);
  });

  it("PURE COMMIT: an unambiguous turn-owned commit with no revert is APPLIED, goal kept", () => {
    const [t] = collect({ turns: GOAL, spool: [bash("GIT_INDEX_FILE=$IDX git commit -F .git/COMMIT_EDITMSG")] });
    expect(t.outcome).toBe("applied");
    expect(t.user_goal).toBe("suppress goal-only observations");
  });

  it("PURE COMMIT (plain git commit, no isolated index) is also APPLIED", () => {
    // Outcome asks whether a commit LANDED, not whether it was isolated-index compliant
    // (that is the tier-2b observer's job, a separate concern).
    const [t] = collect({ turns: GOAL, spool: [bash("git commit -m 'fix the thing'")] });
    expect(t.outcome).toBe("applied");
  });

  it("PURE REVERT (discard): a turn that only DISCARDED uncommitted work and committed nothing is REVERTED", () => {
    // Discard = git restore / checkout -- path / reset --hard: threw away uncommitted work.
    const [t] = collect({ turns: GOAL, spool: [bash("git checkout -- src/a.ts"), bash("git restore src/b.ts")] });
    expect(t.outcome).toBe("reverted");
  });

  // An's follow-up ruling (2026-08-20): `outcome` is whether the GOAL succeeded, while a
  // shell command is a repository MUTATION. `git revert` COMMITS a rollback (forward,
  // successful work), so a user-requested rollback run with `git revert` must NOT read as
  // `reverted`. We cannot prove from the command that the rollback WAS the goal, so the
  // honest floor is `unknown` with the goal dropped, never `reverted`.
  it("REQUESTED ROLLBACK: `git revert` of a named commit is NOT falsely reverted (unknown, goal dropped)", () => {
    const [t] = collect({
      turns: [{ seq: 1, goal: "revert commit abc123def, it broke prod checkout" }],
      spool: [bash("git revert abc123def --no-edit")],
    });
    expect(t.outcome).not.toBe("reverted"); // the ruling's hard requirement
    expect(t.outcome).toBe("unknown"); // the conservative floor the ruling names
    expect(t.user_goal).toBe(""); // goal dropped: a git-revert command must not be paired as the goal
  });

  it("REQUESTED ROLLBACK: `git revert` with no touched files still drops the goal", () => {
    // git revert runs via Bash, so it never populates TOUCHED_FILES_JSON. The goal must
    // still drop on the git-action signal, not only on a non-empty touched set.
    const [t] = collect({ turns: [{ seq: 1, goal: "roll back the bad migration" }], spool: [bash("git revert HEAD")] });
    expect(t.outcome).toBe("unknown");
    expect(t.user_goal).toBe("");
    expect(t.touched_files).toEqual([]);
  });

  it("MENTION NOT USE: a normal commit whose MESSAGE contains revert/restore is still APPLIED", () => {
    // The subcommand anchor (`git <sub>`) means a word inside a -m message is a mention,
    // not a use: `git commit -m 'revert the flaky skip'` is a commit, not a git-revert.
    const [t] = collect({ turns: GOAL, spool: [bash("git commit -m 'revert the flaky skip and restore the config'")] });
    expect(t.outcome).toBe("applied");
    expect(t.user_goal).toBe("suppress goal-only observations"); // a clean applied keeps its goal
  });

  it("NO COMMIT, NO BLOCK: a turn that only edited files (no commit) is UNKNOWN, not applied", () => {
    // The review's correction of the loose rule: an uncommitted edit's outcome is
    // genuinely unknown (it may be reverted, abandoned, or committed next turn). Omission
    // beats false attribution, so the goal is dropped rather than paired with the files.
    const [t] = collect({ turns: GOAL, touched: ["src/a.ts"] });
    expect(t.outcome).toBe("unknown");
    expect(t.user_goal).toBe("");
    expect(t.touched_files).toEqual(["src/a.ts"]);
  });

  it("NO COMMIT, NO BLOCK: a build-only turn (no commit) is UNKNOWN, not applied", () => {
    // `npm run build` / `rm` / `mv` are activity, not a landed commit. The old rule read
    // them as applied; the review's table says only a commit is applied.
    const [t] = collect({ turns: GOAL, spool: [bash("npm run build"), bash("rm -rf dist")] });
    expect(t.outcome).toBe("unknown");
  });

  it("EXPLICIT BLOCK: a turn with a recorded blocked signal is BLOCKED, never derived", () => {
    // `blocked` is honored ONLY from an explicit recorded outcome on the row. It is never
    // synthesized from "no commit" (the proposal's rejected rule).
    const [t] = collect({ turns: [{ seq: 1, goal: "ship the gated change", outcome: "blocked" }] });
    expect(t.outcome).toBe("blocked");
  });

  it("PEER MOVES HEAD: classification is a pure function of session-owned inputs, unchanged", () => {
    // The producer never reads the git log, diffs against HEAD, or uses a time window, so a
    // peer moving HEAD mid-turn cannot change any classification. Same inputs => same output,
    // twice, and the mixed shape stays `unknown` regardless of the ambient repo state.
    const input = {
      turns: [{ seq: 2, goal: "land the slice" }],
      spool: [bash("GIT_INDEX_FILE=$IDX git commit -F .git/COMMIT_EDITMSG"), bash("git checkout -- other.py")],
      touched: ["a.ts"],
    };
    const first = collect(input)[0];
    const second = collect(input)[0];
    expect(first.outcome).toBe("unknown");
    expect(second.outcome).toBe(first.outcome);
    expect(second.user_goal).toBe(first.user_goal);
  });

  it("a turn that only READ is not applied: reading is not doing", () => {
    // The discriminator has to be mutation, not activity. A turn that grepped and
    // caught fire is still a turn that changed nothing.
    const [t] = collect({ turns: GOAL, spool: [bash("grep -rn foo src/"), bash("ls -la")] });
    expect(t.outcome).toBe("unknown");
  });

  it("a turn with narration but no artifact stays unknown: saying it is not doing it", () => {
    const [t] = collect({ turns: GOAL, spool: [said("I fixed everything and it all works now")] });
    expect(t.outcome).toBe("unknown");
  });

  it("a goal-only turn stays unknown, and therefore stays suppressed", () => {
    const [t] = collect({ turns: GOAL });
    expect(t.outcome).toBe("unknown");
    // The self-echo guard (intel _is_self_echo) still drops it, which is the point:
    // resolving outcomes must not smuggle empty turns back into the corpus.
    expect(t.assistant_summary).toBe("");
    expect(t.touched_files).toEqual([]);
    expect(t.commands_run).toEqual([]);
  });

  it("never invents an outcome for a turn it has no evidence about", () => {
    // Only the freshest turn carries spool evidence (the spool is not turn-indexed,
    // documented in collect_recent_turns). Older turns must NOT inherit it: that
    // would be exactly the false attribution the shared tree makes so easy. The freshest
    // turn OWNS a commit (=> applied, goal kept); the older turn has nothing (=> unknown).
    const turns = collect({
      turns: [
        { seq: 1, goal: "older turn" },
        { seq: 2, goal: "newer turn" },
      ],
      spool: [bash("GIT_INDEX_FILE=$IDX git commit -F .git/COMMIT_EDITMSG")],
    });
    const older = turns.find((t) => t.sequence === 1)!;
    const newer = turns.find((t) => t.sequence === 2)!;
    expect(newer.outcome).toBe("applied");
    expect(newer.user_goal).toBe("newer turn"); // a clean applied commit keeps its goal
    expect(older.outcome).toBe("unknown");
    expect(older.touched_files).toEqual([]);
    expect(older.commands_run).toEqual([]);
  });

  it("only ever emits values from intel's enum", () => {
    const legal = ["applied", "reverted", "blocked", "unknown"];
    for (const probe of [
      collect({ turns: GOAL }),
      collect({ turns: GOAL, touched: ["a.ts"] }),
      collect({ turns: GOAL, spool: [bash("rm -rf /tmp/x"), said("done")] }),
    ]) {
      for (const t of probe) expect(legal).toContain(t.outcome);
    }
  });

  it("does not read the git log, so a peer's commit can never be attributed here", () => {
    // The guard is structural: evidence comes from the session-keyed spool and the
    // session touched-set. A turn with neither is unknown even though this very
    // repo has commits from many sessions in any time window.
    const [t] = collect({ turns: GOAL });
    expect(t.outcome).toBe("unknown");
  });

  // ------------------------------------------------------------------------------------
  // F1 (An review 2026-08-20, note 20260820-...-fc038453): the signals matched raw command
  // text with a BARE-SPACE anchor `(^|[;&| ])`, so a git subcommand MENTIONED inside a
  // heredoc body or mid-line prose (a commit message, a doc, an example) fired as a USE.
  // A committing turn whose message says "git revert" was served `unknown`, goal dropped;
  // and a pure-documentation turn that only WROTE "git commit" read `applied`.
  //
  // The fix ports analyze.py's discipline: strip heredoc BODIES (data, not commands), then
  // anchor every signal at a statement head (start, or after ; && || | or a NEWLINE, since
  // heredoc bodies are gone), with an env-assignment prefix allowance for the commit signal
  // only (`GIT_INDEX_FILE=$IDX git commit`). A mid-line prose "git" is no longer a head.
  // ------------------------------------------------------------------------------------

  it("F1 CHARACTERIZATION (verbatim from session fc038453): a commit whose heredoc message says 'git revert' is APPLIED, goal kept", () => {
    // The self-referential defect: turn 2 of fc038453 committed the git-revert follow-up via
    // scoped-commit.sh, and its OWN commit message contained the prose "git revert". It was
    // served back as outcome=unknown with the goal dropped. The honest outcome is `applied`.
    const [t] = collect({
      turns: [{ seq: 2, goal: "make git revert its own signal" }],
      spool: [bash("cat > msg.txt <<EOF\nfix: git revert is its own signal now\nEOF\nbash scoped-commit.sh -F msg.txt -- common.sh")],
    });
    expect(t.outcome).toBe("applied");
    expect(t.user_goal).toBe("make git revert its own signal"); // goal retained: a clean turn-owned commit
  });

  it("F1 SAFE DIRECTION: a heredoc body with line-start `git revert HEAD` must NOT set the revert signal (still applied via the real commit)", () => {
    // Statement-head anchoring is necessary but not sufficient: inside a heredoc EVERY line is
    // a statement head. The body line `git revert HEAD` is a documentation example, not a run.
    // The turn also runs a real scoped-commit, so it is `applied` -- and would be `unknown`
    // (goal dropped) if the body-line git revert leaked into the revert signal.
    const [t] = collect({
      turns: [{ seq: 1, goal: "document the git revert recipe" }],
      spool: [bash("cat > note.md <<EOF\ngit revert HEAD\nEOF\nbash scoped-commit.sh -F note.md -- x.md")],
    });
    expect(t.outcome).toBe("applied");
    expect(t.user_goal).toBe("document the git revert recipe");
  });

  it("F1 DANGEROUS DIRECTION: a heredoc body with line-start `git commit` and NO executed commit must NOT read APPLIED", () => {
    // The false-`applied` the bare-space anchor caused in the other direction: a pure-docs turn
    // that only WRITES a `git commit` example never committed anything. The reviewer's hard
    // requirement is "must not report applied"; the honest outcome is unknown. The goal SURVIVES
    // here (unlike the git-action cases) precisely because no git action was detected, so there
    // is nothing to falsely pair it with -- the intel self-echo guard drops the empty turn.
    const [t] = collect({
      turns: [{ seq: 1, goal: "write a commit example for the runbook" }],
      spool: [bash("cat > ex.md <<EOF\ngit commit -m fix\nEOF")],
    });
    expect(t.outcome).not.toBe("applied"); // the reviewer's hard requirement
    expect(t.outcome).toBe("unknown");
  });

  it("F1 DANGEROUS DIRECTION: prose `git commit` mid-line inside a heredoc body is not a commit", () => {
    const [t] = collect({
      turns: [{ seq: 1, goal: "explain when a git commit counts" }],
      spool: [bash("cat > doc.md <<EOF\nThe git commit outcome should only count when executed.\nEOF")],
    });
    expect(t.outcome).toBe("unknown");
  });

  it("MULTILINE BOUNDARY: an actual multiline `git revert HEAD` statement is UNKNOWN with the goal dropped", () => {
    // The reviewer's bounded syntax must cover multiline command boundaries. A real `git revert`
    // on the second line of a compound command is a USE (heredoc bodies are already stripped, so
    // a newline is now a safe statement boundary), so the goal must drop, exactly as it does for
    // a `git revert` at the head. On main this stayed `unknown` but WRONGLY kept the goal.
    const [t] = collect({
      turns: [{ seq: 1, goal: "revert HEAD, it broke prod checkout" }],
      spool: [bash("git add -A\ngit revert HEAD --no-edit")],
    });
    expect(t.outcome).toBe("unknown");
    expect(t.user_goal).toBe("");
  });

  it("MULTILINE BOUNDARY: a real commit on the second line of a compound command is APPLIED", () => {
    const [t] = collect({ turns: GOAL, spool: [bash("cd packages/cli\nGIT_INDEX_FILE=$IDX git commit -F .git/COMMIT_EDITMSG")] });
    expect(t.outcome).toBe("applied");
    expect(t.user_goal).toBe("suppress goal-only observations");
  });

  it("HEREDOC-FED COMMIT: `git commit -F - <<EOF` (message via heredoc) is a real commit and is APPLIED", () => {
    // Heredoc stripping keeps the OPENER line, so a commit that reads its message from a heredoc
    // still fires the commit signal; only the message BODY is treated as data.
    const [t] = collect({ turns: GOAL, spool: [bash("git commit -F - <<EOF\nrevert the flaky skip; restore the config\nEOF")] });
    expect(t.outcome).toBe("applied");
    expect(t.user_goal).toBe("suppress goal-only observations");
  });

  it("MENTION NOT USE: prose `scoped-commit.sh` inside an echo (no invocation) is not a commit", () => {
    // scoped-commit.sh is anchored at a statement head too, so a mention inside a quoted echo
    // argument is prose, not a run. (Previously the bare `scoped-commit\\.sh` match fired anywhere.)
    const [t] = collect({ turns: GOAL, spool: [bash('echo "remember to run scoped-commit.sh later"')] });
    expect(t.outcome).toBe("unknown");
  });

  it("SINGLE-QUOTED HEREDOC DELIM: `<<'EOF'` body prose is stripped too", () => {
    const [t] = collect({
      turns: [{ seq: 1, goal: "quote-delimited heredoc" }],
      spool: [bash("cat > m <<'EOF'\nfix: git revert now\nEOF\nbash scoped-commit.sh -F m -- a")],
    });
    expect(t.outcome).toBe("applied");
    expect(t.user_goal).toBe("quote-delimited heredoc");
  });

  it("SCRIPT-WRITING TURN: scoped-commit written INTO a heredoc body is not an invocation", () => {
    // A turn that WRITES a script containing scoped-commit.sh (heredoc body) did not commit.
    const [t] = collect({
      turns: [{ seq: 1, goal: "generate a helper script" }],
      spool: [bash("cat <<EOF > s.sh\nbash scoped-commit.sh -m x -- y\nEOF")],
    });
    expect(t.outcome).toBe("unknown");
  });

  it("PRECEDENCE UNCHANGED: heredoc-message commit that ALSO really discards is still mixed => unknown", () => {
    // The commit reads its message via heredoc (prose ignored), and a real discard runs after.
    // commit AND discard => unknown, goal dropped -- the seam-3 precedence, unaffected by the fix.
    const [t] = collect({
      turns: [{ seq: 3, goal: "land the slice" }],
      spool: [bash("git commit -F - <<EOF\ndone\nEOF\ngit checkout -- other.py")],
      touched: ["a.ts"],
    });
    expect(t.outcome).toBe("unknown");
    expect(t.user_goal).toBe("");
  });

  // ------------------------------------------------------------------------------------
  // F1 second ambiguity (An review 2026-08-26): MULTILINE QUOTED STRINGS. Heredoc stripping
  // does not touch a `-m "..."` message or any other quoted argument, so a git subcommand on
  // a line-start INSIDE a multiline quoted span recreates the mention-vs-use defect through
  // another representation. The fix masks quoted spans (analyze.py `_mask_quoted` semantics,
  // single-quote-first) to `Q` AFTER heredoc stripping and BEFORE the statement-head match,
  // so a newline inside a quote is neither a boundary nor a place a signal can hide.
  // ------------------------------------------------------------------------------------

  it("MULTILINE QUOTED MESSAGE: a real `git commit -m` whose quoted message has a line-start `git revert` stays APPLIED, goal kept", () => {
    const [t] = collect({
      turns: [{ seq: 1, goal: "fix classifier mention-vs-use" }],
      spool: [bash('git commit -m "fix classifier\ngit revert remains conservative"')],
    });
    expect(t.outcome).toBe("applied");
    expect(t.user_goal).toBe("fix classifier mention-vs-use"); // goal retained: the executed command is a commit
  });

  it("MULTILINE QUOTED MENTION: a non-git command whose quoted argument has a line-start `git commit` must NOT read APPLIED", () => {
    // printf writes a two-line doc string; nothing was committed. The quoted `git commit`
    // line must not fire the commit signal.
    const [t] = collect({
      turns: [{ seq: 1, goal: "document the commit rule" }],
      spool: [bash(`printf '%s\\n' "documentation:\ngit commit is only an example"`)],
    });
    expect(t.outcome).not.toBe("applied"); // the reviewer's hard requirement
    expect(t.outcome).toBe("unknown");
  });

  it("QUOTED SEPARATOR PRESERVED: a real `; git revert` OUTSIDE quotes still fires (commit then revert => mixed unknown)", () => {
    // Masking must only remove quoted content, never a real statement separator. A commit
    // followed by a genuine `git revert` is a mixed action, so the conservative floor holds.
    const [t] = collect({
      turns: [{ seq: 1, goal: "commit then roll back" }],
      spool: [bash('git commit -m "wip" ; git revert HEAD --no-edit')],
    });
    expect(t.outcome).toBe("unknown");
    expect(t.user_goal).toBe("");
  });
});
