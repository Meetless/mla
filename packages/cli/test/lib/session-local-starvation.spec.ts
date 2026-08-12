import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execFileSync } from "child_process";

// WHY session_local reported SUCCEEDED with zero candidates, settled.
//
// The 2026-08-06 fix proposal called this "the single most damning row, because
// everything upstream worked", and asked for a live repro to find "the actual bug":
//
//   intent_type: "session_report"      router_confidence: 0.8
//   surfaces_required/attempted/succeeded: ["session_local"]
//   retrieved_count: 0    primary_no_offer_reason: "zero_candidates"
//
// There is no bug. The zero is correct, and it is correct because of a guard that
// shipped the day before: intel's `_is_self_echo` (enrich_session_local.py) drops any
// prior turn that records a goal and NOTHING about what came of it, because
// "Prior session turn 3. Goal: <the operator's own prompt>" is the question restated,
// not evidence, and it costs a slot real evidence would take.
//
// What that exposed is the real finding, and it is structural. A turn can only escape
// the self-echo guard by carrying a summary, a touched file, a command, or a resolved
// outcome. This hook's ledger (`record_session_turn`) writes ONLY {turn_id, sequence,
// user_goal}. The other three fields are back-filled by `collect_recent_turns` from two
// sources, and BOTH are conditional:
//
//   assistant_summary / commands_run  <- the capture spool, which is drained
//                                        periodically, and attributed to the freshest
//                                        turn only ($i == 0)
//   touched_files                     <- the cumulative session touched-set, filtered
//                                        to the git root, freshest turn only
//
// So every turn at index >= 1 is goal-only BY CONSTRUCTION and can never be served.
//
// Measured on the audited session (d629ac1c) at the moment of the session_report turn:
// the capture spool was fully drained (no <session>.jsonl on disk), and every single
// path in the touched ledger fell OUTSIDE the git root -- the work was in intel/ (a
// sibling repo), the notes vault, and the scratchpad, none of which are under
// the session's own git root. So touched_files was [] as well, the
// freshest turn was goal-only too, and all three were suppressed.
//
// These pin the mechanism so the next reader does not spend a run looking for a bug
// that is a guard doing its job. What is NOT fixed here, deliberately: widening the
// touched-file scope past the git root would change which absolute paths leave this
// machine, and that is a policy call, not a defect to patch mid-audit.

const COMMON = join(__dirname, "../../src/hooks-template/common.sh");

interface WireTurn {
  turn_id: string;
  sequence: number;
  user_goal: string;
  assistant_summary: string;
  touched_files: string[];
  commands_run: string[];
  outcome: string;
}

/** Run `collect_recent_turns` out of the real common.sh against a seeded queue dir. */
function collectRecentTurns(opts: { turns: { seq: number; goal: string }[]; spool?: string[] }): WireTurn[] {
  const home = mkdtempSync(join(tmpdir(), "mla-sl-home-"));
  const queue = join(home, "queue");
  mkdirSync(queue, { recursive: true });
  const sid = "sl_probe";

  writeFileSync(
    join(queue, `${sid}.turns`),
    opts.turns.map((t) => JSON.stringify({ turn_id: `${sid}:${t.seq}`, sequence: t.seq, user_goal: t.goal })).join("\n") + "\n",
  );
  if (opts.spool) writeFileSync(join(queue, `${sid}.jsonl`), opts.spool.join("\n") + "\n");

  const out = execFileSync(
    "bash",
    ["-c", `set -a; MEETLESS_HOME="${home}"; source "${COMMON}" >/dev/null 2>&1; collect_recent_turns "${sid}"`],
    { encoding: "utf8", env: { ...process.env, MEETLESS_HOME: home, HOME: home } },
  );
  return JSON.parse(out.trim() || "[]");
}

/** intel's `_is_self_echo`, mirrored exactly, so the assertions read as one story. */
function isSelfEcho(t: WireTurn): boolean {
  if (t.assistant_summary || t.touched_files.length || t.commands_run.length) return false;
  if (t.outcome && t.outcome.trim().toLowerCase() !== "unknown") return false;
  return Boolean(t.user_goal);
}

const THREE_TURNS = [
  { seq: 1, goal: "check out ~/projects/baml and see if we can leverage it" },
  { seq: 2, goal: "look through the jsonl files of recent sessions" },
  { seq: 3, goal: "what are the 9 prompts without evals" },
];

describe("what the session_local feed can carry", () => {
  it("sends the prior turns at all, so the rest of this suite is not vacuous", () => {
    const turns = collectRecentTurns({ turns: THREE_TURNS });

    expect(turns).toHaveLength(3);
    expect(turns[0].user_goal).toContain("9 prompts");
  });

  it("records a bare goal and nothing about what the turn did", () => {
    // The ledger's whole payload is {turn_id, sequence, user_goal}. Everything else on
    // the wire is a back-fill that may or may not have a source.
    const turns = collectRecentTurns({ turns: THREE_TURNS });

    for (const t of turns) {
      expect(t.outcome).toBe("unknown");
    }
    expect(turns.every((t) => t.user_goal.length > 0)).toBe(true);
  });

  it("leaves every turn past the freshest with no evidence, whatever the spool holds", () => {
    // The back-fill is attributed to $i == 0 only, on purpose: the spool is not
    // turn-indexed, so spreading it would assert a join that cannot be proven. The
    // consequence is that turns 2..N are permanently goal-only.
    const turns = collectRecentTurns({
      turns: THREE_TURNS,
      spool: [JSON.stringify({ event: "assistant_message", payload: { narration: "ran the eval sweep" } })],
    });

    for (const t of turns.slice(1)) {
      expect(t.assistant_summary).toBe("");
      expect(t.commands_run).toEqual([]);
      expect(t.touched_files).toEqual([]);
      expect(isSelfEcho(t)).toBe(true);
    }
  });

  it("starves the surface completely once the capture spool has been drained", () => {
    // The exact live condition of the audited session: no <session>.jsonl on disk, and
    // a touched set whose every path sits outside the git root. Nothing survives, which
    // is what produced retrieved_count 0 with primary_no_offer_reason zero_candidates.
    const turns = collectRecentTurns({ turns: THREE_TURNS });

    expect(turns.every(isSelfEcho)).toBe(true);
  });

  it("serves the freshest turn as soon as the spool has anything to say", () => {
    // The other side of the split: this is NOT a broken provider. Given one narration
    // line, the freshest turn carries real evidence and earns its slot.
    const turns = collectRecentTurns({
      turns: THREE_TURNS,
      spool: [JSON.stringify({ event: "assistant_message", payload: { narration: "ran the eval sweep" } })],
    });

    expect(turns[0].assistant_summary).toBe("ran the eval sweep");
    expect(isSelfEcho(turns[0])).toBe(false);
  });
});
