// `delivered_citations` has THREE states, and no reporting surface may collapse them.
//
// The field landed 2026-08-09 (H4). Every trace written before it, and every turn that
// rendered no evidence block, simply lacks the key. `?? []` or a truthiness test would
// read all of those as "a block was rendered and nothing survived", which is the exact
// class of reading error the field was added to end: for five audits running, a
// three-document delivery was reported for a one-document turn because nothing
// distinguished "not instrumented" from "measured, and it was fine".
//
//   missing  -> UNMEASURED. Not a zero, not a count, and excluded from both sides of
//               any rate.
//   []       -> ZERO delivered. A block rendered and the budget took all of it.
//   [a, b]   -> the actual delivered count.
//
// Deliberately NOT a backfill and NOT a compatibility flag: old rows are unmeasured and
// stay that way, which is the honest value.

import { evidenceDelivery, renderAskOutcomes, summarizeAskOutcomes, toAskTraceRow } from "../../src/lib/analytics/ask-outcomes";
import { parseAskTrace } from "../../src/lib/analytics/turn-recap";

/** A trace line with an evidence turn, and `hook` merged from the caller. */
const line = (hook: Record<string, unknown>) => ({
  ts: "2026-08-09T10:00:00Z",
  session_id: "s1",
  turn_index: 1,
  enrichment: { status: "ok" },
  hook: { layer2_injected: true, ...hook },
});

describe("delivered_citations: missing is UNMEASURED, [] is zero", () => {
  it("reads the three states apart in the mla stats ask row", () => {
    expect(toAskTraceRow(line({}))!.deliveredCitations).toBeNull();
    expect(toAskTraceRow(line({ delivered_citations: null }))!.deliveredCitations).toBeNull();
    expect(toAskTraceRow(line({ delivered_citations: [] }))!.deliveredCitations).toEqual([]);
    expect(toAskTraceRow(line({ delivered_citations: ["NT:a", "NT:b"] }))!.deliveredCitations).toEqual(["NT:a", "NT:b"]);
  });

  it("reads the three states apart in the turn recap", () => {
    expect(parseAskTrace(line({}))!.delivered_citations).toBeNull();
    expect(parseAskTrace(line({ delivered_citations: [] }))!.delivered_citations).toEqual([]);
    expect(parseAskTrace(line({ delivered_citations: ["NT:a"] }))!.delivered_citations).toEqual(["NT:a"]);
  });

  // THE ARITHMETIC, which is where a collapse would actually do damage: an unmeasured
  // turn must not enter the denominator, and an explicitly-empty one must.
  it("excludes an unmeasured turn from the rate and counts an empty one", () => {
    const rows = [line({}), line({ delivered_citations: [] }), line({ delivered_citations: ["NT:a", "NT:b"] })]
      .map(toAskTraceRow)
      .filter((r): r is NonNullable<typeof r> => r !== null);
    const d = evidenceDelivery(rows);

    expect(d.evidenceTurns).toBe(3);
    expect(d.measured).toBe(2); // NOT 3: the missing row is unmeasured
    expect(d.delivered).toBe(2);
    expect(d.deliveredNothing).toBe(1); // the explicit [], and only that one
  });

  it("says UNMEASURED, not zero, when no row in the window carries the field", () => {
    const rows = [line({}), line({})].map(toAskTraceRow).filter((r): r is NonNullable<typeof r> => r !== null);
    const text = renderAskOutcomes(summarizeAskOutcomes(rows, { budgetMs: 10000 }), "last 7d").join("\n");

    expect(text).toContain("EVIDENCE DELIVERY  UNMEASURED over 2 evidence turn(s)");
    expect(text).toContain("Not zero.");
    expect(text).not.toMatch(/0 citation\(s\) reached the model/);
  });

  it("says zero delivered, in different words, when the window measured one", () => {
    const rows = [line({ delivered_citations: [] })].map(toAskTraceRow).filter((r): r is NonNullable<typeof r> => r !== null);
    const text = renderAskOutcomes(summarizeAskOutcomes(rows, { budgetMs: 10000 }), "last 7d").join("\n");

    expect(text).toContain("0 citation(s) reached the model over 1 measured turn(s)");
    expect(text).toContain("delivered NOTHING (an explicit empty list, not a missing field)");
    // Scoped to THIS section's own line: the same window is legitimately unmeasured for
    // head pressure, and a whole-text search would read that as a delivery verdict.
    const deliveryLine = text.split("\n").find((l) => l.startsWith("EVIDENCE DELIVERY"))!;
    expect(deliveryLine).not.toContain("UNMEASURED");
  });
});
