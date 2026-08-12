import { renderFooter, type TurnRecap } from "../../src/lib/analytics/turn-recap";

// F2 (notes/20260809-mla-session-c7fa280f-the-collision-it-could-not-see.md D2), and the
// note's stated mechanism was WRONG. It reported that turn 4's `evidence injected (1 src)`
// counted "the governance block". It did not, and it cannot: the floor rides its own
// `kind="floor-rules"` block, `is_evidence_item_line` accepts only the trust bands
// `accepted|pending|shadow|agent-observation` (never `MUST`/`SHOULD`), and across all 5,065
// injected `context_items` in the local ledger every single one carries an `NT:`/`CC:`/`DE:`
// citation. That "1 src" was `ctx_pull_1` -- a real 899-character note from the corpus-probe
// pull arm, which does not route through governed-KB retrieval and therefore does not appear
// in `governed_kb_trace.selected_count`. The recap was right and the audit misread it.
//
// So the proposed fix (count `selected_count` instead) would have been a REGRESSION: it
// renders a turn that genuinely delivered a document as if it delivered nothing.
//
// THE REAL DEFECT IS ONE LAYER DOWN, and there is already a field for it. The headline
// counts `offered_source_ids`, which is intel's OFFER, taken before the hook's inline
// budget takes its cut. `hook.delivered_citations` (H4) is read back off the budgeted block
// and is the only field that says WHAT REACHED THE MODEL. They disagree on measured turns:
// session `carryrem` turn 2 offered 3 and delivered 2, and the headline said 3.
//
// The headline now prefers the delivered set whenever it was measured, and falls back to the
// offer only for rows that predate the field (null is UNMEASURED, `[]` is a measured zero).

function recap(over: Partial<TurnRecap> = {}): TurnRecap {
  return {
    session_id: "s1",
    turn_index: 4,
    trace_id: "t".repeat(32),
    ran: true,
    injected_floor: true,
    injected_evidence: true,
    injected_chars: 8485,
    not_run_reason: null,
    enrich_latency_ms: 224,
    evidence_offered: true,
    offered_source_ids: [],
    delivered_source_ids: null,
    zero_results: false,
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
    verdict: "OFFERED",
    ...over,
  } as TurnRecap;
}

const A = "NT:notes/a.md";
const B = "NT:notes/b.md";
const C = "NT:notes/c.md";

describe("F2: the headline counts what reached the model", () => {
  // ---- the actual-evidence case -------------------------------------------

  it("counts the DELIVERED set, not the offer, when the budget dropped items", () => {
    const line = renderFooter(
      recap({ offered_source_ids: [A, B, C], delivered_source_ids: [A, B] }),
    );
    expect(line).toContain("evidence injected (2 src, 224ms)");
    expect(line).not.toContain("(3 src");
  });

  it("counts the offer when delivery matches it", () => {
    const line = renderFooter(
      recap({ offered_source_ids: [A, B, C], delivered_source_ids: [A, B, C] }),
    );
    expect(line).toContain("evidence injected (3 src, 224ms)");
  });

  it("falls back to the offer on a row that predates the delivered field", () => {
    // null is UNMEASURED. Reporting 0 here would invent a delivery failure out of an
    // instrumentation gap, which is the same class of error the field exists to remove.
    const line = renderFooter(
      recap({ offered_source_ids: [A, B, C], delivered_source_ids: null }),
    );
    expect(line).toContain("evidence injected (3 src, 224ms)");
  });

  // ---- the no-offer case ---------------------------------------------------

  it("still reports a document the governed-KB trace never counted", () => {
    // Turn 4 of c7fa280f, verbatim: `primary_surface: no_offer`, `selected_count: 0`, and
    // one real note delivered by the pull arm. The document reached the model, so the
    // headline says so. This is the case that switching to `selected_count` would have
    // silently deleted.
    const line = renderFooter(
      recap({
        offered_source_ids: ["NT:notes/20260709-mla-user-tracking-comprehensive-audit.md"],
        delivered_source_ids: ["NT:notes/20260709-mla-user-tracking-comprehensive-audit.md"],
        retrieved_count: 0,
        selected_count: 0,
      }),
    );
    expect(line).toContain("evidence injected (1 src, 224ms)");
  });

  it("renders NO_OFFER, never an evidence count, when nothing governed was offered", () => {
    const line = renderFooter(
      recap({
        verdict: "NO_OFFER",
        evidence_offered: false,
        injected_evidence: false,
        offered_source_ids: [],
        delivered_source_ids: [],
        retrieved_count: 0,
        selected_count: 0,
      }),
    );
    expect(line).not.toContain("evidence injected");
    expect(line).toContain("NO_OFFER");
  });

  // ---- the floor-only case -------------------------------------------------

  it("a floor-only turn never renders an evidence count", () => {
    // The invariant the note thought was broken. It holds by construction upstream (the
    // floor is a separate block and carries no citation), and it is pinned HERE so a future
    // change that starts projecting rule bullets into `context_items` fails a test instead
    // of quietly inflating the one number an operator reads.
    const line = renderFooter(
      recap({
        verdict: "NO_OFFER",
        evidence_offered: false,
        injected_evidence: false,
        injected_chars: 3923, // static 1340 + floor-rules 2583, the measured floor-only size
        offered_source_ids: [],
        delivered_source_ids: null,
      }),
    );
    expect(line).toContain("floor only");
    expect(line).not.toContain("evidence injected");
    expect(line).toContain("3,923 chars");
  });

  it("a floor that GREW does not become evidence", () => {
    // A turn whose floor delta fired still injected zero evidence.
    const line = renderFooter(
      recap({
        verdict: "NO_OFFER",
        evidence_offered: false,
        injected_evidence: false,
        offered_source_ids: [],
        delivered_source_ids: [],
        floor_delta: "floor +2 rules",
      } as Partial<TurnRecap>),
    );
    expect(line).not.toContain("evidence injected");
    expect(line).toContain("floor +2 rules");
  });

  // ---- the whole point: the number cannot exceed what arrived ---------------

  it("never reports more sources than reached the model on a measured turn", () => {
    for (const [offered, delivered] of [
      [[A, B, C], [A]],
      [[A, B], []],
      [[A], [A]],
    ] as [string[], string[]][]) {
      const line = renderFooter(
        recap({ offered_source_ids: offered, delivered_source_ids: delivered, verdict: "OFFERED" }),
      );
      const m = /evidence injected \((\d+) src/.exec(line);
      expect(m).not.toBeNull();
      expect(Number(m![1])).toBe(delivered.length);
    }
  });
});
