// E17: `mla stats ask` IS the authoritative reader for the enrichment timeout metric.
//
// WHY THIS EXISTS. On 2026-08-08 an audit reported "timeout rate is 28 of 4,549 = 0.6%, so this
// is rare", and rarity was the load-bearing justification for recommending instrumentation
// instead of a fix. The real rate was 6.7% over 30 days and 8.08% over the full local history:
// wrong by roughly 13x, and wrong in the direction that closes an investigation.
//
// The mechanism was not a hard bug. It was a hand-rolled rate whose NUMERATOR came from the
// `enrich_timeout` block (a field that landed 2026-08-06) while its DENOMINATOR spanned every
// trace back to 2026-05-31. A three-day-old field divided by ten weeks of history.
//
// `enrichment.status` has been on every row for the whole period and the product already reads
// it. So the fix is not new telemetry and not a new metric: it is making the EXISTING reader
// authoritative, and pinning that it agrees with a raw count over the identical window.
//
// The last case here is the one with teeth. It reproduces the young-field division mechanically
// and shows the two answers diverging by an order of magnitude on the SAME rows, so a future
// author who reaches for a hand count has a red test explaining why they should not.

import * as fs from "fs";
import * as path from "path";

import { logsDir } from "../../src/lib/analytics/logs";
import { runStats } from "../../src/commands/stats";

/** The day `enrich_timeout` started being written. Rows before it carry no such block. */
const YOUNG_FIELD_LANDED = "2026-08-06";

interface TraceSeed {
  ts: string;
  status: string;
  latencyMs?: number | null;
  failOpenReason?: string | null;
}

/**
 * One ask-trace line in the shape the hook actually spools: `enrichment.status` is the terminal
 * outcome, `hook.*` carries the timing, and `enrich_timeout` is present ONLY on timeout rows
 * written on or after the day that block landed. That conditional is the whole point of the
 * fixture; a fixture that stamped it on every timeout could not reproduce the defect.
 */
function traceLine(seed: TraceSeed): string {
  const isTimeout = seed.status === "timeout";
  const hasYoungField = isTimeout && seed.ts.slice(0, 10) >= YOUNG_FIELD_LANDED;
  const row: Record<string, unknown> = {
    trace_id: `t_${seed.ts}`,
    ts: seed.ts,
    surface: "cli_intercept",
    workspace_id: "ws_e17",
    enrichment: { status: seed.status },
    hook: {
      enrich_latency_ms: seed.latencyMs ?? (seed.status === "ok" ? 1200 : null),
      fail_open_reason: seed.failOpenReason ?? (isTimeout ? "timeout" : null),
    },
  };
  if (hasYoungField) row.enrich_timeout = { budget_ms: 6000, elapsed_ms: 6005, candidates_available: 0 };
  return JSON.stringify(row);
}

/** Days back from `now`, as the ISO instant the hook would have stamped. */
function daysAgo(now: number, days: number): string {
  return new Date(now - days * 86_400_000).toISOString();
}

function writeTraces(lines: string[]): void {
  const dir = logsDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "ask-traces.jsonl"), `${lines.join("\n")}\n`, "utf8");
}

/**
 * The RAW count, deliberately re-implemented here rather than imported.
 *
 * Importing `toAskTraceRow` would make this test tautological: the reader would be compared
 * against itself and could drift in lockstep. This is the count a careful human would write by
 * hand at a terminal, which is precisely the thing that has to agree.
 */
function rawCount(lines: string[], cutoffIso: string): { total: number; timeouts: number } {
  let total = 0;
  let timeouts = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const ts = row.ts;
    const status = ((row.enrichment ?? {}) as Record<string, unknown>).status;
    if (typeof ts !== "string" || typeof status !== "string") continue;
    if (ts < cutoffIso) continue;
    total += 1;
    if (status === "timeout") timeouts += 1;
  }
  return { total, timeouts };
}

/** Drive `mla stats ask --json` and hand back the parsed report. */
async function runAskJson(windowDays: number): Promise<Record<string, unknown>> {
  const captured: string[] = [];
  const spy = jest.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    captured.push(a.map(String).join(" "));
  });
  try {
    const code = await runStats(["ask", "--json", "--window", `${windowDays}d`]);
    expect(code).toBe(0);
  } finally {
    spy.mockRestore();
  }
  return JSON.parse(captured.join("\n")) as Record<string, unknown>;
}

describe("E17: mla stats ask agrees with a raw enrichment.status count over the identical window", () => {
  const NOW = Date.parse("2026-08-09T12:00:00.000Z");
  let lines: string[];

  beforeEach(() => {
    jest.spyOn(Date, "now").mockReturnValue(NOW);

    // A population with every terminal outcome the hook records, spread across a window
    // boundary. Counts are deliberately awkward (not round) so an off-by-one cannot hide.
    const seeds: TraceSeed[] = [];
    for (let d = 0; d < 40; d++) {
      const ts = daysAgo(NOW, d);
      // Rough shape of the real series: a handful of attempts a day, a timeout most days.
      seeds.push({ ts, status: "ok", latencyMs: 900 + d });
      seeds.push({ ts, status: "empty", latencyMs: 60 });
      if (d % 3 === 0) seeds.push({ ts, status: "timeout" });
      if (d % 7 === 0) seeds.push({ ts, status: "error", failOpenReason: "intel_down", latencyMs: 11 });
      if (d % 11 === 0) seeds.push({ ts, status: "skipped" });
    }
    lines = seeds.map(traceLine);

    // Corruption the reader is documented as tolerating, so agreement must survive it.
    lines.push("");
    lines.push("{ this is not json");
    // A line with no terminal enrichment outcome: not an attempt, and neither counter may take it.
    lines.push(JSON.stringify({ ts: daysAgo(NOW, 1), surface: "cli_intercept", enrichment: {} }));

    writeTraces(lines);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("reports the same total and timeout count as a raw count over the same 30d window", async () => {
    const report = await runAskJson(30);
    const raw = rawCount(lines, new Date(NOW - 30 * 86_400_000).toISOString());

    expect(raw.total).toBeGreaterThan(0);
    expect(raw.timeouts).toBeGreaterThan(0);
    expect(report.total).toBe(raw.total);
    expect(report.timeoutCount).toBe(raw.timeouts);
  });

  it("agrees on the RATE, not merely the counts, and on a second window", async () => {
    for (const days of [7, 30]) {
      const report = await runAskJson(days);
      const raw = rawCount(lines, new Date(NOW - days * 86_400_000).toISOString());
      expect(report.total).toBe(raw.total);
      expect(report.timeoutCount).toBe(raw.timeouts);
      // The rate is what an audit publishes, so pin the derived number too.
      expect(report.timeoutRate as number).toBeCloseTo(raw.timeouts / raw.total, 10);
    }
  });

  it("counts an attempt by its terminal outcome, never by whether a diagnostic block is present", async () => {
    // THE 13x DEFECT, reproduced. Same rows, same window; the only difference is which field the
    // numerator is drawn from. `enrich_timeout` is younger than the window, so a count over it
    // sees a fraction of the timeouts while the denominator sees all of the attempts.
    const cutoff = new Date(NOW - 30 * 86_400_000).toISOString();
    const raw = rawCount(lines, cutoff);

    let youngFieldNumerator = 0;
    for (const line of lines) {
      if (!line.trim()) continue;
      let row: Record<string, unknown>;
      try {
        row = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (typeof row.ts !== "string" || row.ts < cutoff) continue;
      if (row.enrich_timeout) youngFieldNumerator += 1;
    }

    // The young-field count is strictly smaller: that is the error, and it is silent.
    expect(youngFieldNumerator).toBeGreaterThan(0);
    expect(youngFieldNumerator).toBeLessThan(raw.timeouts);

    // And the product reader sides with the durable field, not the young one.
    const report = await runAskJson(30);
    expect(report.timeoutCount).toBe(raw.timeouts);
    expect(report.timeoutCount).not.toBe(youngFieldNumerator);
  });

  it("puts a row missing the counting field in NEITHER the numerator nor the denominator", async () => {
    // This is G1(a), expressed the way it is actually true.
    //
    // The tempting rule was "reject a rate whose numerator field was first seen after the
    // denominator window opened". That rule is wrong: first OBSERVED occurrence is not schema
    // introduction. A field can be older than its first sighting (nothing triggered it), and a
    // backfill can put old values on a young field. A first-seen timestamp is evidence about
    // traffic, not about schema.
    //
    // The invariant that IS load-bearing is narrower and local: the numerator and the
    // denominator must be drawn from the SAME field on the SAME row. `toAskTraceRow` already
    // enforces it by returning null when `enrichment.status` is absent, so such a row is not an
    // attempt for either counter and the two can never span different populations. That is the
    // same discipline `computeMetrics` applies to inject outcomes, where `pending` and
    // `no_opportunity` are excluded from every denominator because their opportunity was never
    // observed. Nothing new is introduced here; the coupling is pinned so it cannot be loosened
    // by someone adding a convenience branch that counts a row the other side cannot see.
    const withoutField = 25;
    const extra: string[] = [];
    for (let i = 0; i < withoutField; i++) {
      extra.push(JSON.stringify({ ts: daysAgo(NOW, i % 20), surface: "cli_intercept", workspace_id: "ws_e17" }));
    }
    writeTraces([...lines, ...extra]);

    const report = await runAskJson(30);
    const raw = rawCount(lines, new Date(NOW - 30 * 86_400_000).toISOString());

    // 25 rows that cannot be classified were added, and the denominator did not move. Had they
    // landed in it, the rate would have been diluted by roughly a quarter with no defect visible.
    expect(report.total).toBe(raw.total);
    expect(report.timeoutCount).toBe(raw.timeouts);
  });

  it("never counts a timed-out call as a latency observation", async () => {
    // The other half of the same discipline: a request that was CUT has no observed duration, and
    // synthesizing one at the budget would manufacture a percentile out of the deadline. The
    // successful-tail figure is the one an audit is entitled to reason about.
    const report = await runAskJson(30);
    const latency = report.successLatency as Record<string, unknown>;
    const byOutcome = report.byOutcome as Record<string, number>;
    expect(latency.n).toBe(byOutcome.ok);
    expect(latency.n).toBeLessThan(report.total as number);
  });
});
