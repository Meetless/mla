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
});
