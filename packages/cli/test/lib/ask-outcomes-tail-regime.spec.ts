// The headroom line may only compare a tail to the budget that tail RAN UNDER.
//
// WHY THIS EXISTS. `mla stats ask` printed, live on 2026-08-09:
//
//     SUCCESS LATENCY  (n=271; timed-out calls are NOT counted here)
//       p50 1354ms  p90 2834ms  p95 3765ms  p99 5343ms  max 5890ms
//       budget 10000ms
//       The successful tail clears the budget by 4110ms.
//
// Every one of those 271 samples was collected under the 6,000ms deadline. Not one request in
// the sample was ever ALLOWED to finish at 7,000ms, because the client cut it at 6,000 and it
// was recorded as a timeout instead. So "clears the budget by 4110ms" is not a weak claim, it
// is a claim about a population that cannot exist: the deadline censors its own tail, and
// comparing a censored sample to a LATER, wider wall reads reassurance out of the censoring.
//
// The same shape, in the other direction, is the reading d7e5bcc12 already had to correct once
// ("the p95 of 6,017ms is an artifact, not a measurement of the service"). This is that lesson
// applied to the reader instead of to the note.
//
// The rows carry `hook.budget_ms`, so the reader can tell which regime a sample came from and
// simply decline to draw the comparison when they disagree.

import { renderAskOutcomes, summarizeAskOutcomes, type AskTraceRow } from "../../src/lib/analytics/ask-outcomes";

function ok(ts: string, latencyMs: number, budgetMs: number | null): AskTraceRow {
  return {
    ts,
    status: "ok",
    latencyMs,
    failOpenReason: null,
    workspaceId: "ws_1",
    surface: "cli_intercept",
    budgetMs,
    layer2Injected: true,
  } as AskTraceRow;
}

function timedOut(ts: string, budgetMs: number | null): AskTraceRow {
  return {
    ts,
    status: "timeout",
    latencyMs: null,
    failOpenReason: "timeout",
    workspaceId: "ws_1",
    surface: "cli_intercept",
    budgetMs,
    layer2Injected: false,
  } as AskTraceRow;
}

const render = (rows: AskTraceRow[], budgetMs: number) =>
  renderAskOutcomes(summarizeAskOutcomes(rows, { budgetMs }), "last 30d").join("\n");

describe("the success-latency tail is only compared to the budget it ran under", () => {
  it("refuses the headroom claim when every sample predates the current budget", () => {
    // The live 2026-08-09 shape: a whole sample collected at 6,000ms, reported against 10,000ms.
    const rows = [
      ...[1200, 2800, 3700, 5343, 5890].map((ms, i) => ok(`2026-08-0${i + 1}T10:00:00Z`, ms, 6000)),
      timedOut("2026-08-04T11:00:00Z", 6000),
    ];
    const out = render(rows, 10_000);

    expect(out).toContain("budget 10000ms");
    // The forbidden sentence, in both of its spellings.
    expect(out).not.toMatch(/clears the budget by/);
    expect(out).not.toMatch(/reaches within \d+ms of the budget/);
    // And it must say WHY it is not drawing the comparison, or the omission reads as an absence
    // of a problem rather than a refusal to answer.
    expect(out).toMatch(/censor|ran under|different budget|6000ms/i);
  });

  it("draws the comparison when the sample and the budget agree", () => {
    const rows = [1200, 2800, 3700, 5343, 5890].map((ms, i) => ok(`2026-08-0${i + 1}T10:00:00Z`, ms, 10_000));
    const out = render(rows, 10_000);
    expect(out).toContain("The successful tail clears the budget by 4110ms.");
  });

  it("still warns when a same-regime tail is genuinely near the wall", () => {
    // The warning is the useful half of this block and must survive the fix.
    const rows = [1200, 4800, 5700, 5890].map((ms, i) => ok(`2026-08-0${i + 1}T10:00:00Z`, ms, 6000));
    const out = render(rows, 6000);
    expect(out).toContain("reaches within 110ms of the budget");
  });

  it("refuses the claim on a MIXED sample rather than silently averaging two regimes", () => {
    // A window that straddles the change is the common case for the next two weeks, and it is
    // the one where a single headroom number is least meaningful.
    const rows = [
      ok("2026-08-08T10:00:00Z", 5890, 6000),
      ok("2026-08-09T10:00:00Z", 1200, 10_000),
    ];
    const out = render(rows, 10_000);
    expect(out).not.toMatch(/clears the budget by|reaches within \d+ms of the budget/);
    expect(out).toMatch(/2 budget|mixed|more than one/i);
  });

  it("says nothing about headroom when no row records which budget it ran under", () => {
    // Rows older than the field. Unknown is not agreement.
    const rows = [ok("2026-06-01T10:00:00Z", 1200, null), ok("2026-06-02T10:00:00Z", 5890, null)];
    const out = render(rows, 10_000);
    expect(out).not.toMatch(/clears the budget by|reaches within \d+ms of the budget/);
  });
});
