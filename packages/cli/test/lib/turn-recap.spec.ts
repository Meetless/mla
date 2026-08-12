import {
  INTEL_NO_OFFER_REASONS,
  computeTurnRecap,
  parseAskTrace,
  renderFooter,
  renderBlockContext,
  renderBlock,
  type TurnRecap,
  type TurnRecapDeps,
} from "../../src/lib/analytics/turn-recap";

// Per-turn assist recap (notes/20260609-mla-per-turn-assist-recap-plan.md, Layer A).
// computeTurnRecap joins the same three LOCAL spool files the followthrough reader
// uses (ask-traces.jsonl / mcp-calls.jsonl / report-citations.jsonl) but for ONE
// (session_id, turn_index) and at window=0 (same turn: at Stop, all of the turn's
// pulls and citations are already on disk). It answers two operator questions:
//   liveness  -- did mla run this turn? (ran / not_run_reason)
//   usefulness -- was the offered evidence used? (verdict USED/IGNORED/NO_OFFER/NOT_RUN)

// --- fixture builders (plain parsed objects, the shape readLog returns) -------

function ask(opts: {
  session?: string;
  turn?: number;
  trace_id?: string | null;
  injected?: boolean;
  layer2?: boolean;
  latency?: number | null;
  offered?: string[];
  arb_reason?: string;
  fail_open?: string | null;
  not_run_reason?: string | null;
  error?: unknown;
  // The governed-KB enrich trace the hook persists under governed_kb_trace (Item 4).
  gkb?: { retrieved_count?: number; selected_count?: number; primary_no_offer_reason?: string };
}): Record<string, unknown> {
  const offered = opts.offered ?? [];
  const hook: Record<string, unknown> = {
    injected: opts.injected ?? true,
    layer2_injected: opts.layer2 ?? offered.length > 0,
    enrich_latency_ms: opts.latency === undefined ? 400 : opts.latency,
    fail_open_reason: opts.fail_open ?? null,
  };
  if (opts.not_run_reason !== undefined) hook.not_run_reason = opts.not_run_reason;
  const line: Record<string, unknown> = {
    trace_id: opts.trace_id === undefined ? "a".repeat(32) : opts.trace_id,
    ts: "2026-06-09T00:00:00Z",
    session_id: opts.session ?? "s1",
    turn_index: opts.turn ?? 1,
    arbitration: {
      decision: opts.injected === false ? "skipped" : "injected",
      reason: opts.arb_reason ?? "enrichment_driven",
      discarded_after_compute: false,
    },
    enrichment: {
      status: "ok",
      context_items: offered.map((sid, i) => ({ id: `ctx_${i + 1}`, source_id: sid, injected: true })),
    },
    hook,
    error: opts.error ?? null,
  };
  if (opts.gkb) line.governed_kb_trace = opts.gkb;
  return line;
}

function mcp(
  session: string,
  turn: number,
  tool: string,
  evidence_tool: boolean,
  source_ids: string[],
): Record<string, unknown> {
  return { ts: "x", event: "tool_used_mcp", session_id: session, turn_index: turn, tool, evidence_tool, query: "", source_ids };
}

function cite(session: string, turn: number, source_ids: string[]): Record<string, unknown> {
  return { ts: "x", event: "report_citations", session_id: session, turn_index: turn, source_ids };
}

function deps(files: {
  traces?: Record<string, unknown>[];
  mcp?: Record<string, unknown>[];
  reports?: Record<string, unknown>[];
}): TurnRecapDeps {
  return {
    readLog: (file: string) =>
      file === "ask-traces.jsonl"
        ? files.traces ?? []
        : file === "mcp-calls.jsonl"
          ? files.mcp ?? []
          : file === "report-citations.jsonl"
            ? files.reports ?? []
            : [],
  };
}

// --- parseAskTrace -----------------------------------------------------------

describe("parseAskTrace", () => {
  it("extracts trace_id, hook flags, latency, and injected source_ids", () => {
    const t = parseAskTrace(ask({ offered: ["NT:a.md", "NT:b.md"], latency: 412, trace_id: "b".repeat(32) }));
    expect(t).not.toBeNull();
    expect(t!.trace_id).toBe("b".repeat(32));
    expect(t!.injected_floor).toBe(true);
    expect(t!.injected_evidence).toBe(true);
    expect(t!.enrich_latency_ms).toBe(412);
    expect(t!.offered_source_ids).toEqual(["NT:a.md", "NT:b.md"]);
  });

  it("returns null when session_id missing or turn_index not numeric", () => {
    expect(parseAskTrace({ turn_index: 1 })).toBeNull();
    expect(parseAskTrace({ session_id: "s1", turn_index: null })).toBeNull();
  });

  it("ignores context_items that were not injected", () => {
    const line = ask({ offered: [] });
    (line.enrichment as Record<string, unknown>).context_items = [
      { id: "ctx_1", source_id: "NT:a.md", injected: false },
    ];
    const t = parseAskTrace(line);
    expect(t!.offered_source_ids).toEqual([]);
  });

  it("reads the governed_kb_trace counts + reason when present (Item 4)", () => {
    const t = parseAskTrace(
      ask({ offered: [], gkb: { retrieved_count: 5, selected_count: 0, primary_no_offer_reason: "all_failed_relevance" } }),
    );
    expect(t!.retrieved_count).toBe(5);
    expect(t!.selected_count).toBe(0);
    expect(t!.primary_no_offer_reason).toBe("all_failed_relevance");
  });

  it("leaves the governed_kb_trace fields null on lines that predate it", () => {
    const t = parseAskTrace(ask({ offered: ["NT:a.md"] }));
    expect(t!.retrieved_count).toBeNull();
    expect(t!.selected_count).toBeNull();
    expect(t!.primary_no_offer_reason).toBeNull();
  });
});

// --- computeTurnRecap: verdicts ----------------------------------------------

describe("computeTurnRecap: verdict", () => {
  it("USED: offered + an overlapping evidence Pull", () => {
    const r = computeTurnRecap(
      "s1",
      7,
      deps({
        traces: [ask({ turn: 7, offered: ["NT:a.md"], latency: 412 })],
        mcp: [mcp("s1", 7, "retrieve_knowledge", true, ["NT:a.md"]), mcp("s1", 7, "retrieve_knowledge", true, ["NT:a.md"])],
      }),
    );
    expect(r.verdict).toBe("USED");
    expect(r.ran).toBe(true);
    expect(r.evidence_offered).toBe(true);
    expect(r.referenced_source_ids).toEqual(["NT:a.md"]);
    expect(r.pull_count).toBe(2);
    expect(r.evidence_tools_pulled).toEqual(["retrieve_knowledge"]);
    expect(r.enrich_latency_ms).toBe(412);
  });

  it("USED: offered + the report cited the offered id (no Pull)", () => {
    const r = computeTurnRecap(
      "s1",
      3,
      deps({ traces: [ask({ turn: 3, offered: ["NT:a.md"] })], reports: [cite("s1", 3, ["NT:a"])] }),
    );
    expect(r.verdict).toBe("USED");
    expect(r.referenced_source_ids).toEqual(["NT:a.md"]);
    expect(r.cited_source_ids).toEqual(["NT:a"]);
    expect(r.pull_count).toBe(0);
  });

  it("IGNORED: offered, but neither pulled nor cited this turn", () => {
    const r = computeTurnRecap("s1", 9, deps({ traces: [ask({ turn: 9, offered: ["NT:a.md", "NT:b.md"], latency: 380 })] }));
    expect(r.verdict).toBe("IGNORED");
    expect(r.evidence_offered).toBe(true);
    expect(r.referenced_source_ids).toEqual([]);
    expect(r.pull_count).toBe(0);
  });

  it("IGNORED: pulled an UNRELATED source (no overlap with the offer)", () => {
    const r = computeTurnRecap(
      "s1",
      9,
      deps({ traces: [ask({ turn: 9, offered: ["NT:a.md"] })], mcp: [mcp("s1", 9, "retrieve_knowledge", true, ["NT:z.md"])] }),
    );
    expect(r.verdict).toBe("IGNORED");
    expect(r.referenced_source_ids).toEqual([]);
    expect(r.pull_count).toBe(1);
  });

  it("relationship_verdict (evidence_tool=false) is NOT a Pull -> IGNORED not USED", () => {
    const r = computeTurnRecap(
      "s1",
      9,
      deps({ traces: [ask({ turn: 9, offered: ["NT:a.md"] })], mcp: [mcp("s1", 9, "relationship_verdict", false, ["NT:a.md"])] }),
    );
    expect(r.verdict).toBe("IGNORED");
    expect(r.referenced_source_ids).toEqual([]);
  });

  it("NO_OFFER: ran (floor) but no evidence offered -> coverage_gap no_relevant_context", () => {
    const r = computeTurnRecap(
      "s1",
      8,
      deps({ traces: [ask({ turn: 8, injected: true, layer2: false, offered: [], arb_reason: "no_relevant_context" })] }),
    );
    expect(r.verdict).toBe("NO_OFFER");
    expect(r.evidence_offered).toBe(false);
    expect(r.zero_results).toBe(true);
    expect(r.coverage_gap_type).toBe("no_relevant_context");
    expect(r.not_run_reason).toBeNull();
  });

  it("NO_OFFER: enrichment timed out (fail-open) -> coverage_gap enrich_timeout", () => {
    const r = computeTurnRecap(
      "s1",
      8,
      deps({
        traces: [ask({ turn: 8, injected: true, layer2: false, offered: [], arb_reason: "enrichment_timeout", fail_open: "timeout" })],
      }),
    );
    expect(r.verdict).toBe("NO_OFFER");
    expect(r.coverage_gap_type).toBe("enrich_timeout");
  });

  it("NO_OFFER: enrichment auth-rejected (401/403) -> coverage_gap enrich_unauthorized (NOT enrich_error)", () => {
    // The dead-session case: the CLI token expired mid-session, intel 401s, the
    // floor still injects but no evidence is offered. This must read as an auth
    // problem, not a generic failure, so the operator sees a re-auth instruction.
    const r = computeTurnRecap(
      "s1",
      8,
      deps({
        traces: [ask({ turn: 8, injected: true, layer2: false, offered: [], arb_reason: "enrichment_unauthorized", fail_open: "unauthorized" })],
      }),
    );
    expect(r.verdict).toBe("NO_OFFER");
    expect(r.coverage_gap_type).toBe("enrich_unauthorized");
  });

  it("NO_OFFER: intel unreachable (connection refused) -> coverage_gap enrich_unreachable, evidence_layer_down", () => {
    // The textbook outage: the hook could not reach intel at all, so it records
    // fail_open_reason "intel_down" (arb "enrichment_intel_down"). This MUST read
    // as a backend outage, never as "nothing matched" -- the friction An hit.
    const r = computeTurnRecap(
      "s1",
      8,
      deps({
        traces: [ask({ turn: 8, injected: true, layer2: false, offered: [], arb_reason: "enrichment_intel_down", fail_open: "intel_down" })],
      }),
    );
    expect(r.verdict).toBe("NO_OFFER");
    expect(r.coverage_gap_type).toBe("enrich_unreachable");
    expect(r.evidence_layer_down).toBe(true);
  });

  it("NO_OFFER: a stop_guard is named, not rendered as 'nothing relevant offered'", () => {
    // THE SAME DEFECT AS intel_down, ONE REASON LATER, IN THIS SAME FUNCTION.
    //
    // The hook sets FAIL_OPEN_REASON="stop_guard" / ARB_REASON="enrichment_stop_guard"
    // (user-prompt-submit.sh, arbitrate_layer2). Neither string contains "timeout",
    // "error", "unauthorized" or "intel_down", so every branch missed it and it fell
    // through to null, which renders exactly like a merits abstain. 23 such rows sit in
    // the local ledger.
    //
    // Found by grepping every other consumer of `fail_open_reason` after fixing the
    // identical hole in `analyze.py`'s `no_offer_reason_for`. The intel_down branch two
    // tests up was added for this exact reason and did not sweep its siblings.
    const r = computeTurnRecap(
      "s1",
      8,
      deps({
        traces: [ask({ turn: 8, injected: true, layer2: false, offered: [], arb_reason: "enrichment_stop_guard", fail_open: "stop_guard" })],
      }),
    );

    expect(r.verdict).toBe("NO_OFFER");
    expect(r.coverage_gap_type).toBe("enrich_stop_guard");
  });

  it("NO_OFFER: a stop_guard does NOT flip evidence_layer_down, because intel answered", () => {
    // The half that must NOT change. intel is UP and its own guard fired mid-answer, so
    // this is not a backend outage and must not be counted as one. This file already
    // states the principle at `intelAnswered`: "a turn that failed for another reason
    // (stop_guard, muted, unauthorized) proves nothing about the backend, and treating
    // it as healthy is what manufactured 160 phantom recoveries". Naming the gap and
    // flipping the outage flag are different claims.
    const r = computeTurnRecap(
      "s1",
      8,
      deps({
        traces: [ask({ turn: 8, injected: true, layer2: false, offered: [], arb_reason: "enrichment_stop_guard", fail_open: "stop_guard" })],
      }),
    );

    expect(r.evidence_layer_down).toBe(false);
  });

  it("NO_OFFER: enrich timeout and enrich error both flip evidence_layer_down", () => {
    const timedOut = computeTurnRecap(
      "s1",
      8,
      deps({ traces: [ask({ turn: 8, injected: true, layer2: false, offered: [], arb_reason: "enrichment_timeout", fail_open: "timeout" })] }),
    );
    expect(timedOut.coverage_gap_type).toBe("enrich_timeout");
    expect(timedOut.evidence_layer_down).toBe(true);

    const errored = computeTurnRecap(
      "s1",
      9,
      deps({ traces: [ask({ turn: 9, injected: true, layer2: false, offered: [], arb_reason: "enrichment_error", fail_open: "error" })] }),
    );
    expect(errored.coverage_gap_type).toBe("enrich_error");
    expect(errored.evidence_layer_down).toBe(true);
  });

  it("NO_OFFER on the MERITS does NOT flip evidence_layer_down (looked, nothing matched)", () => {
    const merits = computeTurnRecap(
      "s1",
      8,
      deps({ traces: [ask({ turn: 8, injected: true, layer2: false, offered: [], arb_reason: "no_relevant_context" })] }),
    );
    expect(merits.verdict).toBe("NO_OFFER");
    expect(merits.evidence_layer_down).toBe(false);

    // A governed zero_candidates abstain is also a merits result, not an outage.
    const zeroCandidates = computeTurnRecap(
      "s1",
      9,
      deps({ traces: [ask({ turn: 9, injected: true, layer2: false, offered: [], gkb: { retrieved_count: 0, selected_count: 0, primary_no_offer_reason: "zero_candidates" } })] }),
    );
    expect(zeroCandidates.evidence_layer_down).toBe(false);
  });

  it("NO_OFFER auth-expired is NOT evidence_layer_down (intel is UP; re-auth, not an outage)", () => {
    const r = computeTurnRecap(
      "s1",
      8,
      deps({ traces: [ask({ turn: 8, injected: true, layer2: false, offered: [], arb_reason: "enrichment_unauthorized", fail_open: "unauthorized" })] }),
    );
    expect(r.coverage_gap_type).toBe("enrich_unauthorized");
    expect(r.evidence_layer_down).toBe(false);
  });

  it("a USED turn is never evidence_layer_down", () => {
    const r = computeTurnRecap(
      "s1",
      7,
      deps({ traces: [ask({ turn: 7, offered: ["NT:a.md"] })], mcp: [mcp("s1", 7, "retrieve_knowledge", true, ["NT:a.md"])] }),
    );
    expect(r.verdict).toBe("USED");
    expect(r.evidence_layer_down).toBe(false);
  });

  // --- a recovered outage is history, not a live alarm ------------------------
  //
  // THE LIVE DEFECT (measured 2026-07-28): the C-lite block injected at the top of
  // turn k carries turn k-1's recap. When k-1 timed out and k reached intel in
  // 1.1 seconds, the agent still read "⚠ evidence layer DOWN (could not reach
  // intel)" in the present tense, in the same hook invocation that had just gotten
  // a healthy answer. 70 turns in the local spool did exactly this.
  //
  // The hook writes THIS turn's ask-traces line (write_trace) BEFORE it appends the
  // recap block, so the answer is already on disk: turn k's own trace says whether
  // intel is up. The recap reads it rather than taking a new flag from the hook, so
  // `mla turn N` gets the same correction for free.

  it("an outage the NEXT turn recovered from is not rendered as a live alarm", () => {
    const r = computeTurnRecap(
      "s1",
      8,
      deps({
        traces: [
          ask({ turn: 8, injected: true, layer2: false, offered: [], arb_reason: "enrichment_timeout", fail_open: "timeout" }),
          // turn 9: intel answered, with evidence. The outage is over.
          ask({ turn: 9, injected: true, layer2: true, offered: ["NT:a.md"], latency: 1129 }),
        ],
      }),
    );
    // The finding stays true as history: turn 8 WAS an outage, not a merits abstain.
    expect(r.evidence_layer_down).toBe(true);
    expect(r.coverage_gap_type).toBe("enrich_timeout");
    // ... but nothing the agent reads may assert a present-tense outage.
    expect(r.evidence_layer_recovered).toBe(true);
    expect(renderFooter(r)).not.toMatch(/⚠/);
    expect(renderFooter(r)).not.toMatch(/DOWN/);
    expect(renderFooter(r)).toMatch(/recovered/);
  });

  it("recovery counts when intel ANSWERED, even if the answer was a no-offer", () => {
    // A governed no-offer still proves intel is reachable: the enrich trace only
    // rides back on a real response. Requiring evidence to have been injected
    // would leave the alarm up through every healthy abstain, which is most turns.
    const r = computeTurnRecap(
      "s1",
      8,
      deps({
        traces: [
          ask({ turn: 8, injected: true, layer2: false, offered: [], arb_reason: "enrichment_intel_down", fail_open: "intel_down" }),
          ask({ turn: 9, injected: true, layer2: false, offered: [], gkb: { retrieved_count: 0, selected_count: 0, primary_no_offer_reason: "router_low_confidence" } }),
        ],
      }),
    );
    expect(r.evidence_layer_recovered).toBe(true);
  });

  it("an outage on the NEWEST turn keeps its alarm (nothing yet proves recovery)", () => {
    // Fail loud. With no later turn on disk we have no evidence intel came back,
    // and silencing the warning on no evidence would be the mirror of the bug.
    const r = computeTurnRecap(
      "s1",
      8,
      deps({ traces: [ask({ turn: 8, injected: true, layer2: false, offered: [], arb_reason: "enrichment_timeout", fail_open: "timeout" })] }),
    );
    expect(r.evidence_layer_recovered).toBe(false);
    expect(renderFooter(r)).toMatch(/⚠ evidence layer DOWN/);
  });

  it("a still-broken next turn keeps the alarm up", () => {
    const r = computeTurnRecap(
      "s1",
      8,
      deps({
        traces: [
          ask({ turn: 8, injected: true, layer2: false, offered: [], arb_reason: "enrichment_timeout", fail_open: "timeout" }),
          ask({ turn: 9, injected: true, layer2: false, offered: [], arb_reason: "enrichment_intel_down", fail_open: "intel_down" }),
        ],
      }),
    );
    expect(r.evidence_layer_recovered).toBe(false);
    expect(renderFooter(r)).toMatch(/⚠ evidence layer DOWN/);
  });

  it("a next turn that never reached enrich does not count as recovery", () => {
    // A muted / suppressed / pull_only turn proves nothing about intel's health.
    const r = computeTurnRecap(
      "s1",
      8,
      deps({
        traces: [
          ask({ turn: 8, injected: true, layer2: false, offered: [], arb_reason: "enrichment_timeout", fail_open: "timeout" }),
          ask({ turn: 9, injected: false, layer2: false, offered: [], not_run_reason: "muted" }),
        ],
      }),
    );
    expect(r.evidence_layer_recovered).toBe(false);
  });

  it("recovery is never claimed on a turn that was not an outage", () => {
    // The flag is a qualifier ON evidence_layer_down, so it can never stand alone.
    const merits = computeTurnRecap(
      "s1",
      8,
      deps({
        traces: [
          ask({ turn: 8, injected: true, layer2: false, offered: [], arb_reason: "no_relevant_context" }),
          ask({ turn: 9, injected: true, layer2: true, offered: ["NT:a.md"] }),
        ],
      }),
    );
    expect(merits.evidence_layer_down).toBe(false);
    expect(merits.evidence_layer_recovered).toBe(false);
  });

  it("NO_OFFER (should have matched): candidates found but all dropped -> should_have_matched + counts", () => {
    // retrieved > 0 && selected == 0 is the recall/ranking-debt signature: the
    // score floor or cap dropped every candidate. This is the miss An wants split
    // out from a correct abstain.
    const r = computeTurnRecap(
      "s1",
      8,
      deps({
        traces: [
          ask({ turn: 8, injected: true, layer2: false, offered: [], gkb: { retrieved_count: 5, selected_count: 0, primary_no_offer_reason: "all_failed_relevance" } }),
        ],
      }),
    );
    expect(r.verdict).toBe("NO_OFFER");
    expect(r.abstain_class).toBe("should_have_matched");
    expect(r.retrieved_count).toBe(5);
    expect(r.selected_count).toBe(0);
    expect(r.coverage_gap_type).toBe("all_failed_relevance");
  });

  it("NO_OFFER (correct abstain): zero candidates -> correct_abstain, not a miss", () => {
    const r = computeTurnRecap(
      "s1",
      8,
      deps({
        traces: [ask({ turn: 8, injected: true, layer2: false, offered: [], gkb: { retrieved_count: 0, selected_count: 0, primary_no_offer_reason: "zero_candidates" } })],
      }),
    );
    expect(r.verdict).toBe("NO_OFFER");
    expect(r.abstain_class).toBe("correct_abstain");
    expect(r.retrieved_count).toBe(0);
    expect(r.coverage_gap_type).toBe("zero_candidates");
  });

  it("NO_OFFER (router low confidence): not_routed, because retrieval never ran", () => {
    // intel emits router_low_confidence from intent_router.py's final "Nothing
    // matched. Do NOT guess (P0): abstain" branch, at confidence 0.0 and BEFORE any
    // retrieval call. Calling that should_have_matched contradicts that class's own
    // definition ("candidates existed"): retrieved_count is structurally 0 here.
    const r = computeTurnRecap(
      "s1",
      8,
      deps({
        traces: [ask({ turn: 8, injected: true, layer2: false, offered: [], gkb: { retrieved_count: 0, selected_count: 0, primary_no_offer_reason: "router_low_confidence" } })],
      }),
    );
    expect(r.verdict).toBe("NO_OFFER");
    expect(r.abstain_class).toBe("not_routed");
    expect(r.retrieved_count).toBe(0);
  });

  it("ranking debt and router debt do not collapse into one number", () => {
    // The regression that started this (2026-07-27 pulse): both reasons mapped to
    // should_have_matched, and router_low_confidence is what intel's deliberately
    // narrow router emits for every ordinary coding prompt. Over 62 production turns
    // it labelled 58 as recall debt, all with retrieved_count 0, burying the real
    // all_failed_relevance misses. The two must stay separable.
    const cls = (reason: string, retrieved: number) =>
      computeTurnRecap(
        "s1",
        8,
        deps({
          traces: [ask({ turn: 8, injected: true, layer2: false, offered: [], gkb: { retrieved_count: retrieved, selected_count: 0, primary_no_offer_reason: reason } })],
        }),
      ).abstain_class;

    // We retrieved and dropped everything: ranking debt, owned by the score floor.
    expect(cls("all_failed_relevance", 5)).toBe("should_have_matched");
    // We never retrieved: router debt, owned by intent_router.py.
    expect(cls("router_low_confidence", 0)).toBe("not_routed");
    expect(cls("all_failed_relevance", 5)).not.toBe(cls("router_low_confidence", 0));
    // And neither one is allowed to read as a clean abstain.
    expect(cls("zero_candidates", 0)).toBe("correct_abstain");
  });

  it("NO_OFFER (router routed it to no_offer on purpose): correct_abstain, never null", () => {
    // primary_surface_no_offer is the intent_type != "unknown" arm of
    // enrich_router_plan.py:144: the router RECOGNIZED the prompt (in prod,
    // "generic_coding" at confidence 0.7) and policy routed it to no_offer, an arm
    // that won a pre-registered trial. It used to fall through to null on a
    // NO_OFFER turn, i.e. the most deliberate abstain we make read as "we have no
    // idea why we said nothing". It was live in the local spool while unmapped.
    const r = computeTurnRecap(
      "s1",
      8,
      deps({
        traces: [ask({ turn: 8, injected: true, layer2: false, offered: [], gkb: { retrieved_count: 0, selected_count: 0, primary_no_offer_reason: "primary_surface_no_offer" } })],
      }),
    );
    expect(r.verdict).toBe("NO_OFFER");
    expect(r.abstain_class).toBe("correct_abstain");
    // Specifically NOT the null that means "instrumentation absent".
    expect(r.abstain_class).not.toBeNull();
  });

  it("every reason intel can emit classifies; null is reserved for instrumentation absent", () => {
    // The classifier drifted from intel's vocabulary once already: it handled six
    // of nine and its comment claimed six was the whole set, so a live reason came
    // back null. Mirroring the vocabulary makes the NEXT divergence a red test
    // rather than a silent null on a production turn.
    for (const reason of INTEL_NO_OFFER_REASONS) {
      const r = computeTurnRecap(
        "s1",
        8,
        deps({
          traces: [ask({ turn: 8, injected: true, layer2: false, offered: [], gkb: { retrieved_count: 0, selected_count: 0, primary_no_offer_reason: reason } })],
        }),
      );
      expect(r.verdict).toBe("NO_OFFER");
      // The assertion message names the offender so a future addition to intel's
      // Literal points straight at the switch that has to grow a case.
      expect([reason, r.abstain_class]).not.toEqual([reason, null]);
    }
    // The reserved meaning holds: a string intel never emits still reads as absent.
    const legacy = computeTurnRecap(
      "s1",
      8,
      deps({
        traces: [ask({ turn: 8, injected: true, layer2: false, offered: [], gkb: { retrieved_count: 0, selected_count: 0, primary_no_offer_reason: "some_future_reason" } })],
      }),
    );
    expect(legacy.abstain_class).toBeNull();
  });

  // F6 (2026-08-08). The mirror below was written to catch exactly this class of
  // drift, and it had already drifted again before anyone read it: intel added
  // `machine_envelope` (199 of 898 prod turns, 22.2%) and the mirror never grew it, so
  // every one of those turns recapped with abstain_class null, which reads as
  // "instrumentation absent" on the single largest NO_OFFER population there is.
  it("the mirror carries EVERY reason intel can emit, including the two it drifted on", () => {
    // A withheld mirror is a deliberate precision abstention: the payload was the
    // agent's own same-session exhaust, so there was nothing to serve.
    expect(INTEL_NO_OFFER_REASONS).toContain("self_echo_only");
    // The harness re-invoked the agent and no human asked anything. Not router debt.
    expect(INTEL_NO_OFFER_REASONS).toContain("machine_envelope");
    // 2026-08-10: intel emits this the moment a session has been served everything its
    // retrieval finds, which on a long session is routine rather than exotic.
    expect(INTEL_NO_OFFER_REASONS).toContain("all_excluded_by_caller");
  });

  it("NO_OFFER (all_excluded_by_caller): repeat-suppression is a correct abstain, not a recall miss", () => {
    // Session cba778a7 turn 9: ten candidates, three banded high, and all ten dropped
    // because the session had already been handed them or had written them itself. It
    // arrived as `all_failed_relevance`, which classifies `should_have_matched`, so the
    // recall dashboard counted the suppression working as a miss. Same family as
    // self_echo_only: withholding what the caller already holds is the product being
    // right, and the counts stay non-zero so the turn is still diagnosable.
    const r = computeTurnRecap(
      "s1",
      9,
      deps({
        traces: [
          ask({
            turn: 9,
            injected: true,
            layer2: false,
            offered: [],
            gkb: { retrieved_count: 10, selected_count: 0, primary_no_offer_reason: "all_excluded_by_caller" },
          }),
        ],
      }),
    );
    expect(r.verdict).toBe("NO_OFFER");
    expect(r.abstain_class).toBe("correct_abstain");
    expect(r.abstain_class).not.toBe("should_have_matched");
  });

  it("NO_OFFER (self_echo_only): a withheld mirror is a correct abstain, never a recall gap", () => {
    // The counts are what make this diagnosable, and they are deliberately NOT zero:
    // candidates existed and the provider succeeded. If this ever classified as
    // should_have_matched, the recall dashboard would grow a permanent phantom miss
    // for turns where mla did exactly the right thing.
    const r = computeTurnRecap(
      "s1",
      8,
      deps({
        traces: [
          ask({
            turn: 8,
            injected: true,
            layer2: false,
            offered: [],
            gkb: { retrieved_count: 1, selected_count: 0, primary_no_offer_reason: "self_echo_only" },
          }),
        ],
      }),
    );
    expect(r.verdict).toBe("NO_OFFER");
    expect(r.abstain_class).toBe("correct_abstain");
    expect(r.abstain_class).not.toBe("should_have_matched");
  });

  it("NO_OFFER (empty_prompt): a caller that sent nothing is a plumbing failure, not router debt", () => {
    // intel split this out of router_low_confidence on 2026-07-31. Before the split
    // the two were byte-identical on the wire, so a client that failed to send the
    // prompt at all was indistinguishable from the router honestly declining to
    // guess -- and only one of those is a defect. It classifies as provider_failure
    // (OUR plumbing broke) and specifically NOT not_routed, which would credit the
    // router with a decision it never got to make: `AskRequest.question` has no
    // min-length validator, so this is a reachable production state.
    const r = computeTurnRecap(
      "s1",
      8,
      deps({
        traces: [ask({ turn: 8, injected: true, layer2: false, offered: [], gkb: { retrieved_count: 0, selected_count: 0, primary_no_offer_reason: "empty_prompt" } })],
      }),
    );
    expect(r.verdict).toBe("NO_OFFER");
    expect(r.abstain_class).toBe("provider_failure");
    expect(r.abstain_class).not.toBe("not_routed");
    // And the mirror carries it, so the totality test above covers it too. Adding a
    // reason to intel without adding it here is the drift this array exists to catch.
    expect(INTEL_NO_OFFER_REASONS).toContain("empty_prompt");
  });

  it("NO_OFFER (provider failure): a degraded surface -> provider_failure, not a recall gap", () => {
    const r = computeTurnRecap(
      "s1",
      8,
      deps({
        traces: [ask({ turn: 8, injected: true, layer2: false, offered: [], gkb: { retrieved_count: 0, selected_count: 0, primary_no_offer_reason: "surface_provider_missing" } })],
      }),
    );
    expect(r.verdict).toBe("NO_OFFER");
    expect(r.abstain_class).toBe("provider_failure");
  });

  it("NO_OFFER without a trace leaves abstain_class null (instrumentation absent, not a correct abstain)", () => {
    const r = computeTurnRecap(
      "s1",
      8,
      deps({ traces: [ask({ turn: 8, injected: true, layer2: false, offered: [], arb_reason: "no_relevant_context" })] }),
    );
    expect(r.verdict).toBe("NO_OFFER");
    expect(r.abstain_class).toBeNull();
    expect(r.retrieved_count).toBeNull();
  });

  it("a trace on an offered (USED) turn does not manufacture an abstain_class", () => {
    const r = computeTurnRecap(
      "s1",
      7,
      deps({
        traces: [ask({ turn: 7, offered: ["NT:a.md"], gkb: { retrieved_count: 4, selected_count: 1 } })],
        mcp: [mcp("s1", 7, "retrieve_knowledge", true, ["NT:a.md"])],
      }),
    );
    expect(r.verdict).toBe("USED");
    expect(r.abstain_class).toBeNull();
    expect(r.retrieved_count).toBe(4);
    expect(r.selected_count).toBe(1);
  });

  it("NOT_RUN: no ask-traces line for the turn -> reason unknown, trace_id null", () => {
    const r = computeTurnRecap("s1", 10, deps({ traces: [ask({ turn: 4 })] }));
    expect(r.verdict).toBe("NOT_RUN");
    expect(r.ran).toBe(false);
    expect(r.not_run_reason).toBeNull();
    expect(r.trace_id).toBeNull();
    expect(r.injected_floor).toBe(false);
  });

  it("NOT_RUN: injected=false control (pull_only) -> suppressed", () => {
    const r = computeTurnRecap(
      "s1",
      10,
      deps({ traces: [ask({ turn: 10, injected: false, layer2: false, offered: [], arb_reason: "pull_only_control" })] }),
    );
    expect(r.verdict).toBe("NOT_RUN");
    expect(r.ran).toBe(true);
    expect(r.not_run_reason).toBe("suppressed");
  });

  it("NOT_RUN: early-exit minimal line names the reason (muted)", () => {
    const r = computeTurnRecap(
      "s1",
      10,
      deps({ traces: [ask({ turn: 10, injected: false, layer2: false, offered: [], not_run_reason: "muted" })] }),
    );
    expect(r.verdict).toBe("NOT_RUN");
    expect(r.not_run_reason).toBe("muted");
  });
});

// --- computeTurnRecap: joins / isolation -------------------------------------

describe("computeTurnRecap: join discipline", () => {
  it("passes the turn's trace_id through to the recap", () => {
    const r = computeTurnRecap("s1", 1, deps({ traces: [ask({ trace_id: "c".repeat(32), offered: ["NT:a.md"] })] }));
    expect(r.trace_id).toBe("c".repeat(32));
  });

  it("does not join across sessions", () => {
    const r = computeTurnRecap(
      "s1",
      1,
      deps({ traces: [ask({ session: "s1", turn: 1, offered: ["NT:a.md"] })], mcp: [mcp("s2", 1, "retrieve_knowledge", true, ["NT:a.md"])] }),
    );
    expect(r.verdict).toBe("IGNORED");
  });

  it("does not join across turns (window=0, same turn only)", () => {
    const r = computeTurnRecap(
      "s1",
      1,
      deps({ traces: [ask({ turn: 1, offered: ["NT:a.md"] })], mcp: [mcp("s1", 2, "retrieve_knowledge", true, ["NT:a.md"])] }),
    );
    expect(r.verdict).toBe("IGNORED");
  });

  it("normalizes ids (trailing .md, case) on both sides of the overlap", () => {
    const r = computeTurnRecap(
      "s1",
      1,
      deps({ traces: [ask({ turn: 1, offered: ["NT:Doc-A.MD"] })], mcp: [mcp("s1", 1, "retrieve_knowledge", true, ["nt:doc-a"])] }),
    );
    expect(r.verdict).toBe("USED");
  });

  it("tolerates the logs being absent (no readLog data) -> NOT_RUN", () => {
    const r = computeTurnRecap("s1", 1, deps({}));
    expect(r.verdict).toBe("NOT_RUN");
    expect(r.ran).toBe(false);
  });
});

// --- render ------------------------------------------------------------------

const used: TurnRecap = {
  session_id: "s1",
  turn_index: 7,
  trace_id: "a".repeat(32),
  ran: true,
  injected_floor: true,
  injected_evidence: true,
  not_run_reason: null,
  enrich_latency_ms: 412,
  evidence_offered: true,
  offered_source_ids: ["NT:a.md", "NT:b.md", "NT:c.md"],
  zero_results: false,
  coverage_gap_type: null,
  evidence_layer_down: false,
  evidence_layer_recovered: false,
  retrieved_count: null,
  selected_count: null,
  abstain_class: null,
  evidence_tools_pulled: ["retrieve_knowledge"],
  pull_count: 2,
  referenced_source_ids: ["DD:abc"],
  cited_source_ids: ["DD:abc"],
  opened_source_ids: [],
  path_targeted_source_ids: [],
  echoed_source_ids: [],
  engaged_source_ids: ["DD:abc"],
  verdict: "USED",
};

describe("renderFooter", () => {
  it("USED line matches the Section 7 format", () => {
    expect(renderFooter(used)).toBe(
      "🔎 mla · turn 7 · evidence injected (3 src, 412ms) · pulled retrieve_knowledge ×2 · cited DD:abc · opened 0 · explicit evidence reference observed",
    );
  });

  it("NO_OFFER renders floor only + the gap phrase", () => {
    const r: TurnRecap = { ...used, turn_index: 8, verdict: "NO_OFFER", evidence_offered: false, zero_results: true, coverage_gap_type: "no_relevant_context", offered_source_ids: [], injected_evidence: false, pull_count: 0, evidence_tools_pulled: [], referenced_source_ids: [], cited_source_ids: [] };
    expect(renderFooter(r)).toBe("🔎 mla · turn 8 · floor only · no candidate matched your prompt · NO_OFFER");
  });

  it("NO_OFFER (should have matched) appends retrieved/selected counts + the class (Item 4)", () => {
    const r: TurnRecap = { ...used, turn_index: 8, verdict: "NO_OFFER", evidence_offered: false, zero_results: true, coverage_gap_type: "all_failed_relevance", retrieved_count: 5, selected_count: 0, abstain_class: "should_have_matched", offered_source_ids: [], injected_evidence: false, pull_count: 0, evidence_tools_pulled: [], referenced_source_ids: [], cited_source_ids: [] };
    expect(renderFooter(r)).toBe(
      "🔎 mla · turn 8 · floor only · candidates found but all fell below the score floor · retrieved 5, selected 0 · should_have_matched · NO_OFFER",
    );
  });

  it("NO_OFFER (correct abstain, zero candidates) shows the counts and correct_abstain", () => {
    const r: TurnRecap = { ...used, turn_index: 8, verdict: "NO_OFFER", evidence_offered: false, zero_results: true, coverage_gap_type: "zero_candidates", retrieved_count: 0, selected_count: 0, abstain_class: "correct_abstain", offered_source_ids: [], injected_evidence: false, pull_count: 0, evidence_tools_pulled: [], referenced_source_ids: [], cited_source_ids: [] };
    expect(renderFooter(r)).toBe(
      "🔎 mla · turn 8 · floor only · retrieval found nothing to offer · retrieved 0, selected 0 · correct_abstain · NO_OFFER",
    );
  });

  it("NO_OFFER (auth expired) renders an actionable re-auth instruction, not a vague failure", () => {
    const r: TurnRecap = { ...used, turn_index: 12, verdict: "NO_OFFER", evidence_offered: false, zero_results: true, coverage_gap_type: "enrich_unauthorized", offered_source_ids: [], injected_evidence: false, pull_count: 0, evidence_tools_pulled: [], referenced_source_ids: [], cited_source_ids: [] };
    expect(renderFooter(r)).toBe("🔎 mla · turn 12 · floor only · Meetless session expired, run `mla login` · NO_OFFER");
  });

  it("NO_OFFER (evidence layer DOWN) renders an unmistakable outage warning, not a merits phrase", () => {
    const r: TurnRecap = { ...used, turn_index: 8, verdict: "NO_OFFER", evidence_offered: false, zero_results: true, coverage_gap_type: "enrich_unreachable", evidence_layer_down: true, offered_source_ids: [], injected_evidence: false, pull_count: 0, evidence_tools_pulled: [], referenced_source_ids: [], cited_source_ids: [] };
    expect(renderFooter(r)).toBe("🔎 mla · turn 8 · floor only · ⚠ evidence layer DOWN (could not reach intel) · NO_OFFER");
  });

  it("NO_OFFER (evidence layer recovered) states it in the PAST tense and drops the warning sign", () => {
    // The recap is always about a FINISHED turn. Once a later turn reached intel,
    // the only honest rendering is history. Keeping "⚠ ... DOWN" here is what made
    // an agent announce an outage while its own enrich was answering in 1.1s.
    const r: TurnRecap = { ...used, turn_index: 8, verdict: "NO_OFFER", evidence_offered: false, zero_results: true, coverage_gap_type: "enrich_unreachable", evidence_layer_down: true, evidence_layer_recovered: true, offered_source_ids: [], injected_evidence: false, pull_count: 0, evidence_tools_pulled: [], referenced_source_ids: [], cited_source_ids: [] };
    expect(renderFooter(r)).toBe(
      "🔎 mla · turn 8 · floor only · evidence layer was down then (could not reach intel), recovered since · NO_OFFER",
    );
  });

  it("no observed engagement renders the raw counts and says exactly that", () => {
    const r: TurnRecap = { ...used, turn_index: 9, verdict: "IGNORED", enrich_latency_ms: 380, offered_source_ids: ["NT:a.md", "NT:b.md", "NT:c.md", "NT:d.md", "NT:e.md"], pull_count: 0, evidence_tools_pulled: [], referenced_source_ids: [], cited_source_ids: [] };
    // The stored verdict is still IGNORED (intel pins the literal); the RENDERING no longer
    // asserts a mental state we never observed. All three deterministic counters are shown so
    // a reader can see which signals were watched for.
    expect(r.verdict).toBe("IGNORED");
    expect(renderFooter(r)).toBe(
      "🔎 mla · turn 9 · evidence injected (5 src, 380ms) · pulled 0 · cited 0 · opened 0 · no explicit evidence reference observed",
    );
  });

  // D5 (session be3cbc73, turn 2). The line read:
  //
  //   ... cited NT:notes/20260807-mla-helpfulness-session-8779efcf-fix-proposal.md · IGNORED
  //
  // and that document was NOT among the three items mla delivered. The agent named it
  // itself, out of eval-harness output it was already holding.
  //
  // THE METRIC IS CORRECT and this is not a metric fix. `referenced_source_ids` IS the
  // intersection of offered against pulled+cited, and the verdict is computed from it
  // properly. The defect is only in the RENDERING: the line printed the RAW
  // `cited_source_ids` next to a verdict derived from the intersection, so a reader saw
  // a governed id and the word IGNORED in one breath with no way to tell that the cited
  // id was never on offer.
  //
  // The two facts are separated rather than one of them dropped. `cited-elsewhere` is
  // arguably the most interesting number mla produces: it is the agent going to governed
  // material mla did NOT supply, which is precisely the gap the push side exists to close.
  it("D5: separates a citation mla OFFERED from one the agent found elsewhere", () => {
    const r: TurnRecap = {
      ...used,
      turn_index: 2,
      offered_source_ids: ["NT:notes/a.md", "NT:notes/b.md", "CC:cmexample0000000000000005"],
      pull_count: 0,
      evidence_tools_pulled: [],
      // One of the two cited ids was on offer; the other the agent brought itself.
      cited_source_ids: ["NT:notes/a.md", "NT:notes/20260807-mla-helpfulness-session-8779efcf-fix-proposal.md"],
      referenced_source_ids: ["NT:notes/a.md"],
      engaged_source_ids: ["NT:notes/a.md"],
      verdict: "USED",
    };
    expect(renderFooter(r)).toBe(
      "🔎 mla · turn 2 · evidence injected (3 src, 412ms) · pulled 0 · cited NT:notes/a.md (+1 elsewhere) · opened 0 · explicit evidence reference observed",
    );
  });

  it("D5: the be3cbc73 line no longer claims a citation for something never offered", () => {
    const r: TurnRecap = {
      ...used,
      turn_index: 2,
      offered_source_ids: ["NT:notes/x.md", "NT:notes/y.md", "CC:cmexample0000000000000005"],
      pull_count: 0,
      evidence_tools_pulled: [],
      cited_source_ids: ["NT:notes/20260807-mla-helpfulness-session-8779efcf-fix-proposal.md"],
      referenced_source_ids: [],
      engaged_source_ids: [],
      opened_source_ids: [],
      verdict: "IGNORED",
    };
    const line = renderFooter(r);
    // The id mla never offered must not sit beside IGNORED as though it had been.
    expect(line).not.toContain("cited NT:notes/20260807-mla-helpfulness-session-8779efcf-fix-proposal.md");
    expect(line).toBe(
      "🔎 mla · turn 2 · evidence injected (3 src, 412ms) · pulled 0 · cited 0 (+1 elsewhere) · opened 0 · no explicit evidence reference observed",
    );
  });

  it("D5: a turn citing only what was offered renders exactly as before (no format churn)", () => {
    // `used` cites DD:abc, which IS in referenced_source_ids. The suffix must not appear
    // at all when there is nothing to disambiguate: every existing line keeps its shape.
    expect(renderFooter(used)).not.toContain("elsewhere");
  });

  // D3, at the surface where the blindness was actually felt. On be3cbc73 turn 1 the
  // agent called retrieve_knowledge TWICE, was refused twice ("intel is unreachable"),
  // and the recap for that turn said `pulled 0` -- byte-identical to a turn where the
  // agent never reached for governed memory at all. That is the strongest signal mla
  // can collect being rendered as its own opposite.
  it("D3: a refused pull is named, not silently folded into `pulled 0`", () => {
    const r: TurnRecap = {
      ...used,
      turn_index: 1,
      pull_count: 0,
      pull_refused_count: 2,
      evidence_tools_pulled: [],
      cited_source_ids: [],
      referenced_source_ids: [],
      opened_source_ids: [],
      engaged_source_ids: [],
      verdict: "IGNORED",
    };
    expect(renderFooter(r)).toBe(
      "🔎 mla · turn 1 · evidence injected (3 src, 412ms) · pulled 0 (2 refused) · cited 0 · opened 0 · no explicit evidence reference observed",
    );
  });

  it("D3: a turn with no refusal renders exactly as before", () => {
    expect(renderFooter({ ...used, pull_refused_count: 0 })).toBe(
      "🔎 mla · turn 7 · evidence injected (3 src, 412ms) · pulled retrieve_knowledge ×2 · cited DD:abc · opened 0 · explicit evidence reference observed",
    );
  });

  it("NOT_RUN (muted) names the reason", () => {
    const r: TurnRecap = { ...used, turn_index: 10, ran: false, injected_floor: false, verdict: "NOT_RUN", not_run_reason: "muted" };
    expect(renderFooter(r)).toBe("🔎 mla · turn 10 · muted this session · NOT_RUN");
  });

  it("NOT_RUN (not_activated) names the reason", () => {
    const r: TurnRecap = { ...used, turn_index: 11, ran: false, injected_floor: false, verdict: "NOT_RUN", not_run_reason: "not_activated" };
    expect(renderFooter(r)).toBe("🔎 mla · turn 11 · not activated for this repo · NOT_RUN");
  });
});

describe("renderBlockContext", () => {
  it("wraps the footer in a meetless-context block with the soft nudge", () => {
    const out = renderBlockContext(used);
    expect(out).toContain('<meetless-context kind="turn-recap" for-turn="7">');
    expect(out).toContain(renderFooter(used));
    expect(out).toMatch(/You may surface this assist recap/);
    expect(out.trimEnd().endsWith("</meetless-context>")).toBe(true);
  });

  it("says the recap is about a FINISHED turn, not the turn being answered now", () => {
    // The block is injected at the TOP of turn 8 and describes turn 7. The turn
    // number was always in the wrapper, but nothing in the prose said "this is
    // history", so a stale condition read as the current state of the world.
    const out = renderBlockContext(used);
    expect(out).toMatch(/turn 7\b.*(already finished|has finished)/);
    expect(out).toMatch(/not the turn you are answering now/);
  });
});

describe("renderBlock", () => {
  it("expands the full recap fields with the verdict", () => {
    const out = renderBlock(used);
    expect(out).toMatch(/turn 7 recap/);
    expect(out).toContain("outcome:    explicit evidence reference observed");
    expect(out).toMatch(/floor \+ evidence/);
    expect(out).toContain("a".repeat(32));
  });

  it("describes a suppressed turn as suppressed, not USED", () => {
    const r: TurnRecap = { ...used, ran: true, injected_floor: false, verdict: "NOT_RUN", not_run_reason: "suppressed", evidence_offered: false, offered_source_ids: [] };
    expect(renderBlock(r)).toMatch(/suppressed/);
  });

  it("expands retrieved/selected/class when the governed-KB trace is present (Item 4)", () => {
    const r: TurnRecap = { ...used, turn_index: 8, verdict: "NO_OFFER", evidence_offered: false, zero_results: true, coverage_gap_type: "all_failed_relevance", retrieved_count: 5, selected_count: 0, abstain_class: "should_have_matched", offered_source_ids: [], injected_evidence: false, pull_count: 0, evidence_tools_pulled: [], referenced_source_ids: [], cited_source_ids: [] };
    const out = renderBlock(r);
    expect(out).toMatch(/retrieved:\s+5/);
    expect(out).toMatch(/selected:\s+0/);
    expect(out).toMatch(/class:\s+should_have_matched/);
  });

  it("omits retrieved/selected/class on a turn with no trace (unchanged block)", () => {
    expect(renderBlock(used)).not.toMatch(/retrieved:/);
  });

  it("surfaces the evidence-layer-DOWN outage callout in the expanded block", () => {
    const r: TurnRecap = { ...used, turn_index: 8, verdict: "NO_OFFER", evidence_offered: false, zero_results: true, coverage_gap_type: "enrich_unreachable", evidence_layer_down: true, offered_source_ids: [], injected_evidence: false, pull_count: 0, evidence_tools_pulled: [], referenced_source_ids: [], cited_source_ids: [] };
    const out = renderBlock(r);
    expect(out).toMatch(/evidence layer DOWN/);
    expect(out).toMatch(/backend outage, not a merits result/);
  });
});

// --- F3: the decision cannot grade itself, and a pull that resolved nothing is
// not a falsifier ------------------------------------------------------------
//
// `correct_abstain` is derived ENTIRELY from intel's own no_offer reason. It is a
// DECISION class, and the recap printed it under a name that reads as a graded
// OUTCOME. On the session that prompted this, turn 5 rendered `correct_abstain`
// while the very same record carried `pulled: retrieve_knowledge x1`: mla declined
// to offer, the agent went and fetched governed evidence by hand, and mla graded
// its own non-offer correct.
//
// The 2026-08-10 owner correction, on top of that fix:
//
//   1. The label `correct_abstain (unverified: ...)` was invalid: the class still
//      SAID correct while the suffix said it was not. The class itself becomes
//      `unverified_abstain`, so nothing downstream can read the wrong word.
//   2. A bare pull COUNT is not contrary evidence. A `retrieve_knowledge` that
//      resolved NOTHING is the corpus AGREEING with the abstention, and the old
//      rule fired on it. Only a successful pull that resolved >=1 governed source
//      id falsifies the abstention.
//   3. The CLI never claims `missed_offer`. That requires establishing the pulled
//      source was ELIGIBLE for the push mechanism at that time, which needs the
//      corpus facts the analyzer has and this process does not. Uncertainty is
//      preserved rather than manufacturing a win or a miss.
//
// deriveAbstainClass (the intel-reason taxonomy) is NOT changed; the demotion is a
// separate step applied on top of it.
describe("an abstention is not certified by the decision that made it", () => {
  const abstainTrace = (turn: number) =>
    ask({ turn, injected: true, layer2: false, offered: [], gkb: { retrieved_count: 0, selected_count: 0, primary_no_offer_reason: "primary_surface_no_offer" } });

  it("demotes to unverified_abstain when a successful pull resolved governed evidence", () => {
    const r = computeTurnRecap(
      "s1",
      9,
      deps({
        traces: [abstainTrace(9)],
        mcp: [mcp("s1", 9, "retrieve_knowledge", true, ["NT:notes/20260712-x.md"])],
      }),
    );
    expect(r.verdict).toBe("NO_OFFER");
    // The word `correct` is gone from the class, not merely qualified after it.
    expect(r.abstain_class).toBe("unverified_abstain");
    expect(r.hand_pulled_source_ids).toEqual(["NT:notes/20260712-x.md"]);
    const line = renderFooter(r);
    expect(line).toContain("unverified");
    expect(line).toMatch(/retrieve_knowledge/);
    expect(line).not.toContain("correct_abstain");
  });

  it("never claims missed_offer, which needs eligibility this process cannot establish", () => {
    const r = computeTurnRecap(
      "s1",
      9,
      deps({
        traces: [abstainTrace(9)],
        mcp: [mcp("s1", 9, "kb_doc_detail", true, ["NT:notes/20260712-x.md"])],
      }),
    );
    expect(r.abstain_class).not.toBe("missed_offer");
    expect(r.abstain_class).toBe("unverified_abstain");
  });

  it("a pull that resolved nothing leaves the abstention as intel classified it", () => {
    // The corpus was asked and returned nothing. That CONFIRMS the abstention; the
    // old rule read it as a falsifier because it counted calls, not resolutions.
    const r = computeTurnRecap(
      "s1",
      9,
      deps({
        traces: [abstainTrace(9)],
        mcp: [mcp("s1", 9, "retrieve_knowledge", true, [])],
      }),
    );
    expect(r.abstain_class).toBe("correct_abstain");
    expect(r.hand_pulled_source_ids).toEqual([]);
    expect(renderFooter(r)).not.toContain("unverified");
  });

  it("a REFUSED pull is not a falsifier: it never reached the corpus", () => {
    const r = computeTurnRecap(
      "s1",
      9,
      deps({
        traces: [abstainTrace(9)],
        mcp: [{ ...mcp("s1", 9, "kb_doc_detail", true, ["NT:notes/20260712-x.md"]), outcome: "error" }],
      }),
    );
    expect(r.pull_refused_count).toBe(1);
    expect(r.hand_pulled_source_ids).toEqual([]);
    expect(r.abstain_class).toBe("correct_abstain");
  });

  it("an ACTION call is not an evidence pull", () => {
    const r = computeTurnRecap(
      "s1",
      9,
      deps({
        traces: [abstainTrace(9)],
        mcp: [mcp("s1", 9, "relationship_verdict", false, ["NT:notes/20260712-x.md"])],
      }),
    );
    expect(r.hand_pulled_source_ids).toEqual([]);
    expect(r.abstain_class).toBe("correct_abstain");
  });

  it("leaves an abstention with no manual pull reading as it did before", () => {
    const r = computeTurnRecap("s1", 10, deps({ traces: [abstainTrace(10)] }));
    expect(r.abstain_class).toBe("correct_abstain");
    expect(renderFooter(r)).not.toContain("unverified");
  });

  it("does not touch a class that never claimed correctness", () => {
    const r = computeTurnRecap(
      "s1",
      11,
      deps({
        traces: [ask({ turn: 11, injected: true, layer2: false, offered: [], gkb: { retrieved_count: 0, selected_count: 0, primary_no_offer_reason: "router_low_confidence" } })],
        mcp: [mcp("s1", 11, "retrieve_knowledge", true, ["NT:notes/20260712-x.md"])],
      }),
    );
    expect(r.abstain_class).toBe("not_routed");
    expect(renderFooter(r)).not.toContain("unverified");
  });
});

// The EXPANDED block is the surface an operator actually reads (`mla turn N`), and
// it prints `class:` on its own line, two lines below `pulled:`. Fixing only the
// one-line footer left the original complaint fully intact there: run against the
// real spool, `mla turn 5 --session 2c0c38b4...` still printed
//   pulled:     retrieve_knowledge x1
//   class:      correct_abstain
// which is the exact pair the finding was about. Caught by exercising the built
// binary, not by the unit test, because the unit test asserted on renderFooter.
describe("the expanded block carries the same falsifier as the footer", () => {
  it("marks correct_abstain unverified in `mla turn` when the agent pulled by hand", () => {
    const r = computeTurnRecap(
      "s1",
      12,
      deps({
        traces: [ask({ turn: 12, injected: true, layer2: false, offered: [], gkb: { retrieved_count: 0, selected_count: 0, primary_no_offer_reason: "primary_surface_no_offer" } })],
        mcp: [mcp("s1", 12, "retrieve_knowledge", true, ["NT:notes/20260712-x.md"])],
      }),
    );
    const block = renderBlock(r);
    expect(block).toMatch(/pulled:\s+retrieve_knowledge/);
    expect(block).toContain("unverified");
  });

  it("leaves the expanded block alone when nothing falsifies the abstention", () => {
    const r = computeTurnRecap(
      "s1",
      13,
      deps({
        traces: [ask({ turn: 13, injected: true, layer2: false, offered: [], gkb: { retrieved_count: 0, selected_count: 0, primary_no_offer_reason: "primary_surface_no_offer" } })],
      }),
    );
    expect(renderBlock(r)).not.toContain("unverified");
  });
});
