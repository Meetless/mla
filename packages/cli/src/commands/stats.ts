// `mla stats` -- the usefulness-first local dashboard (spec §7). It reads the
// append-only ~/.meetless/events.jsonl (INV-LOCAL-STATS-1: works with all remote
// switches off) and answers "did mla help", not "did mla run". Every headline is
// value; activity (commands run, KB size) is a --verbose footnote (Thesis B).
//
//   mla stats               this workspace, last 30 days (the ROI default window)
//   mla stats evidence      the adoption join, focused (alias of `mla adoption`)
//   mla stats --window 7d   configurable window
//   mla stats --json        machine-readable
//   mla stats --verbose     append the activity footnote
//   mla stats --global      server-aggregated (handled in Phase 6 / T6.2)
//
// `mla stats evidence` and `mla adoption` route through the SAME runAdoption code
// path (INV-ADOPTION-SOURCE-1: one join, two entry points), so the §10.5 parity
// row holds by construction, not by a second implementation.
//
// The delayed-outcome trap (§7.4, INV-LOCAL-STATS-2): an inject is written
// immediately but its outcome lands only once the window closes (3 turns or 15
// minutes later). Rendering in between must count the inject in the denominator as
// `pending`, never drop it and never silently call it ignored. We window-filter
// the INJECTS (the denominator population) and attach each inject's outcome by
// inject_id regardless of when the outcome was written, so an inject near the
// window edge keeps its later verdict instead of being undercounted.

import {
  AnalyticsEvent,
  CoverageGapType,
  EvidenceInjectPayload,
  EvidenceOutcomePayload,
  StatsViewedPayload,
} from "../lib/analytics/envelope";
import { computeMetrics, MetricFamily, MetricInput, REFERENCE_PRECISION_V1_LABEL } from "../lib/analytics/metrics";
import { normId } from "../lib/analytics/followthrough";
import { readEvents } from "../lib/analytics/store";
import { RecordContext, recordAnalyticsEvent } from "../lib/analytics/recorder";
import { remoteAnalyticsEnabled } from "../lib/analytics/consent";
import { readConfig } from "../lib/config";
import { tryResolveWorkspaceId } from "../lib/workspace";
import { get } from "../lib/http";
import { runAdoption } from "./adoption";
import { runTurn } from "./turn";

// --- args -------------------------------------------------------------------

export interface StatsArgs {
  section: "evidence" | null;
  windowDays: number;
  windowLabel: string;
  json: boolean;
  verbose: boolean;
  global: boolean;
  // Everything after a recognized section, passed through verbatim (the evidence
  // section delegates these to runAdoption / `mla adoption`).
  rest: string[];
}

const DEFAULT_WINDOW_DAYS = 30;

// Parse `--window 7d` / `--window 30` (bare integer = days). Days only in v1; the
// ROI report and §7.2 examples are all day-grained.
function parseWindow(raw: string | undefined): { days: number; label: string } {
  if (raw === undefined) throw new Error("--window requires a value (e.g. 7d, 30d, 30)");
  const m = /^(\d+)(d)?$/.exec(raw.trim());
  if (!m) throw new Error(`--window must be a positive number of days (e.g. 7d, 30d). Got: ${raw}`);
  const days = Number(m[1]);
  if (!Number.isInteger(days) || days <= 0) {
    throw new Error(`--window must be a positive number of days. Got: ${raw}`);
  }
  return { days, label: `${days}d` };
}

export function parseStatsArgs(argv: string[]): StatsArgs {
  const out: StatsArgs = {
    section: null,
    windowDays: DEFAULT_WINDOW_DAYS,
    windowLabel: `${DEFAULT_WINDOW_DAYS}d`,
    json: false,
    verbose: false,
    global: false,
    rest: [],
  };
  let i = 0;
  // A leading bare token is the section selector. `evidence` is the only section
  // in v1; once selected, the remaining argv belongs to that section's handler.
  if (argv[i] !== undefined && !argv[i].startsWith("-")) {
    const section = argv[i];
    if (section !== "evidence") {
      throw new Error(`Unknown \`mla stats\` section: ${section} (known: evidence)`);
    }
    out.section = "evidence";
    out.rest = argv.slice(i + 1);
    return out;
  }
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") out.json = true;
    else if (a === "--verbose") out.verbose = true;
    else if (a === "--global") out.global = true;
    else if (a === "--window") {
      const w = parseWindow(argv[++i]);
      out.windowDays = w.days;
      out.windowLabel = w.label;
    } else throw new Error(`Unknown flag for \`mla stats\`: ${a}`);
  }
  return out;
}

// --- the dashboard model (what --json prints, what the renderer reads) -------

export interface CoverageGapBreakdown {
  type: CoverageGapType;
  count: number;
}

export interface LoadBearingItem {
  source_id: string;
  reference_count: number;
}

// Section 2b: governed-rule enforcement (the "wrong actions caught" signal). One
// PreToolUse deny fires an mla_enforcement_incident; an offline labeler can later
// supersede it to flip review_status, so the summary is collapsed by incident_id
// (latest wins, like latestOutcomes). The adjudication split is load-bearing for
// HONESTY: a raw deny count overclaims because a rule can misfire (the known
// notes-location-v1 vault-own-path false positive), so `confirmed` is the only
// number we may present as a proven catch; `unreviewed` is the honest unknown.
export interface EnforcementSummary {
  total: number; // distinct incidents in window (collapsed by incident_id)
  denied: number; // latest decision === "deny" (hard block)
  warned: number; // latest decision === "warn" (soft gate; reserved, 0 today)
  confirmed: number; // latest review_status === "confirmed" -- a proven catch
  false_positive: number; // latest review_status === "false_positive" -- a misfire
  unreviewed: number; // latest review_status === "unreviewed" -- not yet adjudicated
  by_tool: { tool: string; count: number }[]; // drilldown (verbose / web dashboard)
  // STAR's R follow-through, among the DENIED incidents in window: `resolved` carry a
  // correlated mla_enforcement_outcome (we know what the agent did next), `unclassified`
  // carry none yet (the session never Stopped again, the attempt was unmatchable, or the
  // reaction is still pending). unclassified is the honest blind-spot denominator the raw
  // deny count hides. LOCAL-ONLY: the server rollup has no per-session correlator, so both
  // are absent (undefined) on the --global view and the follow-through line is not shown.
  resolved?: number;
  unclassified?: number;
}

export interface StatsDashboard {
  window: string;
  window_days: number;
  generated_at: string;
  // Section 1: evidence followthrough (the headline metric family).
  evidence: MetricFamily;
  injections: number; // count of inject events in window (= metric family denom + zero-result injects)
  // Section 2: wrong actions caught (governed-rule PreToolUse denies, locally
  // observable). Contradiction/supersession and governed-decision counts have no
  // local producer -- they live in the server rollup behind `mla stats --global`.
  enforcement: EnforcementSummary;
  // Section 4: coverage gaps, sorted by demand.
  coverage_gaps: CoverageGapBreakdown[];
  coverage_gaps_total: number;
  // Section 5: load-bearing knowledge (local: by id; remote sees opaque ids).
  load_bearing: LoadBearingItem[];
  // Section 6: activity footnote (only populated when --verbose).
  commands_total: number;
  commands_by_name: { command: string; count: number }[];
}

// The server rollup read-model behind `mla stats --global` (control's
// GET /internal/v1/analytics/rollups). Its shape mirrors control's AnalyticsRollup
// (apps/control/src/analytics/analytics-rollup.ts): the same MetricFamily plus the
// permission-scoped tallies. has_any_events distinguishes "nothing has ever synced
// for your workspaces" (unknown) from "synced activity that nets to zero in this
// window" (INV-GLOBAL-UNKNOWN-1). It deliberately carries NO load-bearing source
// ids and NO activity footnote: remote sees opaque ids only (spec section 9, 7.3),
// so those two local-only sections have no global counterpart.
export interface GlobalRollup {
  window_days: number;
  workspaces: number;
  has_any_events: boolean;
  generated_at: string;
  evidence: MetricFamily;
  injections: number;
  contradictions_surfaced: number;
  contradictions_acted_on: number;
  // Wrong actions caught -- the opaque-id-safe deny summary (all fields are counts
  // or closed enums), so it has a server counterpart and mirrors the local view.
  enforcement: EnforcementSummary;
  review_decisions: number;
  coverage_gaps: CoverageGapBreakdown[];
  coverage_gaps_total: number;
}

// --- assembly ---------------------------------------------------------------

type InjectEvent = AnalyticsEvent & EvidenceInjectPayload & { event_type: "mla_evidence_inject" };
type OutcomeEvent = AnalyticsEvent & EvidenceOutcomePayload & { event_type: "mla_evidence_outcome" };
type EnforcementEvent = AnalyticsEvent & { event_type: "mla_enforcement_incident" };

function inWindow(iso: string, startMs: number, nowMs: number): boolean {
  const t = Date.parse(iso);
  return Number.isFinite(t) && t >= startMs && t <= nowMs;
}

// Latest outcome per inject_id (highest outcome_version wins; ties keep the last
// written). A recomputed outcome (bumped version) supersedes its predecessor.
function latestOutcomes(events: AnalyticsEvent[]): Map<string, OutcomeEvent> {
  const byInject = new Map<string, OutcomeEvent>();
  for (const e of events) {
    if (e.event_type !== "mla_evidence_outcome") continue;
    const o = e as OutcomeEvent;
    const prev = byInject.get(o.inject_id);
    if (!prev || o.outcome_version >= prev.outcome_version) byInject.set(o.inject_id, o);
  }
  return byInject;
}

// Collapse mla_enforcement_incident events into a windowed summary. An incident
// can appear more than once (the original v0 deny, then a labeler's v1+ flip of
// review_status), so we group by incident_id: the EARLIEST occurrence dates the
// incident for windowing (delayed-label trap, like the inject/outcome join) and
// the LATEST occurrence supplies the authoritative decision + review_status. Today
// there is exactly one event per incident (the labeler is not wired yet), so this
// reduces to a straight count; it is written this way so a future re-label does
// not double-count.
function summarizeEnforcement(
  events: AnalyticsEvent[],
  startMs: number,
  nowMs: number,
): EnforcementSummary {
  const byIncident = new Map<
    string,
    { firstMs: number; latestMs: number; latest: EnforcementEvent }
  >();
  // incident_ids that carry at least one mla_enforcement_outcome (STAR's R). Collected
  // regardless of when the outcome was written -- the correlator emits it on a LATER Stop,
  // so an outcome commonly post-dates its deny (delayed-close trap, exactly like the
  // inject/outcome join). We attach by id, never window-filter the outcome, so a deny near
  // the window edge still counts as resolved.
  const outcomedIncidentIds = new Set<string>();
  for (const e of events) {
    if (e.event_type === "mla_enforcement_outcome") {
      const id = (e as { incident_id?: unknown }).incident_id;
      if (typeof id === "string" && id.length > 0) outcomedIncidentIds.add(id);
      continue;
    }
    if (e.event_type !== "mla_enforcement_incident") continue;
    const ev = e as EnforcementEvent;
    const id = ev.incident_id;
    if (!id) continue;
    const ms = Date.parse(ev.created_at);
    if (!Number.isFinite(ms)) continue;
    const prev = byIncident.get(id);
    if (!prev) {
      byIncident.set(id, { firstMs: ms, latestMs: ms, latest: ev });
    } else {
      prev.firstMs = Math.min(prev.firstMs, ms);
      if (ms >= prev.latestMs) {
        prev.latestMs = ms;
        prev.latest = ev;
      }
    }
  }

  let total = 0;
  let denied = 0;
  let warned = 0;
  let confirmed = 0;
  let false_positive = 0;
  let unreviewed = 0;
  let resolved = 0;
  let unclassified = 0;
  const toolCounts = new Map<string, number>();
  for (const [id, { firstMs, latest }] of byIncident) {
    // Window on the incident's first occurrence; attach the latest verdict regardless.
    if (firstMs < startMs || firstMs > nowMs) continue;
    total++;
    if (latest.decision === "deny") {
      denied++;
      // Only denies have a follow-through to correlate (a warn does not block). Split the
      // denied population into "we know what happened next" vs the honest blind spot.
      if (outcomedIncidentIds.has(id)) resolved++;
      else unclassified++;
    } else if (latest.decision === "warn") warned++;
    if (latest.review_status === "confirmed") confirmed++;
    else if (latest.review_status === "false_positive") false_positive++;
    else unreviewed++;
    toolCounts.set(latest.enforced_tool, (toolCounts.get(latest.enforced_tool) ?? 0) + 1);
  }
  const by_tool = Array.from(toolCounts.entries())
    .map(([tool, count]) => ({ tool, count }))
    .sort((a, b) => b.count - a.count || a.tool.localeCompare(b.tool));

  return {
    total,
    denied,
    warned,
    confirmed,
    false_positive,
    unreviewed,
    by_tool,
    resolved,
    unclassified,
  };
}

export function buildDashboard(
  events: AnalyticsEvent[],
  windowDays: number,
  nowMs: number,
): StatsDashboard {
  const startMs = nowMs - windowDays * 24 * 60 * 60 * 1000;

  // Window the inject population (the denominator). Outcomes are attached by id
  // below, NOT window-filtered, so a late-closing window is not undercounted.
  const injects = events.filter(
    (e): e is InjectEvent => e.event_type === "mla_evidence_inject" && inWindow(e.created_at, startMs, nowMs),
  );
  const outcomes = latestOutcomes(events);

  const metricInputs: MetricInput[] = injects.map((inj) => {
    const o = outcomes.get(inj.inject_id);
    return {
      evidence_offered: inj.evidence_offered,
      offered_source_ids: inj.offered_source_ids ?? [],
      referenced: o?.referenced ?? false,
      referenced_source_ids: o?.referenced_source_ids ?? [],
      outcome: o?.outcome ?? "pending",
    };
  });
  const evidence = computeMetrics(metricInputs);

  // Section 2: governed-rule denies (the "wrong actions caught" value signal).
  // Contradiction/supersession and governed-decision counts are server-side only
  // (no local producer); the local view points at `mla stats --global` for them.
  const enforcement = summarizeEnforcement(events, startMs, nowMs);

  // Section 4: coverage gaps by type, sorted by demand (most frequent first).
  const gapCounts = new Map<CoverageGapType, number>();
  for (const e of events) {
    if (e.event_type !== "mla_coverage_gap" || !inWindow(e.created_at, startMs, nowMs)) continue;
    gapCounts.set(e.coverage_gap_type, (gapCounts.get(e.coverage_gap_type) ?? 0) + 1);
  }
  const coverage_gaps: CoverageGapBreakdown[] = Array.from(gapCounts.entries())
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
  const coverage_gaps_total = coverage_gaps.reduce((s, g) => s + g.count, 0);

  // Section 5: load-bearing knowledge -- referenced source ids across the
  // windowed injects' outcomes, counted by the same normId rule the join uses so
  // "NT:foo.md" and "NT:foo" collapse. Local renders the id; remote never sees it.
  const refCounts = new Map<string, { id: string; count: number }>();
  for (const inj of injects) {
    const o = outcomes.get(inj.inject_id);
    if (!o) continue;
    for (const id of o.referenced_source_ids ?? []) {
      const key = normId(id);
      const prev = refCounts.get(key);
      if (prev) prev.count++;
      else refCounts.set(key, { id, count: 1 });
    }
  }
  const load_bearing: LoadBearingItem[] = Array.from(refCounts.values())
    .map((r) => ({ source_id: r.id, reference_count: r.count }))
    .sort((a, b) => b.reference_count - a.reference_count || a.source_id.localeCompare(b.source_id))
    .slice(0, 5);

  // Section 6: activity footnote (commands run by name).
  const cmdCounts = new Map<string, number>();
  let commands_total = 0;
  for (const e of events) {
    if (e.event_type !== "mla_command" || !inWindow(e.created_at, startMs, nowMs)) continue;
    commands_total++;
    cmdCounts.set(e.command, (cmdCounts.get(e.command) ?? 0) + 1);
  }
  const commands_by_name = Array.from(cmdCounts.entries())
    .map(([command, count]) => ({ command, count }))
    .sort((a, b) => b.count - a.count || a.command.localeCompare(b.command));

  return {
    window: `${windowDays}d`,
    window_days: windowDays,
    generated_at: new Date(nowMs).toISOString(),
    evidence,
    injections: injects.length,
    enforcement,
    coverage_gaps,
    coverage_gaps_total,
    load_bearing,
    commands_total,
    commands_by_name,
  };
}

// --- render -----------------------------------------------------------------

function pct(r: number | null): string {
  return r === null ? "n/a" : (r * 100).toFixed(0) + "%";
}

// Shared Section 2b renderer (wrong actions caught), so the local and --global views
// cannot drift. The headline is the blocked count; the adjudication split keeps it
// honest (only `confirmed` is a proven catch; a rule can misfire, so we never sell
// `unreviewed` as a win). The per-tool drilldown is verbose-only.
function enforcementLines(en: EnforcementSummary, verbose: boolean): string[] {
  if (en.total === 0) {
    return ["   No risky actions blocked by governed rules in this window."];
  }
  const out: string[] = [];
  const warnNote = en.warned > 0 ? `, ${en.warned} warned` : "";
  out.push(
    `   mla blocked ${en.denied} action(s) before they ran${warnNote} (Write/Edit gated by governed rules).`,
  );
  out.push(
    `     adjudication: ${en.confirmed} confirmed correct, ${en.false_positive} false positive, ${en.unreviewed} not yet reviewed.`,
  );
  // Follow-through (STAR's R) is a LOCAL-only signal: present only when
  // summarizeEnforcement computed it (undefined on the server --global view). Surfaces the
  // correlator's blind spot -- a deny we blocked but never learned the reaction to -- so
  // the miss denominator is visible instead of silently absent.
  if (en.resolved !== undefined && en.unclassified !== undefined && en.denied > 0) {
    out.push(
      `     follow-through: ${en.resolved}/${en.denied} deny outcome(s) correlated, ${en.unclassified} not yet classified.`,
    );
  }
  if (verbose && en.by_tool.length > 0) {
    out.push(`     by tool: ${en.by_tool.map((t) => `${t.tool} ${t.count}`).join(", ")}`);
  }
  return out;
}

export function renderDashboard(d: StatsDashboard, verbose: boolean): string {
  const m = d.evidence;
  const lines: string[] = [];
  lines.push(`mla usefulness, last ${d.window} (workspace-local):`);
  lines.push("");

  // 1. Evidence followthrough (headline).
  lines.push("1. Evidence followthrough");
  if (d.injections === 0) {
    lines.push("   No evidence injections recorded in this window yet.");
  } else {
    const pendingNote = m.pending > 0 ? `, ${m.pending} pending` : "";
    lines.push(
      `   mla surfaced evidence in ${d.injections} injection(s) (${m.injects_offered} offered evidence${pendingNote}).`,
    );
    lines.push(
      `   Injection Utilization:    ${pct(m.injection_utilization)} (${m.injects_referenced}/${m.injects_offered} offered injects referenced)`,
    );
    lines.push(
      `   ${REFERENCE_PRECISION_V1_LABEL}:  ${pct(m.reference_precision_v1)} (${m.used}/${m.used + m.ignored} closed used vs ignored)`,
    );
    lines.push(
      `   Unknown Coverage:         ${pct(m.unknown_coverage)} (${m.unknown}/${m.closed_windows} closed windows unclassified)`,
    );
    lines.push(
      `   Evidence Item Utilization: ${pct(m.evidence_item_utilization)} (${m.distinct_referenced}/${m.distinct_offered} distinct docs)`,
    );
    if (m.no_opportunity > 0) {
      // The agent never got a turn to act on these, so they are excluded from every
      // rate above; surfaced here only so the count is not silently dropped.
      lines.push(
        `   No-opportunity injects:   ${m.no_opportunity} (landed on a session's final turn; excluded from all rates)`,
      );
    }
  }
  lines.push("");

  // 2. Caught before it shipped -- wrong actions blocked by governed rules
  // (locally observable). Contradiction/supersession catches are aggregated
  // server-side; see `mla stats --global`.
  lines.push("2. Caught before it shipped");
  lines.push(...enforcementLines(d.enforcement, verbose));
  lines.push("");

  // 3. Decisions governed -- no local proxy; the authoritative contradiction,
  // governed-change, and propagation counts live in the server rollup.
  lines.push("3. Decisions governed");
  lines.push("   For the authoritative contradiction, governed-change, and propagation count, run `mla stats --global`.");
  lines.push("");

  // 4. What mla could not help with (coverage gaps == the roadmap).
  lines.push("4. Coverage gaps (the roadmap)");
  if (d.coverage_gaps_total === 0) {
    lines.push("   No coverage gaps recorded in this window.");
  } else {
    lines.push(`   ${d.coverage_gaps_total} query/queries returned nothing useful, by type:`);
    for (const g of d.coverage_gaps) lines.push(`     ${g.type}: ${g.count}`);
  }
  lines.push("");

  // 5. Load-bearing knowledge.
  lines.push("5. Load-bearing knowledge");
  if (d.load_bearing.length === 0) {
    lines.push("   No referenced evidence recorded in this window.");
  } else {
    lines.push("   Most-referenced evidence:");
    for (const it of d.load_bearing) lines.push(`     ${it.source_id} (x${it.reference_count})`);
  }

  // 6. Activity footnote (only under --verbose; never the lead).
  if (verbose) {
    lines.push("");
    lines.push("Activity (footnote)");
    lines.push(`   ${d.commands_total} command(s) run.`);
    for (const c of d.commands_by_name) lines.push(`     ${c.command}: ${c.count}`);
  }

  return lines.join("\n");
}

// The global dashboard. Same usefulness-first ordering as the local view, but only
// the sections that have a permission-scoped, opaque-id-safe server counterpart:
// evidence followthrough, the wedge (contradictions caught), decisions governed
// (here AUTHORITATIVE, not a local proxy), and coverage gaps. Load-bearing
// knowledge and the activity footnote are local-only (spec section 9, 7.3) and have
// no global form, so they are intentionally absent rather than rendered empty.
export function renderGlobalDashboard(r: GlobalRollup): string {
  const m = r.evidence;
  const lines: string[] = [];
  const wsLabel = r.workspaces === 1 ? "1 workspace" : `${r.workspaces} workspaces`;
  lines.push(`mla usefulness, last ${r.window_days}d (global: ${wsLabel} you can view):`);
  lines.push("");

  // 1. Evidence followthrough (headline).
  lines.push("1. Evidence followthrough");
  if (r.injections === 0) {
    lines.push("   No evidence injections recorded in this window yet.");
  } else {
    const pendingNote = m.pending > 0 ? `, ${m.pending} pending` : "";
    lines.push(
      `   mla surfaced evidence in ${r.injections} injection(s) (${m.injects_offered} offered evidence${pendingNote}).`,
    );
    lines.push(
      `   Injection Utilization:    ${pct(m.injection_utilization)} (${m.injects_referenced}/${m.injects_offered} offered injects referenced)`,
    );
    lines.push(
      `   ${REFERENCE_PRECISION_V1_LABEL}:  ${pct(m.reference_precision_v1)} (${m.used}/${m.used + m.ignored} closed used vs ignored)`,
    );
    lines.push(
      `   Unknown Coverage:         ${pct(m.unknown_coverage)} (${m.unknown}/${m.closed_windows} closed windows unclassified)`,
    );
    lines.push(
      `   Evidence Item Utilization: ${pct(m.evidence_item_utilization)} (${m.distinct_referenced}/${m.distinct_offered} distinct docs)`,
    );
    if (m.no_opportunity > 0) {
      lines.push(
        `   No-opportunity injects:   ${m.no_opportunity} (landed on a session's final turn; excluded from all rates)`,
      );
    }
  }
  lines.push("");

  // 2. Caught before it shipped (the wedge).
  lines.push("2. Caught before it shipped");
  if (r.contradictions_surfaced === 0) {
    lines.push("   No contradictions or supersessions flagged in this window.");
  } else {
    lines.push(
      `   mla flagged ${r.contradictions_surfaced} contradiction(s)/supersession(s); acted on ${r.contradictions_acted_on}.`,
    );
  }
  // 2b. Wrong actions caught (governed-rule PreToolUse denies). --global has no
  // --verbose, so the per-tool drilldown is always folded.
  lines.push(...enforcementLines(r.enforcement, false));
  lines.push("");

  // 3. Decisions governed (authoritative server count, not the local proxy).
  lines.push("3. Decisions governed");
  lines.push(`   ${r.review_decisions} review decision(s) recorded across your workspaces.`);
  lines.push("");

  // 4. Coverage gaps (the roadmap).
  lines.push("4. Coverage gaps (the roadmap)");
  if (r.coverage_gaps_total === 0) {
    lines.push("   No coverage gaps recorded in this window.");
  } else {
    lines.push(`   ${r.coverage_gaps_total} query/queries returned nothing useful, by type:`);
    for (const g of r.coverage_gaps) lines.push(`     ${g.type}: ${g.count}`);
  }

  return lines.join("\n");
}

// INV-GLOBAL-UNKNOWN-1: telemetry off AND nothing-synced are both "unknown", never
// a misleading zero. Same human-facing message for both; in --json the machine gets
// an explicit `available:false` with the reason so it cannot read it as activity=0.
function emitGlobalUnavailable(
  reason: "telemetry_off" | "no_synced_data",
  json: boolean,
): void {
  const message = "No remote telemetry available. Local stats are still available.";
  if (json) {
    console.log(JSON.stringify({ available: false, reason, message }, null, 2));
  } else {
    console.log(message);
  }
}

// --- entry point ------------------------------------------------------------

export interface StatsDeps {
  read?: (env?: NodeJS.ProcessEnv) => AnalyticsEvent[];
  nowMs?: number;
  // The evidence-section / `mla adoption` delegate. Injectable so the parity test
  // can assert one code path; defaults to the real runAdoption.
  adoption?: (argv: string[]) => number;
  // T6.2 (`--global`). `env` drives the telemetry-consent gate; `fetchGlobal` is
  // the control rollup call. The network call to control is the external boundary,
  // so the CLI test injects fetchGlobal to exercise the telemetry-off and
  // unknown-not-zero branches without a live server (the server side is covered by
  // the real-DB AnalyticsRollupService spec). Defaults hit process.env + control.
  env?: NodeJS.ProcessEnv;
  fetchGlobal?: (periodDays: number) => Promise<GlobalRollup>;
  // T7.2 analytics seam: emit mla_stats_viewed when a human checks value. The
  // recorder + workspace resolver are injectable so the CLI test asserts the
  // emitted event without touching the real local store or cwd resolution.
  record?: typeof recordAnalyticsEvent;
  resolveWorkspaceId?: (startDir?: string) => string | null;
  // `mla stats --turn [N]` is an alias for the per-turn recap. Injectable so the
  // alias-routing test asserts one handler (the real `mla turn`) without disk.
  turn?: (argv: string[]) => Promise<number>;
}

// Translate a `mla stats --turn [N]` argv into the `mla turn` argv: the value
// after --turn (when number-shaped) becomes the positional turn index, and --json
// / --session pass through. Window/verbose/global have no per-turn meaning and are
// dropped (the alias is a convenience, not a second per-turn flag surface).
export function translateTurnAlias(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--turn") {
      const v = argv[i + 1];
      if (v !== undefined && /^[0-9]+$/.test(v)) {
        out.push(v);
        i++;
      }
    } else if (a === "--json") {
      out.push("--json");
    } else if (a === "--session") {
      const v = argv[++i];
      if (v) out.push("--session", v);
    }
  }
  return out;
}

// T7.2: `mla stats` is a value-checking moment -- record that someone looked
// (mla_stats_viewed answers "are people checking value"). The payload is the
// closed scope/window only (no metrics, no PII). Best-effort and fail-soft:
// analytics must never break a stats read. It only record()s into the buffer;
// run context (run_id/trace_id) is ambient from bootstrap and the cli.ts finalize
// flush ships it.
function recordStatsViewed(args: StatsArgs, deps: StatsDeps): void {
  try {
    const env = deps.env ?? process.env;
    const record = deps.record ?? recordAnalyticsEvent;
    const resolveWs = deps.resolveWorkspaceId ?? tryResolveWorkspaceId;
    const nowMs = deps.nowMs ?? Date.now();
    const payload: StatsViewedPayload = {
      scope: args.global ? "global" : "local",
      window: args.windowLabel,
    };
    const ctx: RecordContext = {
      workspaceId: resolveWs(),
      sessionId: (env.CLAUDE_CODE_SESSION_ID || "").trim() || null,
      now: new Date(nowMs).toISOString(),
    };
    record(ctx, { eventType: "mla_stats_viewed", payload: payload as unknown as Record<string, unknown> }, env);
  } catch {
    // fail-soft: a stats view must never be blocked by analytics.
  }
}

export async function runStats(argv: string[], deps: StatsDeps = {}): Promise<number> {
  // `mla stats --turn [N]` is an alias for the per-turn recap (`mla turn`). It is
  // intercepted before parseStatsArgs (which has no --turn flag) and delegated to
  // the SAME handler, so the two entry points are one implementation, not two.
  if (argv.includes("--turn")) {
    return (deps.turn ?? runTurn)(translateTurnAlias(argv));
  }

  let args: StatsArgs;
  try {
    args = parseStatsArgs(argv);
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }

  // T7.2: every successful `mla stats` view is a value-checking signal -- record
  // it before dispatching so local / evidence / global all count uniformly.
  recordStatsViewed(args, deps);

  // `mla stats evidence` is the focused adoption join -- the SAME code path as
  // `mla adoption` (INV-ADOPTION-SOURCE-1). One join, two entry points.
  if (args.section === "evidence") {
    return (deps.adoption ?? runAdoption)(args.rest);
  }

  // `--global` reads the control rollup read-model (spec section 10.4), not PostHog.
  if (args.global) {
    return runGlobalStats(args, deps);
  }

  const read = deps.read ?? readEvents;
  const nowMs = deps.nowMs ?? Date.now();
  const events = read();
  const dashboard = buildDashboard(events, args.windowDays, nowMs);

  if (args.json) {
    console.log(JSON.stringify(dashboard, null, 2));
  } else {
    console.log(renderDashboard(dashboard, args.verbose));
  }
  return 0;
}

// `mla stats --global`: authenticated server call to control's rollup read-model.
// Reads the canonical, deduped, permission-scoped aggregate (NEVER PostHog), so the
// global numbers are ACL-correct and cannot drift from the local definitions (the
// server mirrors the same metric math). "Zero means no activity; telemetry-off
// means unknown" -- both telemetry-off and nothing-synced print the unknown
// message, never a zero (INV-GLOBAL-UNKNOWN-1).
async function runGlobalStats(args: StatsArgs, deps: StatsDeps): Promise<number> {
  const env = deps.env ?? process.env;

  // Telemetry off -> unknown, not zero. No server call is made (and none could
  // succeed: nothing has been synced).
  if (!remoteAnalyticsEnabled(env)) {
    emitGlobalUnavailable("telemetry_off", args.json);
    return 0;
  }

  let rollup: GlobalRollup;
  try {
    rollup = deps.fetchGlobal
      ? await deps.fetchGlobal(args.windowDays)
      : await fetchGlobalRollup(args.windowDays);
  } catch (e) {
    // A reachability/auth failure is NOT "no activity"; surface it as an error
    // (exit 1) so it is never silently read as a zero.
    console.error(`mla stats --global could not reach control: ${(e as Error).message}`);
    return 1;
  }

  // Nothing synced yet for any visible workspace -> unknown, not zero.
  if (!rollup.has_any_events) {
    emitGlobalUnavailable("no_synced_data", args.json);
    return 0;
  }

  if (args.json) {
    console.log(JSON.stringify(rollup, null, 2));
  } else {
    console.log(renderGlobalDashboard(rollup));
  }
  return 0;
}

// The real control call. `get` auto-stamps the bearer, X-Trace-ID, and
// X-Meetless-Actor (the actor the rollup endpoint resolves under INV-AUTH-1). The
// rollup is cross-workspace by design, so we read the base config (readConfig), not
// a workspace-bound one -- there is no single workspace to bind to.
async function fetchGlobalRollup(periodDays: number): Promise<GlobalRollup> {
  const cfg = readConfig();
  return get<GlobalRollup>(cfg, `/internal/v1/analytics/rollups?periodDays=${periodDays}`);
}
