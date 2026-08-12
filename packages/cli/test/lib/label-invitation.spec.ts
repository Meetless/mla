import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { labelInvitation, renderFooter } from "../../src/lib/analytics/turn-recap";
import {
  claimLabelInvitation,
  runInternalTurnRecap,
} from "../../src/commands/internal-turn-recap";
import type { TurnRecap } from "../../src/lib/analytics/turn-recap";

// B.6 (notes/20260804-value-program-closeout-and-browser-delivery.md §4.4).
//
// `mla label` has worked since 2026-06-03 and has been used ONCE in 4,251 traces. The affordance
// was never the problem; nothing ever asked. These specs pin the three properties that make asking
// safe enough to ship:
//
//   1. EXACT TRACE. `mla label` with no positional argument labels "the latest trace in the current
//      session", so an invitation printed on turn 7 and acted on at turn 9 would silently label the
//      WRONG trace. The invitation names the trace id, which also makes concurrent sessions safe
//      (an explicit id needs no CLAUDE_CODE_SESSION_ID at all).
//   2. ONCE PER SESSION, claimed atomically, and fail-CLOSED. A repeated ask teaches the user to
//      dismiss us, and §3.12 of the value program rejected the count-keyed nag for exactly that
//      reason. A missed ask is recoverable; an unbounded one is not.
//   3. ONLY ON DELIVERY. Asking "was this useful?" about a turn that offered nothing is a question
//      with no referent.

function recap(over: Partial<TurnRecap> = {}): TurnRecap {
  return {
    session_id: "s1",
    turn_index: 7,
    trace_id: "0c87f00d",
    ran: true,
    injected_floor: true,
    injected_evidence: true,
    injected_chars: 2603,
    not_run_reason: null,
    enrich_latency_ms: 120,
    evidence_offered: true,
    offered_source_ids: ["kbdoc:abc"],
    zero_results: false,
    coverage_gap_type: null,
    evidence_layer_down: false,
    evidence_layer_recovered: false,
    retrieved_count: null,
    selected_count: null,
    abstain_class: null,
    evidence_tools_pulled: ["retrieve_knowledge"],
    pull_count: 1,
    referenced_source_ids: ["kbdoc:abc"],
    opened_source_ids: [],
    path_targeted_source_ids: [],
    echoed_source_ids: [],
    engaged_source_ids: ["kbdoc:abc"],
    cited_source_ids: ["kbdoc:abc"],
    opened_source_ids: [],
    path_targeted_source_ids: [],
    echoed_source_ids: [],
    engaged_source_ids: ["kbdoc:abc"],
    verdict: "USED",
    ...over,
  } as TurnRecap;
}

describe("B.6: the invitation names the exact trace", () => {
  it("embeds the trace id, so the command cannot drift to a later turn", () => {
    expect(labelInvitation(recap())).toBe("useful? mla label 0c87f00d --useful | --noisy");
  });

  it("uses only flags `mla label` actually supports", () => {
    // parseLabelArgs throws on an unknown flag, so an invitation naming a flag that does not exist
    // would hand the operator a command that errors. --useful and --noisy are both real.
    const invite = labelInvitation(recap()) ?? "";
    for (const flag of invite.match(/--[a-z-]+/g) ?? []) {
      expect(["--useful", "--noisy"]).toContain(flag);
    }
  });

  it("returns null rather than an ambiguous ask when there is no trace to name", () => {
    // Without a trace id the command would fall back to "latest in session", which is the exact
    // mis-targeting this exists to prevent. No ask is better than a wrong one.
    expect(labelInvitation(recap({ trace_id: null }))).toBeNull();
  });

  it("appends to the footer only when the caller grants the invitation", () => {
    expect(renderFooter(recap())).not.toContain("mla label");
    expect(renderFooter(recap(), { inviteLabel: true })).toContain(
      "useful? mla label 0c87f00d --useful | --noisy",
    );
  });

  it("never appends on NO_OFFER or NOT_RUN, even if the caller grants it", () => {
    // Those arms return before the invitation is reachable, by construction rather than by a check
    // a future edit could forget.
    const noOffer = renderFooter(recap({ verdict: "NO_OFFER" }), { inviteLabel: true });
    const notRun = renderFooter(recap({ verdict: "NOT_RUN", ran: false, not_run_reason: "muted" }), {
      inviteLabel: true,
    });
    expect(noOffer).not.toContain("mla label");
    expect(notRun).not.toContain("mla label");
  });
});

describe("B.6: the once-per-session claim", () => {
  let home: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "mla-label-ask-"));
  });
  afterEach(() => {
    // maxRetries per the repo's teardown guard: a recursive remove races anything still writing
    // into the directory, and a flaky teardown fails a suite that already passed.
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 });
  });

  it("grants the first claim and refuses every later one for the same session", () => {
    expect(claimLabelInvitation("sess-1", home)).toBe(true);
    expect(claimLabelInvitation("sess-1", home)).toBe(false);
    expect(claimLabelInvitation("sess-1", home)).toBe(false);
  });

  it("is per session: a different session still gets its one ask", () => {
    expect(claimLabelInvitation("sess-1", home)).toBe(true);
    expect(claimLabelInvitation("sess-2", home)).toBe(true);
  });

  it("refuses an empty session id rather than writing a shared stamp", () => {
    // A blank id would collapse every anonymous run onto one stamp file, so the first such run would
    // silence all the others.
    expect(claimLabelInvitation("", home)).toBe(false);
  });

  it("fails CLOSED when the state root is unwritable", () => {
    // Everywhere else in this codebase a telemetry fault fails open. Here open means nagging.
    //
    // Rooted under /dev/null, NOT /proc. On Linux, procfs returns ENOENT for a mkdir under
    // /proc, so Node's recursive mkdir retries the missing parent forever. That livelock is
    // synchronous, so it blocks the event loop: jest's timeout never fires, --forceExit never
    // runs, and mla-ci hangs to its 15 minute backstop reporting 0 failures. macOS has no
    // /proc, so it fails fast locally and hides. /dev/null is a file, so mkdir under it gives
    // ENOTDIR immediately on both platforms. See failure-telemetry.spec.ts, which carries the
    // same warning after being the first to hit this.
    expect(claimLabelInvitation("sess-1", "/dev/null/nonexistent-root/nope")).toBe(false);
  });

  it("keeps a session id with path characters inside its own directory", () => {
    expect(claimLabelInvitation("../../escape", home)).toBe(true);
    const files = fs.readdirSync(path.join(home, "label-asks"));
    expect(files).toHaveLength(1);
    expect(files[0]).not.toContain("/");
    expect(files[0]).not.toContain("..");
  });
});

describe("B.6: the command only spends its one ask on a delivering turn", () => {
  function run(over: Partial<TurnRecap>, claims: string[]) {
    const lines: string[] = [];
    return runInternalTurnRecap(["--session", "s1", "--turn", "7"], {
      compute: () => recap(over),
      log: (l) => lines.push(l),
      home: "/unused",
      claimInvitation: (sid) => {
        claims.push(sid);
        return true;
      },
      env: {},
    }).then(() => lines.join("\n"));
  }

  it("attempts the claim and renders the ask on a delivering turn", async () => {
    const claims: string[] = [];
    const out = await run({}, claims);
    expect(claims).toEqual(["s1"]);
    expect(out).toContain("mla label 0c87f00d");
  });

  it("does NOT attempt the claim on NO_OFFER, so the session keeps its one ask", async () => {
    // The load-bearing ordering property. If the claim were attempted before the delivery test, a
    // session that opened with a NO_OFFER would burn its only invitation on a turn with nothing to
    // ask about, and the ask would never appear at all.
    const claims: string[] = [];
    const out = await run({ verdict: "NO_OFFER", offered_source_ids: [] }, claims);
    expect(claims).toEqual([]);
    expect(out).not.toContain("mla label");
  });

  it("does NOT attempt the claim when the turn carries no trace id", async () => {
    const claims: string[] = [];
    await run({ trace_id: null }, claims);
    expect(claims).toEqual([]);
  });
});
