import {
  groupOutages,
  percentile,
  summarizeAskOutcomes,
  toAskTraceRow,
  type AskTraceRow,
} from "../../src/lib/analytics/ask-outcomes";

// The two readings this report exists to make impossible.
//
// A 2026-08-05 audit reported "an 11.3% hard-failure rate" by summing timeouts and errors, and
// argued from p90=1,922ms that the timeouts were a distinct failure mode rather than a latency
// tail. Neither reading needed new telemetry to correct; both needed someone to read the rows.
//
//   1. Every `error` row was `intel_down` at 10 to 12 ms, and all of them fell inside one
//      two-hour window. One outage, reported six times, becomes a fake chronic error rate.
//   2. p90 cannot describe requests that timed out, because they all sit above it. The number
//      that matters is the SUCCESSFUL tail against the wall.

function row(over: Partial<AskTraceRow> & { ts: string; status: string }): AskTraceRow {
  return {
    latencyMs: null,
    failOpenReason: null,
    workspaceId: "ws_1",
    surface: "claude_code",
    budgetMs: null,
    layer2Injected: null,
    // Explicit nulls, not omissions. The spread below defeats TypeScript's missing-property
    // check, so a field left out here reaches the summarizers as `undefined` and every
    // "is this measured?" test in them has to defend against a shape the type says cannot
    // exist. Say UNMEASURED out loud instead.
    evidenceFloored: null,
    headBytes: null,
    deliveredCitations: null,
    ...over,
  };
}

describe("percentile: nearest-rank, and honest about an empty sample", () => {
  it("returns null rather than 0 for no observations", () => {
    // A zero here would read as "instant", which is the opposite of "we have no idea".
    expect(percentile([], 90)).toBeNull();
  });

  it("computes nearest-rank percentiles", () => {
    const s = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(percentile(s, 50)).toBe(50);
    expect(percentile(s, 90)).toBe(90);
    expect(percentile(s, 100)).toBe(100);
  });
});

describe("latency: a timed-out call is not a latency observation", () => {
  it("EXCLUDES timeouts from the success distribution", () => {
    // Counting a timeout as a 6,000ms sample would manufacture a percentile out of the deadline
    // and make the tail look worse than it is, on a request whose true duration is unknown.
    const rows = [
      row({ ts: "2026-08-05T10:00:00Z", status: "ok", latencyMs: 300 }),
      row({ ts: "2026-08-05T10:01:00Z", status: "ok", latencyMs: 500 }),
      row({ ts: "2026-08-05T10:02:00Z", status: "timeout", latencyMs: 6023, failOpenReason: "timeout" }),
    ];
    const r = summarizeAskOutcomes(rows, { budgetMs: 6000 });
    expect(r.successLatency.n).toBe(2);
    expect(r.successLatency.max).toBe(500);
  });

  it("does not count an empty or errored call as a success sample", () => {
    const rows = [
      row({ ts: "2026-08-05T10:00:00Z", status: "ok", latencyMs: 300 }),
      row({ ts: "2026-08-05T10:01:00Z", status: "empty", latencyMs: 120 }),
      row({ ts: "2026-08-05T10:02:00Z", status: "error", latencyMs: 11, failOpenReason: "intel_down" }),
    ];
    expect(summarizeAskOutcomes(rows, { budgetMs: 6000 }).successLatency.n).toBe(1);
  });
});

describe("availability: N failed calls against one dead service is ONE incident", () => {
  it("groups a burst of intel_down into a single outage window", () => {
    // The exact shape of the real 2026-08-04 window: six calls, minutes apart, one dead service.
    const rows = [
      row({ ts: "2026-08-04T12:00:00Z", status: "error", latencyMs: 10, failOpenReason: "intel_down" }),
      row({ ts: "2026-08-04T12:05:00Z", status: "error", latencyMs: 11, failOpenReason: "intel_down" }),
      row({ ts: "2026-08-04T12:40:00Z", status: "error", latencyMs: 10, failOpenReason: "intel_down" }),
      row({ ts: "2026-08-04T13:05:00Z", status: "error", latencyMs: 12, failOpenReason: "intel_down" }),
    ];
    const outages = groupOutages(rows);
    expect(outages).toHaveLength(1);
    expect(outages[0].attempts).toBe(4);
    expect(outages[0].start).toBe("2026-08-04T12:00:00Z");
    expect(outages[0].end).toBe("2026-08-04T13:05:00Z");
    expect(outages[0].durationMinutes).toBe(65);
  });

  it("separates two genuinely distinct outages", () => {
    const rows = [
      row({ ts: "2026-08-04T12:00:00Z", status: "error", failOpenReason: "intel_down" }),
      row({ ts: "2026-08-05T12:00:00Z", status: "error", failOpenReason: "intel_down" }),
    ];
    expect(groupOutages(rows)).toHaveLength(2);
  });

  it("does not treat a timeout as an availability incident", () => {
    // A slow dependency and an absent one are different failures with different fixes.
    const rows = [row({ ts: "2026-08-05T10:00:00Z", status: "timeout", latencyMs: 6015, failOpenReason: "timeout" })];
    expect(groupOutages(rows)).toEqual([]);
  });

  it("records which workspaces and surfaces an outage touched", () => {
    const rows = [
      row({ ts: "2026-08-04T12:00:00Z", status: "error", failOpenReason: "intel_down", workspaceId: "ws_a", surface: "claude_code" }),
      row({ ts: "2026-08-04T12:01:00Z", status: "error", failOpenReason: "intel_down", workspaceId: "ws_b", surface: "codex" }),
    ];
    const [o] = groupOutages(rows);
    expect(o.workspaces.sort()).toEqual(["ws_a", "ws_b"]);
    expect(o.surfaces.sort()).toEqual(["claude_code", "codex"]);
  });
});

describe("the headline the audit got wrong", () => {
  it("never combines timeouts and outage errors into one failure rate", () => {
    const rows = [
      ...Array.from({ length: 90 }, (_, i) => row({ ts: `2026-08-05T10:${String(i % 60).padStart(2, "0")}:00Z`, status: "ok", latencyMs: 400 })),
      ...Array.from({ length: 6 }, (_, i) => row({ ts: `2026-08-05T11:0${i}:00Z`, status: "timeout", latencyMs: 6020, failOpenReason: "timeout" })),
      ...Array.from({ length: 4 }, (_, i) => row({ ts: `2026-08-04T12:0${i}:00Z`, status: "error", latencyMs: 10, failOpenReason: "intel_down" })),
    ];
    const r = summarizeAskOutcomes(rows, { budgetMs: 6000 });

    // Timeouts are their own rate.
    expect(r.timeoutCount).toBe(6);
    expect(r.timeoutRate).toBeCloseTo(6 / 100, 5);
    // Availability is incidents, not per-call errors. Four errors, one incident.
    expect(r.outages).toHaveLength(1);
    expect(r.outages[0].attempts).toBe(4);
    // And nothing anywhere reports 10%.
    expect(r).not.toHaveProperty("hardFailureRate");
  });

  it("attributes timeouts by workspace, surface, and hour so concentration is visible", () => {
    const rows = [
      row({ ts: "2026-08-05T10:00:00Z", status: "timeout", failOpenReason: "timeout", workspaceId: "ws_hot" }),
      row({ ts: "2026-08-05T10:30:00Z", status: "timeout", failOpenReason: "timeout", workspaceId: "ws_hot" }),
      row({ ts: "2026-08-05T18:00:00Z", status: "timeout", failOpenReason: "timeout", workspaceId: "ws_cold" }),
    ];
    const r = summarizeAskOutcomes(rows, { budgetMs: 6000 });
    expect(r.timeoutsByWorkspace).toEqual({ ws_hot: 2, ws_cold: 1 });
    expect(r.timeoutsByHour["2026-08-05T10"]).toBe(2);
  });
});

describe("toAskTraceRow: reads the shape the hook already writes", () => {
  it("extracts status, latency and fail-open reason from a real line shape", () => {
    const r = toAskTraceRow({
      ts: "2026-08-05T10:00:00Z",
      workspace_id: "ws_1",
      surface: "claude_code",
      enrichment: { status: "timeout" },
      hook: { enrich_latency_ms: 6023, fail_open_reason: "timeout" },
    });
    expect(r).toEqual({
      ts: "2026-08-05T10:00:00Z",
      status: "timeout",
      latencyMs: 6023,
      failOpenReason: "timeout",
      // Absent on this line, and therefore null. A row from before `budget_ms` was
      // traced has an UNKNOWN deadline, and the recovery cohort must exclude it rather
      // than assume it ran under the current one.
      budgetMs: null,
      layer2Injected: null,
      // H2, same reading as the two above: a line written before head pressure was
      // traced does not know whether the head crowded evidence out, and UNKNOWN must
      // never be counted as "there was room".
      evidenceFloored: null,
      headBytes: null,
      // H4, and the reading this whole file exists to prevent: a line with no
      // `delivered_citations` key did not deliver nothing, it was never measured.
      deliveredCitations: null,
      workspaceId: "ws_1",
      surface: "claude_code",
    });
  });

  it("ignores a line that records no enrichment outcome", () => {
    // Not every trace line is an enrichment attempt; counting them would inflate the denominator
    // and quietly shrink every rate in the report.
    expect(toAskTraceRow({ ts: "2026-08-05T10:00:00Z", hook: {} })).toBeNull();
    expect(toAskTraceRow({ enrichment: { status: "ok" } })).toBeNull();
  });
});

describe("an incident ends on evidence of recovery, not on elapsed time", () => {
  // Enrichment only runs when a human types a prompt. So a long quiet stretch during an outage
  // means "nobody was working", not "the service came back", and splitting on elapsed time alone
  // would report one outage as several. A SUCCESSFUL call is the only real evidence of recovery.
  it("keeps one incident across a long quiet gap with no successful call between", () => {
    const rows = [
      row({ ts: "2026-08-04T12:00:00Z", status: "error", failOpenReason: "intel_down" }),
      row({ ts: "2026-08-04T13:05:00Z", status: "error", failOpenReason: "intel_down" }),
    ];
    const outages = groupOutages(rows);
    expect(outages).toHaveLength(1);
    expect(outages[0].attempts).toBe(2);
    expect(outages[0].durationMinutes).toBe(65);
  });

  it("SPLITS when a successful call proves the dependency recovered in between", () => {
    const rows = [
      row({ ts: "2026-08-04T12:00:00Z", status: "error", failOpenReason: "intel_down" }),
      row({ ts: "2026-08-04T12:10:00Z", status: "ok", latencyMs: 300 }),
      row({ ts: "2026-08-04T12:20:00Z", status: "error", failOpenReason: "intel_down" }),
    ];
    expect(groupOutages(rows)).toHaveLength(2);
  });

  it("an empty answer still proves the dependency answered", () => {
    const rows = [
      row({ ts: "2026-08-04T12:00:00Z", status: "error", failOpenReason: "intel_down" }),
      row({ ts: "2026-08-04T12:10:00Z", status: "empty", latencyMs: 120 }),
      row({ ts: "2026-08-04T12:20:00Z", status: "error", failOpenReason: "intel_down" }),
    ];
    expect(groupOutages(rows)).toHaveLength(2);
  });
});

// G1b (2026-08-09). THE COHORT THAT PRICES THE DEADLINE.
//
// The budget moved from 6,000ms to 10,000ms, and the question it was raised to answer
// is narrow: of the requests the OLD deadline would have killed, how many useful
// evidence deliveries does another four seconds buy? That cannot be recovered from
// history, because those requests already died at 6,016ms with nothing behind them.
// It can only be measured FORWARD, on turns that ran under the new deadline.
//
// So the cohort is defined by two conditions that are both already on every row: the
// turn ran under the CURRENT budget (`hook.budget_ms`), and its observed latency
// crossed the PRIOR one. Historical 6,000ms rows are excluded by the first condition
// rather than by a date filter, which is what keeps the numerator honest when the
// window is widened.
describe("budget recovery cohort: what the extra four seconds actually bought", () => {
  const OPTS = { budgetMs: 10_000, priorBudgetMs: 6_000 };

  it("counts only turns that ran under the CURRENT budget", () => {
    // The whole population this measures did not exist before the change. A row
    // recorded under the 6,000ms deadline crossed nothing; it WAS the deadline, and
    // admitting it would seed the cohort with guaranteed failures and understate the
    // recovery rate by exactly the size of the backlog.
    const rows = [
      row({ ts: "2026-08-08T10:00:00Z", status: "timeout", latencyMs: 6016, budgetMs: 6000, failOpenReason: "timeout" }),
      row({ ts: "2026-08-09T10:00:00Z", status: "ok", latencyMs: 7400, budgetMs: 10000, layer2Injected: true }),
    ];
    const c = summarizeAskOutcomes(rows, OPTS).budgetRecovery;
    expect(c.crossedPriorBudget).toBe(1);
    expect(c.recoveredOk).toBe(1);
  });

  it("splits the cohort into recovered, delivered, and still dead", () => {
    const rows = [
      // Below the old wall: never in the cohort, however it ended.
      row({ ts: "2026-08-09T10:00:00Z", status: "ok", latencyMs: 1200, budgetMs: 10000, layer2Injected: true }),
      // Crossed 6s and answered, WITH evidence. The only bucket that is a win.
      row({ ts: "2026-08-09T10:01:00Z", status: "ok", latencyMs: 6400, budgetMs: 10000, layer2Injected: true }),
      row({ ts: "2026-08-09T10:02:00Z", status: "ok", latencyMs: 9100, budgetMs: 10000, layer2Injected: true }),
      // Crossed 6s and answered, and had NOTHING to say. Recovered but not delivered:
      // four seconds of latency bought an empty envelope, which is a cost, not a win.
      row({ ts: "2026-08-09T10:03:00Z", status: "empty", latencyMs: 7000, budgetMs: 10000, layer2Injected: false }),
      // Crossed 6s and died anyway. Pure cost: the operator waited 10s for the same
      // nothing the old budget delivered in 6.
      row({ ts: "2026-08-09T10:04:00Z", status: "timeout", latencyMs: 10023, budgetMs: 10000, failOpenReason: "timeout" }),
    ];
    const c = summarizeAskOutcomes(rows, OPTS).budgetRecovery;
    expect(c.crossedPriorBudget).toBe(4);
    expect(c.recoveredOk).toBe(2);
    expect(c.deliveredEvidence).toBe(2);
    expect(c.stillTimedOut).toBe(1);
    // Answered-but-empty is neither a recovery nor a death, and it must be visible or
    // the two rates silently stop summing to the cohort.
    expect(c.recoveredEmpty).toBe(1);
  });

  it("does NOT count an answered-but-evidence-free turn as a delivery", () => {
    // `status: ok` means intel replied. It does NOT mean the agent got anything: the
    // arbitration can still drop Layer 2. Conflating the two is how a delivery metric
    // starts reporting round-trips.
    const rows = [
      row({ ts: "2026-08-09T10:01:00Z", status: "ok", latencyMs: 6400, budgetMs: 10000, layer2Injected: false }),
    ];
    const c = summarizeAskOutcomes(rows, OPTS).budgetRecovery;
    expect(c.recoveredOk).toBe(1);
    expect(c.deliveredEvidence).toBe(0);
  });

  it("reports the latency of the recovered turns, so the cost is priced too", () => {
    const rows = [
      row({ ts: "2026-08-09T10:01:00Z", status: "ok", latencyMs: 6400, budgetMs: 10000, layer2Injected: true }),
      row({ ts: "2026-08-09T10:02:00Z", status: "ok", latencyMs: 9100, budgetMs: 10000, layer2Injected: true }),
    ];
    const c = summarizeAskOutcomes(rows, OPTS).budgetRecovery;
    expect(c.recoveredLatency.n).toBe(2);
    expect(c.recoveredLatency.max).toBe(9100);
  });

  it("is empty, not zero-rated, when no turn has run under the new budget yet", () => {
    // The day the budget moves, this cohort is genuinely unmeasured. A 0.0% recovery
    // rate would read as "the extra four seconds bought nothing", which is the exact
    // conclusion the stop condition would then act on. Absent must not render as false.
    const rows = [
      row({ ts: "2026-08-08T10:00:00Z", status: "timeout", latencyMs: 6016, budgetMs: 6000, failOpenReason: "timeout" }),
    ];
    const c = summarizeAskOutcomes(rows, OPTS).budgetRecovery;
    expect(c.crossedPriorBudget).toBe(0);
    expect(c.recoveryRate).toBeNull();
  });

  it("reads budget_ms and layer2_injected off a real trace line", () => {
    const parsed = toAskTraceRow({
      ts: "2026-08-09T10:00:00Z",
      enrichment: { status: "ok" },
      hook: { enrich_latency_ms: 6400, budget_ms: 10000, layer2_injected: true },
    });
    expect(parsed?.budgetMs).toBe(10000);
    expect(parsed?.layer2Injected).toBe(true);
  });
});
