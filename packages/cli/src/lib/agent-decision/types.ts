// src/lib/agent-decision/types.ts
//
// The provider-neutral canonical contract for agent-human decision capture.
// This is the ONE source the rest of the pipeline conforms to (spec
// notes/20260608-agent-decision-capture-design.md, sections 6 and 7).
//
// The domain primitive is an "agent-human decision": the agent asked a human to
// steer, the human answered. Claude Code's AskUserQuestion is the first (and for
// now only) producer behind the normalize() seam. NOTHING in these types names a
// Claude tool concept as a canonical field; provider specifics live only in the
// explicitly provider-scoped fields and in rawProviderPayload (INV-ADAPTER-BOUNDARY).
//
// Control mirrors this contract as a class-validator DTO. The CLI cannot import
// across the nested-workspace boundary into apps/control, so the two definitions
// are kept in sync by the contract tests on both sides plus the synthetic
// non-Claude ingest test (INV-CLAUDE-FIRST-NOT-ONLY). The spec is the source of
// truth for both.

// Exactly one of these. No richer taxonomy until a real producer emits a
// genuinely different interaction (spec section 13, do not re-litigate).
export type DecisionKind = "choice" | "multi_choice" | "free_text";

// How the human answer relates to the offered choices.
export type AnswerType = "choice_label" | "multi_choice_labels" | "free_text";

// The outcome of resolving the returned answer text against the offered labels.
export type ChoiceMatchStatus = "exact_unique" | "exact_ambiguous" | "no_match";

// Which capture path delivered the decision. First writer wins server-side, so
// this records the empirical truth about whether PostToolUse fired (spec 5/11.10).
export type CapturedBy = "post_tool_use" | "stop_transcript_scan";

export interface CanonicalPrompt {
  // The provider's short label / header for the question.
  title: string;
  // The full question text shown to the human.
  body: string;
}

export interface CanonicalChoice {
  // Positional, collision-safe id: "choice_<index>" (INV-CHOICE-ID). NEVER a
  // slugified label, since two labels can slug-collide and corrupt the mapping.
  id: string;
  label: string;
  description?: string;
}

export interface CanonicalAnswer {
  type: AnswerType;
  // A single label for choice_label/free_text; an array of labels for
  // multi_choice_labels. Claude's real multi-select serialization is UNVERIFIED
  // (spec section 3); the normalizer tolerates array or delimited string and
  // always lands here as an array for multi-select.
  value: string | string[];
  // Present only when the answer resolved to an offered choice
  // (exact_unique / exact_ambiguous), single-select.
  choiceId?: string;
  // Present for multi-select when one or more selected labels resolved to
  // offered choices. Augments the spec's singular choiceId for the array case;
  // kept optional so single-select rows stay exactly as the spec describes.
  choiceIds?: string[];
  choiceMatchStatus: ChoiceMatchStatus;
  // The raw answer value exactly as the provider returned it (string or array).
  raw: unknown;
}

// The provider-neutral payload of one agent_decision_captured event. One event
// per question: a single provider tool call carrying N questions decomposes into
// N of these (spec section 5).
export interface CanonicalDecisionPayload {
  // Provider discriminator, e.g. "claude_code".
  provider: string;
  // How this provider's decisions are captured, e.g. "claude_hook".
  providerSource: string;
  // Provider tool/widget name, metadata only, e.g. "AskUserQuestion". Optional
  // because not every provider has a tool concept.
  providerToolName?: string | null;
  // Idempotency identity. For Claude: "<tool_use.id>#<questionIndex>". For
  // providers without a stable id: a deterministic content hash (T6,
  // INV-STABLE-FALLBACK-ID). NEVER derived from capture timestamp.
  providerEventId: string;
  // External agent session id (provider's own).
  providerSessionId?: string | null;

  decisionKind: DecisionKind;

  prompt: CanonicalPrompt;
  choices: CanonicalChoice[];
  answer: CanonicalAnswer;

  multiSelect: boolean;
  // Best-effort: the turn within the mla session this decision influenced.
  turnIndex?: number | null;
  // 32-hex trace id when present, for joins to Langfuse / logs.
  traceId?: string | null;
  capturedBy: CapturedBy;

  // Best-effort local actor hint. Control resolves the AUTHORITATIVE actor from
  // the X-Meetless-Actor path and sets actorSource; this is only a fallback
  // label so a decision is never silently anonymous (INV-ACTOR-ATTRIBUTION).
  actorDisplayName?: string | null;

  // Full provider question + answer, audit only. Never the UI source of truth
  // (INV-RAW-PRESERVATION).
  rawProviderPayload: unknown;

  // ISO 8601 instant the human answered. Stored, but NEVER an identity input and
  // NOT the feed ordering key (spec sections 7 and 10).
  occurredAt?: string;
}

// The local spool event envelope (existing common.sh:spool_append shape) that
// carries one canonical payload through flush.sh to control.
export interface AgentDecisionSpoolEvent {
  ts: string;
  event: "agent_decision_captured";
  // "agent_decision_captured:<provider>:<providerEventId>" (spec section 5).
  // The spool/flush layer dedupes on this; control upserts on
  // (workspaceId, provider, providerEventId).
  eventKey: string;
  sessionId: string;
  payload: CanonicalDecisionPayload;
}

export const AGENT_DECISION_EVENT = "agent_decision_captured" as const;

// Inputs a non-Claude provider needs to derive a deterministic fallback id when
// it has no stable per-event id (spec section 7, used by T6).
export interface FallbackIdInput {
  provider: string;
  providerSessionId: string;
  // "<K>#<i>": zero-based index of this decision among all decision-bearing
  // events in the provider's native replay-stable stream order, suffixed with
  // the within-event question index (spec section 7 sourceOrdinal).
  sourceOrdinal: string;
  prompt: CanonicalPrompt;
  choices: CanonicalChoice[];
  answer: Pick<CanonicalAnswer, "type" | "value">;
}
