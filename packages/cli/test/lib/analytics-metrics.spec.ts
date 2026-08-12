// The metric family math (spec section 5, T4.3, INV-METRIC-DEFINITION-1). The
// load-bearing test is the worked example the review used to kill the old
// single-number metric: the same two injects read 100% on the wall metric and
// 18.18% on the item drilldown, and the two are reported as SEPARATE numbers.

import {
  MetricInput,
  REFERENCE_PRECISION_V1_LABEL,
  computeMetrics,
} from "../../src/lib/analytics/metrics";

const mk = (over: Partial<MetricInput>): MetricInput => ({
  evidence_offered: 1,
  offered_source_ids: ["d1"],
  referenced: false,
  referenced_source_ids: [],
  outcome: "ignored",
  ...over,
});

describe("computeMetrics", () => {
  it("the worked example: A offers 10 ref 1, B offers 1 ref 1 -> 100% injection, 18.18% item, separate", () => {
    const A: MetricInput = {
      evidence_offered: 10,
      offered_source_ids: ["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8", "a9", "a10"],
      referenced: true,
      referenced_source_ids: ["a1"],
      outcome: "used",
    };
    const B: MetricInput = {
      evidence_offered: 1,
      offered_source_ids: ["b1"],
      referenced: true,
      referenced_source_ids: ["b1"],
      outcome: "used",
    };
    const m = computeMetrics([A, B]);
    // Injection Utilization = injects referenced / injects offered = 2/2.
    expect(m.injection_utilization).toBe(1);
    // Evidence Item Utilization = distinct referenced ids / distinct offered ids
    // = 2/11 = 0.1818..., the honest drilldown the old formula hid.
    expect(m.evidence_item_utilization).toBeCloseTo(2 / 11, 6);
    expect(m.distinct_offered).toBe(11);
    expect(m.distinct_referenced).toBe(2);
    // Reported as two distinct fields; the test would fail if they were collapsed.
    expect(m.injection_utilization).not.toBe(m.evidence_item_utilization);
  });

  it("reference_precision_v1 = used/(used+ignored); pending and unknown excluded from it", () => {
    const m = computeMetrics([
      mk({ referenced: true, outcome: "used" }),
      mk({ referenced: false, outcome: "ignored" }),
      mk({ referenced: false, outcome: "unknown" }),
      mk({ referenced: false, outcome: "pending" }),
    ]);
    expect(m.reference_precision_v1).toBe(0.5); // 1 / (1 + 1)
    expect(m.unknown_coverage).toBeCloseTo(1 / 3, 6); // 1 unknown / 3 closed windows
    expect(m.used).toBe(1);
    expect(m.ignored).toBe(1);
    expect(m.unknown).toBe(1);
    expect(m.pending).toBe(1);
    expect(m.closed_windows).toBe(3); // pending is open, not closed
  });

  // INV-LOCAL-STATS-2, REVISED 2026-08-08 (F4). The invariant carried three claims and
  // only one of them is being changed, so they are split rather than deleted.
  //
  //   KEPT: a pending inject is never DROPPED from the report (it is reported as
  //         `unresolved`, with its own count, and `pending` still holds it).
  //   KEPT: a pending inject is never counted `ignored`.
  //   RETIRED: "a pending inject stays in the RATE denominator". That clause made an
  //         open window arithmetically identical to a miss, which is the exact thing
  //         the invariant's own prose ("never silently calls them ignored",
  //         notes/20260607-mla-tracking-and-analytics.md §7.4) forbids. An open window
  //         is CENSORED: the opportunity has not been observed yet, so it cannot be
  //         evidence either way.
  //
  // This is the rule `no_opportunity` already carries ("the agent never had a turn is
  // not a missed use, so it can never drag down a utilization or precision rate",
  // 4d51c879 / ce081439), extended to the other unobserved class. It is an extension of
  // the governed direction, not a reversal of it.
  it("INV-LOCAL-STATS-2 (kept): a pending inject is reported, never counted ignored", () => {
    const m = computeMetrics([
      mk({
        evidence_offered: 1,
        offered_source_ids: ["x"],
        referenced: true,
        referenced_source_ids: ["x"],
        outcome: "used",
      }),
      mk({
        evidence_offered: 1,
        offered_source_ids: ["y"],
        referenced: false,
        referenced_source_ids: [],
        outcome: "pending",
      }),
    ]);
    expect(m.ignored).toBe(0); // NOT counted as ignored
    expect(m.pending).toBe(1); // NOT dropped from the report
    expect(m.unresolved).toBe(1); // and named for what it is
  });

  it("F4: an open window is CENSORED out of every rate denominator, not scored a miss", () => {
    const m = computeMetrics([
      mk({
        evidence_offered: 1,
        offered_source_ids: ["x"],
        referenced: true,
        referenced_source_ids: ["x"],
        outcome: "used",
      }),
      mk({
        evidence_offered: 1,
        offered_source_ids: ["y"],
        referenced: false,
        referenced_source_ids: [],
        outcome: "pending",
      }),
    ]);
    // The denominator is the DECIDED population only: one inject, and it was referenced.
    expect(m.injects_offered).toBe(1);
    expect(m.injects_referenced).toBe(1);
    expect(m.injection_utilization).toBe(1); // 1/1, NOT 1/2
    // The item drilldown censors the open window's offered ids for the same reason:
    // "y" has not had its opportunity, so counting it as an unreferenced document is
    // the same fabricated miss one level down.
    expect(m.distinct_offered).toBe(1);
    expect(m.evidence_item_utilization).toBe(1); // 1/1, NOT 1/2
    // And the censored count is reported, so the sample size behind the rate is legible.
    expect(m.unresolved).toBe(1);
  });

  it("F4: a window that is ENTIRELY unresolved yields null rates, never 0%", () => {
    const m = computeMetrics([
      mk({ evidence_offered: 2, offered_source_ids: ["a", "b"], outcome: "pending" }),
      mk({ evidence_offered: 1, offered_source_ids: ["c"], outcome: "pending" }),
    ]);
    // The session that produced this proposal had exactly this shape: 1 inject, 0
    // outcomes. The old math reported 0% referenced, which asserts a miss nobody
    // observed. `null` is the honest reading: undefined, not zero.
    expect(m.injection_utilization).toBeNull();
    expect(m.evidence_item_utilization).toBeNull();
    expect(m.unresolved).toBe(2);
    expect(m.pending).toBe(2);
  });

  it("no_opportunity is a side count, excluded from EVERY rate denominator (agent never had a turn)", () => {
    const used: MetricInput = {
      evidence_offered: 1,
      offered_source_ids: ["a1"],
      referenced: true,
      referenced_source_ids: ["a1"],
      outcome: "used",
    };
    const noOpp: MetricInput = {
      evidence_offered: 2,
      offered_source_ids: ["b1", "b2"], // offered, but the session ended before any turn
      referenced: false,
      referenced_source_ids: [],
      outcome: "no_opportunity",
    };
    const m = computeMetrics([used, noOpp]);
    expect(m.no_opportunity).toBe(1);
    // Excluded from the injection denominator: only the `used` inject counts.
    expect(m.injects_offered).toBe(1);
    expect(m.injects_referenced).toBe(1);
    expect(m.injection_utilization).toBe(1); // 1/1, not 1/2
    // Excluded from the item denominator: b1/b2 do not appear in distinct_offered.
    expect(m.distinct_offered).toBe(1);
    expect(m.evidence_item_utilization).toBe(1); // 1/1, not 1/3
    // Excluded from closed_windows and therefore from unknown_coverage / precision.
    expect(m.closed_windows).toBe(1); // used only; no_opportunity is not a closed window
    expect(m.reference_precision_v1).toBe(1); // 1 / (1 + 0)
    expect(m.unknown_coverage).toBe(0); // 0 unknown / 1 closed window
  });

  it("returns null rates when nothing was offered / no window has closed", () => {
    const m = computeMetrics([
      mk({
        evidence_offered: 0,
        offered_source_ids: [],
        referenced: false,
        referenced_source_ids: [],
        outcome: "pending",
      }),
    ]);
    expect(m.injection_utilization).toBeNull();
    expect(m.evidence_item_utilization).toBeNull();
    expect(m.reference_precision_v1).toBeNull();
    expect(m.unknown_coverage).toBeNull();
  });

  it("labels the v1 follow-through honestly (section 4.2, rollout step 4)", () => {
    expect(REFERENCE_PRECISION_V1_LABEL).toBe("Reference follow-through (v1)");
  });
});
