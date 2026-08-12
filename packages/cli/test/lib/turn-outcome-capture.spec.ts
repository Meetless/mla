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

function collect(opts: { turns: { seq: number; goal: string }[]; spool?: string[]; touched?: string[] }): WireTurn[] {
  const home = mkdtempSync(join(tmpdir(), "mla-outcome-"));
  const queue = join(home, "queue");
  mkdirSync(queue, { recursive: true });
  const sid = "outcome_probe";
  writeFileSync(
    join(queue, `${sid}.turns`),
    opts.turns.map((t) => JSON.stringify({ turn_id: `${sid}:${t.seq}`, sequence: t.seq, user_goal: t.goal })).join("\n") + "\n",
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
  it("a turn that changed files is APPLIED, not unknown", () => {
    const [t] = collect({ turns: GOAL, touched: ["src/a.ts"] });
    expect(t.outcome).toBe("applied");
  });

  it("a turn that ran a mutating command is APPLIED", () => {
    const [t] = collect({ turns: GOAL, spool: [bash("git commit -m 'fix the thing'")] });
    expect(t.outcome).toBe("applied");
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
    // would be exactly the false attribution the shared tree makes so easy.
    const turns = collect({
      turns: [
        { seq: 1, goal: "older turn" },
        { seq: 2, goal: "newer turn" },
      ],
      touched: ["src/a.ts"],
    });
    const older = turns.find((t) => t.user_goal === "older turn")!;
    const newer = turns.find((t) => t.user_goal === "newer turn")!;
    expect(newer.outcome).toBe("applied");
    expect(older.outcome).toBe("unknown");
    expect(older.touched_files).toEqual([]);
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
