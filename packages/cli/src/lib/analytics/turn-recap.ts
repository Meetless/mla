// Per-turn assist recap (Layer A of notes/20260609-mla-per-turn-assist-recap-plan.md).
//
// The session-level `mla stats` / `mla adoption` reader answers "across this
// session, how often was injected evidence used?" This module is the per-TURN
// analog: for one (session_id, turn_index) it answers the two operator questions
// An asked for at the end of every turn:
//
//   liveness   -- did mla run this turn, or silently not fire? (ran / not_run_reason)
//   usefulness -- if it offered evidence, was the evidence pulled or cited, or
//                 ignored? (verdict USED / IGNORED / NO_OFFER / NOT_RUN)
//
// It reuses the SAME three local spool files and the SAME overlap math as the
// followthrough reader (INV-ADOPTION-SOURCE-1) so a per-turn USED is exactly the
// per-turn instance of the session-level A1c. The only new parse is a single-turn
// ask-traces reader; mcp-calls and report-citations go through followthrough's
// parsers unchanged. Window is 0 (same turn): this is computed at Stop, when all
// of the turn's pulls (written during the turn) and citations (written by stop.sh
// moments earlier) are already on disk, so the cross-turn window the session
// reader needs does not apply here.

import { readLogJsonl } from "./logs";
import { overlap, parseMcpCalls, parseReportCitations } from "./followthrough";

export type Verdict = "USED" | "IGNORED" | "NO_OFFER" | "NOT_RUN";

export type NotRunReason = "muted" | "not_activated" | "suppressed" | "timeout" | "error";

export interface TurnRecap {
  session_id: string;
  turn_index: number;
  // The turn's $TRACE_ID from its ask-traces line == its Langfuse trace id (Layer D).
  trace_id: string | null;

  // Liveness (answers "did mla run this turn?")
  ran: boolean; // an ask-traces line exists for this turn
  injected_floor: boolean; // hook.injected (Layer 1 static floor landed)
  injected_evidence: boolean; // hook.layer2_injected (Layer 2 enrichment landed)
  not_run_reason: NotRunReason | null;
  enrich_latency_ms: number | null;

  // Offer (what mla put in front of the agent)
  evidence_offered: boolean;
  offered_source_ids: string[];
  zero_results: boolean;
  coverage_gap_type: string | null; // why nothing was offered, if applicable

  // Followthrough (answers "how useful was it?")
  evidence_tools_pulled: string[]; // distinct meetless evidence tools called this turn
  pull_count: number;
  referenced_source_ids: string[]; // offered ids that were pulled or cited this turn
  cited_source_ids: string[]; // ids the final answer cited

  verdict: Verdict;
}

export interface TurnRecapDeps {
  // Read one jsonl spool file under the live logs dir. Defaults to readLogJsonl so
  // the live CLI reads the same files the hook wrote; tests inject a fake.
  readLog?: (file: string) => Record<string, unknown>[];
}

// --- single-turn ask-traces parse -------------------------------------------

export interface AskTrace {
  session_id: string;
  turn_index: number;
  trace_id: string | null;
  injected_floor: boolean;
  injected_evidence: boolean;
  enrich_latency_ms: number | null;
  offered_source_ids: string[];
  arb_reason: string;
  fail_open_reason: string | null;
  not_run_reason: NotRunReason | null;
  has_error: boolean;
}

function asObj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

function asStr(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function asNum(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

const NOT_RUN_REASONS: NotRunReason[] = ["muted", "not_activated", "suppressed", "timeout", "error"];

function asNotRunReason(v: unknown): NotRunReason | null {
  return typeof v === "string" && (NOT_RUN_REASONS as string[]).includes(v) ? (v as NotRunReason) : null;
}

// parseAskTrace reads ONE ask-traces.jsonl line into the fields the recap needs.
// Returns null when the line cannot join (no session_id or non-numeric turn).
// The offered set mirrors parseInjectTurns: enrichment.context_items[] with
// injected===true and a non-empty source_id (the ids mla actually PUSHED).
export function parseAskTrace(line: Record<string, unknown>): AskTrace | null {
  const session_id = asStr(line.session_id);
  const turn_index = asNum(line.turn_index);
  if (!session_id || turn_index === null) return null;

  const hook = asObj(line.hook);
  const arbitration = asObj(line.arbitration);
  const enrichment = asObj(line.enrichment);

  const items = Array.isArray(enrichment.context_items) ? enrichment.context_items : [];
  const offered: string[] = [];
  for (const raw of items) {
    const item = asObj(raw);
    if (item.injected !== true) continue;
    const sid = asStr(item.source_id);
    if (sid) offered.push(sid);
  }

  const failOpen = asStr(hook.fail_open_reason);
  // The early-exit minimal line (Phase 1 §5 enabling change) names its reason
  // explicitly; accept it from hook or top-level so the writer has either home.
  const explicitReason = asNotRunReason(hook.not_run_reason) ?? asNotRunReason(line.not_run_reason);

  return {
    session_id,
    turn_index,
    trace_id: typeof line.trace_id === "string" && line.trace_id ? line.trace_id : null,
    injected_floor: hook.injected === true,
    injected_evidence: hook.layer2_injected === true,
    enrich_latency_ms: asNum(hook.enrich_latency_ms),
    offered_source_ids: Array.from(new Set(offered)),
    arb_reason: asStr(arbitration.reason),
    fail_open_reason: failOpen || null,
    not_run_reason: explicitReason,
    has_error: line.error != null,
  };
}

// Why mla did not RUN (or suppressed injection) this turn. Only meaningful when
// the floor was not injected (a control, suppression, or early-exit). An explicit
// minimal-line reason wins; otherwise the injected=false control maps to
// "suppressed". An injected floor means it ran, so this is null there.
function deriveNotRunReason(t: AskTrace | null): NotRunReason | null {
  if (!t) return null; // no line at all: reason unknown
  if (t.not_run_reason) return t.not_run_reason;
  const arb = t.arb_reason.toLowerCase();
  if (arb.includes("pull_only") || arb.includes("suppress")) return "suppressed";
  if (t.fail_open_reason === "timeout") return "timeout";
  if (t.fail_open_reason === "error" || t.has_error) return "error";
  return null;
}

// Why nothing was OFFERED this turn though mla ran (floor injected, no evidence).
// Feeds the NO_OFFER footer and the session-level "coverage gaps" vocabulary.
function deriveCoverageGap(t: AskTrace): string | null {
  const arb = t.arb_reason.toLowerCase();
  const fail = (t.fail_open_reason ?? "").toLowerCase();
  if (arb.includes("no_relevant_context")) return "no_relevant_context";
  // Auth rejection (expired/revoked CLI token) is checked before the generic
  // error so a dead session reads as "re-auth", not "enrichment failed".
  if (fail === "unauthorized" || arb.includes("unauthorized")) return "enrich_unauthorized";
  if (fail === "timeout" || arb.includes("timeout")) return "enrich_timeout";
  if (fail === "error" || arb.includes("error")) return "enrich_error";
  if (arb.includes("missing_token")) return "missing_token";
  return null;
}

// --- the join ----------------------------------------------------------------

export function computeTurnRecap(sessionId: string, turnIndex: number, deps: TurnRecapDeps = {}): TurnRecap {
  const readLog = deps.readLog ?? readLogJsonl;

  const askLines = readLog("ask-traces.jsonl");
  const mcpLines = parseMcpCalls(readLog("mcp-calls.jsonl"));
  const citeLines = parseReportCitations(readLog("report-citations.jsonl"));

  // The single ask-traces line for this turn. One line per turn is the invariant
  // (write_trace is the sole emitter); take the last match so a re-emit wins.
  let trace: AskTrace | null = null;
  for (const raw of askLines) {
    const t = parseAskTrace(raw);
    if (t && t.session_id === sessionId && t.turn_index === turnIndex) trace = t;
  }

  const ran = trace !== null;
  const injected_floor = trace?.injected_floor ?? false;
  const injected_evidence = trace?.injected_evidence ?? false;
  const offered_source_ids = trace?.offered_source_ids ?? [];
  const evidence_offered = offered_source_ids.length > 0;

  // Same-turn, same-session pulls and citations (window=0).
  const pulledIds: string[] = [];
  const toolSet = new Set<string>();
  let pull_count = 0;
  for (const c of mcpLines) {
    if (c.session_id !== sessionId || c.turn_index !== turnIndex || !c.evidence_tool) continue;
    pull_count += 1;
    pulledIds.push(...c.source_ids);
    if (c.tool) toolSet.add(c.tool);
  }

  const cited_source_ids: string[] = [];
  for (const r of citeLines) {
    if (r.session_id !== sessionId || r.turn_index !== turnIndex) continue;
    cited_source_ids.push(...r.source_ids);
  }

  // Referenced = offered ids the agent pulled (via an evidence tool) or cited.
  const referenced_source_ids = overlap(offered_source_ids, [...pulledIds, ...cited_source_ids]);

  const notRun = !ran || !injected_floor;
  const not_run_reason = notRun ? deriveNotRunReason(trace) : null;
  const coverage_gap_type = !notRun && !evidence_offered ? deriveCoverageGap(trace as AskTrace) : null;

  let verdict: Verdict;
  if (notRun) verdict = "NOT_RUN";
  else if (!evidence_offered) verdict = "NO_OFFER";
  else if (referenced_source_ids.length === 0) verdict = "IGNORED";
  else verdict = "USED";

  return {
    session_id: sessionId,
    turn_index: turnIndex,
    trace_id: trace?.trace_id ?? null,
    ran,
    injected_floor,
    injected_evidence,
    not_run_reason,
    enrich_latency_ms: trace?.enrich_latency_ms ?? null,
    evidence_offered,
    offered_source_ids,
    zero_results: !evidence_offered,
    coverage_gap_type,
    evidence_tools_pulled: Array.from(toolSet),
    pull_count,
    referenced_source_ids,
    cited_source_ids,
    verdict,
  };
}

// --- render ------------------------------------------------------------------

function gapPhrase(t: string | null): string {
  switch (t) {
    case "no_relevant_context":
      return "no candidate matched your prompt";
    case "enrich_timeout":
      return "enrichment timed out";
    case "enrich_unauthorized":
      return "Meetless session expired, run `mla login`";
    case "enrich_error":
      return "enrichment failed";
    case "missing_token":
      return "no auth token";
    default:
      return "nothing relevant offered";
  }
}

function notRunPhrase(r: NotRunReason | null): string {
  switch (r) {
    case "muted":
      return "muted this session";
    case "not_activated":
      return "not activated for this repo";
    case "suppressed":
      return "injection suppressed";
    case "timeout":
      return "hook timed out";
    case "error":
      return "hook error";
    default:
      return "did not run (reason unknown)";
  }
}

function pulledPhrase(r: TurnRecap): string {
  if (r.pull_count === 0) return "0";
  const names = r.evidence_tools_pulled.length ? r.evidence_tools_pulled.join("+") : "evidence";
  return `${names} ×${r.pull_count}`;
}

function citedPhrase(r: TurnRecap): string {
  return r.cited_source_ids.length ? r.cited_source_ids.join(", ") : "0";
}

// The single-line, scannable footer (Section 7). Also used as the Langfuse score
// comment (Layer D) and the `mla turn` headline, so all three surfaces agree.
export function renderFooter(r: TurnRecap): string {
  const head = `🔎 mla · turn ${r.turn_index}`;
  if (r.verdict === "NOT_RUN") return `${head} · ${notRunPhrase(r.not_run_reason)} · NOT_RUN`;
  if (r.verdict === "NO_OFFER") return `${head} · floor only · ${gapPhrase(r.coverage_gap_type)} · NO_OFFER`;
  const latency = r.enrich_latency_ms != null ? `${r.enrich_latency_ms}ms` : "?ms";
  const offer = `evidence injected (${r.offered_source_ids.length} src, ${latency})`;
  return `${head} · ${offer} · pulled ${pulledPhrase(r)} · cited ${citedPhrase(r)} · ${r.verdict}`;
}

// The C-lite injection payload: the footer wrapped in a context block with one
// soft, optional nudge. Best-effort surfacing; never a command (D3).
export function renderBlockContext(r: TurnRecap): string {
  return [
    `<meetless-context kind="turn-recap" for-turn="${r.turn_index}">`,
    renderFooter(r),
    "You may surface this assist recap to the operator as a one-line footer if useful.",
    "</meetless-context>",
  ].join("\n");
}

// The full multi-line expansion for `mla turn` human output.
export function renderBlock(r: TurnRecap): string {
  const ranDesc = !r.ran
    ? "no (no trace for this turn)"
    : !r.injected_floor
      ? `suppressed (${r.not_run_reason ?? "control"})`
      : r.injected_evidence
        ? "floor + evidence"
        : "floor only";
  const offeredDesc = r.evidence_offered
    ? `${r.offered_source_ids.length} source(s): ${r.offered_source_ids.join(", ")}`
    : `none${r.coverage_gap_type ? ` (${r.coverage_gap_type})` : ""}`;
  const lines = [
    `🔎 mla turn ${r.turn_index} recap`,
    `  ran:        ${ranDesc}`,
    `  offered:    ${offeredDesc}`,
    `  latency:    ${r.enrich_latency_ms != null ? `${r.enrich_latency_ms}ms` : "n/a"}`,
    `  pulled:     ${pulledPhrase(r)}`,
    `  cited:      ${citedPhrase(r)}`,
    `  referenced: ${r.referenced_source_ids.length ? r.referenced_source_ids.join(", ") : "none"}`,
    `  verdict:    ${r.verdict}`,
  ];
  if (r.trace_id) lines.push(`  trace:      ${r.trace_id}`);
  return lines.join("\n");
}
