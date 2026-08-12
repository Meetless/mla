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
  // Onboarding FINDING lifecycle (20260731-mla-onboarding-drift-finding-design §9). One append
  // when a doc/code inconsistency lands PENDING at ingest, one when a human closes it at
  // `mla enrich resolve`. These two rows are the only producer of the §9 metrics: without them
  // the carve-out rate (the kill metric) has no numerator and no denominator, and "time to first
  // finding" has no clock. Payload is one opaque id plus two closed enums, so it crosses the
  // fail-closed projector as ids/enums only (INV-POSTHOG-PII-1). The finding's TEXT, its quote,
  // its paths, and its commit never leave the device.
  "mla_onboarding_finding",
  // Onboarding OFFER lifecycle. One append every time a surface tells a workspace it has no
  // governed memory and names the remedy.
  //
  // It exists because on 2026-08-02 we shipped a SessionStart nudge to fix exactly the funnel
  // this measures, and four days later could not tell whether it had converted nobody or had
  // never been shown at all. Those two states demand opposite fixes (fix the trigger vs fix the
  // ask), and neither was distinguishable, because the nudge emitted nothing. A mitigation you
  // cannot measure is a mitigation you cannot iterate.
  //
  // There is deliberately NO companion `offer_accepted` event. Acceptance is already derivable:
  // `mla enrich <plan|ingest>` is a normal command and emits its own `mla_command`, so
  // conversion is this row joined to a later enrich row in the same session. A second event
  // would be a second thing to keep correct for a number we can already compute.
  "mla_onboarding_offer",
  // Rule-injection COST (audit 6.G / 7.10). One append per governed prompt: how many bytes and
  // rules we charged the model's context window for, split ambient (the always-on floor, billed
  // on every turn to every user) vs scoped (this turn's targeted rules). This is the only event
  // that prices governance, and the only one that can prove scoping buys anything. Payload is
  // numbers and booleans only, so it crosses control's fail-closed PostHog projector untouched.
  "mla_rule_injection",
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

// Who invoked the command (§4.11 of the "agent is the only executor" proposal).
// A closed enum, the same shape as the other payload enums, derived from execution
// context only (never argv, INV-ARGV-1). Carried on mla_command so agent traffic
// can be separated from human traffic. `deriveInvoker` (analytics/invoker.ts) maps
// context to one of these; `hook` and `mcp` are reserved for paths that do not emit
// a command event today (see that module). PostHog projection of this dimension is
// a separate, deferred control-side allowlist change; the CLI only observes it here.
export const INVOKERS = ["agent", "human_tty", "hook", "mcp", "ci"] as const;
export type Invoker = (typeof INVOKERS)[number];

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

// --- onboarding-finding enums (drift-finding design §9) ---------------------
// The two points in a finding's life that a metric can be computed from. `persisted`
// is stamped by `mla enrich ingest` when the finding lands PENDING; `resolved` by
// `mla enrich resolve` when a human closes it. There is deliberately no `dismissed`
// or `expired`: a finding is open until a human says otherwise, and inventing a
// third phase here would put a state in the metrics that the product does not have.
export const ONBOARDING_FINDING_PHASES = ["persisted", "resolved"] as const;
export type OnboardingFindingPhase = (typeof ONBOARDING_FINDING_PHASES)[number];

// The three human verdicts, mirrored from the enrichment protocol's FINDING_RESOLUTIONS.
// The seam assigns a protocol `FindingResolution` into this field, so dropping a verdict
// here (or adding one there without adding it here) is a COMPILE error rather than a
// silently uncounted resolution: `carve_out` is the kill metric's numerator, and a verdict
// that never reaches the payload would make the gate read healthier than the product is.
export const ONBOARDING_FINDING_VERDICTS = ["code_diverged", "doc_stale", "carve_out"] as const;
export type OnboardingFindingVerdict = (typeof ONBOARDING_FINDING_VERDICTS)[number];

// --- onboarding-offer enums -------------------------------------------------
// WHICH surface made the offer. The whole point of the event is to tell "never shown" apart
// from "shown and ignored", and that only works if each surface is separable: they fire at
// different moments with different intent, and the 2026-08-02 SessionStart nudge converting
// nobody says nothing about whether the retrieval-time warning converts.
//
//   session_start   the SessionStart nudge, a LEVEL trigger that speaks before the user has
//                   asked anything (the moment of least intent).
//   retrieval_empty the MCP `retrieve_knowledge` empty-pull warning (see `explainEmptyPull`
//                   in packages/mcp/evidence_actions.js), which fires at the moment the gap
//                   is actually demonstrated.
//   activate        the `mla activate` hand-off to the onboard skill, an EDGE trigger that by
//                   construction can never reach a workspace already past it.
export const ONBOARDING_OFFER_SURFACES = ["session_start", "retrieval_empty", "activate"] as const;
export type OnboardingOfferSurface = (typeof ONBOARDING_OFFER_SURFACES)[number];

// What the offer was made ON TOP OF, i.e. what the deterministic seed had just achieved. This
// is the field that keeps the funnel honest once seeding exists: an offer shown to a workspace
// whose corpus is still empty is a different product event from one shown to a workspace that
// now holds its own instruction files and is being offered the richer agentic pass.
//
//   dark        no governed memory at all, and the seed added none (no instruction files, or
//               the seed could not run). This is the state the 24 dark workspaces are in.
//   seeded      the deterministic seed just persisted at least one document this run.
//   seeded_prior the seed had nothing to do because this checkout is already seeded.
export const ONBOARDING_OFFER_CORPUS_STATES = ["dark", "seeded", "seeded_prior"] as const;
export type OnboardingOfferCorpusState = (typeof ONBOARDING_OFFER_CORPUS_STATES)[number];

// --- enforcement-incident enums (§5.1, the deny tile) -----------------------
// The closed wire forms for the PreToolUse enforcement event. Every value is a
// fixed enum so no open string (a tool name, a decision verb, a review verdict)
// reaches the privacy boundary.

// The tools the deny pilot is armed for. The notes-location admission gate is
// exactly {Write, Edit}; "unknown" is a defensive fallback the gate should make
// unreachable, kept so a future deny rule on another tool still classifies safely.
export const ENFORCED_TOOLS = ["Write", "Edit", "unknown"] as const;
export type EnforcedTool = (typeof ENFORCED_TOOLS)[number];

// The enforcement verdict the hook emitted, i.e. what actually happened to the user's action.
// All three fire today: "deny" blocks it, "warn" permits it with a model-facing advisory, and "ask"
// pauses it for a human answer (a natively-attested ASK ceiling, or a DENY whose bundle lease went
// stale and degrades to one confirmation rather than blocking on a possibly-revoked rule).
//
// "ask" records that the prompt was ISSUED, never that it was approved: Claude Code does not hand a
// hook the answer to its own prompt, and inferring approval from the tool having run afterwards
// would be fabricated evidence. See EnforcementIncidentPayload.ask_outcome.
export const ENFORCEMENT_DECISIONS = ["deny", "warn", "ask"] as const;
export type EnforcementDecision = (typeof ENFORCEMENT_DECISIONS)[number];

// The enforcement authority a rule was ATTESTED at, snapshotted onto its incident. Structurally the
// same four rungs as the rules layer's EligibleEnforcement, redeclared here rather than imported
// because this module is the wire contract and owns its own closed enums (it imports nothing, by
// design). See EnforcementIncidentPayload.enforcement_ceiling for why this is kept separate from
// `decision` and why the two are allowed to disagree.
export const ENFORCEMENT_CEILINGS = ["OBSERVE", "WARN", "ASK", "DENY"] as const;
export type EnforcementCeiling = (typeof ENFORCEMENT_CEILINGS)[number];

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
  // The one-way repo hash, mirrored FLAT alongside the nested copy in
  // `attribution`. The server-side projector drops nested objects wholesale (they
  // could hide anything), so a value that only rides inside `attribution` never
  // reaches PostHog. WGAR (Weekly Governed-Active Repos) counts distinct repos, so
  // the hash has to survive the flat projection: hence this top-level mirror, which
  // the projector allowlists in SAFE_ID_KEYS. Still a NON-identifying one-way hash,
  // never a path, so INV-POSTHOG-PII-1 holds. null outside a git repo.
  repo_fingerprint: string | null;
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
  // Who ran this command (§4.11). Derived from execution context, never argv.
  invoker: Invoker;
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
  // Material-incorporation correlator provenance (notes/20260716-evidence-material-incorporation-correlator.md §6.4).
  // Both additive keys are known at prompt-submit; they let the seal path and the
  // downstream rollup reason about this inject WITHOUT re-deriving CLI state.
  //   trace_upload_consented: the value of traceUploadEnabled(env) at inject time.
  //     When false the client never stages a work-product capture and never POSTs an
  //     intake, so no seal event is ever emitted for this inject (zero-egress path).
  //   work_product_capture_version: the capture schema THIS client is capable of
  //     emitting (CURRENT_CAPTURE_CONTRACT_VERSION), or null for an old/non-capable
  //     client. It says the client CAN capture, not that it DID.
  trace_upload_consented: boolean;
  work_product_capture_version: number | null;
  // The ROUTER's intent classification for the turn this inject landed on, copied
  // from intel's EnrichTrace (which the hook already persists verbatim as
  // governed_kb_trace). Measured over one session the router returned "unknown" on
  // 4 of 6 traced turns and injected anyway on 2 of them, both ignored -- and
  // nothing could tell "the router cannot classify our prompts" apart from "the
  // label is missing but the ranking was fine", because the intent never reached
  // the inject event.
  //
  // null is NOT "unknown". null means no intent was recorded (an older hook, a
  // strategy with no router trace); "unknown" means the router ran and could not
  // classify. Collapsing them would sweep every pre-rollout row into the unknown
  // bucket and make the split unreadable in exactly the window it is meant to read.
  intent_type: string | null;
  // The classified topic of the turn's prompt, carried so the OUTCOME-time
  // `candidates_found_not_used` gap can be labelled too. It was already computed at
  // inject time and written onto the INJECT-time gap payload only, so the
  // correlator -- which reads inject events -- had to hardcode "unknown". Measured
  // 2026-08-07: every low_confidence_candidates gap since the classifier landed
  // carries a real topic, and every candidates_found_not_used gap ever minted is
  // unknown. That is the ranking-failure class, i.e. the half of the roadmap worth
  // slicing. null (not "unknown") when nothing classified it.
  query_topic_category: string | null;
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
  // The ceiling the human ATTESTED the deciding rule at, snapshotted at incident creation from the
  // rule payload (never resolved later by joining a version id that rots, exactly like rule_text).
  // NAMESPACED like `enforced_tool` rather than a bare `ceiling`: a generic key would collide with
  // differently-scoped ceiling values on other events, and this one means specifically "the
  // enforcement authority this rule was attested at".
  //
  // It is deliberately SEPARATE from `decision` and the two can disagree. `decision` is what
  // actually happened; `enforcement_ceiling` is what the rule was armed at. A DENY-attested rule
  // clamped to WARN by the session cap (MEETLESS_ACTION_INTERCEPT_MAX) emits
  // {decision: "warn", enforcement_ceiling: "DENY"}, and that pair is the only way to tell "this
  // rule is advisory" from "this rule would have blocked but the cap stopped it".
  //
  // A closed four-value enum with no path, text or identity, so it is safe to allowlist through the
  // PostHog projector (the same reasoning that allowlists `enforced_tool`).
  //
  // OPTIONAL: incidents emitted before this field existed do not carry it, and there is NO
  // backfill. Absent means "emitted before the field existed", which is true; inventing a value for
  // those 49 historical rows would be the same fabrication as rendering an uninstrumented zero.
  enforcement_ceiling?: EnforcementCeiling;
  // INV-8 consent state. "overridden" means a human redeemed a single-use, action-scoped grant and
  // the hard block was withheld. Absent means the block stood. A closed enum with no path, text or
  // identity, so it is safe to project to PostHog on the same basis as enforcement_ceiling.
  consent_state?: "overridden";
  // The user's answer to an ASK prompt. Present ONLY on `decision: "ask"` rows, and today its only
  // value is "unknown", by design rather than by omission.
  //
  // Claude Code exposes no permission outcome to a hook, and this is documented rather than
  // inferred: PostToolUse fires only after a tool SUCCEEDS (so a denial produces no event at all),
  // no hook event carries the user's answer as input, PermissionDenied fires only for the auto-mode
  // classifier and not for an interactive denial, Stop and SessionEnd carry no permission history,
  // and the session transcript's schema is explicitly undocumented and unstable with official
  // guidance not to parse it.
  //
  // So an explicit "unknown" is the honest record. Inferring approval from the tool having run
  // afterwards would be fabricated evidence of a human decision, which is the worst thing this
  // payload could carry. If the host ever exposes the answer, this field is where it lands.
  ask_outcome?: "unknown";
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

// The rule-cost meter as the hot-path assembler measures it, in BYTES (the only thing actually
// measurable at assembly time; tokens are a derived estimate, added downstream). This is also the
// IPC struct: `mla _internal assemble-context` writes exactly this JSON to its `meterFile`, and
// the hook hands it to the detached `_internal rule-meter` emitter. It lives here, next to the
// event catalog, because it IS the payload's spine: every field is a number or a boolean and none
// of it can carry a rule id, a path, a glob, or the prompt (INV-POSTHOG-PII-1).
export interface RuleMeterFile {
  // The hook-rendered static preamble (LAYER1). Not governance cost, but part of the head, so it
  // has to be visible or the head bytes never reconcile.
  base_bytes: number;
  // THE TAX. The rendered floor block (wrapper included) that rides on EVERY turn regardless of
  // what the user is doing. This single number is the thing 6.G says we were charging every user
  // for and could not name.
  always_on_bytes: number;
  always_on_rules: number;
  // What targeting actually delivered this turn: the rules that matched this prompt's paths.
  scoped_bytes: number;
  scoped_rules: number;
  // How many scoped rules EXIST in the workspace. With scoped_rules, this is the targeting ratio:
  // if every configured scoped rule fires on every turn, the scoping is decorative.
  scoped_configured: number;
  // The counterfactual: bytes we did NOT spend because scoping withheld the non-matching scoped
  // rules. This is the payoff line for the Tier-1 design bet. On overflow it is a LOSS, not a
  // saving (see `overflow`), because nothing scoped rode at all.
  avoided_bytes: number;
  omitted_rules: number;
  head_bytes: number;
  safe_total: number;
  // An applicable MUST could not be delivered inside the budget, so the prompt was BLOCKED
  // fail-closed. The turn cost the user a block, not an injection; cost tiles must exclude it.
  overflow: boolean;
  // The cache was missing or too old to assemble from, so the rule COUNTS are unknowable (they
  // read 0 and mean "unknown", not "zero"). The BYTES remain true. Any tile that averages
  // rules-per-turn must filter this out; any tile that sums bytes should not.
  degraded: boolean;
  // base + the always-on floor ALONE blew the budget, so the assembler could not run at all and
  // the hook's bash fallback delivered the head (LAYER1 + the pre-rendered floor). Everything here
  // is still true (the floor DID ride, and its rule count comes from the cache), which is why this
  // is NOT `degraded`: it is the turn where the tax is at its worst and targeting is structurally
  // dead (scoped_rules is 0 no matter what the prompt was, while scoped_configured says how many
  // rules were forfeited). A cost board that dropped these rows would go blind on exactly the
  // turns that motivated 6.G.
  base_invariant: boolean;
}

// One row per onboarding-finding lifecycle point (drift-finding design §9).
//
// Deliberately four fields. Every §9 metric is a count, a ratio, or a time difference over
// these rows joined to the envelope it already rides on: `created_at` gives the clock,
// `repo_fingerprint` the repository dimension the kill rule's 40% cap needs, `session_id` the
// same-session test, and `run_id` the invocation. Nothing about WHAT the finding says appears
// here, because no §9 metric is about the content and the content is exactly what must not
// leave the device.
export interface OnboardingFindingPayload {
  // The candidate's sha256 identity, truncated to a display-length prefix. It joins a
  // `resolved` row to its `persisted` row (that join IS "time to resolution") and dedups a
  // re-emitted row. A one-way hash prefix of the finding statement: not reversible, and never
  // the statement itself (INV-OPAQUE-ID-1).
  finding_id: string;
  finding_phase: OnboardingFindingPhase;
  // The human verdict. null on `persisted` (nobody has decided yet), always present on
  // `resolved`. Null rather than an "open" token so a mis-filtered query counts zero
  // carve-outs instead of silently counting open findings as decided ones.
  finding_verdict: OnboardingFindingVerdict | null;
  // Whether closing this finding minted a durable rule. True only for a `code_diverged`
  // resolution that actually reached the authority (a --dry-run preview mints nothing), so
  // the adoption story ("findings that became governance") has a real field behind it
  // instead of being inferred from the verdict alone.
  minted_rule: boolean;
}

// The emitted onboarding-offer payload. Counts and closed enums only: no path, no filename, no
// rule text, no corpus size. Corpus size in particular is deliberately absent, for the same
// reason the MCP's empty-pull warning carries no count: the pull crosses an ACL boundary and the
// size of another principal's corpus is not ours to disclose.
export interface OnboardingOfferPayload {
  offer_surface: OnboardingOfferSurface;
  offer_corpus_state: OnboardingOfferCorpusState;
  // The three seed counters below are NULL, not zero, at a surface that runs no seed.
  //
  // `session_start` is a seeding surface: it syncs the checkout's instruction files and then
  // speaks, so 0 there is a real measurement ("nothing to seed"). `retrieval_empty` fires inside
  // an MCP pull that never touches the repository, so a 0 would assert a seed ran and found
  // nothing, and `seed_failed: false` would assert a seed ran and succeeded. Both are claims we
  // have no evidence for, and control's projector drops null, so the mirrored row simply omits
  // what did not happen instead of reporting a fiction.
  //
  // How many agent-instruction documents the deterministic seed persisted on THIS run. 0 is the
  // common steady state (already seeded, or nothing to seed) and is meaningful, not missing.
  seeded_documents: number | null;
  // T1 instruction files present in the checkout, whether or not they were seeded this run.
  // This is the denominator that separates "this repo has nothing written down" from "this repo
  // has instructions and we failed to seed them", which is the P0-1 kill criterion's real
  // question and is unanswerable from `seeded_documents` alone.
  instruction_files_present: number | null;
  // True when the seed attempted a POST and the server refused it (or the POST threw). Keeps a
  // persistently-failing intel from reading as a repo that simply has nothing to seed.
  seed_failed: boolean | null;
}

// The emitted rule-injection payload: the measured meter, plus its turn coordinate and the
// derived token estimates. Tokens sit ALONGSIDE the bytes rather than replacing them: bytes are
// the measurement, tokens are a 4-bytes-per-token convention, and keeping both means a real
// tokenizer later re-derives the estimate without invalidating a single historical row.
export interface RuleInjectionPayload extends RuleMeterFile {
  schema_version: number;
  // Position of this prompt within the session (the universal turn join key). Null when the hook
  // could not supply one; a null here costs a per-turn join, not the row.
  turn_index: number | null;
  always_on_tokens: number;
  scoped_tokens: number;
  avoided_tokens: number;
  head_tokens: number;
  // The ambient share of the delivered rule budget, in basis points (0..10000). Precomputed
  // because it is THE headline of 6.G ("how much of what we inject is untargeted") and a ratio
  // every tile re-derives by hand is a ratio some tile gets wrong. 0 when no rule bytes rode.
  always_on_share_bp: number;
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
    } & EnforcementOutcomePayload)
  | (AnalyticsEnvelope & {
      event_type: "mla_onboarding_finding";
    } & OnboardingFindingPayload)
  | (AnalyticsEnvelope & {
      event_type: "mla_onboarding_offer";
    } & OnboardingOfferPayload)
  | (AnalyticsEnvelope & { event_type: "mla_rule_injection" } & RuleInjectionPayload);

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
    repo_fingerprint: input.repo_fingerprint ?? null,
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
