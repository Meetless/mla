import { renderFooter, type TurnRecap } from "../../src/lib/analytics/turn-recap";

// S5 (2026-08-05): the recap said "floor only" about turns that injected.
//
// Turn 8 of session 0db6e770 printed, verbatim:
//
//     🔎 mla · turn 8 · 6,423 chars · floor only · ... · NO_OFFER
//
// while that turn's trace recorded `layer2_injected: true` with three items. Both
// halves of the line are wrong at once, and they are wrong in opposite directions:
// "floor only" denies an injection that happened, and the 6,423 chars beside it
// silently includes the payload it denies. An operator reading the footer cannot tell
// a turn that offered nothing from a turn that spent ~850 tokens echoing the session
// back at itself, which is exactly the invisible recurring cost the /value page was
// rebuilt to stop rendering.
//
// The recap already held everything needed to tell them apart -- `injected_evidence`
// is `hook.layer2_injected` -- and simply never consulted it on the NO_OFFER arm.
//
// Three states, from two booleans:
//
//   no layer 2 at all                 -> "floor only"
//   layer 2, no governed source ids   -> "self-echo only, no governed offer"
//   governed source ids               -> the offered arm, "evidence injected (N src)"
//
// The verdict token is untouched: a self-echo turn IS a NO_OFFER, because nothing
// governed was offered. What changes is that the line stops claiming the payload did
// not exist.

function recap(over: Partial<TurnRecap> = {}): TurnRecap {
  return {
    session_id: "0db6e770",
    turn_index: 8,
    trace_id: "t".repeat(32),
    ran: true,
    injected_floor: true,
    injected_evidence: false,
    injected_chars: 6423,
    not_run_reason: null,
    enrich_latency_ms: 400,
    evidence_offered: false,
    offered_source_ids: [],
    zero_results: true,
    coverage_gap_type: null,
    evidence_layer_down: false,
    evidence_layer_recovered: false,
    retrieved_count: null,
    selected_count: null,
    abstain_class: null,
    evidence_tools_pulled: [],
    pull_count: 0,
    referenced_source_ids: [],
    cited_source_ids: [],
    opened_source_ids: [],
    path_targeted_source_ids: [],
    echoed_source_ids: [],
    engaged_source_ids: [],
    verdict: "NO_OFFER",
    ...over,
  } as TurnRecap;
}

describe("the recap must not deny an injection it charged the operator for", () => {
  it("says 'floor only' only when Layer 2 really did not fire", () => {
    const line = renderFooter(recap({ injected_evidence: false }));

    expect(line).toContain("floor only");
    expect(line).not.toContain("self-echo");
    expect(line).toContain("NO_OFFER");
  });

  it("names a session-local payload instead of calling it 'floor only'", () => {
    // The turn-8 shape: layer 2 injected, no governed source ids.
    const line = renderFooter(recap({ injected_evidence: true }));

    expect(line).toContain("self-echo only, no governed offer");
    expect(line).not.toContain("floor only");
    // Still a NO_OFFER: nothing GOVERNED was offered, and that verdict is correct.
    // What was wrong was the claim that nothing was injected.
    expect(line).toContain("NO_OFFER");
    // The size stays on the head, and now the line accounts for what it covers.
    expect(line).toContain("6,423 chars");
  });

  it("never prints NO_OFFER on a line that claims governed context was injected", () => {
    const line = renderFooter(
      recap({
        injected_evidence: true,
        evidence_offered: true,
        offered_source_ids: ["NT:notes/20260601-x.md", "NT:notes/20260628-y.md"],
        zero_results: false,
        verdict: "IGNORED",
      }),
    );

    expect(line).toContain("evidence injected (2 src");
    expect(line).not.toContain("NO_OFFER");
    expect(line).not.toContain("floor only");
    expect(line).not.toContain("self-echo");
  });

  it("keeps the outage line honest, and still does not call an injection 'floor only'", () => {
    // An outage NO_OFFER carries no governed trace, so there is nothing to inject and
    // "floor only" is true. This pins that the new branch did not disturb it.
    const down = renderFooter(recap({ evidence_layer_down: true, coverage_gap_type: "enrich_unreachable" }));
    expect(down).toContain("floor only");
    expect(down).toContain("evidence layer DOWN");

    // But if Layer 2 somehow DID land on an outage turn, the line must still not deny it.
    const downButInjected = renderFooter(
      recap({ evidence_layer_down: true, coverage_gap_type: "enrich_unreachable", injected_evidence: true }),
    );
    expect(downButInjected).not.toContain("floor only");
    expect(downButInjected).toContain("self-echo only, no governed offer");
  });

  it("says nothing about a payload on a turn that never ran", () => {
    const line = renderFooter(recap({ ran: false, verdict: "NOT_RUN", not_run_reason: "muted", injected_chars: null }));

    expect(line).toContain("NOT_RUN");
    expect(line).not.toContain("floor only");
    expect(line).not.toContain("self-echo");
  });
});
