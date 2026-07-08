// Coverage-gap classification (spec §7.5, INV-COVERAGE-GAP-1).
//
// A zero-result or low-confidence retrieval is the most actionable forward
// signal mla produces, but ONLY if it distinguishes cause. "Capture more docs"
// is the wrong fix when the real problem is ranking, staleness, or a permission
// filter. This module is the single, pure classifier that maps the inject-time
// retrieval signals to one closed `coverage_gap_type`, so the inject command and
// its test run the identical code with no I/O.
//
// The classification is INJECT-TIME: it answers "why did this retrieval fail to
// help" from what we knew when we surfaced (or failed to surface) evidence. The
// seventh type, `candidates_found_not_used`, is OUTCOME-time (the agent had
// usable candidates but referenced none) and is owned by the correlator, never
// emitted here.

import {
  CoverageGapPayload,
  CoverageGapType,
  QUERY_TOPIC_CATEGORIES,
  QueryTopicCategory,
  RETRIEVAL_CONFIDENCES,
  RetrievalConfidence,
} from "./envelope";
import { deterministicEventId } from "./event-id";

// The raw inject-time signals the classifier reads. All but zero_results and
// retrieval_confidence are optional booleans that default false: the hook sets
// only the ones it can cheaply detect, and the classifier degrades to the
// knowledge-gap reading (no_candidate_found / low_confidence_candidates) when
// the richer signals are absent.
export interface CoverageGapSignals {
  // A retrieval call threw or returned an error (a bug, route to Sentry).
  retrievalError?: boolean;
  // The candidates the retrieval found were dropped by an ACL filter (an access
  // problem, not a knowledge problem).
  permissionFiltered?: boolean;
  // Nothing came back at all: capture the missing knowledge.
  zeroResults: boolean;
  // Candidates came back but are stale or conflict with each other: reconcile
  // the KB (a curation job).
  staleOrConflicting?: boolean;
  // How confident the retrieval was. "low" with candidates present means fix
  // retrieval and ranking.
  retrievalConfidence: RetrievalConfidence;
}

// classifyCoverageGap returns the single canonical gap type, or null when there
// is no coverage gap to report (a healthy, confident retrieval). Precedence is
// most-specific cause first, so a single inject is attributed to exactly one
// type even when several signals are set (INV-COVERAGE-GAP-1):
//
//   retrieval_error             a bug shadows every other reading
//   permission_filtered         an ACL drop is an access problem, not knowledge
//   no_candidate_found          nothing came back at all
//   stale_or_conflicting        candidates exist but the KB needs reconciling
//   low_confidence_candidates   candidates exist but ranking is weak
//   (null)                      confident, non-empty retrieval: no gap
//
// candidates_found_not_used is deliberately NOT reachable here: it is the
// outcome-time type the correlator emits when usable candidates were ignored.
export function classifyCoverageGap(
  signals: CoverageGapSignals,
): CoverageGapType | null {
  if (signals.retrievalError) return "retrieval_error";
  if (signals.permissionFiltered) return "permission_filtered";
  if (signals.zeroResults) return "no_candidate_found";
  if (signals.staleOrConflicting) return "stale_or_conflicting_candidates";
  if (signals.retrievalConfidence === "low") return "low_confidence_candidates";
  return null;
}

// Coerce a free-form topic string to the closed query_topic_category enum,
// defaulting to "unknown" so an unrecognized topic never leaks a raw string
// past the PII boundary (INV-POSTHOG-PII-1).
export function coerceTopicCategory(raw: string | null | undefined): QueryTopicCategory {
  if (raw && (QUERY_TOPIC_CATEGORIES as readonly string[]).includes(raw)) {
    return raw as QueryTopicCategory;
  }
  return "unknown";
}

// Coerce a free-form confidence string to the closed enum, defaulting to "low"
// (the same conservative default buildInjectPayload uses) so an unknown
// confidence never inflates the dashboard.
export function coerceRetrievalConfidence(
  raw: string | null | undefined,
): RetrievalConfidence {
  if (raw && (RETRIEVAL_CONFIDENCES as readonly string[]).includes(raw)) {
    return raw as RetrievalConfidence;
  }
  return "low";
}

// Deterministic event_id for an inject-time coverage gap. One inject produces at
// most one inject-time gap, so the inject_id IS the natural business key; the
// `coverage_gap:` prefix keeps it from colliding with the inject event's own id
// (which is the bare inject_id) under control's (workspace_id, event_id) dedupe.
export function coverageGapEventId(injectId: string): string {
  return deterministicEventId(`coverage_gap:${injectId}`, 1);
}

// Deterministic event_id for the OUTCOME-time `candidates_found_not_used` gap the
// correlator emits when a confident, non-empty inject closed as ignored. A
// distinct business-key prefix from the inject-time gap so a single inject can
// carry both an inject-time gap and (in principle) an outcome-time gap without an
// event_id collision; in practice they are mutually exclusive (the correlator
// only emits this when no inject-time gap exists).
export function coverageGapNotUsedEventId(injectId: string): string {
  return deterministicEventId(`coverage_gap_not_used:${injectId}`, 1);
}

export interface CoverageGapPayloadInput {
  injectId: string;
  coverageGapType: CoverageGapType;
  queryTopicCategory: QueryTopicCategory;
  retrievalConfidence: RetrievalConfidence;
  zeroResults: boolean;
}

// Build the typed, PII-bounded coverage-gap payload. ids/counts/enums/booleans
// only (no raw query text or paths): the raw topic stays in Langfuse.
export function buildCoverageGapPayload(
  input: CoverageGapPayloadInput,
): CoverageGapPayload {
  return {
    inject_id: input.injectId,
    coverage_gap_type: input.coverageGapType,
    query_topic_category: input.queryTopicCategory,
    retrieval_confidence: input.retrievalConfidence,
    zero_results: input.zeroResults,
  };
}
