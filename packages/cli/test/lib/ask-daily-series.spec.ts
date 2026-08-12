// E18: the daily timeout series must SAY when a day steps away from its own recent baseline.
//
// WHY THIS EXISTS. The enrichment timeout rate went from 2-6% in late July to 19-21% on
// 2026-08-05 and stayed there for five days. Every row needed to see it was already on disk the
// whole time. Nobody filed it, because `mla stats ask` reports one number for the whole window
// and a window average is exactly the statistic that hides a step: 30 days of 2-6% averaged with
// 5 days of 20% still reads "6.7%", which looks like a tail rather than a regression.
//
// This is a REPORT, not an alarm and not a gate. No threshold blocks anything, no flag turns it
// on, and no percentage is hard-coded as a product bar. It rides the report that already exists.
//
// The headline case below is the real series, day for day, so this file also answers "would it
// have caught the thing it was written for" without anyone having to reason about it.

import {
  summarizeDailyTimeoutSeries,
  renderDailyTimeoutSeries,
  type DailyTimeoutPoint,
} from "../../src/lib/analytics/ask-daily-series";
import type { AskTraceRow } from "../../src/lib/analytics/ask-outcomes";

/** Expand a (day, attempts, timeouts) triple into the rows the reader consumes. */
function rowsFor(series: [day: string, attempts: number, timeouts: number][]): AskTraceRow[] {
  const out: AskTraceRow[] = [];
  for (const [day, attempts, timeouts] of series) {
    for (let i = 0; i < attempts; i++) {
      out.push({
        ts: `${day}T${String(i % 24).padStart(2, "0")}:00:00Z`,
        status: i < timeouts ? "timeout" : "ok",
        latencyMs: i < timeouts ? null : 1200,
        failOpenReason: i < timeouts ? "timeout" : null,
        workspaceId: "ws_1",
        surface: "cli_intercept",
      } as AskTraceRow);
    }
  }
  return out;
}

// The measured local series, 2026-07-20 to 2026-08-09, from ~/.meetless/logs/ask-traces.jsonl.
// Reproduced exactly: attempts and timeouts per day, counted on `enrichment.status`.
const REAL_SERIES: [string, number, number][] = [
  ["2026-07-20", 43, 4],
  ["2026-07-21", 37, 0],
  ["2026-07-22", 33, 3],
  ["2026-07-23", 46, 0],
  ["2026-07-24", 44, 0],
  ["2026-07-25", 10, 0],
  ["2026-07-26", 24, 2],
  ["2026-07-27", 70, 2],
  ["2026-07-28", 109, 3],
  ["2026-07-29", 33, 2],
  ["2026-07-30", 7, 0],
  ["2026-07-31", 41, 7],
  ["2026-08-01", 23, 0],
  ["2026-08-02", 39, 1],
  ["2026-08-03", 16, 1],
  ["2026-08-04", 61, 5],
  ["2026-08-05", 29, 6],
  ["2026-08-06", 74, 14],
  ["2026-08-07", 110, 14],
  ["2026-08-08", 98, 20],
  ["2026-08-09", 95, 18],
];

describe("summarizeDailyTimeoutSeries: the shape of the series", () => {
  it("buckets by UTC day and computes each day's own rate", () => {
    const series = summarizeDailyTimeoutSeries(
      rowsFor([
        ["2026-08-01", 40, 2],
        ["2026-08-02", 20, 10],
      ]),
    );
    expect(series.days.map((d: DailyTimeoutPoint) => [d.day, d.attempts, d.timeouts])).toEqual([
      ["2026-08-01", 40, 2],
      ["2026-08-02", 20, 10],
    ]);
    expect(series.days[0].rate).toBeCloseTo(0.05, 10);
    expect(series.days[1].rate).toBeCloseTo(0.5, 10);
  });

  it("returns an empty series rather than throwing on no rows", () => {
    const series = summarizeDailyTimeoutSeries([]);
    expect(series.days).toEqual([]);
    expect(series.flagged).toEqual([]);
  });
});

describe("E18: a day that steps away from its trailing baseline is reported, not silent", () => {
  it("flags the real 2026-08-05 step against the real July baseline", () => {
    const series = summarizeDailyTimeoutSeries(rowsFor(REAL_SERIES));
    const flaggedDays = series.flagged.map((f) => f.day);

    // The whole point: the day the regression started is named.
    expect(flaggedDays).toContain("2026-08-05");

    const step = series.flagged.find((f) => f.day === "2026-08-05")!;
    expect(step.rate).toBeCloseTo(6 / 29, 10);
    // Its own baseline is the quiet July it stepped away from, not the elevated days after it.
    expect(step.baselineRate).toBeLessThan(0.08);
    expect(step.ratio).toBeGreaterThan(3);
  });

  it("does NOT flag the quiet July days it is riding over", () => {
    const series = summarizeDailyTimeoutSeries(rowsFor(REAL_SERIES));
    const flaggedDays = new Set(series.flagged.map((f) => f.day));
    for (const day of ["2026-07-23", "2026-07-24", "2026-07-27", "2026-07-28", "2026-08-02"]) {
      expect(flaggedDays.has(day)).toBe(false);
    }
  });

  it("a window average hides exactly what the series shows", () => {
    // The number `mla stats ask` reports for the whole window, computed the same way.
    const rows = rowsFor(REAL_SERIES);
    const windowRate = rows.filter((r) => r.status === "timeout").length / rows.length;
    const series = summarizeDailyTimeoutSeries(rows);
    const worst = Math.max(...series.days.map((d) => d.rate));

    // ~10% averaged, ~20% on the bad days. Reporting only the average understates the
    // current regime by about half, which is how five days went by without a filing.
    expect(windowRate).toBeLessThan(0.13);
    expect(worst).toBeGreaterThan(0.19);
    expect(worst / windowRate).toBeGreaterThan(1.8);
  });
});

describe("E18: the detector refuses readings it cannot support", () => {
  it("ignores a low-volume day rather than letting one timeout read as a step", () => {
    // A 3-attempt day with 1 timeout is 33%. That is noise, not a regime, and a detector that
    // shouts about it gets muted and then misses the real one.
    const days: [string, number, number][] = [];
    for (let d = 1; d <= 20; d++) days.push([`2026-07-${String(d).padStart(2, "0")}`, 60, 2]);
    days.push(["2026-07-21", 3, 1]);
    const series = summarizeDailyTimeoutSeries(rowsFor(days));
    expect(series.flagged.map((f) => f.day)).not.toContain("2026-07-21");
  });

  it("refuses to judge a day with too little history behind it", () => {
    // Two days in is not a baseline. A ratio against one prior day is arithmetic, not evidence.
    const series = summarizeDailyTimeoutSeries(
      rowsFor([
        ["2026-08-01", 60, 1],
        ["2026-08-02", 60, 30],
      ]),
    );
    expect(series.flagged).toEqual([]);
  });

  it("names a clean-baseline break separately instead of dividing by zero", () => {
    // A trailing median of exactly 0 makes the ratio undefined. That is not a reason to stay
    // quiet (going from no timeouts to many IS the event) and not a reason to invent a ratio.
    const days: [string, number, number][] = [];
    for (let d = 1; d <= 16; d++) days.push([`2026-07-${String(d).padStart(2, "0")}`, 60, 0]);
    days.push(["2026-07-17", 60, 12]);
    const series = summarizeDailyTimeoutSeries(rowsFor(days));
    const flagged = series.flagged.find((f) => f.day === "2026-07-17");
    expect(flagged).toBeDefined();
    expect(flagged!.baselineRate).toBe(0);
    expect(flagged!.ratio).toBeNull();
    expect(flagged!.kind).toBe("clean_baseline_break");
  });

  it("does not flag a clean baseline broken by a single timeout", () => {
    // One timeout after a quiet fortnight is a tail, not a regime change.
    const days: [string, number, number][] = [];
    for (let d = 1; d <= 16; d++) days.push([`2026-07-${String(d).padStart(2, "0")}`, 60, 0]);
    days.push(["2026-07-17", 60, 1]);
    const series = summarizeDailyTimeoutSeries(rowsFor(days));
    expect(series.flagged).toEqual([]);
  });
});

describe("renderDailyTimeoutSeries", () => {
  it("prints nothing at all when there is no series to print", () => {
    expect(renderDailyTimeoutSeries(summarizeDailyTimeoutSeries([]))).toEqual([]);
  });

  it("shows the recent days and marks the flagged ones", () => {
    const out = renderDailyTimeoutSeries(summarizeDailyTimeoutSeries(rowsFor(REAL_SERIES))).join("\n");
    expect(out).toContain("2026-08-09");
    expect(out).toContain("2026-08-05");
    // The marker has to be legible in a terminal dump, and the baseline has to travel with it
    // so the reader can see what the day is being compared against.
    expect(out).toMatch(/2026-08-05.*<-/);
    expect(out.toLowerCase()).toContain("baseline");
    // No verdict, no threshold language, nothing that reads like a gate.
    expect(out).not.toMatch(/FAIL|ERROR|must be under/i);
  });
});
