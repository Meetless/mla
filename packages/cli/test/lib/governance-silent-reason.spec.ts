import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";

// The A-0c governance nudge (surface 2) declines to fire far more often than it
// fires, and until now every one of those declines wrote the same thing into the
// trace: `governance: null`. Measured over 3977 real dogfood rows, the block was
// present on 932 and null on 3045, and that null could not distinguish "the
// operator muted it" from "no pending-count cache was ever written" from "the
// cache is corrupt" from "the cache decayed past its TTL".
//
// The live condition on the dogfood machine turned out to be the last of those,
// and it is datable to the minute: the count cache holds {"count":0,"ts":
// 1783301418} (2026-07-06T01:30:18Z), the TTL defaults to 86400s, so it expired
// at 2026-07-07T01:30:18Z, and the last trace row carrying any governance block
// at all is 2026-07-07T01:24:22Z. Six minutes inside the boundary. The surface
// did not break; it decayed on schedule and then stayed dark for three weeks
// writing the same null a muted session writes.
//
// These drive the REAL src/hooks-template/user-prompt-submit.sh, the same way the
// harness drives it: JSON on stdin, MEETLESS_HOME pointed at a sandbox, then read
// the ask-traces.jsonl line the hook actually wrote. No mocks, no re-implemented
// bash.
const HOOK = join(__dirname, "../../src/hooks-template/user-prompt-submit.sh");
const WORKSPACE_ID = "ws_1";
const PROMPT = "add a retry to the fetch function";

type Governance = {
  pending_count: number | null;
  injected: boolean;
  form: string | null;
  silent_reason: string | null;
};

/**
 * Run the hook in a fresh sandbox home. `cache` is the pending-count cache body
 * to write (undefined writes no cache file at all, the live condition).
 */
function runHook(opts: {
  session: string;
  cache?: string;
  env?: Record<string, string>;
  /** Reuse a previous run's sandbox, so per-session state written by turn 1 is visible. */
  home?: string;
}): { governance: Governance; context: string; status: number | null; home: string } {
  const home = opts.home ?? mkdtempSync(join(tmpdir(), "mlgov-home-"));
  const repo = mkdtempSync(join(tmpdir(), "mlgov-repo-"));
  writeFileSync(join(repo, ".meetless.json"), JSON.stringify({ workspaceId: WORKSPACE_ID }));
  mkdirSync(join(home, "logs", "governance"), { recursive: true });
  writeFileSync(
    join(home, "cli-config.json"),
    JSON.stringify({ workspaceId: WORKSPACE_ID, actorUserId: "user_a", intelUrl: "http://127.0.0.1:8100" }),
  );
  if (opts.cache !== undefined) {
    // The path common.sh's governance_count_file() builds: ws id sanitized through
    // `tr -c 'A-Za-z0-9_.-' '_'`, which leaves "ws_1" untouched.
    writeFileSync(join(home, "logs", "governance", `pending-count-${WORKSPACE_ID}.json`), opts.cache);
  }

  const r = spawnSync("bash", [HOOK], {
    input: JSON.stringify({ session_id: opts.session, prompt: PROMPT, cwd: repo }),
    encoding: "utf8",
    // The activation gate walks up from the subprocess $PWD, not the stdin cwd field.
    cwd: repo,
    env: { ...process.env, MEETLESS_HOME: home, HOME: home, ...(opts.env ?? {}) },
    timeout: 15000,
  });

  const lines = readFileSync(join(home, "logs", "ask-traces.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
  // A reused home accumulates one line per turn; the newest is this run's.
  if (opts.home === undefined) expect(lines).toHaveLength(1);

  let context = "";
  try {
    context = JSON.parse(r.stdout || "{}")?.hookSpecificOutput?.additionalContext ?? "";
  } catch {
    context = "";
  }
  return { governance: lines[lines.length - 1].governance, context, status: r.status, home };
}

const nowSec = () => Math.floor(Date.now() / 1000);

describe("governance nudge: silence is recorded, not implied", () => {
  it("no cache file at all reports no_pending_count_cache, not a bare null", () => {
    // A workspace where nobody has ever run `mla kb pending`: governance-cache.ts
    // never wrote the count file. Distinct from stale_pending_count_cache below, and the
    // distinction is the whole point: this one is fixed by running the command
    // once, that one is fixed by running it AGAIN.
    const { governance, status } = runHook({ session: "gov_no_pending_count_cache" });
    expect(status).toBe(0);
    expect(governance.silent_reason).toBe("no_pending_count_cache");
    expect(governance.pending_count).toBeNull();
    expect(governance.injected).toBe(false);
  });

  it("the kill switch reports disabled, which is a choice and not a fault", () => {
    const { governance } = runHook({
      session: "gov_disabled",
      cache: JSON.stringify({ count: 3, ts: nowSec() }),
      env: { MEETLESS_GOVERNANCE_HINT: "0" },
    });
    expect(governance.silent_reason).toBe("disabled");
    expect(governance.injected).toBe(false);
  });

  it("a non-numeric count reports malformed_pending_count_cache", () => {
    const { governance } = runHook({
      session: "gov_bad_count",
      cache: JSON.stringify({ count: "abc", ts: nowSec() }),
    });
    expect(governance.silent_reason).toBe("malformed_pending_count_cache");
  });

  it("a non-numeric ts reports malformed_pending_count_cache and NOT stale_pending_count_cache", () => {
    // The regression this test exists for. The old code coerced an unparseable ts
    // to 0, which then tripped the staleness guard, so a CORRUPT file reported
    // itself as merely OLD. That sends the reader to the wrong fix: no amount of
    // waiting for the next `mla kb pending` repairs a malformed file.
    const { governance } = runHook({
      session: "gov_bad_ts",
      cache: JSON.stringify({ count: 3, ts: "not-a-number" }),
    });
    expect(governance.silent_reason).toBe("malformed_pending_count_cache");
    expect(governance.silent_reason).not.toBe("stale_pending_count_cache");
  });

  it("a cache older than the TTL reports stale_pending_count_cache", () => {
    const { governance } = runHook({
      session: "gov_stale",
      cache: JSON.stringify({ count: 3, ts: 1 }),
    });
    expect(governance.silent_reason).toBe("stale_pending_count_cache");
  });

  it("the ACTUAL live dogfood cache bytes report stale_pending_count_cache", () => {
    // Not a synthetic ts:1. These are the literal bytes sitting in
    // ~/.meetless/logs/governance/pending-count-<ws>.json on the machine this was
    // written on, and they are why the whole surface has been dark since
    // 2026-07-07T01:30:18Z. Pinned as a test so the diagnosis is reproducible by
    // someone who does not have that machine, and so a future TTL change has to
    // confront the case that actually happened rather than a made-up one.
    const { governance } = runHook({
      session: "gov_live_bytes",
      cache: '{"count":0,"ts":1783301418}',
    });
    expect(governance.silent_reason).toBe("stale_pending_count_cache");
    // count:0 in the file, but stale wins: a decayed 0 is not a known-empty
    // queue. Reporting pending_count:0 here would claim knowledge we do not have.
    expect(governance.pending_count).toBeNull();
  });

  it("a fresh KNOWN-empty queue keeps silent_reason null: it ran and decided", () => {
    // count==0 is not silence, it is a real answer. Conflating the two is exactly
    // what made the old null unreadable.
    const { governance } = runHook({
      session: "gov_zero",
      cache: JSON.stringify({ count: 0, ts: nowSec() }),
    });
    expect(governance.pending_count).toBe(0);
    expect(governance.silent_reason).toBeNull();
    expect(governance.injected).toBe(false);
  });

  it("a fresh non-empty queue still injects the nudge, with silent_reason null", () => {
    // The instrumentation must not have cost us the behavior it measures.
    const { governance, context } = runHook({
      session: "gov_fires",
      cache: JSON.stringify({ count: 3, ts: nowSec() }),
    });
    expect(governance.pending_count).toBe(3);
    expect(governance.injected).toBe(true);
    expect(governance.form).toBe("prose");
    expect(governance.silent_reason).toBeNull();
    expect(context).toContain('kind="governance"');
    expect(context).toContain("governance_pending_count: 3");
  });

  it("every path emits the same four keys, so a reader never has to probe for one", () => {
    const cases: Array<{ session: string; cache?: string; env?: Record<string, string> }> = [
      { session: "shape_no_pending_count_cache" },
      { session: "shape_disabled", env: { MEETLESS_GOVERNANCE_HINT: "0" } },
      { session: "shape_malformed", cache: JSON.stringify({ count: "abc", ts: nowSec() }) },
      { session: "shape_stale", cache: JSON.stringify({ count: 3, ts: 1 }) },
      { session: "shape_zero", cache: JSON.stringify({ count: 0, ts: nowSec() }) },
      { session: "shape_fires", cache: JSON.stringify({ count: 3, ts: nowSec() }) },
    ];
    for (const c of cases) {
      const { governance } = runHook(c);
      expect(Object.keys(governance).sort()).toEqual(
        ["form", "injected", "pending_count", "silent_reason"].sort(),
      );
      // A silent path never claims to have injected; a live path never carries a
      // reason for a silence that did not happen.
      if (governance.silent_reason !== null) {
        expect(governance.injected).toBe(false);
        expect(governance.pending_count).toBeNull();
      }
    }
  });
});

// P13. Recording a silence in the TRACE is not the same as telling the AGENT.
//
// The block above fixed the trace: every decline now writes a silent_reason instead
// of a bare null. But the agent still saw NOTHING, and on the dogfood machine that
// meant the review-queue lane was dark for 171 hours against a 24h TTL while the last
// cached value, `count: 0`, had been written on a day the corpus held 13,177 pending
// claims. Two failures compound there:
//
//   1. The cache only refreshes when a human runs `mla kb pending`. So the signal
//      whose entire job is to prompt review goes quiet precisely BECAUSE nobody is
//      reviewing. It is a function of the behavior it exists to cause.
//   2. Silence is indistinguishable from a healthy empty queue. "Nothing shown"
//      reads as "nothing pending" to a reader who is not thinking about TTLs.
//
// The invariant these pin: stale or unavailable review data is never presented as
// zero and never silently suppressed. The agent is told the status is unavailable,
// with the age or last-refresh time, and any old count is shown only when it is
// clearly labeled stale.
describe("governance nudge: unavailable must be SAID, not implied by silence", () => {
  const STALE_TS = 1785259234; // 2026-07-28T13:20:34Z, the real dogfood cache stamp

  it("fresh nonzero still nudges with the real count", () => {
    const { governance, context } = runHook({
      session: "p13_fresh_nonzero",
      cache: JSON.stringify({ count: 7, ts: nowSec() }),
    });
    expect(governance.pending_count).toBe(7);
    expect(governance.injected).toBe(true);
    expect(context).toContain("governance_pending_count: 7");
    expect(context).not.toContain("UNAVAILABLE");
  });

  it("fresh zero stays silent, because a known-empty queue IS zero", () => {
    // The one case where silence is honest: the count is current and it is zero.
    const { governance, context } = runHook({
      session: "p13_fresh_zero",
      cache: JSON.stringify({ count: 0, ts: nowSec() }),
    });
    expect(governance.pending_count).toBe(0);
    expect(governance.silent_reason).toBeNull();
    expect(context).not.toContain("UNAVAILABLE");
  });

  it("stale nonzero TELLS the agent, and labels the old count stale", () => {
    const { governance, context } = runHook({
      session: "p13_stale_nonzero",
      cache: JSON.stringify({ count: 42, ts: STALE_TS }),
    });
    expect(governance.silent_reason).toBe("stale_pending_count_cache");
    expect(context).toContain('kind="governance"');
    expect(context).toContain("UNAVAILABLE");
    expect(context).toContain("stale_pending_count_cache");
    // The age or the last-refresh stamp, so a reader can judge it themselves.
    expect(context).toMatch(/last refreshed/i);
    // An old count may appear ONLY when it is unmistakably marked stale.
    expect(context).toContain("42");
    expect(context).toMatch(/STALE/);
  });

  it("stale ZERO is never presented as zero", () => {
    // THE LIVE DOGFOOD CONDITION, and the most dangerous cell in this table: a
    // stale zero is exactly the shape that reads as "all clear" while the real
    // queue holds thousands.
    //
    // NARROWED 2026-08-10 (D4). This used to also require `UNAVAILABLE` and a
    // `last refreshed` line in the payload. The block is gone for this state now (see
    // the "a block with no number does not ride the payload" describe below), so the
    // property that survives is the one this test is actually named for and the one
    // that mattered: a stale zero must never reach the agent as a zero. It cannot,
    // because it does not reach the agent at all.
    const { governance, context } = runHook({
      session: "p13_stale_zero",
      cache: JSON.stringify({ count: 0, ts: STALE_TS }),
    });
    expect(governance.silent_reason).toBe("stale_pending_count_cache");
    // It must NOT assert an empty queue.
    expect(context).not.toMatch(/governance_pending_count: 0\b/);
  });

  // A4 (notes/20260805-did-mla-help-this-session-...md §12.3). The counter is the
  // RELATIONSHIP-candidate count and nothing on the block says so. An operator read
  // "governance_pending_count: UNAVAILABLE" as "the governance backlog is
  // unreadable", paired it with an empty `mla kb pending`, and concluded the review
  // queue was unreachable while 14,108 CLAIMS sat PENDING in a different queue this
  // counter has never touched. Naming the queue is the whole fix; the refresh
  // pointer alone is what created the false generality.
  //
  // Driven off a stale NONZERO since 2026-08-10 (D4): that is the only unavailable
  // state that still renders a block, so it is the only one where the naming can be
  // asserted. The states that used to carry this line now carry nothing at all, which
  // closes the same misread more completely than naming the queue did.
  it("names WHICH queue the count covers, so an unavailable count cannot read as a global one", () => {
    const { context } = runHook({
      session: "p13_names_queue",
      cache: JSON.stringify({ count: 9, ts: STALE_TS }),
    });
    expect(context).toMatch(/relationship/i);
    expect(context).toContain("mla kb claims --pending");
  });

  it("a stale ZERO quotes no count at all, because a stale zero measures nothing", () => {
    // F7 (notes/20260805-mla-session-postmortem-and-fix-proposal.md). The rule
    // above ("a stale count may appear ONLY when unmistakably marked stale") is
    // right for 42 and wrong for 0, and the live dogfood block proves it:
    //
    //   governance_pending_count: UNAVAILABLE (reason: stale_pending_count_cache)
    //   last refreshed 2026-07-28T17:20:34Z (196h ago).
    //   last known count: 0 (STALE, do not treat as current)
    //
    // That third line is the only one carrying a number and it carries nothing.
    // It is not a count (we just said it is not current) and it is not an alarm
    // (it is zero). What it IS, is the exact byte sequence that reads as "all
    // clear" to a skimming agent -- the misread the sibling spec above exists to
    // prevent, reintroduced by the mitigation. A stale NONZERO still prints,
    // because "42 were pending when we last looked" is a real, actionable fact.
    //
    // SUPERSEDED IN PART 2026-08-10 (D4). F7 removed the only numeric line from this
    // state; what remained was a block whose every line said "unknown", so the block
    // itself is gone for this state. The F7 property is preserved and strengthened: a
    // stale zero cannot be quoted, because nothing about it is rendered.
    const { governance, context } = runHook({
      session: "p13_stale_zero_no_count",
      cache: JSON.stringify({ count: 0, ts: STALE_TS }),
    });
    expect(governance.silent_reason).toBe("stale_pending_count_cache");
    expect(context).not.toMatch(/last known count/i);
    expect(context).not.toMatch(/\b0\b\s*\(STALE/);
  });

  it("a missing cache records the reason and shows no count at all", () => {
    // SUPERSEDED IN PART 2026-08-10 (D4): it used to also inject an `UNAVAILABLE`
    // block. Nothing was ever written, so there is no count to label stale or
    // otherwise, and a block that can only say "unknown" no longer rides the payload.
    // The reason is still on the trace every turn, which is where a dark lane is
    // detected without spending model context.
    const { governance, context } = runHook({ session: "p13_missing" });
    expect(governance.silent_reason).toBe("no_pending_count_cache");
    expect(context).not.toMatch(/last known count/i);
    expect(context).not.toContain("UNAVAILABLE");
  });

  it("an unreadable cache (a failed refresh) records the reason and quotes no number", () => {
    // The closest thing to a refresh failure the hook can observe: `mla kb pending`
    // wrote, and what it left cannot be parsed. Quoting a number from it would be
    // inventing a measurement -- and since 2026-08-10 (D4) it says nothing at all,
    // for the same reason: there is no number to state.
    const { governance, context } = runHook({
      session: "p13_refresh_failed",
      cache: '{"count": "abc", "ts": 1785259234}',
    });
    expect(governance.silent_reason).toBe("malformed_pending_count_cache");
    expect(context).not.toMatch(/last known count/i);
    expect(context).not.toContain("UNAVAILABLE");
  });

  it("says it ONCE per session, not on every turn", () => {
    // "Must never silently suppress" is satisfied by saying it. Repeating it every
    // turn adds no information and is exactly the spam the nudge's own per-session
    // throttle exists to prevent: without this the notice would ride on EVERY prompt,
    // indefinitely, in any workspace where nobody has run `mla kb pending`.
    const first = runHook({ session: "p13_once", cache: JSON.stringify({ count: 4, ts: STALE_TS }) });
    expect(first.context).toContain("UNAVAILABLE");

    // Same session id, same sandbox home, so the marker written by the first turn is
    // visible to the second.
    const second = runHook({
      session: "p13_once",
      cache: JSON.stringify({ count: 4, ts: STALE_TS }),
      home: first.home,
    });
    expect(second.context).not.toContain("UNAVAILABLE");
    // The TRACE still carries the reason every turn: throttling the block must never
    // throttle the diagnosis.
    expect(second.governance.silent_reason).toBe("stale_pending_count_cache");
  });

  it("the kill switch stays fully silent, because muting is a choice", () => {
    // MEETLESS_GOVERNANCE_HINT=0 is the operator saying "not now". Emitting an
    // unavailability notice would defeat the switch, which is a different defect
    // than the one being fixed.
    const { governance, context } = runHook({
      session: "p13_disabled",
      cache: JSON.stringify({ count: 5, ts: STALE_TS }),
      env: { MEETLESS_GOVERNANCE_HINT: "0" },
    });
    expect(governance.silent_reason).toBe("disabled");
    expect(context).not.toContain("UNAVAILABLE");
  });
});

// D4 (notes/20260810-mla-helpfulness-session-c5d12c88-...md). A block that cannot state
// a number should not occupy the payload that evidence is being cut from.
//
// WHAT THE PROPOSAL GOT WRONG, measured before changing anything. It reported "~340
// bytes on EVERY turn". Driven against this same hook on 2026-08-10 the block is 429 to
// 447 bytes and it fires ONCE PER SESSION: the `unavail-<session>.json` marker already
// throttles it, and the sibling test above pins that. The cost is therefore ~445 bytes
// once, not 340 per turn, and D4's cost argument is roughly N times weaker than filed.
//
// WHAT IS STILL TRUE, and why this ships anyway. In three of the four unavailable
// states the block carries NO NUMBER at all:
//
//   no_pending_count_cache      429B   "never refreshed in this workspace."
//   stale_pending_count_cache   444B   "last refreshed <ts> (55h ago)."     [count 0]
//   malformed_..._cache         447B   "last refreshed <ts> (0h ago)."
//   stale_pending_count_cache   498B   "last known count: 42 (STALE...)"   [count 42]
//
// The first three spend their bytes telling the agent that a counter is unknown and
// that it should go run `mla kb pending`, which no agent will do mid-task. The fourth
// states a real, actionable fact: 42 were pending when we last looked.
//
// The visibility argument that put this block here is now satisfied elsewhere and by
// better mechanisms, both of which shipped AFTER it:
//
//   * `spawn_governance_count_refresh` repairs the cache in the background, so the
//     unknown state fixes itself on the next turn instead of waiting for a human. It is
//     working on the live dogfood machine: the cache was refreshed 1.1h before this was
//     written, and the workspace consequently emits no block at all.
//   * `governance.silent_reason` is written to the trace on EVERY turn, throttled or
//     not, so a lane going dark for 171 hours is detectable without spending a byte of
//     the model's context.
//
// So the rule is: state a number or say nothing.
describe("governance nudge: a block with no number does not ride the payload", () => {
  // The real dogfood cache stamp, same value the sibling describe uses.
  const STALE_TS = 1785259234;

  it("a never-refreshed workspace injects NOTHING and still records the reason", () => {
    const { governance, context } = runHook({ session: "d4_no_cache" });
    expect(governance.silent_reason).toBe("no_pending_count_cache");
    expect(context).not.toContain('kind="governance"');
    expect(context).not.toContain("UNAVAILABLE");
  });

  it("a stale ZERO injects NOTHING, because a stale zero measures nothing", () => {
    // This is the exact live condition session c5d12c88 measured, and the block it
    // produced is the one that said "unknown, go run a command" for 25 hours.
    const { governance, context } = runHook({
      session: "d4_stale_zero",
      cache: JSON.stringify({ count: 0, ts: STALE_TS }),
    });
    expect(governance.silent_reason).toBe("stale_pending_count_cache");
    expect(context).not.toContain('kind="governance"');
  });

  it("a malformed cache injects NOTHING, because it has no number to quote either", () => {
    const { governance, context } = runHook({
      session: "d4_malformed",
      cache: '{"count": "abc", "ts": 1785259234}',
    });
    expect(governance.silent_reason).toBe("malformed_pending_count_cache");
    expect(context).not.toContain('kind="governance"');
  });

  it("a stale NONZERO still speaks, because it has something to say", () => {
    // The one unavailable state that is not dropped. "42 were pending when we last
    // looked" is a fact an operator can act on, and the STALE label is what keeps it
    // from being read as current. Dropping this too would trade a real signal for the
    // same bytes the numberless cases waste.
    const { governance, context } = runHook({
      session: "d4_stale_nonzero",
      cache: JSON.stringify({ count: 42, ts: STALE_TS }),
    });
    expect(governance.silent_reason).toBe("stale_pending_count_cache");
    expect(context).toContain("UNAVAILABLE");
    expect(context).toContain("42");
    expect(context).toMatch(/STALE/);
    // The queue is still named: an unavailable count must not read as a global one.
    expect(context).toMatch(/relationship/i);
  });

  it("the self-heal still fires on a state that now injects nothing", () => {
    // THE PROPERTY THAT MAKES THE DROP SAFE. Silence is only acceptable because the
    // condition repairs itself; if dropping the block also dropped the refresh, this
    // would be a regression to the 171-hour dark lane, not a fix.
    const { home } = runHook({ session: "d4_selfheal", cache: JSON.stringify({ count: 0, ts: STALE_TS }) });
    const marker = join(home, "logs", "governance", `refresh-${WORKSPACE_ID}.json`);
    expect(existsSync(marker)).toBe(true);
  });
});
