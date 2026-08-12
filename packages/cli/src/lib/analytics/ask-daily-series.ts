// The daily timeout series for `mla stats ask`.
//
// WHY THIS EXISTS. `summarizeAskOutcomes` reports ONE timeout rate for the whole window, and a
// window average is the exact statistic that hides a step. The enrichment timeout rate moved
// from 2-6% in late July to 19-21% on 2026-08-05 and held for five days; over a 30-day window
// that still averages to 6.7%, which reads as an unremarkable tail. Every row needed to see the
// step was already on disk the entire time. Nobody filed it because nobody was shown it.
//
// So this is a READER, not an alerting subsystem. It adds no store, no schedule, no delivery
// channel and no flag: it groups rows the report already loaded, and prints them under the
// report that already prints. Nothing here blocks, and no percentage is a product bar -- the
// comparison is always a day against its OWN recent baseline, never against a fixed number
// someone would then have to defend.

import type { AskTraceRow } from "./ask-outcomes";

/** One UTC day of enrichment attempts. */
export interface DailyTimeoutPoint {
  day: string;
  attempts: number;
  timeouts: number;
  rate: number;
}

/**
 * Why a day was surfaced.
 *
 * `step` is a day whose rate is a multiple of its trailing baseline. `clean_baseline_break` is
 * the case a ratio cannot express: a baseline of exactly zero, where "3x" is undefined but the
 * event ("we went from no timeouts to a lot of them") is real and is the more alarming of the
 * two. Splitting them keeps `ratio` honest instead of forcing an Infinity into a report.
 */
export type FlagKind = "step" | "clean_baseline_break";

export interface FlaggedDay extends DailyTimeoutPoint {
  kind: FlagKind;
  /** Median rate over the eligible trailing days, the thing this day is compared against. */
  baselineRate: number;
  /** `rate / baselineRate`, or null when the baseline is zero and the ratio has no value. */
  ratio: number | null;
  /** How many trailing days actually backed the baseline, so a reader can weigh it. */
  baselineDays: number;
}

export interface DailyTimeoutSeries {
  days: DailyTimeoutPoint[];
  flagged: FlaggedDay[];
  options: Required<DailySeriesOptions>;
}

export interface DailySeriesOptions {
  /**
   * Days of history a day is compared against. Fourteen covers a fortnight, which is long enough
   * that one bad afternoon does not become the baseline and short enough that a regime five weeks
   * gone does not still count as normal.
   */
  trailingDays?: number;
  /**
   * How many times its own baseline a day must reach. Three is chosen to sit well clear of the
   * day-to-day spread in the observed series (2.6% to 8.2% inside a single quiet fortnight), so
   * ordinary variance cannot reach it while the measured 08-05 step (6.7% against a ~2.9%
   * baseline) clears it.
   */
  multiplier?: number;
  /**
   * Attempts a day needs before its rate is worth reading. Below ~20 a single timeout moves the
   * rate by more than five points, so a small day would out-shout a real regime change and the
   * whole block would get ignored.
   */
  minAttempts?: number;
  /**
   * Eligible trailing days needed before any judgement is offered. A ratio against one or two
   * prior days is arithmetic, not evidence.
   */
  minBaselineDays?: number;
  /**
   * Timeouts a day needs before a zero baseline counts as broken. One timeout after a quiet
   * fortnight is a tail; this is deliberately a COUNT and not a rate, because the thing being
   * ruled out is a single event, not a level.
   */
  minTimeoutsForCleanBreak?: number;
}

const DEFAULTS: Required<DailySeriesOptions> = {
  trailingDays: 14,
  multiplier: 3,
  minAttempts: 20,
  minBaselineDays: 5,
  minTimeoutsForCleanBreak: 3,
};

/** Median of a sample. Returns null for an empty one rather than a misleading 0. */
function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Group attempts into UTC days and mark the days that departed from their own recent baseline.
 *
 * Pure over the rows, so the numbers are testable without a log file, exactly like
 * `summarizeAskOutcomes` beside it.
 */
export function summarizeDailyTimeoutSeries(
  rows: AskTraceRow[],
  opts: DailySeriesOptions = {},
): DailyTimeoutSeries {
  const options: Required<DailySeriesOptions> = { ...DEFAULTS, ...opts };

  const buckets = new Map<string, { attempts: number; timeouts: number }>();
  for (const r of rows) {
    const day = r.ts.slice(0, 10);
    if (day.length !== 10) continue;
    const b = buckets.get(day) ?? { attempts: 0, timeouts: 0 };
    b.attempts += 1;
    if (r.status === "timeout") b.timeouts += 1;
    buckets.set(day, b);
  }

  const days: DailyTimeoutPoint[] = [...buckets.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([day, b]) => ({ day, attempts: b.attempts, timeouts: b.timeouts, rate: b.timeouts / b.attempts }));

  const flagged: FlaggedDay[] = [];
  for (let i = 0; i < days.length; i++) {
    const d = days[i];
    if (d.attempts < options.minAttempts) continue;

    // The baseline is the trailing window BEFORE this day, and only the days in it that are
    // themselves readable. Including the day under test would let a step dilute its own signal.
    const trailing = days
      .slice(Math.max(0, i - options.trailingDays), i)
      .filter((p) => p.attempts >= options.minAttempts);
    if (trailing.length < options.minBaselineDays) continue;

    const baselineRate = median(trailing.map((p) => p.rate));
    if (baselineRate === null) continue;

    if (baselineRate === 0) {
      if (d.timeouts >= options.minTimeoutsForCleanBreak) {
        flagged.push({ ...d, kind: "clean_baseline_break", baselineRate: 0, ratio: null, baselineDays: trailing.length });
      }
      continue;
    }
    const ratio = d.rate / baselineRate;
    if (ratio > options.multiplier) {
      flagged.push({ ...d, kind: "step", baselineRate, ratio, baselineDays: trailing.length });
    }
  }

  return { days, flagged, options };
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

/**
 * Render the series for the terminal. Returns [] when there is nothing to say, so the caller can
 * splice it in unconditionally without printing an empty heading.
 *
 * Deliberately verdict-free. It prints what happened and what it was compared against; deciding
 * whether 20% is acceptable is the reader's job, and a line that reads like a gate would turn a
 * report into a bar someone has to argue with.
 */
export function renderDailyTimeoutSeries(series: DailyTimeoutSeries, maxDays = 14): string[] {
  if (series.days.length === 0) return [];
  const L: string[] = [];
  const flaggedByDay = new Map(series.flagged.map((f) => [f.day, f]));
  const shown = series.days.slice(-maxDays);

  L.push("");
  L.push(`DAILY TIMEOUT RATE  (last ${shown.length} day(s) with attempts; a window average hides a step)`);
  for (const d of shown) {
    const f = flaggedByDay.get(d.day);
    const base = `  ${d.day}  ${String(d.timeouts).padStart(4)}/${String(d.attempts).padEnd(5)} ${pct(d.rate).padStart(6)}`;
    if (!f) {
      L.push(base);
      continue;
    }
    const against =
      f.kind === "clean_baseline_break"
        ? `no timeouts across ${f.baselineDays} prior day(s)`
        : `${f.ratio!.toFixed(1)}x its ${pct(f.baselineRate)} baseline over ${f.baselineDays} prior day(s)`;
    L.push(`${base}  <- ${against}`);
  }

  const outside = series.flagged.filter((f) => !shown.some((d) => d.day === f.day));
  if (outside.length) {
    L.push(`  (${outside.length} earlier day(s) also departed from baseline: ${outside.map((f) => f.day).join(", ")})`);
  }
  return L;
}
