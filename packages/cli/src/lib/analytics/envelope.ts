// The analytics event envelope + closed enums + the typed event union.
//
// Spec section 6 (the event catalog) and section 10 (the implementation
// contract). Every remotely emitted event carries the envelope (INV-JOIN-1);
// every payload is ids/counts/rates/enums/booleans/durations only, never raw
// text/paths/argv/queries/errors (INV-POSTHOG-PII-1). Events are FLAT: the
// envelope fields and the payload fields sit at the same top level (matching
// the local jsonl examples in section 7.4).

// INV-SCHEMA-1: every payload carries schema_version and is forward-compatible.
export const SCHEMA_VERSION = 1;

// --- closed enums (section 6.3) ---------------------------------------------
// As const tuples so membership can be validated at the privacy boundary; no
// open string ever reaches PostHog.

export const EVENT_TYPES = [
  "mla_command",
  "mla_evidence_inject",
  "mla_evidence_outcome",
  "mla_coverage_gap",
  "mla_contradiction",
  "mla_review_decision",
  "mla_stats_viewed",
  // CE0 evidence-consultation telemetry (§6.4). Named per the ratified proposal
  // contract (no `mla_` prefix): these four are the PostHog projection of the
  // obligation lifecycle and the dashboards in §6.4 query them by these names.
  "memory_requirement_assessed",
  "evidence_consultation_completed",
  "evidence_obligation_finalized",
  "evidence_hook_health",
  // Enforcement (PreToolUse deny) telemetry. The one append per fired deny that
  // the product-health dashboard's deny tile reads
  // (notes/20260627-mla-product-health-dashboard-posthog-metrics.md §5.1). Before
  // this event the deny path produced ZERO analytics: the durable EnforcementAttempt
  // row existed but no metric saw it, so "wrong actions blocked" was un-measurable.
  // Payload is ids/enums only -- the blocked PATH never leaves the device, only its
  // surface enum (INV-POSTHOG-PII-1).
  "mla_enforcement_incident",
  // Enforcement OUTCOME (the "result of our action", STAR's R). The companion that
  // closes an incident window: one append per deny once the correlator can read what
  // the agent did NEXT from the session transcript (redirected to an allowed path,
  // stopped, or retried into another block). Keyed on incident_id, evidence-only (it
  // never sets review_status; the human verdict stays orthogonal). Payload is
  // enums + counts only, never a path or transcript text (INV-POSTHOG-PII-1).
  "mla_enforcement_outcome",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const EVENT_SOURCES = ["cli", "hook", "mcp", "control", "intel"] as const;
export type EventSource = (typeof EVENT_SOURCES)[number];

// The emission-surface label carried in the attribution block (spec section 3.7
// / T1.10). Derived from the typed `source` enum, NOT a free string, so the two
// axes can never drift: `source` is the closed emission channel (cli|hook|mcp),
// `sourceSurface` is its human-facing uppercase form. Kept distinct from the
// product-origin axis (`source:"mla"`), which is a constant on every event.
export const SOURCE_SURFACES = {
  cli: "CLI",
  hook: "HOOK",
  mcp: "MCP",
  control: "CONTROL",
  intel: "INTEL",
} as const satisfies Record<EventSource, string>;
export type EventAttributionSurface = (typeof SOURCE_SURFACES)[EventSource];

export const COMMAND_OUTCOMES = [
  "success",
  "user_error",
  "system_error",
  "auth_error",
  "network_error",
  "permission_denied",
  "validation_error",
  "noop",
  "cancelled",
  "timeout",
] as const;
export type CommandOutcome = (typeof COMMAND_OUTCOMES)[number];

export const TOUCHED_SURFACES = [
  "code",
  "tests",
  "docs",
  "config",
  "migration",
  "infra",
  "unknown",
] as const;
export type TouchedSurface = (typeof TOUCHED_SURFACES)[number];

export const GOVERNED_RELATION_TYPES = [
  "architecture",
  "api_contract",
  "migration",
  "security",
  "product_decision",
  "data_model",
  "unknown",
] as const;
export type GovernedRelationType = (typeof GOVERNED_RELATION_TYPES)[number];

export const QUERY_TOPIC_CATEGORIES = [
  "architecture",
  "testing",
  "deployment",
  "product_decision",
  "customer_context",
  "security",
  "data_model",
  "api_contract",
  "migration",
  "process",
  "unknown",
] as const;
export type QueryTopicCategory = (typeof QUERY_TOPIC_CATEGORIES)[number];

export const COVERAGE_GAP_TYPES = [
  "no_candidate_found",
  "low_confidence_candidates",
  "candidates_found_not_used",
  "stale_or_conflicting_candidates",
  "retrieval_error",
  "permission_filtered",
] as const;
export type CoverageGapType = (typeof COVERAGE_GAP_TYPES)[number];

// How an inject's correlation window closed. `turn_limit` = the full turn window
// was observed; `time_limit` = the 15-min deadline passed while the session was
// still idle-but-alive (genuinely unknown); `session_ended` = the deadline passed
// AND the session is provably ENDED (idle past ABANDONED_AFTER_MS), so the
// opportunity is fully observed even with fewer than WINDOW_TURNS turns;
// `still_open` = neither (the inject stays pending, never emitted).
export const WINDOW_CLOSED_REASONS = [
  "turn_limit",
  "time_limit",
  "session_ended",
  "still_open",
] as const;
export type WindowClosedReason = (typeof WINDOW_CLOSED_REASONS)[number];

// `no_opportunity` = the inject landed on the session's LAST turn (zero subsequent
// turns before the session ended), so the agent never had a chance to act on it.
// Kept distinct from `ignored` (which implies the agent had a turn and skipped it)
// and from `unknown` (which implies we did not observe the full opportunity).
export const INJECT_OUTCOMES = ["used", "ignored", "unknown", "no_opportunity", "pending"] as const;
export type InjectOutcome = (typeof INJECT_OUTCOMES)[number];

export const RETRIEVAL_CONFIDENCES = ["high", "medium", "low"] as const;
export type RetrievalConfidence = (typeof RETRIEVAL_CONFIDENCES)[number];

// Command scope: where the command's effect landed. local = no backend hop;
// workspace = a single-workspace remote op; global = cross-workspace. Used by
// mla_command and mla_stats_viewed.
export const COMMAND_SCOPES = ["local", "workspace", "global", "unknown"] as const;
export type CommandScope = (typeof COMMAND_SCOPES)[number];

// The relationship edge classes mla curates (kb review / contradiction). These
// are the governed-relation lifecycle types, not the PII enums above.
export const RELATION_EDGE_TYPES = [
  "CONTRADICTS",
  "SUPERSEDES",
  "STALE_RELIES_ON",
  "REFINES",
  "unknown",
] as const;
export type RelationEdgeType = (typeof RELATION_EDGE_TYPES)[number];

export const REVIEW_DECISIONS = ["accept", "reject", "reclassify", "no_relation"] as const;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

// --- enforcement-incident enums (§5.1, the deny tile) -----------------------
// The closed wire forms for the PreToolUse enforcement event. Every value is a
// fixed enum so no open string (a tool name, a decision verb, a review verdict)
// reaches the privacy boundary.

// The tools the deny pilot is armed for. The notes-location admission gate is
// exactly {Write, Edit}; "unknown" is a defensive fallback the gate should make
// unreachable, kept so a future deny rule on another tool still classifies safely.
export const ENFORCED_TOOLS = ["Write", "Edit", "unknown"] as const;
export type EnforcedTool = (typeof ENFORCED_TOOLS)[number];

// The enforcement verdict the hook emitted. Only "deny" fires today; "warn" is
// reserved for the soft-gate path so the tile can later split block vs warn.
export const ENFORCEMENT_DECISIONS = ["deny", "warn"] as const;
export type EnforcementDecision = (typeof ENFORCEMENT_DECISIONS)[number];

// The human-review label dimension the deny tile needs (§5.1: "confirmed /
// false-positive / unreviewed"). Born "unreviewed" at emit time; an offline
// labeler supersedes with "confirmed" or "false_positive" (e.g. the known
// notes-location-v1 vault-own-path false positive).
export const ENFORCEMENT_REVIEW_STATUSES = ["unreviewed", "confirmed", "false_positive"] as const;
export type EnforcementReviewStatus = (typeof ENFORCEMENT_REVIEW_STATUSES)[number];

// The terminal "result of our action" classes (STAR's R). Derived by the Stop-hook
// correlator from the session transcript: what the agent did AFTER a deny.
//   - complied_redirected: a later Write/Edit landed on a different, non-blocked path
//     (the success case: the deny steered the agent to the right target).
//   - complied_stopped:    the agent reacted but made no further Write/Edit (it dropped
//     the mutation).
//   - retried_blocked:     the agent's next Write/Edit hit another blocked path (it
//     pushed against the rule and was blocked again).
// Two NON-emitted states stay off the wire on purpose: `pending` (the deny is the last
// thing in the transcript, no reaction observed yet -- re-derive next Stop) and
// `indeterminate` (the deny attempt could not be located in the transcript -- stay blind,
// never fabricate an outcome). Only these three terminal classes are ever emitted.
export const ENFORCEMENT_OUTCOMES = [
  "complied_redirected",
  "complied_stopped",
  "retried_blocked",
] as const;
export type EnforcementOutcome = (typeof ENFORCEMENT_OUTCOMES)[number];

// --- CE0 evidence-consultation telemetry enums (§6.4) -----------------------
// The wire forms of the rules-layer CE0 enums. Re-declared here, in the analytics
// layer, on purpose: the privacy boundary validates membership against THESE closed
// tuples, and the analytics layer must not depend up into lib/rules. The string
// values mirror the rules-layer unions (MemoryRequirement, ConsultationExecution,
// ObligationOutcome); ce0-telemetry.ts is the seam that maps one onto the other.

export const MEMORY_REQUIREMENTS = ["REQUIRED", "NOT_REQUIRED", "UNKNOWN"] as const;
export type MemoryRequirementLabel = (typeof MEMORY_REQUIREMENTS)[number];

export const CONSULTATION_EXECUTIONS = ["COMPLETE", "FAILED", "UNKNOWN"] as const;
export type ConsultationExecutionLabel = (typeof CONSULTATION_EXECUTIONS)[number];

export const CONSULTATION_RESULTS = ["RESULTS_RETURNED", "NO_MATCH"] as const;
export type ConsultationResultLabel = (typeof CONSULTATION_RESULTS)[number];

export const OBLIGATION_OUTCOME_LABELS = [
  "NOT_DUE",
  "COMPLIANT_ON_TIME",
  "CONSULTED_LATE_WITH_EVIDENCE",
  "CONSULTED_LATE_NO_EVIDENCE",
  "MISSED",
  "UNKNOWN",
  "CANCELLED",
] as const;
export type ObligationOutcomeLabel = (typeof OBLIGATION_OUTCOME_LABELS)[number];

export const CE0_HOOKS = [
  "USER_PROMPT_SUBMIT",
  "CONSULTATION_CAPTURE",
  "STOP",
  "OFFLINE_LABEL_IMPORT",
] as const;
export type Ce0Hook = (typeof CE0_HOOKS)[number];

// --- the envelope (section 6.1) ---------------------------------------------

export interface AnalyticsEnvelope {
  schema_version: number;
  event_id: string;
  event_type: EventType;
  // created_at: when the event happened. emitted_at: when it was shipped (may
  // differ on replay). Both ISO 8601.
  created_at: string;
  emitted_at: string;
  // May be null for unbound runs (e.g. `mla init` from a directory with no
  // workspace marker). Such an event is still recorded locally but is NOT
  // remotely emittable (see isRemotelyEmittable); INV-JOIN-1 governs the
  // remote plane only.
  workspace_id: string | null;
  distinct_id: string | null;
  session_id: string | null;
  // INV-RUN-1: exactly one run_id per CLI/hook/MCP invocation. Minted
  // independently (uuid), never derived from trace_id.
  run_id: string;
  // The cross-system observability join key (32-hex). A separate identity from
  // run_id even though they are 1:1 at the CLI in v1.
  trace_id: string;
  source: EventSource;
  // Source attribution (spec section 3.7 / T1.10). A nested, additive block so
  // an analytics consumer can split MLA-originated events by product, surface,
  // actor, and (one-way-hashed) repo WITHOUT any schema migration. Distinct from
  // the envelope `source` enum above, which is the emission CHANNEL; `source:"mla"`
  // here is the product ORIGIN. Every field is an id, a constant, or a one-way
  // hash, never a raw path/argv/text (INV-POSTHOG-PII-1).
  attribution: EventAttribution;
}

// The attribution block (spec section 3.7). Rides inside the envelope so every
// event type carries it uniformly. INV-POSTHOG-PII-1 holds field-by-field:
//   - source/sourceProduct: closed constants identifying the product.
//   - sourceSurface: the uppercase emission surface, derived from `source`.
//   - actorWorkspaceUserId: the workspace-scoped actor cuid (opaque, not end-user
//     PII); null on an unbound/actorless run.
//   - workspaceId: mirror of the envelope workspace_id (null when unbound).
//   - agentSessionId: the ambient agent session (CLAUDE_CODE_SESSION_ID); the same
//     value as session_id. null when there is no session.
//   - repoFingerprint: a NON-identifying one-way hash of the git remote/repo the
//     run executed in (never an absolute path). null outside a git repo.
export interface EventAttribution {
  source: "mla";
  sourceProduct: "MLA";
  sourceSurface: EventAttributionSurface;
  actorWorkspaceUserId: string | null;
  workspaceId: string | null;
  agentSessionId: string | null;
  repoFingerprint: string | null;
}

// --- per-event payloads (section 6.2) ---------------------------------------

export interface CommandPayload {
  command: string;
  subcommand: string | null;
  flags_shape: string[];
  scope: CommandScope;
  duration_ms: number;
  exit_code: number;
  outcome: CommandOutcome;
  error_class: string | null;
  retryable: boolean;
  touched_surface: TouchedSurface;
  mla_version: string;
  git_sha: string;
  command_index_in_session: number | null;
  preceded_by: string | null;
  session_idle_gap_ms: number | null;
}

export interface EvidenceInjectPayload {
  inject_id: string;
  // The per-session turn this inject landed on (1-based, monotonic; the same
  // counter as command_index_in_session and the ask-traces turn_index). The local
  // correlator joins inject -> pulls / citations on (session_id, turn_index), so
  // the turn must travel with the event (INV-CORRELATOR-1). It is a sequence
  // integer, not PII. null only for an inject we could not place in the turn
  // stream (best-effort); such an inject still records but cannot be correlated.
  turn_index: number | null;
  evidence_offered: number;
  offered_source_ids: string[];
  evidence_tokens: number;
  retrieval_confidence: RetrievalConfidence;
  retrieval_latency_ms: number;
  zero_results: boolean;
  window_deadline: string;
}

export interface EvidenceOutcomePayload {
  inject_id: string;
  outcome_version: number;
  outcome: InjectOutcome;
  pulled_within_window: boolean;
  report_cited: boolean;
  referenced: boolean;
  referenced_source_ids: string[];
  citation_precision: number | null;
  offered_reference_rate: number | null;
  window_closed_reason: WindowClosedReason;
}

export interface CoverageGapPayload {
  inject_id: string;
  coverage_gap_type: CoverageGapType;
  query_topic_category: QueryTopicCategory;
  retrieval_confidence: RetrievalConfidence;
  zero_results: boolean;
}

export interface ContradictionPayload {
  contradiction_id: string;
  edge_type: RelationEdgeType;
  contradiction_surfaced: boolean;
  contradiction_acted_on: boolean;
}

export interface ReviewDecisionPayload {
  decision_id: string;
  decision_version: number;
  decision: ReviewDecision;
  relation_type: RelationEdgeType;
}

export interface StatsViewedPayload {
  scope: CommandScope;
  window: string;
}

// CE0 telemetry payloads (§6.4). workspace_id / session_id / event_id live on the
// envelope, so they are NOT repeated here; the payload carries only the per-event
// fields. Every field is an id, an enum, a count, a boolean, a duration, or a hash
// (INV-POSTHOG-PII-1): markers_matched_hashed never carries the raw marker text.

export interface MemoryRequirementAssessedPayload {
  assessment_id: string;
  turn_id: string;
  local_turn_sequence: number;
  memory_requirement: MemoryRequirementLabel;
  work_type: string;
  classifier_version: string;
  marker_set_version: string;
  markers_matched_hashed: string;
  sampling_bucket: string;
}

export interface EvidenceConsultationCompletedPayload {
  consultation_id: string;
  local_turn_sequence: number;
  // OPTIONAL (§6.4 R4 P1.2): present only when the turn holds an obligation and thus a rule version;
  // a consultation on a NOT_REQUIRED / UNKNOWN turn omits it.
  rule_version_id?: string;
  source: string;
  execution: ConsultationExecutionLabel;
  // Present (non-null) IFF execution is COMPLETE (§6.4 / P0.3).
  result: ConsultationResultLabel | null;
  delivered_to_answering_context: boolean;
  // OPTIONAL (§6.4 P0.2): monotonic retrieval-start to result-capture latency; absent when no
  // retrieval was timed (a proactive push observed after the fact).
  latency_ms?: number;
}

export interface EvidenceObligationFinalizedPayload {
  obligation_id: string;
  local_turn_sequence: number;
  rule_version_id: string;
  state_version: number;
  outcome: ObligationOutcomeLabel;
  // The distinct §1.6 sources that proved a required subject, recomputed offline over the frozen
  // eligible set; [] when nothing proved a subject. answer_disposition is a human label CE0 does
  // not derive on the device, so the offline labeler may leave it null.
  satisfied_by_sources: string[];
  answer_disposition: string | null;
}

export interface EvidenceHookHealthPayload {
  hook: Ce0Hook;
  // The stable per-hook coordinate the hook acted on (§6.4), keying the deterministic event_id so a
  // re-fired hook dedups instead of double-counting.
  operation_identity: string;
  duration_ms: number;
  failed: boolean;
  // A classified reason CODE (e.g. "DB_LOCKED", "TIMEOUT"), never a raw error string.
  reason: string | null;
  // OPTIONAL harness turn id; present only when the harness supplied one (§6.4; the envelope's
  // session_id + the operation_identity are authoritative).
  turn_id?: string;
}

// Enforcement-incident payload (§5.1). One per fired PreToolUse deny. workspace_id /
// session_id / event_id ride the envelope, so they are NOT repeated here. Every OTHER
// field is an id or a closed enum. The raw strings (`rule_text`, `rule_node_id`,
// `blocked_path`) are kept off the analytics-to-PostHog boundary by the fail-closed
// projector allowlist (INV-POSTHOG-PII-1): they are stored locally + forwarded to control
// for the console review queue, but the projector drops any un-allowlisted string key so
// they never reach PostHog.
export interface EnforcementIncidentPayload {
  // The durable EnforcementAttempt id (a ULID) the seam minted for this deny. It is
  // BOTH the event's natural business key (the deterministic event_id is keyed by it,
  // so a re-fired hook dedups) AND the join key to the device-local audit row.
  incident_id: string;
  decision: EnforcementDecision;
  // Namespaced deliberately: the PostHog minimization projector is event-agnostic, and a
  // generic `tool` key already carries a RAW, un-normalized MCP tool name on another event
  // (followthrough's McpCall). `enforced_tool` is this event's closed {Write, Edit, unknown}
  // enum and cannot collide with that raw value at the privacy boundary.
  enforced_tool: EnforcedTool;
  touched_surface: TouchedSurface;
  // The human-attested LIVE rule version that produced the deny (joins to which rule
  // and which version fired). Opaque id, not PII. NOTE: this id is NOT stable across a
  // rules-store cutover: a pre-cutover deny cites a version id that a later join cannot
  // resolve. rule_node_id + rule_text below are the cutover-proof snapshot that supersedes
  // relying on this join for the review queue.
  rule_version_id: string;
  // The deciding rule NODE id, snapshotted at block time. OPTIONAL because legacy denies omit
  // it. Stable across version cutovers (unlike rule_version_id), so control can resolve the
  // human rule NAME even after the fired version is superseded. Opaque id, not PII, but still
  // allowlist-dropped from PostHog (it is an un-allowlisted string key).
  rule_node_id?: string;
  // The deciding rule's own statement, snapshotted at block time. OPTIONAL because legacy denies
  // omit it. The review queue reads it DIRECTLY as immutable evidence instead of joining a version
  // id that rots. Authored rule content, not user PII; allowlist-projected out of PostHog.
  rule_text?: string;
  // The review label dimension (§5.1). Always "unreviewed" from the CLI; a later
  // offline labeler emits a superseding event to flip it.
  review_status: EnforcementReviewStatus;
  // The runtime-relative path the rule blocked (never absolute, micro-decision A); OPTIONAL
  // because pre-capture denies and non-file denies omit it. A raw string on this event;
  // allowlist-projected out of PostHog, served only to the console review queue so the
  // operator can see WHAT was blocked and adjudicate it.
  blocked_path?: string;
}

// Enforcement-outcome payload (STAR's R). One per closed deny window, keyed on the
// SAME incident_id as its incident (so it self-joins to the incident it resolves).
// workspace_id / session_id / event_id ride the envelope. Every field is a closed enum
// or a count -- NO path, NO transcript text, NO file content (INV-POSTHOG-PII-1), so the
// whole payload is safe to reach PostHog unprojected. It is EVIDENCE-ONLY: it records
// what the machine observed, never the human review_status (that stays on the incident).
export interface EnforcementOutcomePayload {
  // The incident this outcome closes. Same value as the incident's incident_id; the
  // outcome's own deterministic event_id is namespaced (enf-outcome:<id>) so it never
  // collides with the incident's event_id (which is keyed on the bare incident_id at v0).
  incident_id: string;
  // Monotonic per-incident version. Only a terminal outcome is ever emitted, and it is
  // emitted at most once, so this is always 0 in v1 (kept for parity with the evidence
  // outcome's supersede-by-higher-version model, should a re-classification ever ship).
  outcome_version: number;
  // The terminal class the correlator derived for what the agent did after the deny.
  outcome: EnforcementOutcome;
  // How many Write/Edit attempts the agent made AFTER this deny in the same session
  // transcript (0 for complied_stopped). A count, never the paths themselves.
  followup_attempts: number;
  // How many of those follow-up attempts were themselves blocked (>= 1 iff the class is
  // retried_blocked). A count, never the paths.
  retried_blocked_count: number;
}

// The typed, discriminated event union. event_type narrows the payload.
export type AnalyticsEvent =
  | (AnalyticsEnvelope & { event_type: "mla_command" } & CommandPayload)
  | (AnalyticsEnvelope & { event_type: "mla_evidence_inject" } & EvidenceInjectPayload)
  | (AnalyticsEnvelope & { event_type: "mla_evidence_outcome" } & EvidenceOutcomePayload)
  | (AnalyticsEnvelope & { event_type: "mla_coverage_gap" } & CoverageGapPayload)
  | (AnalyticsEnvelope & { event_type: "mla_contradiction" } & ContradictionPayload)
  | (AnalyticsEnvelope & { event_type: "mla_review_decision" } & ReviewDecisionPayload)
  | (AnalyticsEnvelope & { event_type: "mla_stats_viewed" } & StatsViewedPayload)
  | (AnalyticsEnvelope & {
      event_type: "memory_requirement_assessed";
    } & MemoryRequirementAssessedPayload)
  | (AnalyticsEnvelope & {
      event_type: "evidence_consultation_completed";
    } & EvidenceConsultationCompletedPayload)
  | (AnalyticsEnvelope & {
      event_type: "evidence_obligation_finalized";
    } & EvidenceObligationFinalizedPayload)
  | (AnalyticsEnvelope & { event_type: "evidence_hook_health" } & EvidenceHookHealthPayload)
  | (AnalyticsEnvelope & {
      event_type: "mla_enforcement_incident";
    } & EnforcementIncidentPayload)
  | (AnalyticsEnvelope & {
      event_type: "mla_enforcement_outcome";
    } & EnforcementOutcomePayload);

// --- envelope construction --------------------------------------------------

export interface EnvelopeInput {
  event_id: string;
  event_type: EventType;
  created_at: string;
  emitted_at?: string;
  workspace_id: string | null;
  distinct_id: string | null;
  session_id: string | null;
  run_id: string;
  trace_id: string;
  source?: EventSource;
  // Attribution inputs (T1.10). actor_workspace_user_id is the un-collapsed actor
  // cuid (NOT distinct_id, which falls back to a hashed machine id on an actorless
  // run); repo_fingerprint is the bootstrap-computed one-way repo hash. Both
  // optional and default to null so existing callers/tests need no change.
  actor_workspace_user_id?: string | null;
  repo_fingerprint?: string | null;
}

export function makeEnvelope(input: EnvelopeInput): AnalyticsEnvelope {
  const source = input.source ?? "cli";
  return {
    schema_version: SCHEMA_VERSION,
    event_id: input.event_id,
    event_type: input.event_type,
    created_at: input.created_at,
    emitted_at: input.emitted_at ?? input.created_at,
    workspace_id: input.workspace_id,
    distinct_id: input.distinct_id,
    session_id: input.session_id,
    run_id: input.run_id,
    trace_id: input.trace_id,
    source,
    attribution: buildAttribution({
      source,
      workspaceId: input.workspace_id,
      actorWorkspaceUserId: input.actor_workspace_user_id ?? null,
      agentSessionId: input.session_id,
      repoFingerprint: input.repo_fingerprint ?? null,
    }),
  };
}

// Assemble the attribution block (T1.10). Pure: every field is mapped from a
// caller-supplied id/constant, no I/O. sourceSurface is derived from the closed
// `source` enum so it can never carry an open string; the `?? "CLI"` is a
// defensive default for the (type-impossible) case of an unmapped source.
export function buildAttribution(input: {
  source: EventSource;
  workspaceId: string | null;
  actorWorkspaceUserId: string | null;
  agentSessionId: string | null;
  repoFingerprint: string | null;
}): EventAttribution {
  return {
    source: "mla",
    sourceProduct: "MLA",
    sourceSurface: SOURCE_SURFACES[input.source] ?? "CLI",
    actorWorkspaceUserId: input.actorWorkspaceUserId,
    workspaceId: input.workspaceId,
    agentSessionId: input.agentSessionId,
    repoFingerprint: input.repoFingerprint,
  };
}

// --- validators (INV-JOIN-1, the test contract) -----------------------------

// The eight join fields the test contract requires on every event. workspace_id
// and session_id are allowed to be null here (an unbound local run); presence of
// the KEY is asserted, while remote-emittability (non-null workspace+session) is
// a separate, stricter check (isRemotelyEmittable).
const REQUIRED_ENVELOPE_KEYS: (keyof AnalyticsEnvelope)[] = [
  "schema_version",
  "event_id",
  "event_type",
  "created_at",
  "workspace_id",
  "session_id",
  "run_id",
  "trace_id",
];

export function envelopeMissingKeys(ev: Partial<AnalyticsEnvelope>): string[] {
  const missing: string[] = [];
  for (const k of REQUIRED_ENVELOPE_KEYS) {
    if (!(k in ev)) {
      missing.push(k);
      continue;
    }
    const v = (ev as Record<string, unknown>)[k];
    // null is allowed for workspace_id / session_id (unbound run); undefined
    // never is. Every other required key must be a non-empty value.
    if (v === undefined) {
      missing.push(k);
    } else if (v === null && k !== "workspace_id" && k !== "session_id") {
      missing.push(k);
    } else if (typeof v === "string" && v.length === 0) {
      missing.push(k);
    }
  }
  return missing;
}

// Throws if any required envelope field is missing. Used as the assertion in
// the envelope test (INV-JOIN-1) and as a defensive gate before remote ship.
export function assertEnvelopeComplete(ev: Partial<AnalyticsEnvelope>): void {
  const missing = envelopeMissingKeys(ev);
  if (missing.length > 0) {
    throw new Error(
      `analytics event missing required envelope field(s): ${missing.join(", ")}`,
    );
  }
}

// INV-JOIN-1 applies to REMOTELY emitted events: they need a real workspace and
// session to join. An event with a null workspace_id or session_id is recorded
// locally (the operator's own view) but never shipped. The forwarder filters on
// this.
export function isRemotelyEmittable(ev: AnalyticsEnvelope): boolean {
  return (
    envelopeMissingKeys(ev).length === 0 &&
    typeof ev.workspace_id === "string" &&
    ev.workspace_id.length > 0 &&
    typeof ev.session_id === "string" &&
    ev.session_id.length > 0
  );
}
