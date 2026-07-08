// The evidence-grounding lifecycle: build an inject payload at surface time, and
// derive its outcome once the correlation window closes. Both are pure functions
// over data the caller supplies, so the Stop-hook correlator and its test run the
// identical code with no I/O or clock baked in.
//
// The window is "next 3 turns OR 15 minutes, whichever first" (spec §0, §7.4).
// The inject is written immediately and counted as outcome=pending; the local
// correlator (v1: the Stop hook, INV-CORRELATOR-1) calls deriveOutcome to close
// eligible windows and append mla_evidence_outcome. Server-side correlation may
// validate or enrich, never be the only writer.

import {
  EvidenceInjectPayload,
  EvidenceOutcomePayload,
  InjectOutcome,
  RETRIEVAL_CONFIDENCES,
  RetrievalConfidence,
  WindowClosedReason,
} from "./envelope";
import { mintEventId, outcomeEventId } from "./event-id";
import {
  InjectTurn,
  McpCall,
  ReportCitation,
  computeFollowthrough,
  normId,
} from "./followthrough";

// The turn window covers the inject turn and its next 3 turns; the wall-clock
// window is 15 minutes. Whichever fills first closes the inject (§0).
export const WINDOW_TURNS = 3;
export const WINDOW_MS = 15 * 60 * 1000;

// The current outcome schema generation. Bumped only when the outcome derivation
// changes meaning, so a recomputed outcome gets a NEW deterministic event_id
// rather than silently overwriting the prior landing (event-id.ts).
// v2: a deadline-closed inject in a provably-ENDED session is finalized as
// fully-observed (ignored / no_opportunity, reason=session_ended) instead of the
// blind `unknown`; the idle-but-alive case still closes `unknown` (reason=time_limit).
// v3: the correlator stops EMITTING the blind `unknown` as a durable outcome. A
// deadline-closed-but-not-yet-ended window collapses to pending (re-derived every
// sweep, never written) and is emitted only once the reaper proves the session
// ENDED, as a terminal ignored / no_opportunity. The bump gives that finalizing
// terminal a fresh event_id so it SUPERSEDES any legacy v1/v2 `unknown` landing for
// the same inject in both read-model reducers (highest outcome_version wins), which
// is what actually drains the historical `unknown` backlog (the re-open guard).
export const OUTCOME_VERSION = 3;

// A session is treated as ENDED once it has been totally silent for at least
// ABANDONED_AFTER_MS. Claude Code emits no true session-death event
// (NT:20260626-g8-cross-session-conflict-redesign.md §1.3), so the correlator
// approximates death from the last observed activity, mirroring the read-time
// `deriveLiveness` 24h threshold. An ENDED session is what lets deriveOutcome split
// the blind `unknown` (which otherwise dominates, because most sessions never
// produce WINDOW_TURNS more turns after an inject) into the honest ignored /
// no_opportunity it actually was.
export const ABANDONED_AFTER_MS = 24 * 60 * 60 * 1000; // 24h, parity with deriveLiveness

// The TERMINAL outcomes: a window that reaches one of these has a verdict for good.
// The correlator's idempotency skip-set holds ONLY these, so once an inject is
// terminal it is never re-derived. `unknown` is deliberately NON-terminal: a
// deadline-closed window whose session may still be alive is provisional and must
// stay re-derivable so the idle reaper can finalize it later (the re-open guard /
// `unknown` backlog drain). `pending` (the absence of any outcome) is likewise
// non-terminal. deriveOutcome still computes `unknown`; the correlator just declines
// to emit it durably under v3.
export const TERMINAL_OUTCOMES: ReadonlySet<InjectOutcome> = new Set<InjectOutcome>([
  "used",
  "ignored",
  "no_opportunity",
]);

// True iff `outcome` is a terminal verdict. Accepts a raw string so callers reading
// stored event payloads do not have to pre-narrow to the enum.
export function isTerminalOutcome(outcome: string): boolean {
  return (TERMINAL_OUTCOMES as ReadonlySet<string>).has(outcome);
}

// --- inject payload ---------------------------------------------------------

export interface InjectInput {
  // The per-session turn the inject landed on (1-based). null only when the hook
  // could not place the inject in the turn stream; such an inject records but
  // cannot be correlated (it stays pending forever and is filtered from precision).
  turn_index: number | null;
  evidence_offered: number;
  offered_source_ids: string[];
  evidence_tokens: number;
  // Free-form from the caller; coerced to the closed enum, defaulting to "low"
  // so an unknown confidence never inflates the dashboard.
  retrieval_confidence: string;
  retrieval_latency_ms: number;
  createdAtMs: number;
  // Test/replay seam: reuse a known inject_id instead of minting a fresh one.
  injectId?: string;
}

// buildInjectPayload normalizes the hook's raw retrieval result into the typed,
// PII-bounded inject payload. It mints the inject_id ONCE (CLI-origin identity,
// §10.2) and stamps the window deadline from the supplied clock so the function
// stays hermetic.
export function buildInjectPayload(input: InjectInput): EvidenceInjectPayload {
  const confidence: RetrievalConfidence = (RETRIEVAL_CONFIDENCES as readonly string[]).includes(
    input.retrieval_confidence,
  )
    ? (input.retrieval_confidence as RetrievalConfidence)
    : "low";
  const offered = input.offered_source_ids.filter(
    (s): s is string => typeof s === "string" && s.length > 0,
  );
  const offeredCount = Number.isFinite(input.evidence_offered)
    ? input.evidence_offered
    : offered.length;
  return {
    inject_id: input.injectId ?? mintEventId(),
    turn_index: input.turn_index,
    evidence_offered: offeredCount,
    offered_source_ids: offered,
    evidence_tokens: Number.isFinite(input.evidence_tokens) ? input.evidence_tokens : 0,
    retrieval_confidence: confidence,
    retrieval_latency_ms: Number.isFinite(input.retrieval_latency_ms)
      ? input.retrieval_latency_ms
      : 0,
    zero_results: offeredCount === 0,
    window_deadline: new Date(input.createdAtMs + WINDOW_MS).toISOString(),
  };
}

// --- outcome derivation (the correlator) ------------------------------------

// The minimal inject view the correlator needs: enough to join (session, turn,
// offered ids) and to know when its window closes (deadline). This is exactly
// what an mla_evidence_inject jsonl line carries (envelope.session_id +
// payload), so the correlator can reconstruct it without a separate store.
export interface InjectRecord {
  inject_id: string;
  session_id: string;
  turn_index: number | null;
  offered_source_ids: string[];
  window_deadline: string;
}

export interface DeriveOutcomeContext {
  nowMs: number;
  // Highest turn_index observed per session, so the correlator can tell whether
  // the full turn window has elapsed (turn_limit close).
  maxTurnBySession: Map<string, number>;
  // Sessions proven ENDED (idle past ABANDONED_AFTER_MS) at sweep time. A
  // deadline-closed inject in one of these is finalized as fully-observed
  // (ignored / no_opportunity) instead of left as the blind `unknown`. Optional and
  // treated as empty when absent, so with no reaper info deriveOutcome is
  // byte-identical to the pre-reaper behaviour (every deadline close -> unknown):
  // a strict, fail-safe no-op.
  endedSessions?: Set<string>;
  // Defaults to WINDOW_TURNS; exposed so the parity test can pin it.
  window?: number;
}

// deriveEndedSessions turns a per-session last-activity map into the set of sessions
// that have been silent for at least `abandonedAfterMs` (default ABANDONED_AFTER_MS).
// Pure over the supplied clock + map, so the reaper decision is unit-testable with no
// I/O. A session with an unparseable/absent last-activity is never marked ended (it
// is simply absent from the map), so the reaper can only ever finalize a session it
// can positively prove is old: a fail-safe that mirrors the read-time deriveLiveness.
export function deriveEndedSessions(
  lastActivityMsBySession: Map<string, number>,
  nowMs: number,
  abandonedAfterMs: number = ABANDONED_AFTER_MS,
): Set<string> {
  const ended = new Set<string>();
  for (const [sessionId, lastMs] of lastActivityMsBySession) {
    if (Number.isFinite(lastMs) && nowMs - lastMs >= abandonedAfterMs) {
      ended.add(sessionId);
    }
  }
  return ended;
}

export interface DerivedOutcome {
  event_id: string;
  payload: EvidenceOutcomePayload;
}

// deriveOutcome closes one inject's window if it is eligible, else returns null
// (the inject stays pending). Close precedence (§0, "whichever first"):
//
//   turn_limit    the full turn window has been observed (maxTurn >= turn+window).
//                 The agent had its whole opportunity; not-referenced => ignored.
//   session_ended the deadline passed before the turn window filled AND the session
//                 is provably ENDED (ctx.endedSessions). The agent will never take
//                 another turn, so the opportunity IS fully observed after all: a
//                 not-referenced inject is ignored if >=1 later turn happened, else
//                 no_opportunity (the inject landed on the very last turn, so the
//                 agent literally never got a turn to act on it). Neither is the
//                 blind `unknown`; both are honest, terminal verdicts.
//   time_limit    the 15-minute deadline passed before the turn window filled and
//                 the session is NOT known-ended (idle but possibly alive). A
//                 not-referenced inject is unknown, not ignored: we did not observe
//                 the full opportunity. This is what keeps Unknown Coverage a
//                 meaningful honesty term for genuinely-ambiguous closes.
//   still_open    none of the above => null, stays pending.
//
// session_ended is what drains the `unknown` pile: most dogfood sessions never add
// WINDOW_TURNS more turns after an inject, so without a death signal nearly every
// inject closed on time_limit -> unknown. With the idle reaper (deriveEndedSessions),
// an inject in a long-dead session is finalized as the ignored / no_opportunity it
// truly was. With ctx.endedSessions empty/absent this branch is never taken, so the
// function degrades to the exact pre-reaper behaviour (zero regression).
//
// v1 used := referenced (§4.2): an inject that was pulled or cited is "used".
// The schema keeps referenced and used as separate fields so a later correlator
// can tighten "used" to material incorporation without a migration.
export function deriveOutcome(
  inject: InjectRecord,
  calls: McpCall[],
  citations: ReportCitation[],
  ctx: DeriveOutcomeContext,
): DerivedOutcome | null {
  // No numeric turn means we cannot align the inject to pulls/citations; it can
  // never be correlated, so leave it pending rather than guess an outcome.
  if (inject.turn_index === null) return null;

  const window = ctx.window ?? WINDOW_TURNS;
  const maxTurn = ctx.maxTurnBySession.get(inject.session_id) ?? inject.turn_index;
  const deadlineMs = Date.parse(inject.window_deadline);

  const deadlinePassed = Number.isFinite(deadlineMs) && ctx.nowMs >= deadlineMs;
  let reason: WindowClosedReason;
  if (maxTurn >= inject.turn_index + window) {
    // Full turn window observed: a real, fully-observed close regardless of liveness.
    reason = "turn_limit";
  } else if (deadlinePassed && ctx.endedSessions?.has(inject.session_id)) {
    // Deadline passed AND the session is dead: the opportunity is over for good.
    reason = "session_ended";
  } else if (deadlinePassed) {
    // Deadline passed but the session may still be alive: genuinely unknown.
    reason = "time_limit";
  } else {
    return null; // still open -> stays pending
  }

  // Reuse the ONE shared join (INV-ADOPTION-SOURCE-1): score this single inject
  // turn against the window's pulls and citations.
  const injectTurn: InjectTurn = {
    session_id: inject.session_id,
    turn_index: inject.turn_index,
    injected_source_ids: inject.offered_source_ids,
  };
  const [row] = computeFollowthrough([injectTurn], calls, citations, window);

  const pulled_within_window = row.a1a_pull;
  const report_cited = row.a1b_push_reference;
  const referenced = row.a1c_any;

  // The offered ids that were referenced (pulled or cited), original form, deduped
  // by the same normId rule the join uses.
  const referencedByNorm = new Map<string, string>();
  for (const id of [...row.pulled_overlap, ...row.cited_overlap]) {
    const n = normId(id);
    if (!referencedByNorm.has(n)) referencedByNorm.set(n, id);
  }
  const referenced_source_ids = Array.from(referencedByNorm.values());

  let outcome: InjectOutcome;
  if (referenced) {
    outcome = "used";
  } else if (reason === "turn_limit") {
    outcome = "ignored";
  } else if (reason === "session_ended") {
    // A dead session with at least one turn after the inject saw the opportunity
    // and passed on it (ignored); a dead session whose inject landed on the final
    // turn never gave the agent a turn to act (no_opportunity).
    outcome = maxTurn - inject.turn_index >= 1 ? "ignored" : "no_opportunity";
  } else {
    outcome = "unknown";
  }

  // offered_reference_rate: distinct offered ids referenced / distinct offered ids
  // (the recall direction). null when nothing was offered.
  const distinctOffered = new Set(inject.offered_source_ids.map(normId));
  const offered_reference_rate = distinctOffered.size
    ? referenced_source_ids.length / distinctOffered.size
    : null;

  // citation_precision (v1 hallucinated-id guard): of the distinct ids the report
  // cited in this window, the fraction that resolve to one of THIS inject's
  // offered ids. null when the report cited nothing in the window (undefined, not
  // zero). v1 caveat: an id pointing to a real-but-not-offered doc counts against
  // precision, so this is a conservative proxy, in step with the §4.2 v1 framing.
  const citedInWindow: string[] = [];
  for (const c of citations) {
    if (c.session_id !== inject.session_id) continue;
    if (c.turn_index < inject.turn_index || c.turn_index > inject.turn_index + window) continue;
    citedInWindow.push(...c.source_ids);
  }
  const distinctCited = new Set(citedInWindow.map(normId));
  const validOffered = new Set(row.cited_overlap.map(normId));
  const citation_precision = distinctCited.size ? validOffered.size / distinctCited.size : null;

  const payload: EvidenceOutcomePayload = {
    inject_id: inject.inject_id,
    outcome_version: OUTCOME_VERSION,
    outcome,
    pulled_within_window,
    report_cited,
    referenced,
    referenced_source_ids,
    citation_precision,
    offered_reference_rate,
    window_closed_reason: reason,
  };

  return {
    event_id: outcomeEventId(inject.inject_id, OUTCOME_VERSION),
    payload,
  };
}
