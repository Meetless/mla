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
import {
  computeMetrics,
  MetricFamily,
  MetricInput,
  EVIDENCE_ITEM_REFERENCE_RATE_LABEL,
  PROACTIVE_INJECTION_UTILIZATION_LABEL,
  REFERENCE_PRECISION_V1_LABEL,
} from "../lib/analytics/metrics";
import { readLogJsonl, readLogJsonlTail } from "../lib/analytics/logs";
import { parseMcpCalls, parseReportCitations } from "../lib/analytics/followthrough";
import { parsePointerFires } from "../lib/evidence-pointer";
import { IgnoredDocument, ignoredDocuments } from "../lib/analytics/ignored-by-document";
import { matchOpenedIds, parseFileReads } from "../lib/analytics/turn-recap";
import {
  POINTER_KILL_MIN_FIRES,
  PointerOutcome,
  buildPointerEngagements,
  pointerVerdict,
  scorePointerOutcomes,
} from "../lib/analytics/pointer-outcome";
import { PullSummary, computePullSummary, emptyPullSummary } from "../lib/analytics/pull";
import { FloorSummary, computeFloorSummary, emptyFloorSummary } from "../lib/analytics/floor";
import { renderAskOutcomes, summarizeAskOutcomes, toAskTraceRow } from "../lib/analytics/ask-outcomes";
import { renderDailyTimeoutSeries, summarizeDailyTimeoutSeries } from "../lib/analytics/ask-daily-series";
import { LAYER2_ENRICH_BUDGET_MS } from "../connectors/claude-code/hook-contract";
import { coverageGapPresentation } from "../lib/analytics/coverage-gap-presentation";
import { normId } from "../lib/analytics/followthrough";
import { readEvents } from "../lib/analytics/store";
import { RecordContext, recordAnalyticsEvent } from "../lib/analytics/recorder";
import { remoteAnalyticsEnabled } from "../lib/analytics/consent";
import { readConfig } from "../lib/config";
import { tryResolveWorkspaceId } from "../lib/workspace";
import { get } from "../lib/http";
import {
  isWorkspaceAccessDenied,
  workspaceAccessDeniedMessage,
} from "../lib/workspace-access";
import { runAdoption } from "./adoption";
import { runTurn } from "./turn";

// --- args -------------------------------------------------------------------

export interface StatsArgs {
  section: "evidence" | "ask" | null;
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
    if (section !== "evidence" && section !== "ask") {
      throw new Error(`Unknown \`mla stats\` section: ${section} (known: evidence, ask)`);
    }
    out.section = section;
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
  // What KIND of question failed, and how close retrieval got. Section 4 calls
  // itself "the roadmap" but shipped a bare {type, count}, which says something
  // failed and refuses to say what: an eval-set builder cannot act on it.
  //
  // The query TEXT is deliberately absent and stays absent. It is not retained on
  // this path at all (internal-evidence-inject takes --topic-category, a closed
  // enum, never the prompt) and INV-POSTHOG-PII-1 bars the prompt from this plane.
  // Exposing it would mean BUILDING a prompt-capture path. Both fields below are
  // closed enums already on the payload; nothing new is captured.
  topics: { topic: string; count: number }[];
  confidences: { confidence: string; count: number }[];
  // Most recent occurrence, so a gap that stopped happening is distinguishable
  // from one that is still firing. Null only if no event carried a timestamp.
  last_seen: string | null;
}

export interface LoadBearingItem {
  source_id: string;
  reference_count: number;
}

// Section 2b: governed-rule enforcement (the "wrong actions caught" signal). A
// PreToolUse deny OR warn fires an mla_enforcement_incident (the session ceiling
// MEETLESS_ACTION_INTERCEPT_MAX defaults to WARN, which clamps a DENY-attested
// rule down to a non-blocking warn, so warns are the common case, not reserved);
// an offline labeler can later supersede it to flip review_status, so the summary
// is collapsed by incident_id
// (latest wins, like latestOutcomes). The adjudication split is load-bearing for
// HONESTY: a raw deny count overclaims because a rule can misfire (the known
// notes-location-v1 vault-own-path false positive), so `confirmed` is the only
// number we may present as a proven catch; `unreviewed` is the honest unknown.
export interface EnforcementSummary {
  total: number; // distinct incidents in window (collapsed by incident_id)
  denied: number; // latest decision === "deny" (hard block)
  warned: number; // latest decision === "warn" (non-blocking advisory; INV-8 rung)
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

// Utilization for one intent bucket. `unlabelled` counts injects whose event
// carried no intent at all (an older hook, or a strategy with no router trace);
// those are in NEITHER bucket, because "the router said unknown" and "nobody told
// us" are different facts and merging them would make the split unreadable in
// exactly the window it exists to read.
export interface IntentSplit {
  known: { injects_offered: number; injects_referenced: number; injection_utilization: number | null };
  unknown: { injects_offered: number; injects_referenced: number; injection_utilization: number | null };
  unlabelled: number;
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
  // Section 1b: the PULL path -- what the agent fetched for itself. Reported
  // separately from `evidence` and never merged into it: they answer different
  // questions (did our push land vs did the agent's own lookup go anywhere), and
  // one number covering both would hide whichever is doing the work.
  pull: PullSummary;
  // Section 1c (F1, 2026-08-08): the FLOOR path -- the always-on rules that ride on
  // every turn whether or not anything was retrieved. The third channel, reported
  // beside the other two and never merged into either.
  //
  // It is a COST number and it is labelled as one. There is no observable event for
  // "the agent obeyed a MUST" the way there is for a pull (a citation) or a push (a
  // reference), so counting delivery as value would be the same over-claim `mla
  // status` was fixed for. What it buys is that the channel becomes VISIBLE: a
  // regression in floor delivery, or a floor that doubles in size, is now detectable
  // rather than invisible to every number on the page.
  floor: FloorSummary;
  // Section 1a: the SAME inject population, decomposed by the router's intent.
  // A decomposition, never a filter: the headline metric family above is unchanged.
  intent_split: IntentSplit;
  // Section 4: coverage gaps, sorted by demand.
  coverage_gaps: CoverageGapBreakdown[];
  coverage_gaps_total: number;
  // Section 5: load-bearing knowledge (local: by id; remote sees opaque ids).
  load_bearing: LoadBearingItem[];
  // Section 5c: F6. Documents pushed repeatedly and never once engaged with. A
  // CANDIDATE negative for a human to look at, never a ranking input; see
  // lib/analytics/ignored-by-document.ts for why that boundary is the design.
  ignored_documents: IgnoredDocument[];
  // Section 5b: F1's moment-of-need pointer, on its OWN instrument.
  //
  // Kept out of the metric family above ON PURPOSE. F1 resurfaces evidence at the tool
  // call, so its success is usually an `opened` or a silent read, neither of which is in
  // `referenced`; and when a pointer DOES cause a pull, that pull is mla's own output.
  // Folding either into the injection rate would make the number un-interpretable in one
  // direction or the other. See lib/analytics/pointer-outcome.ts.
  pointer: PointerOutcome;
  // Section 6: activity footnote (only populated when --verbose).
  commands_total: number;
  commands_by_name: { command: string; count: number }[];
  // ACTIVATION, and deliberately NOT windowed like everything above it. "Has this workspace ever
  // reached first value" is a lifetime question; scoping it to 30 days would un-activate a
  // workspace that activated in month one and quietly answer a different question.
  activation: ActivationSummary;
}

/**
 * Did MLA ever do something in this repository that the session would not have done without it?
 *
 * THE DEFINITION (An's ruling, 2026-08-08): activation is the first agent turn carrying
 * REPO-SCOPED governed state or REPO-DERIVED evidence. Deliberately narrower than "any governed
 * rule": the always-on floor is largely generic and global, so counting it would mark a workspace
 * activated for delivering rules that prove nothing was ever learned about THIS repository.
 *
 * Two signals qualify, and both are already emitted:
 *   scoped_rule  an `mla_rule_injection` turn with scoped_rules > 0. A scoped rule matched this
 *                turn's paths or prompt, which only happens against repo-specific targeting.
 *   evidence     an `mla_evidence_inject`. Evidence is retrieved from this workspace's own corpus.
 *
 * Utilization stays a SEPARATE and stronger question (section 1): activation says the product
 * delivered something repo-specific, not that the agent used it.
 */
export interface ActivationSummary {
  activated: boolean;
  /** ISO of the first qualifying turn; null when it never happened. */
  first_governed_turn_at: string | null;
  /** ISO of the earliest local command, the clock this is measured from. */
  first_command_at: string | null;
  /** Whole minutes between the two; null when either endpoint is missing. */
  minutes_to_activation: number | null;
  /** Which signal proved it, so the number is never quoted without its cause. */
  via: "scoped_rule" | "evidence" | null;
}

/**
 * Compute activation over the FULL local event history (never the window; see the field comment).
 * Pure, and exported so a test can pin the definition rather than the rendering.
 */
export function computeActivation(events: AnalyticsEvent[]): ActivationSummary {
  let firstCommandAt: string | null = null;
  let firstGovernedAt: string | null = null;
  let via: "scoped_rule" | "evidence" | null = null;

  for (const e of events) {
    const at = e.created_at;
    if (typeof at !== "string" || at.length === 0) continue;
    if (e.event_type === "mla_command" && (firstCommandAt === null || at < firstCommandAt)) {
      firstCommandAt = at;
    }
    const qualifies =
      e.event_type === "mla_evidence_inject"
        ? "evidence"
        : e.event_type === "mla_rule_injection" &&
            typeof (e as { scoped_rules?: unknown }).scoped_rules === "number" &&
            (e as { scoped_rules: number }).scoped_rules > 0
          ? "scoped_rule"
          : null;
    if (qualifies && (firstGovernedAt === null || at < firstGovernedAt)) {
      firstGovernedAt = at;
      via = qualifies;
    }
  }

  // Only report a duration when both endpoints exist AND the order makes sense. A governed turn
  // stamped before the first command means the local spool was pruned or clock-skewed, and a
  // negative "time to value" is worse than an absent one.
  let minutes: number | null = null;
  if (firstCommandAt && firstGovernedAt) {
    const delta = Date.parse(firstGovernedAt) - Date.parse(firstCommandAt);
    if (Number.isFinite(delta) && delta >= 0) minutes = Math.round(delta / 60000);
  }

  return {
    activated: firstGovernedAt !== null,
    first_governed_turn_at: firstGovernedAt,
    first_command_at: firstCommandAt,
    minutes_to_activation: minutes,
    via,
  };
}

// The server rollup read-model behind `mla stats --global` (control's
// GET /internal/v1/analytics/rollups). Its shape mirrors control's AnalyticsRollup
// (apps/control/src/analytics/analytics-rollup.ts): the same MetricFamily plus the
// permission-scoped tallies. has_any_events distinguishes "nothing has ever synced
// for your workspaces" (unknown) from "synced activity that nets to zero in this
// window" (INV-GLOBAL-UNKNOWN-1). It deliberately carries NO load-bearing source
// ids and NO activity footnote: remote sees opaque ids only (spec section 9, 7.3),
// so those two local-only sections have no global counterpart.
export interface GlobalActivitySummary {
  commands: number;
  sessions: number;
  rule_injections: number;
  head_tokens: number;
  hook_invocations: number;
  hook_failures: number;
  rules_configured: number;
  last_active_at: string | null;
}

export interface GlobalRollup {
  window_days: number;
  workspaces: number;
  has_any_events: boolean;
  // The THIRD state (notes/20260801-value-dashboard-empty-root-cause.md).
  // has_any_events answers "is the CLI syncing at all"; this answers "has any
  // instrument this dashboard reads ever fired". They came apart in production:
  // every workspace synced heavily and not one had produced a governed event, so
  // --global printed a full dashboard of zeros as if it had measured a failure.
  // Optional so an older control (pre-rollout) is read as governed, i.e. the old
  // behavior, rather than flipping every terminal into the new branch.
  has_governed_events?: boolean;
  // What the workspaces DID, whether or not it was governed. Rendered in place of
  // the zero wall so the third state is informative instead of a dead end.
  activity?: GlobalActivitySummary;
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
  // The pull join, computed by the caller from the two local trace files. Passed in
  // rather than read here so buildDashboard stays a pure function of its inputs,
  // which is what every existing test of it relies on.
  pull: PullSummary = emptyPullSummary(),
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

  // The intent decomposition, over the SAME decided-inject population the headline
  // uses (evidence_offered > 0; no_opportunity AND pending both censored, F4), so the
  // two can be read together without a denominator mismatch. This filter and
  // computeMetrics' `scored` filter have to move together; if they ever disagree, the
  // split will not sum to the headline and neither number will be trustworthy.
  const bucket = () => ({ injects_offered: 0, injects_referenced: 0, injection_utilization: null as number | null });
  const known = bucket();
  const unknown = bucket();
  let unlabelled = 0;
  for (const inj of injects) {
    const o = outcomes.get(inj.inject_id);
    if (o === undefined || o.outcome === "no_opportunity" || o.outcome === "pending") continue;
    if (inj.evidence_offered <= 0) continue;
    const intent = (inj as unknown as { intent_type?: string | null }).intent_type;
    if (typeof intent !== "string" || intent.length === 0) {
      unlabelled++;
      continue;
    }
    const b = intent === "unknown" ? unknown : known;
    b.injects_offered++;
    if (o?.referenced) b.injects_referenced++;
  }
  for (const b of [known, unknown]) {
    b.injection_utilization = b.injects_offered ? b.injects_referenced / b.injects_offered : null;
  }
  const intent_split: IntentSplit = { known, unknown, unlabelled };

  // Section 2: governed-rule denies (the "wrong actions caught" value signal).
  // Contradiction/supersession and governed-decision counts are server-side only
  // (no local producer); the local view points at `mla stats --global` for them.
  const enforcement = summarizeEnforcement(events, startMs, nowMs);

  // Section 4: coverage gaps by type, sorted by demand (most frequent first).
  const gapAgg = new Map<
    CoverageGapType,
    { count: number; topics: Map<string, number>; confidences: Map<string, number>; lastSeen: string | null }
  >();
  for (const e of events) {
    if (e.event_type !== "mla_coverage_gap" || !inWindow(e.created_at, startMs, nowMs)) continue;
    let agg = gapAgg.get(e.coverage_gap_type);
    if (!agg) {
      agg = { count: 0, topics: new Map(), confidences: new Map(), lastSeen: null };
      gapAgg.set(e.coverage_gap_type, agg);
    }
    agg.count += 1;
    const topic = e.query_topic_category ?? "unknown";
    agg.topics.set(topic, (agg.topics.get(topic) ?? 0) + 1);
    const conf = e.retrieval_confidence ?? "none";
    agg.confidences.set(conf, (agg.confidences.get(conf) ?? 0) + 1);
    if (e.created_at && (agg.lastSeen === null || e.created_at > agg.lastSeen)) {
      agg.lastSeen = e.created_at;
    }
  }
  // Descending by count, then by name, so a tie renders the same way twice.
  const byDemand = (m: Map<string, number>, key: "topic" | "confidence") =>
    Array.from(m.entries())
      .map(([k, count]) => ({ [key]: k, count }) as never)
      .sort((a: { count: number }, b: { count: number }) => b.count - a.count) as never[];
  const coverage_gaps: CoverageGapBreakdown[] = Array.from(gapAgg.entries())
    .map(([type, agg]) => ({
      type,
      count: agg.count,
      topics: byDemand(agg.topics, "topic") as { topic: string; count: number }[],
      confidences: byDemand(agg.confidences, "confidence") as { confidence: string; count: number }[],
      last_seen: agg.lastSeen,
    }))
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

  // Section 5b: F1's pointer ledger. Read from the local spools, like the pull half
  // beside it. Cheap by construction: only the turns a pointer actually fired on are
  // scored, and pointers are capped at two per turn.
  const pointer = readPointerOutcome();

  // Section 5c (F6): the same inject/outcome rows read above, aggregated the other way
  // round. A document offered again and again and never engaged with is either
  // mis-ranked or not useful, and today that fact is computed per turn and thrown away.
  // Only DECIDED windows count: a pending inject, or one that landed on the session's
  // last turn, had no opportunity to be used and proves nothing.
  const ignored_documents = ignoredDocuments(
    injects.map((inj) => {
      const o = outcomes.get(inj.inject_id);
      return {
        offered_source_ids: inj.offered_source_ids ?? [],
        referenced_source_ids: o?.referenced_source_ids ?? [],
        decided: o !== undefined && o.outcome !== "pending" && o.outcome !== "no_opportunity",
      };
    }),
  );

  return {
    window: `${windowDays}d`,
    window_days: windowDays,
    generated_at: new Date(nowMs).toISOString(),
    evidence,
    injections: injects.length,
    enforcement,
    pull,
    // Computed from the SAME windowed event list as everything else, so the three
    // channels describe one window and can be read against each other.
    floor: computeFloorSummary(events.filter((e) => inWindow(e.created_at, startMs, nowMs))),
    intent_split,
    coverage_gaps,
    coverage_gaps_total,
    load_bearing,
    ignored_documents,
    pointer,
    commands_total,
    commands_by_name,
    // Full history on purpose, not the windowed slice above.
    activation: computeActivation(events),
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

/**
 * Score F1's pointers against what the agent did next.
 *
 * Reads four small local spools and joins only on the turns a pointer fired. Fails to an
 * empty ledger on any fault: a stats section is not worth breaking `mla stats` over, and
 * "no pointers scored" is honestly what an unreadable spool means.
 */
function readPointerOutcome(): PointerOutcome {
  try {
    // 1MB of ~150-byte rows is the last ~7,000 fires, far past the 50 the verdict needs.
    const fires = parsePointerFires(readLogJsonlTail("evidence-pointers.jsonl", 1024 * 1024));
    if (!fires.length) return scorePointerOutcomes([], []);
    const readsByTurn = new Map<string, string[]>();
    for (const r of parseFileReads(readLogJsonl("file-reads.jsonl"))) {
      const key = `${r.session_id} ${r.turn_index}`;
      const list = readsByTurn.get(key) ?? [];
      list.push(r.path);
      readsByTurn.set(key, list);
    }
    const engagements = buildPointerEngagements(fires, {
      mcpCalls: parseMcpCalls(readLogJsonl("mcp-calls.jsonl")),
      citations: parseReportCitations(readLogJsonl("report-citations.jsonl")),
      readsByTurn,
      // The SHARED id-to-path rule, not a second copy: a private one here would let the
      // pointer ledger and the turn recap disagree about whether a file was opened.
      matchOpened: (offered, paths) =>
        matchOpenedIds(
          offered,
          paths.map((p) => ({ session_id: "", turn_index: 0, path: p })),
        ),
    });
    return scorePointerOutcomes(fires, engagements);
  } catch {
    return scorePointerOutcomes([], []);
  }
}

/**
 * Section 5b. Reported beside the injection rate and never inside it, with the verdict
 * spelled out, because this number's whole job is to decide whether F1 stays.
 */
function pointerLines(p: PointerOutcome): string[] {
  const lines: string[] = ["5b. Moment-of-need pointers (F1)"];
  if (p.pointed === 0) {
    lines.push("   No pointers have fired yet.");
    return lines;
  }
  const rate = p.engagement_rate === null ? "n/a" : `${Math.round(p.engagement_rate * 100)}%`;
  lines.push(`   Fired: ${p.fires} (${p.pointed} distinct document/turn opportunities)`);
  lines.push(`   Engaged after the pointer: ${p.engaged}/${p.pointed} (${rate})`);
  const verdict = pointerVerdict(p);
  if (verdict === "undecided") {
    lines.push(`   Verdict: undecided (${p.pointed}/${POINTER_KILL_MIN_FIRES} opportunities toward the kill check)`);
  } else {
    lines.push(`   Verdict: ${verdict.toUpperCase()}`);
  }
  // Said out loud, because the alternative is someone adding these two numbers together.
  lines.push(
    "   Scored separately from the injection rate on purpose: a pointer's success is usually an open or a",
  );
  lines.push(
    "   silent read (invisible to `referenced`), and a pointer-caused pull is mla grading its own output.",
  );
  return lines;
}

/**
 * Section 1's headline, shared by the local and global renders.
 *
 * ONE implementation on purpose: these two blocks were byte-identical copies, and the
 * F4 change had to be made twice to land at all. A metric whose two renders can drift
 * is a metric that will eventually report two different numbers for the same fact.
 *
 * F4 (2026-08-08): `unresolved` is stated, with the reason, whenever it is non-zero.
 * The old render said "N pending" inside a parenthetical and then printed a rate that
 * had already counted those same injects as misses. Now the rate covers DECIDED
 * windows only and the censored count sits directly beneath it, so the sample size
 * behind the percentage is never implicit.
 */
function evidenceHeadlineLines(m: MetricFamily, injections: number): string[] {
  const lines: string[] = [
    `   mla surfaced evidence in ${injections} injection(s) (${m.injects_offered} decided, with evidence offered).`,
    `   ${PROACTIVE_INJECTION_UTILIZATION_LABEL}: ${pct(m.injection_utilization)} (${m.injects_referenced}/${m.injects_offered} decided injects referenced)`,
    `   ${REFERENCE_PRECISION_V1_LABEL}:  ${pct(m.reference_precision_v1)} (${m.used}/${m.used + m.ignored} referenced / decided)`,
    `   Unknown Coverage:         ${pct(m.unknown_coverage)} (${m.unknown}/${m.closed_windows} closed windows unclassified)`,
    `   ${EVIDENCE_ITEM_REFERENCE_RATE_LABEL}: ${pct(m.evidence_item_utilization)} (${m.distinct_referenced}/${m.distinct_offered} distinct docs)`,
  ];
  if (m.unresolved > 0) {
    // CENSORED, not counted. Spelled out because the alternative reading of a small
    // denominator is "mla barely ran", and the true reading is "most windows have not
    // been graded yet". Split by cause: the two are unresolved for different reasons
    // and only one of them will ever resolve.
    const parts: string[] = [];
    if (m.pending > 0) parts.push(`${m.pending} still open`);
    if (m.no_opportunity > 0) parts.push(`${m.no_opportunity} landed on a session's final turn`);
    lines.push(
      `   Unresolved windows:       ${m.unresolved} (${parts.join("; ")}); censored from every rate above, never scored a miss`,
    );
  }
  return lines;
}

export function renderDashboard(d: StatsDashboard, verbose: boolean): string {
  const m = d.evidence;
  const lines: string[] = [];
  lines.push(`mla usefulness, last ${d.window} (workspace-local):`);
  lines.push("");

  // Activation leads, because a workspace that never activated makes every number below it a
  // measurement of nothing. Marked lifetime so it is never read as part of the window.
  const a = d.activation;
  if (a.activated) {
    const when =
      a.minutes_to_activation === null
        ? ""
        : a.minutes_to_activation < 60
          ? ` after ${a.minutes_to_activation}m`
          : ` after ${(a.minutes_to_activation / 60).toFixed(1)}h`;
    const cause = a.via === "evidence" ? "evidence from this repo" : "a repo-scoped rule";
    lines.push(`0. Activated (lifetime): first turn carrying ${cause}${when} from the first command.`);
  } else {
    lines.push(
      "0. NOT activated (lifetime): no turn has yet carried a repo-scoped rule or evidence from",
    );
    lines.push(
      "   this repository. The always-on floor does not count: it is generic, so delivering it",
    );
    lines.push(
      "   proves nothing was learned about this repo. Run the `/mla onboard` skill to index it.",
    );
  }
  lines.push("");

  // 1. Evidence followthrough (headline).
  lines.push("1. Evidence followthrough");
  if (d.injections === 0) {
    lines.push("   No evidence injections recorded in this window yet.");
  } else {
    lines.push(...evidenceHeadlineLines(m, d.injections));
    // The SAME injects, split by what the router thought the turn was about. A
    // decomposition, not a filter: the rate above is unchanged. It exists because
    // "the router could not classify this turn and we injected anyway" and "the
    // ranking was wrong" produce the same ignored inject, and only this split tells
    // them apart. Behavior on an unknown intent is deliberately unchanged until this
    // has a week of data: suppressing those injects would raise the rate above
    // without making one inject more useful.
    const isp = d.intent_split;
    if (isp.known.injects_offered + isp.unknown.injects_offered > 0) {
      lines.push(
        `     by router intent: known ${pct(isp.known.injection_utilization)} (${isp.known.injects_referenced}/${isp.known.injects_offered}), unknown ${pct(isp.unknown.injection_utilization)} (${isp.unknown.injects_referenced}/${isp.unknown.injects_offered})`,
      );
      if (isp.unlabelled > 0) {
        lines.push(`     ${isp.unlabelled} inject(s) carry no router intent yet (pre-rollout rows).`);
      }
    } else if (isp.unlabelled > 0) {
      // Never render "unknown 0%" for a bucket with no members: that reads as a
      // measured failure of the router rather than as telemetry that has not
      // reached this window yet.
      lines.push(`     by router intent: not yet labelled (${isp.unlabelled} inject(s) predate the intent field).`);
    }
  }
  lines.push("");

  // 1b. The PULL path. Reported next to the push metrics and never merged into
  // them. Every number here is already on disk (mcp-calls.jsonl +
  // report-citations.jsonl); this section exists because nothing was reading them.
  //
  // Note what is NOT claimed. A non-empty pull is a RETRIEVAL result, not a help
  // result: on this machine 93% of evidence-tool calls returned something and 1.6%
  // of returned references were ever cited. Only the observable follow-through is
  // reported as follow-through.
  lines.push("1b. Pull path (evidence the agent fetched for itself)");
  if (d.pull.pull_calls === 0) {
    lines.push("   No agent-initiated evidence calls recorded in this window.");
  } else {
    const p = d.pull;
    lines.push(
      `   Pull calls:               ${p.pull_calls} (${p.non_empty_pull_calls} returned results, ${p.empty_pull_calls} empty)`,
    );
    lines.push(
      `   Documents returned:       ${p.documents_returned} (${p.unique_documents_returned} unique)`,
    );
    lines.push(
      `   Pull reference follow-through: ${pct(p.pull_reference_followthrough)} (${p.returned_references_cited}/${p.returned_references} returned references later cited)`,
    );
    if (verbose && p.by_tool.length > 0) {
      lines.push(`     by tool: ${p.by_tool.map((t) => `${t.tool} ${t.count}`).join(", ")}`);
    }
    lines.push(
      "   A returned result is not a used result: only citations are counted above.",
    );
  }
  lines.push("");

  // 1c. The floor channel (F1). Third of three, and the only one reported as pure cost.
  lines.push("1c. Floor (governed rules delivered on every turn)");
  if (d.floor.turns === 0) {
    lines.push("   No rule block was delivered in this window.");
  } else {
    const f = d.floor;
    const rules = f.rules_now === null ? "unknown" : `${f.rules_now}`;
    lines.push(
      `   Turns carrying rules:     ${f.turns} (${rules} always-on rules on the latest turn)`,
    );
    lines.push(
      `   Always-on cost:           ~${f.always_on_tokens_mean ?? 0} tokens/turn, ${f.always_on_tokens_total} this window`,
    );
    if (f.always_on_share !== null) {
      lines.push(
        `   Untargeted share:         ${pct(f.always_on_share)} of delivered rule tokens rode on every turn regardless of the prompt`,
      );
    }
    if (f.overflow_turns > 0) {
      // A block is not an injection. Held out of the means above and named here,
      // because a MUST that could not fit is the most actionable row on this page.
      lines.push(
        `   Blocked by budget:        ${f.overflow_turns} turn(s) where an applicable MUST did not fit (prompt blocked, fail-closed)`,
      );
    }
    if (f.degraded_turns > 0) {
      lines.push(
        `   Counts unknown:           ${f.degraded_turns} turn(s) assembled from a missing or stale cache (bytes true, rule counts unknown)`,
      );
    }
    // Said out loud, every render, because this is the one section on the page whose
    // numbers a reader will otherwise take for a value claim.
    lines.push(
      "   This is COST, not value: delivery is observable, obedience is not. The two reference rates",
    );
    lines.push(
      "   above are the only 'did it help' numbers here, and the three channels are never summed.",
    );
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
    for (const g of d.coverage_gaps) {
      const gap = coverageGapPresentation(g.type);
      lines.push(`     ${gap.label}: ${g.count}  (${gap.hint})`);
      // The class of question that failed, and how close retrieval got. This is
      // what makes the section actionable as a roadmap: a bare count names no
      // work. The query text is not retained on this path and is not printed.
      const topics = g.topics.map((t) => `${t.topic} x${t.count}`).join(", ");
      if (topics) lines.push(`       topics:     ${topics}`);
      const confs = g.confidences.map((c) => `${c.confidence} x${c.count}`).join(", ");
      if (confs) lines.push(`       retrieval:  ${confs}`);
      if (g.last_seen) lines.push(`       last seen:  ${g.last_seen}`);
    }
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
  if (d.ignored_documents.length > 0) {
    // Named as an OBSERVATION, with the caveat attached, because the number invites
    // exactly one wrong reading ("delete these notes") and one dangerous one ("penalize
    // these notes"). Neither is supported by the signal.
    lines.push("   Offered repeatedly, never engaged with:");
    for (const it of d.ignored_documents.slice(0, 5)) {
      lines.push(`     ${it.source_id} (offered x${it.offered}, engaged 0)`);
    }
    lines.push("     Mis-ranked or not useful; this cannot tell which. A question for a human, not a ranking signal.");
  }
  lines.push("");
  lines.push(...pointerLines(d.pointer));

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
    lines.push(...evidenceHeadlineLines(m, r.injections));
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
    for (const g of r.coverage_gaps) {
      const gap = coverageGapPresentation(g.type);
      lines.push(`     ${gap.label}: ${g.count}  (${gap.hint})`);
    }
  }

  return lines.join("\n");
}

// "2026-07-12 (20 days ago)". The reader of this block is asking one question:
// is this install dead, or just quiet? The age answers it; the milliseconds never
// did. The reference clock is the rollup's OWN generated_at (server-stamped,
// already on the wire), not Date.now(), so the line is deterministic, testable,
// and identical whether it is read now or out of a log next week. A last_active
// ahead of generated_at (clock skew, or a replayed rollup) degrades to the bare
// date: a negative age reads as a bug in mla rather than a fact about the data.
function lastActiveLabel(iso: string, generatedAt: string): string {
  const day = iso.slice(0, 10);
  const then = Date.parse(iso);
  const now = Date.parse(generatedAt);
  if (!Number.isFinite(then) || !Number.isFinite(now)) return day;
  const days = Math.floor((now - then) / 86_400_000);
  if (days < 0) return day;
  if (days === 0) return `${day} (today)`;
  if (days === 1) return `${day} (1 day ago)`;
  return `${day} (${days} days ago)`;
}

// The THIRD state render: the CLI is syncing and NOT ONE governed instrument has
// ever fired. Rendering the normal dashboard here is a lie in the other direction:
// every rate divides by zero, so a wall of 0% reads as "mla ran and achieved
// nothing" when the truth is "mla ran and was never given anything to govern". We
// name that, show the work that did happen, and give the one action that changes it.
export function renderGlobalNothingGoverned(r: GlobalRollup): string {
  const a = r.activity;
  const wsLabel = r.workspaces === 1 ? "1 workspace" : `${r.workspaces} workspaces`;
  const lines: string[] = [];
  lines.push(`mla usefulness, last ${r.window_days}d (global: ${wsLabel} you can view):`);
  lines.push("");
  lines.push("Nothing governed yet.");
  lines.push(
    `   mla is syncing, but nothing governed has been recorded in the last ${r.window_days}d:`,
  );
  lines.push(
    "   no evidence offered, no contradiction surfaced, no rule enforced, no review decision.",
  );
  lines.push("   Every rate would divide by zero, so here is what actually happened instead.");
  lines.push("");

  if (a) {
    lines.push(`   ${a.commands} command(s) across ${a.sessions} session(s).`);
    if (a.rule_injections > 0) {
      lines.push(
        `   ${a.rule_injections} rule injection(s), ${a.head_tokens.toLocaleString("en-US")} tokens of context.`,
      );
    }
    // A healthy hook is not worth a line; a failing one is a reason the governed
    // instruments never fire, so it earns one.
    if (a.hook_failures > 0) {
      lines.push(
        `   ${a.hook_failures} of ${a.hook_invocations} hook invocation(s) failed; mla could not observe those turns.`,
      );
    }
    if (a.last_active_at) {
      lines.push(`   Last active: ${lastActiveLabel(a.last_active_at, r.generated_at)}.`);
    }
    lines.push("");
  }

  // Zero rules is the production cause (75 of 85 workspaces had none). A workspace
  // WITH rules is genuinely just quiet, and claiming otherwise would be the same
  // over-claim in reverse.
  if ((a?.rules_configured ?? 0) > 0) {
    lines.push(`   ${a?.rules_configured} rule(s) in force and nothing has tripped them.`);
    lines.push("   That is a quiet window, not a broken install.");
  } else {
    lines.push("   No rules are configured, so there is nothing for mla to catch.");
    lines.push("   Run `mla onboard` in your repo to turn your conventions into governed rules.");
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

// The hook's enrichment deadline, shown beside the latency distribution so a reader can see the
// tail against the wall instead of having to know where the wall is.
//
// IMPORTED, not restated. This was "the reader's copy" of the hook's value for exactly as long
// as it took to drift: the prior wall lives in ask-outcomes as PRIOR_ENRICH_BUDGET_MS, and the
// only reason a reader's copy existed at all was that the hook is bash. It now reads the one
// canonical export, which test/lib/enrich-budget-canonical.spec.ts binds to the shell literal.
const ENRICH_BUDGET_MS = LAYER2_ENRICH_BUDGET_MS;

// `mla stats ask [--window Nd]`: the enrichment-outcome report over ask-traces.jsonl.
function runAskOutcomes(args: StatsArgs): number {
  const rows = readLogJsonl("ask-traces.jsonl")
    .map(toAskTraceRow)
    .filter((r): r is NonNullable<typeof r> => r !== null);

  // The section parser returns as soon as it sees the bare section token, so this section's own
  // flags arrive unparsed in `rest`. Read them here rather than restructuring a parser three other
  // sections depend on.
  let days = args.windowDays;
  let json = args.json;
  for (let i = 0; i < args.rest.length; i++) {
    const a = args.rest[i];
    if (a === "--json") json = true;
    else if (a === "--window") {
      const v = args.rest[++i] ?? "";
      const m = /^(\d+)d$/.exec(v);
      if (!m) {
        console.error(`\`mla stats ask --window\` expects Nd (e.g. 7d), got ${JSON.stringify(v)}`);
        return 2;
      }
      days = Number(m[1]);
    } else {
      console.error(`Unknown flag for \`mla stats ask\`: ${a}`);
      return 2;
    }
  }
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  const inWindow = rows.filter((r) => r.ts >= cutoff);

  if (inWindow.length === 0) {
    console.log(`mla stats ask: no enrichment attempts in the last ${days}d.`);
    return 0;
  }
  const report = summarizeAskOutcomes(inWindow, { budgetMs: ENRICH_BUDGET_MS });
  // The same rows, per day. The window headline cannot show a step (30 days of 2-6% averaged
  // with 5 days of 20% still reads 6.7%), and that is how the 2026-08-05 regression stayed
  // unfiled for five days with every row already on disk. No new store, schedule or flag: it
  // rides this report.
  const daily = summarizeDailyTimeoutSeries(inWindow);
  if (json) {
    console.log(JSON.stringify({ ...report, dailyTimeoutSeries: daily }, null, 2));
    return 0;
  }
  for (const line of renderAskOutcomes(report, `last ${days}d`)) console.log(line);
  for (const line of renderDailyTimeoutSeries(daily)) console.log(line);
  return 0;
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

  // `mla stats ask` reads the enrichment outcomes we already trace. It exists because a
  // 2026-08-05 audit summed timeouts and dependency-down errors into one "11.3% hard-failure
  // rate" and argued a latency claim off p90, and neither error needed new telemetry to catch:
  // enrich_latency_ms and fail_open_reason were on every row. Nobody was reading them.
  if (args.section === "ask") {
    return runAskOutcomes(args);
  }

  // `--global` reads the control rollup read-model (spec section 10.4), not PostHog.
  if (args.global) {
    return runGlobalStats(args, deps);
  }

  const read = deps.read ?? readEvents;
  const nowMs = deps.nowMs ?? Date.now();
  const events = read();
  // The pull join reads the two LOCAL trace files the hooks already write. Windowed
  // by the same cutoff the event population uses, so the two halves of the dashboard
  // describe the same span.
  const startMs = nowMs - args.windowDays * 24 * 60 * 60 * 1000;
  const inSpan = (r: Record<string, unknown>): boolean => {
    const t = typeof r.ts === "string" ? Date.parse(r.ts) : NaN;
    return !Number.isFinite(t) || (t >= startMs && t <= nowMs);
  };
  const pull = computePullSummary(
    parseMcpCalls(readLogJsonl("mcp-calls.jsonl").filter(inSpan)),
    parseReportCitations(readLogJsonl("report-citations.jsonl").filter(inSpan)),
  );
  const dashboard = buildDashboard(events, args.windowDays, nowMs, pull);

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
    // (exit 1) so it is never silently read as a zero. A workspace-membership
    // 403 means control WAS reached and refused us: give the shared canonical
    // line, never "could not reach control" (a lie) and never the token-refresh
    // "login expired" text (BUG-5 #2: a live-token 403 was mislabeled as expiry
    // and, worse, exited 0).
    if (isWorkspaceAccessDenied(e)) {
      console.error(workspaceAccessDeniedMessage(e));
      return 1;
    }
    console.error(`mla stats --global could not reach control: ${(e as Error).message}`);
    return 1;
  }

  // Nothing synced yet for any visible workspace -> unknown, not zero.
  if (!rollup.has_any_events) {
    emitGlobalUnavailable("no_synced_data", args.json);
    return 0;
  }

  // --json passes the rollup through untouched: it already carries
  // has_governed_events + activity, so a machine reader sees the third state
  // explicitly rather than inferring activity=0 from the counters.
  if (args.json) {
    console.log(JSON.stringify(rollup, null, 2));
  } else if (rollup.has_governed_events === false) {
    console.log(renderGlobalNothingGoverned(rollup));
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
