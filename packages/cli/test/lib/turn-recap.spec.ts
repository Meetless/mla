import {
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

  it("NO_OFFER (router low confidence): read as should_have_matched (router never retrieved)", () => {
    const r = computeTurnRecap(
      "s1",
      8,
      deps({
        traces: [ask({ turn: 8, injected: true, layer2: false, offered: [], gkb: { retrieved_count: 0, selected_count: 0, primary_no_offer_reason: "router_low_confidence" } })],
      }),
    );
    expect(r.verdict).toBe("NO_OFFER");
    expect(r.abstain_class).toBe("should_have_matched");
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
  retrieved_count: null,
  selected_count: null,
  abstain_class: null,
  evidence_tools_pulled: ["retrieve_knowledge"],
  pull_count: 2,
  referenced_source_ids: ["DD:abc"],
  cited_source_ids: ["DD:abc"],
  verdict: "USED",
};

describe("renderFooter", () => {
  it("USED line matches the Section 7 format", () => {
    expect(renderFooter(used)).toBe(
      "🔎 mla · turn 7 · evidence injected (3 src, 412ms) · pulled retrieve_knowledge ×2 · cited DD:abc · USED",
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

  it("IGNORED renders pulled/cited counts", () => {
    const r: TurnRecap = { ...used, turn_index: 9, verdict: "IGNORED", enrich_latency_ms: 380, offered_source_ids: ["NT:a.md", "NT:b.md", "NT:c.md", "NT:d.md", "NT:e.md"], pull_count: 0, evidence_tools_pulled: [], referenced_source_ids: [], cited_source_ids: [] };
    expect(renderFooter(r)).toBe("🔎 mla · turn 9 · evidence injected (5 src, 380ms) · pulled 0 · cited 0 · IGNORED");
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
});

describe("renderBlock", () => {
  it("expands the full recap fields with the verdict", () => {
    const out = renderBlock(used);
    expect(out).toMatch(/turn 7 recap/);
    expect(out).toMatch(/verdict:\s+USED/);
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
