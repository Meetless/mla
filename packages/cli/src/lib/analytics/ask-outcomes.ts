// `mla stats ask`: what the enrichment call actually did, read from traces we already write.
//
// WHY THIS EXISTS. A 2026-08-05 audit reported "an 11.3% hard-failure rate" by adding timeouts
// and errors together, and argued from a p90 of 1,922ms that the timeouts could not be a latency
// tail. Both readings were wrong, and neither needed new instrumentation to correct:
//
//   - The `error` rows were every one `intel_down` at 10 to 12 ms, and they all landed inside a
//     single two-hour window. That is ONE outage, not a chronic application error rate, and
//     reporting six independent failures from it overstates unreliability sixfold.
//   - p90 says almost nothing about requests that timed out, because they are all ABOVE it by
//     construction. The number that matters is the successful tail: at a max of 5,291ms against a
//     6,000ms budget, a timeout is entirely consistent with the ordinary tail crossing the wall.
//
// So the defect was never missing telemetry. `enrich_latency_ms` and `fail_open_reason` were on
// every row the whole time. The defect was that nobody consumed them, and a number nobody reads
// gets summarized by whoever needs a number that day. This is the consumer.
//
// It deliberately REFUSES two conveniences: it never folds `timeout` and `intel_down` into one
// headline percentage, and it never counts a timed-out request as a 6,000ms latency sample.

/** Terminal enrichment outcomes, as the hook records them. */
export type AskOutcome = "ok" | "empty" | "timeout" | "skipped" | "error" | "stop_guard";

export interface AskTraceRow {
  ts: string;
  status: string | null;
  latencyMs: number | null;
  failOpenReason: string | null;
  workspaceId: string | null;
  surface: string | null;
  /** The deadline THIS turn actually ran under. Null on rows written before it was traced. */
  budgetMs: number | null;
  /** Whether the agent received Layer 2, as opposed to intel merely having replied. */
  layer2Injected: boolean | null;
  /**
   * H2. Whether the assembled head left less than the 1200B minimum for evidence, so the
   * evidence block was floored there and the turn is projected to cross the inline
   * ceiling anyway. Null on turns that rendered no evidence block and on rows written
   * before the field existed: a turn whose head pressure is UNKNOWN must never be
   * counted as a turn that had room.
   */
  evidenceFloored: boolean | null;
  /** The assembled head in bytes on an evidence turn. Null when unknown. */
  headBytes: number | null;
  /**
   * H4. The citations that survived budgeting and reached the model, in order.
   *
   * THREE STATES, and collapsing any two of them is the defect this field exists to
   * expose rather than commit:
   *   null  the row does not carry the field -> UNMEASURED. Every trace written before
   *         2026-08-09 is this, and so is every turn that rendered no evidence block.
   *   []    a block was rendered and NOTHING survived the cut -> zero delivered.
   *   [...] what actually reached the model.
   *
   * `?? []` on this field would turn "we do not know" into "we delivered nothing", which
   * is the same reading error that let a three-document success be reported for a
   * one-document delivery. Callers take the length only after a null check.
   */
  deliveredCitations: string[] | null;
}

export interface LatencySummary {
  n: number;
  p50: number | null;
  p90: number | null;
  p95: number | null;
  p99: number | null;
  max: number | null;
}

export interface OutageWindow {
  reason: string;
  start: string;
  end: string;
  durationMinutes: number;
  attempts: number;
  workspaces: string[];
  surfaces: string[];
}

/**
 * G1b (2026-08-09). What the deadline change bought, on the only population that can
 * answer it: turns that ran under the CURRENT budget and crossed the PRIOR one.
 *
 * The counterfactual is unrecoverable. The 298 turns that died at ~6,016ms died with
 * nothing behind them; no later analysis can say which would have answered at 8s. So
 * the trade is priced FORWARD, and the cohort is defined by two fields that were
 * already on every row (`hook.budget_ms`, `hook.enrich_latency_ms`) rather than by a
 * date filter, which would silently re-admit the backlog whenever the window widened.
 *
 * The four buckets are not the same claim and are deliberately kept apart:
 *   recoveredOk       intel answered after the old wall. A round-trip, not yet a win.
 *   deliveredEvidence the agent actually received Layer 2. THIS is the win.
 *   recoveredEmpty    it answered and had nothing. Latency spent, nothing bought.
 *   stillTimedOut     it died anyway. Pure cost: the same nothing, four seconds later.
 */
export interface BudgetRecoveryCohort {
  /** The deadline that used to cut these turns. */
  priorBudgetMs: number;
  /** The deadline in force now. */
  budgetMs: number;
  crossedPriorBudget: number;
  recoveredOk: number;
  deliveredEvidence: number;
  recoveredEmpty: number;
  stillTimedOut: number;
  /** Latency over the recovered turns, so the cost side is priced as well as the win. */
  recoveredLatency: LatencySummary;
  /**
   * `deliveredEvidence / crossedPriorBudget`, and NULL on an empty cohort rather than 0.
   * A zero rate is the exact reading the stop condition acts on ("the extra seconds
   * bought nothing"), so an unmeasured cohort must not be able to render as one.
   */
  recoveryRate: number | null;
}

export interface AskOutcomeReport {
  total: number;
  byOutcome: Record<string, number>;
  failOpenByReason: Record<string, number>;
  /** Latency over SUCCESSFUL calls only. Timed-out calls are never synthesized into this. */
  successLatency: LatencySummary;
  /**
   * The distinct deadlines the successful samples actually ran under (`null` for rows written
   * before `hook.budget_ms` was traced), ascending.
   *
   * The headroom line needs this and cannot be honest without it. A deadline CENSORS its own
   * tail: no sample can exceed the wall it ran under, because the client cut it and recorded a
   * timeout instead. So a tail collected at 6,000ms compared against a 10,000ms budget will
   * always look comfortable, and that comfort is an artifact of the censoring rather than a
   * measurement of the service. Exactly one entry, equal to `budgetMs`, is the only case where
   * the comparison means anything.
   */
  successLatencyBudgets: (number | null)[];
  budgetMs: number;
  timeoutCount: number;
  timeoutRate: number;
  timeoutsByWorkspace: Record<string, number>;
  timeoutsBySurface: Record<string, number>;
  timeoutsByHour: Record<string, number>;
  outages: OutageWindow[];
  budgetRecovery: BudgetRecoveryCohort;
  headPressure: HeadPressure;
  evidenceDelivery: EvidenceDelivery;
}

/**
 * H2 (notes/20260809-mla-helpfulness-session-a4a779b2-the-budgeter-miscounts-its-own-items.md).
 * How often the always-on head crowded the evidence block down to its floor.
 *
 * The hook has always emitted a WARN when this happens. It goes to a per-session log
 * file that no report reads, and on the machine where it was found it had fired exactly
 * twice, both on the same day, in two different sessions, and neither was noticed. The
 * floor block is a TAX billed to every turn forever, and when it outgrows its assumed
 * size the evidence block is what pays, silently.
 *
 * REPORTED, NOT FIXED, on purpose. The head is not capped here, the inline ceiling is
 * not raised, and no MUST-follow rule is spilled: an oversized head is a governance
 * question (which rule earns its bytes) and a machine picking which MUST to drop is the
 * wrong answer to it. This is the number that makes the question askable.
 *
 * `measured` is the denominator and it is evidence turns with the field present, NOT all
 * attempts: a turn that rendered no evidence block had nothing to crowd out, and a row
 * predating the field is unknown rather than healthy.
 */
export interface HeadPressure {
  measured: number;
  floored: number;
  /** `floored / measured`, and null on an empty denominator rather than 0. */
  flooredRate: number | null;
  /** Head bytes over the measured turns; the magnitude behind the count. */
  headBytes: LatencySummary;
}

/**
 * H4. What the evidence block actually DELIVERED, over the turns that can say.
 *
 * `measured` is the denominator and it counts ONLY rows carrying
 * `hook.delivered_citations`. A row without the field is UNMEASURED and is excluded
 * from both numerator and denominator; it is never read as a zero. That distinction is
 * the entire point: the audit this came from mistook "no instrumentation" for
 * "delivered everything" in the other direction for five audits running.
 */
export interface EvidenceDelivery {
  /** Evidence turns in the window, whether or not they carry the field. */
  evidenceTurns: number;
  /** Of those, how many carry `delivered_citations` at all. */
  measured: number;
  /** Citations that reached the model, summed over the measured turns. */
  delivered: number;
  /** Measured turns whose list was EXPLICITLY empty: a block rendered, nothing survived. */
  deliveredNothing: number;
}

/**
 * The deadline the hook applied before 2026-08-09. Kept as a constant here because this
 * is the ONLY consumer that still needs it: it is the boundary the recovery cohort is
 * measured against, not a budget anything applies. When the current budget has been in
 * force long enough that the cohort has answered its question, this and the block it
 * feeds come out together.
 */
export const PRIOR_ENRICH_BUDGET_MS = 6000;

/**
 * Failure reasons that mean "the dependency was not there", as opposed to "it was too slow".
 * These are grouped into incidents; everything else is counted per attempt.
 */
const OUTAGE_REASONS = new Set(["intel_down"]);

/**
 * Backstop only. An incident normally ends when a call SUCCEEDS (see `groupOutages`); this gap
 * exists for the case where the operator simply stops working during an outage and the log has
 * no evidence of recovery at all. It is deliberately generous, because a quiet period is not a
 * recovery: enrichment only runs when a human types, so an hour of silence says nothing about
 * whether the dependency came back.
 */
export const OUTAGE_GAP_MINUTES = 240;

/** Extract the fields this report needs from a raw trace line, tolerating older shapes. */
export function toAskTraceRow(raw: Record<string, unknown>): AskTraceRow | null {
  const ts = typeof raw.ts === "string" ? raw.ts : null;
  if (!ts) return null;
  const enrichment = (raw.enrichment ?? {}) as Record<string, unknown>;
  const hook = (raw.hook ?? {}) as Record<string, unknown>;
  const status = typeof enrichment.status === "string" ? enrichment.status : null;
  if (!status) return null; // a line with no terminal enrichment outcome is not an attempt
  const latency = hook.enrich_latency_ms;
  const budget = hook.budget_ms;
  return {
    ts,
    status,
    latencyMs: typeof latency === "number" && Number.isFinite(latency) ? latency : null,
    failOpenReason: typeof hook.fail_open_reason === "string" && hook.fail_open_reason ? hook.fail_open_reason : null,
    workspaceId: typeof raw.workspace_id === "string" ? raw.workspace_id : null,
    surface: typeof raw.surface === "string" ? raw.surface : null,
    budgetMs: typeof budget === "number" && Number.isFinite(budget) ? budget : null,
    // `null` for a row that never carried the field, never `false`: a turn whose
    // delivery is unknown must not be counted as a turn that delivered nothing.
    layer2Injected: typeof hook.layer2_injected === "boolean" ? hook.layer2_injected : null,
    evidenceFloored: typeof hook.evidence_floored === "boolean" ? hook.evidence_floored : null,
    headBytes: typeof hook.head_bytes === "number" && Number.isFinite(hook.head_bytes) ? hook.head_bytes : null,
    // An ARRAY check, not a truthiness check: `[]` is truthy in JS but `Array.isArray`
    // is what separates "a block was rendered and nothing survived" from "no field".
    deliveredCitations: Array.isArray(hook.delivered_citations)
      ? hook.delivered_citations.filter((c): c is string => typeof c === "string")
      : null,
  };
}

/** Nearest-rank percentile. Returns null for an empty sample rather than a misleading 0. */
export function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1];
}

function bump(into: Record<string, number>, key: string | null): void {
  const k = key ?? "unknown";
  into[k] = (into[k] ?? 0) + 1;
}

/**
 * Group consecutive dependency-down failures into outage windows by timestamp adjacency.
 *
 * This is the correction that matters most. Six `intel_down` rows are six ATTEMPTS that hit one
 * dead service, and presenting them as six reliability incidents is how a two-hour outage gets
 * mistaken for a chronic 3.6% error rate.
 */
export function groupOutages(rows: AskTraceRow[], gapMinutes: number = OUTAGE_GAP_MINUTES): OutageWindow[] {
  // Walk EVERY attempt in time order, not just the failing ones. A successful call is the only
  // real evidence the dependency came back, so it is what closes an incident.
  //
  // Splitting on elapsed time alone would be wrong in both directions here: enrichment fires only
  // when a human types, so a two-hour gap can mean "went to lunch during the outage" (splitting
  // one incident into two) while a dense burst of retries inside a genuinely recovered-then-broken
  // period could merge two. Recovery is an observation, not a duration.
  const ordered = [...rows].sort((a, b) => a.ts.localeCompare(b.ts));
  const out: OutageWindow[] = [];
  let recovered = false;
  for (const r of ordered) {
    const isDown = r.failOpenReason !== null && OUTAGE_REASONS.has(r.failOpenReason);
    if (!isDown) {
      // Any attempt that reached the dependency at all proves it is up again.
      if (r.status !== "error") recovered = true;
      continue;
    }
    const at = Date.parse(r.ts);
    const last = out[out.length - 1];
    const withinGap =
      !recovered && last !== undefined && last.reason === r.failOpenReason && at - Date.parse(last.end) <= gapMinutes * 60_000;
    if (!withinGap) {
      recovered = false;
      out.push({
        reason: r.failOpenReason as string,
        start: r.ts,
        end: r.ts,
        durationMinutes: 0,
        attempts: 1,
        workspaces: r.workspaceId ? [r.workspaceId] : [],
        surfaces: r.surface ? [r.surface] : [],
      });
      continue;
    }
    last.end = r.ts;
    last.attempts += 1;
    last.durationMinutes = Math.round((Date.parse(last.end) - Date.parse(last.start)) / 60_000);
    if (r.workspaceId && !last.workspaces.includes(r.workspaceId)) last.workspaces.push(r.workspaceId);
    if (r.surface && !last.surfaces.includes(r.surface)) last.surfaces.push(r.surface);
  }
  return out;
}

/**
 * The G1b cohort. Pure over the rows; see `BudgetRecoveryCohort` for why it is forward-only.
 */
export function budgetRecoveryCohort(
  rows: AskTraceRow[],
  budgetMs: number,
  priorBudgetMs: number,
): BudgetRecoveryCohort {
  const recoveredLatencies: number[] = [];
  let crossed = 0;
  let recoveredOk = 0;
  let delivered = 0;
  let recoveredEmpty = 0;
  let stillTimedOut = 0;

  for (const r of rows) {
    // Ran under the CURRENT deadline, and crossed the old one. A row whose budget is
    // unknown is excluded rather than assumed: this cohort's whole value is that its
    // denominator contains only turns the change could have affected.
    if (r.budgetMs !== budgetMs || r.latencyMs === null || r.latencyMs <= priorBudgetMs) continue;
    crossed++;
    if (r.status === "timeout") {
      stillTimedOut++;
      continue;
    }
    if (r.status === "ok") {
      recoveredOk++;
      recoveredLatencies.push(r.latencyMs);
      // Delivery, not reply. `layer2Injected` is what the AGENT received; an `ok` whose
      // Layer 2 was dropped bought the operator four seconds and no evidence.
      if (r.layer2Injected === true) delivered++;
    } else if (r.status === "empty") {
      recoveredEmpty++;
      recoveredLatencies.push(r.latencyMs);
    }
  }

  recoveredLatencies.sort((a, b) => a - b);
  return {
    priorBudgetMs,
    budgetMs,
    crossedPriorBudget: crossed,
    recoveredOk,
    deliveredEvidence: delivered,
    recoveredEmpty,
    stillTimedOut,
    recoveredLatency: {
      n: recoveredLatencies.length,
      p50: percentile(recoveredLatencies, 50),
      p90: percentile(recoveredLatencies, 90),
      p95: percentile(recoveredLatencies, 95),
      p99: percentile(recoveredLatencies, 99),
      max: recoveredLatencies.length ? recoveredLatencies[recoveredLatencies.length - 1] : null,
    },
    recoveryRate: crossed ? delivered / crossed : null,
  };
}

/** Build the report. Pure over the rows, so the numbers are testable without a log file. */
export function summarizeAskOutcomes(
  rows: AskTraceRow[],
  opts: { budgetMs: number; priorBudgetMs?: number },
): AskOutcomeReport {
  const byOutcome: Record<string, number> = {};
  const failOpenByReason: Record<string, number> = {};
  const timeoutsByWorkspace: Record<string, number> = {};
  const timeoutsBySurface: Record<string, number> = {};
  const timeoutsByHour: Record<string, number> = {};
  const successLatencies: number[] = [];
  // Which deadline the SUCCESSFUL samples ran under, so the headroom line below can refuse to
  // compare a censored tail to a wall it never met. See successLatencyBudgets on the report.
  const successBudgets = new Set<number | null>();

  for (const r of rows) {
    bump(byOutcome, r.status);
    if (r.failOpenReason) bump(failOpenByReason, r.failOpenReason);
    // Successful calls ONLY. A timed-out request has no observed duration, and pretending it
    // finished at exactly the budget would manufacture a percentile out of the deadline.
    if (r.status === "ok" && r.latencyMs !== null) {
      successLatencies.push(r.latencyMs);
      successBudgets.add(r.budgetMs);
    }
    if (r.status === "timeout") {
      bump(timeoutsByWorkspace, r.workspaceId);
      bump(timeoutsBySurface, r.surface);
      bump(timeoutsByHour, r.ts.slice(0, 13));
    }
  }

  successLatencies.sort((a, b) => a - b);
  const timeoutCount = byOutcome.timeout ?? 0;

  return {
    total: rows.length,
    byOutcome,
    failOpenByReason,
    successLatency: {
      n: successLatencies.length,
      p50: percentile(successLatencies, 50),
      p90: percentile(successLatencies, 90),
      p95: percentile(successLatencies, 95),
      p99: percentile(successLatencies, 99),
      max: successLatencies.length ? successLatencies[successLatencies.length - 1] : null,
    },
    successLatencyBudgets: [...successBudgets].sort((a, b) => (a ?? -1) - (b ?? -1)),
    budgetMs: opts.budgetMs,
    timeoutCount,
    timeoutRate: rows.length ? timeoutCount / rows.length : 0,
    timeoutsByWorkspace,
    timeoutsBySurface,
    timeoutsByHour,
    outages: groupOutages(rows),
    budgetRecovery: budgetRecoveryCohort(rows, opts.budgetMs, opts.priorBudgetMs ?? PRIOR_ENRICH_BUDGET_MS),
    headPressure: headPressure(rows),
    evidenceDelivery: evidenceDelivery(rows),
  };
}

/** H4. See {@link EvidenceDelivery}: a missing list is UNMEASURED, never a zero. */
export function evidenceDelivery(rows: AskTraceRow[]): EvidenceDelivery {
  let evidenceTurns = 0;
  let measured = 0;
  let delivered = 0;
  let deliveredNothing = 0;
  for (const r of rows) {
    if (r.layer2Injected === true) evidenceTurns++;
    if (r.deliveredCitations == null) continue; // undefined too: see headPressure
    measured++;
    delivered += r.deliveredCitations.length;
    if (r.deliveredCitations.length === 0) deliveredNothing++;
  }
  return { evidenceTurns, measured, delivered, deliveredNothing };
}

/** H2. See {@link HeadPressure}: measured over evidence turns that carry the field. */
export function headPressure(rows: AskTraceRow[]): HeadPressure {
  const heads: number[] = [];
  let measured = 0;
  let floored = 0;
  for (const r of rows) {
    // `== null` covers undefined as well as null. A hand-built row, or a row from an
    // older parser, simply lacks the key; that is UNMEASURED for the same reason a null
    // is, and reading it as "measured, and there was room" would inflate the denominator
    // with turns nothing observed.
    if (r.evidenceFloored == null) continue;
    measured++;
    if (r.evidenceFloored) floored++;
    if (r.headBytes !== null) heads.push(r.headBytes);
  }
  heads.sort((a, b) => a - b);
  return {
    measured,
    floored,
    flooredRate: measured ? floored / measured : null,
    headBytes: {
      n: heads.length,
      p50: percentile(heads, 50),
      p90: percentile(heads, 90),
      p95: percentile(heads, 95),
      p99: percentile(heads, 99),
      max: heads.length ? heads[heads.length - 1] : null,
    },
  };
}

function pct(n: number, total: number): string {
  return total ? `${((n / total) * 100).toFixed(1)}%` : "0.0%";
}

function topN(counts: Record<string, number>, n: number): [string, number][] {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n);
}

export function renderAskOutcomes(r: AskOutcomeReport, windowLabel: string): string[] {
  const L: string[] = [];
  L.push(`mla stats ask  (${windowLabel}, ${r.total} enrichment attempts)`);
  L.push("");
  L.push("OUTCOMES");
  for (const [k, v] of Object.entries(r.byOutcome).sort((a, b) => b[1] - a[1])) {
    L.push(`  ${k.padEnd(10)} ${String(v).padStart(5)}  ${pct(v, r.total)}`);
  }

  if (Object.keys(r.failOpenByReason).length) {
    L.push("");
    L.push("FAIL-OPEN BY REASON");
    for (const [k, v] of Object.entries(r.failOpenByReason).sort((a, b) => b[1] - a[1])) {
      L.push(`  ${k.padEnd(18)} ${String(v).padStart(5)}`);
    }
  }

  L.push("");
  L.push(`SUCCESS LATENCY  (n=${r.successLatency.n}; timed-out calls are NOT counted here)`);
  const s = r.successLatency;
  L.push(`  p50 ${s.p50 ?? "-"}ms   p90 ${s.p90 ?? "-"}ms   p95 ${s.p95 ?? "-"}ms   p99 ${s.p99 ?? "-"}ms   max ${s.max ?? "-"}ms`);
  L.push(`  budget ${r.budgetMs}ms`);
  // The headroom claim is only available when the sample and the wall are the same regime.
  // A deadline censors its own tail (nothing survives above it, by construction), so a tail
  // collected under a DIFFERENT deadline cannot say anything about this one in either
  // direction. Live on 2026-08-09 this printed "clears the budget by 4110ms" over 271 samples
  // every one of which had been cut at 6,000ms.
  const budgets = r.successLatencyBudgets;
  const sameRegime = budgets.length === 1 && budgets[0] === r.budgetMs;
  if (s.max !== null && sameRegime) {
    const headroom = r.budgetMs - s.max;
    L.push(
      headroom <= r.budgetMs * 0.2
        ? `  NOTE: the successful tail reaches within ${headroom}ms of the budget, so timeouts are consistent with the ordinary tail crossing it.`
        : `  The successful tail clears the budget by ${headroom}ms.`,
    );
  } else if (s.max !== null) {
    // Say why, or the missing line reads as the absence of a problem rather than a refusal.
    const known = budgets.filter((b): b is number => b !== null);
    const where =
      known.length === 0
        ? "these rows predate hook.budget_ms, so which deadline they ran under is unknown"
        : known.length === 1
          ? `these samples ran under a ${known[0]}ms deadline`
          : `these samples span ${known.length} budgets (${known.join("ms, ")}ms)`;
    L.push(`  No headroom comparison: ${where}, and a deadline censors its own tail.`);
    L.push("  Nothing survives above the wall it ran under, so this sample cannot describe this budget.");
  }

  L.push("");
  L.push(`TIMEOUTS  ${r.timeoutCount} (${pct(r.timeoutCount, r.total)} of attempts), reported separately from availability`);
  if (r.timeoutCount > 0) {
    const ws = topN(r.timeoutsByWorkspace, 3);
    const sf = topN(r.timeoutsBySurface, 3);
    const hr = topN(r.timeoutsByHour, 3);
    if (ws.length) L.push(`  by workspace: ${ws.map(([k, v]) => `${k}=${v}`).join("  ")}`);
    if (sf.length) L.push(`  by surface:   ${sf.map(([k, v]) => `${k}=${v}`).join("  ")}`);
    if (hr.length) L.push(`  busiest hours: ${hr.map(([k, v]) => `${k}=${v}`).join("  ")}`);
  }

  const c = r.budgetRecovery;
  L.push("");
  L.push(`BUDGET RECOVERY  turns that ran at ${c.budgetMs}ms and crossed the old ${c.priorBudgetMs}ms wall`);
  if (c.crossedPriorBudget === 0) {
    // Not "0.0% recovered". The cohort is empty, which is a fact about the window, and
    // the stop condition must never be able to fire on an unmeasured one.
    L.push(`  none yet in this window. The cohort is UNMEASURED, which is not the same as zero.`);
  } else {
    L.push(
      `  ${c.crossedPriorBudget} crossed  ->  ${c.deliveredEvidence} delivered evidence` +
        `  ${c.recoveredEmpty} answered empty  ${c.stillTimedOut} still timed out`,
    );
    L.push(`  recovery rate (evidence delivered / crossed): ${pct(c.deliveredEvidence, c.crossedPriorBudget)}`);
    const rl = c.recoveredLatency;
    if (rl.n > 0) L.push(`  recovered latency: p50 ${rl.p50}ms  p90 ${rl.p90}ms  max ${rl.max}ms`);
    L.push(
      `  This is the ONLY number that prices the change: the ${c.priorBudgetMs}ms deadline killed its own`,
    );
    L.push(`  evidence, so what it cut can be measured forward and never recovered from history.`);
  }

  // H2. The floor block competing with the evidence block, made countable. Always
  // rendered, including at zero: a section that appears only when it is bad teaches the
  // reader nothing about the turns where it was fine, and the condition it reports had
  // already been firing silently for a day when it was found by hand.
  const hp = r.headPressure;
  L.push("");
  if (hp.measured === 0) {
    L.push("HEAD PRESSURE  UNMEASURED in this window (no evidence turn carries hook.evidence_floored)");
    L.push("  Not zero. These rows predate the field, so whether the head crowded evidence out is unknown.");
  } else {
    L.push(`HEAD PRESSURE  ${hp.floored} of ${hp.measured} evidence turns (${pct(hp.floored, hp.measured)}) floored to the 1200B minimum`);
    const h = hp.headBytes;
    if (h.n > 0) L.push(`  head bytes: p50 ${h.p50}B  p90 ${h.p90}B  max ${h.max}B`);
    if (hp.floored > 0) {
      L.push("  A floored turn crossed the inline ceiling anyway: the always-on head (static + floor");
      L.push("  rules + scoped) grew until the evidence block could not fit under it. The fix is to");
      L.push("  reclassify a floor rule, not to raise the ceiling and not to have a machine drop a MUST.");
    }
  }

  // H4. What reached the model, kept strictly apart from what was offered. The three
  // states are rendered as three different sentences ON PURPOSE: an unmeasured window
  // and a window that delivered nothing are opposite operator actions (instrument it vs
  // fix it), and one `?? 0` is all it takes to print the second when the first is true.
  const ed = r.evidenceDelivery;
  L.push("");
  if (ed.measured === 0) {
    L.push(`EVIDENCE DELIVERY  UNMEASURED over ${ed.evidenceTurns} evidence turn(s) in this window`);
    L.push("  Not zero. These rows predate hook.delivered_citations, so what reached the model is unknown.");
  } else {
    L.push(`EVIDENCE DELIVERY  ${ed.delivered} citation(s) reached the model over ${ed.measured} measured turn(s)`);
    if (ed.measured < ed.evidenceTurns) {
      L.push(`  ${ed.evidenceTurns - ed.measured} further evidence turn(s) carry no delivered_citations and are UNMEASURED, not zero.`);
    }
    if (ed.deliveredNothing > 0) {
      L.push(`  ${ed.deliveredNothing} turn(s) rendered an evidence block and delivered NOTHING (an explicit empty list, not a missing field).`);
    }
  }

  L.push("");
  if (r.outages.length === 0) {
    L.push("AVAILABILITY  no dependency-down incidents in window");
  } else {
    const affected = r.outages.reduce((a, o) => a + o.attempts, 0);
    L.push(`AVAILABILITY  ${r.outages.length} incident(s), ${affected} affected attempt(s)`);
    L.push("  Counted as INCIDENTS, not as independent errors: N failed calls against one dead");
    L.push("  service is one outage, and reporting it per-call overstates the error rate N-fold.");
    for (const o of r.outages) {
      L.push(`  ${o.reason}  ${o.start} -> ${o.end}  (${o.durationMinutes}m, ${o.attempts} attempts)`);
    }
  }
  return L;
}
