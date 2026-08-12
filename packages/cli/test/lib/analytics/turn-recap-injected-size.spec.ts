// P3.4: the recap states how much context it injected, in MEASURED characters.
//
// Session 607da042 paid roughly 4,589 estimated head tokens across six turns and
// fired one scoped rule. That figure existed the whole time in the
// `mla_rule_injection` event and in the hook trace, and never reached the operator:
// the recap said "floor only, offered: none" and stopped. An invisible recurring
// cost is exactly what the /value page was rebuilt to stop rendering, so the recap
// should not be allowed to keep doing it.
//
// CHARACTERS, not tokens, and that is the point rather than a detail. The reviewer
// required this line to state whether the number is measured or estimated.
// `head_tokens` is ESTIMATED: `rule-meter.ts:30` computes `ceil(bytes / BYTES_PER_TOKEN)`.
// The hook trace already carries `injected_chars`, which is the measured input to
// that estimate (verified on real traces: 2603/4 = 651, 2868/4 = 717, 2897/4 -> 725,
// matching the `head_tokens` those turns emitted). Reporting the measured character
// count sidesteps the estimate entirely, so the recap never asserts a precision it
// does not have.
//
// Note also that on a layer-2 turn `injected_chars` covers the floor AND the evidence
// block (turn 5 of that session: 5157 chars against 861 floor-only head tokens), which
// is the honest total: it is what actually entered the prompt.

import { describe, it, expect } from "@jest/globals";

import { parseAskTrace, renderBlock, renderFooter, type TurnRecap } from "../../../src/lib/analytics/turn-recap";

/** A hook trace line in the shape the real hook writes (keys verified against
 *  ~/.meetless/logs/ask-traces.jsonl for session 607da042). */
function traceLine(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_id: "s1",
    turn_index: 4,
    trace_id: "t-abc",
    hook: {
      injected: true,
      injected_chars: 2897,
      layer2_injected: false,
      enrich_latency_ms: 12,
      ...(over.hook as Record<string, unknown>),
    },
    ...over,
  };
}

function recap(over: Partial<TurnRecap> = {}): TurnRecap {
  return {
    session_id: "s1",
    turn_index: 4,
    trace_id: "t-abc",
    ran: true,
    injected_floor: true,
    injected_evidence: false,
    injected_chars: 2897,
    evidence_offered: false,
    offered_source_ids: [],
    zero_results: false,
    referenced_source_ids: [],
    cited_source_ids: [],
    opened_source_ids: [],
    path_targeted_source_ids: [],
    echoed_source_ids: [],
    engaged_source_ids: [],
    evidence_tools_pulled: [],
    pull_count: 0,
    verdict: "NO_OFFER",
    enrich_latency_ms: 12,
    coverage_gap_type: null,
    not_run_reason: null,
    evidence_layer_down: false,
    evidence_layer_recovered: false,
    retrieved_count: null,
    selected_count: null,
    abstain_class: null,
    primary_no_offer_reason: null,
    ...over,
  } as TurnRecap;
}

describe("P3.4: the recap reports the context it injected", () => {
  it("parses injected_chars off the hook trace", () => {
    const t = parseAskTrace(traceLine());
    expect(t).not.toBeNull();
    expect(t!.injected_chars).toBe(2897);
  });

  it("treats a trace with no injected_chars as unknown, never as zero", () => {
    // An older trace line simply lacks the key. Rendering "0 chars" there would
    // invent a measurement, which is the failure this whole item exists to fix.
    const t = parseAskTrace(traceLine({ hook: { injected: true, layer2_injected: false } }));
    expect(t!.injected_chars).toBeNull();
  });

  it("states the measured size in the one-line footer", () => {
    const line = renderFooter(recap());
    expect(line).toContain("2,897 chars");
    // Never presented as tokens: that number would be estimated.
    expect(line).not.toMatch(/\btok(en)?s?\b/i);
  });

  it("states it in the expanded block too", () => {
    const block = renderBlock(recap());
    expect(block).toMatch(/injected:\s+2,897 chars/);
  });

  it("says nothing at all when the size is unknown", () => {
    // Silence is correct for an old trace. A line reading "injected: unknown" on
    // every historical turn is noise that teaches the operator to skip the field.
    const block = renderBlock(recap({ injected_chars: null }));
    expect(block).not.toContain("injected:");
    expect(renderFooter(recap({ injected_chars: null }))).not.toContain("chars");
  });

  it("reports the honest total on an evidence turn, not the floor alone", () => {
    // Turn 5 of the audited session: 5157 chars with layer 2 present, against 861
    // floor-only head tokens. The total is what actually entered the prompt.
    const block = renderBlock(recap({ injected_evidence: true, injected_chars: 5157 }));
    expect(block).toMatch(/injected:\s+5,157 chars/);
  });
});
