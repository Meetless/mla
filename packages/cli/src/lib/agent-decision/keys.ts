// src/lib/agent-decision/keys.ts
//
// Identity + dedup keys for the canonical agent-decision contract.

import { createHash } from "crypto";

import { AGENT_DECISION_EVENT, type FallbackIdInput } from "./types";

// The spool/flush dedup key (spec section 5):
//   "agent_decision_captured:<provider>:<providerEventId>"
// Provider-scoped, NOT hardcoded to claude_code, so a second provider's events
// never collide with Claude's. Control independently upserts on
// (workspaceId, provider, providerEventId).
export function buildEventKey(provider: string, providerEventId: string): string {
  return `${AGENT_DECISION_EVENT}:${provider}:${providerEventId}`;
}

// Claude's stable per-question id (spec section 5): "<tool_use.id>#<questionIndex>".
export function buildClaudeProviderEventId(toolUseId: string, questionIndex: number): string {
  return `${toolUseId}#${questionIndex}`;
}

// NUL field separator so concatenation is unambiguous: ("a","bc") can never
// collide with ("ab","c"). NUL cannot appear in JSON text or a session id, so it
// is a safe fence (a plain space is not, since labels contain spaces).
const FIELD_SEP = "\u0000";

// Deterministic fallback providerEventId for a provider with NO stable per-event
// id (spec section 7, INV-STABLE-FALLBACK-ID):
//   sha256(provider + providerSessionId + sourceOrdinal
//          + normalizedPrompt + normalizedChoices + normalizedAnswer)
// CRITICAL: it must NOT depend on capture timestamp. occurredAt drifts between
// the real-time path and the transcript-scan backstop, so feeding it in would
// break dedup across the two paths. It is therefore not an input here. Claude
// uses the stable "<tool_use.id>#<i>" id and never needs this.
export function deriveFallbackProviderEventId(input: FallbackIdInput): string {
  const normalizedPrompt = JSON.stringify({ title: input.prompt.title, body: input.prompt.body });
  // Order is significant (positional choice ids), so preserve it.
  const normalizedChoices = JSON.stringify(
    input.choices.map((c) => [c.id, c.label, c.description ?? ""]),
  );
  const normalizedAnswer = JSON.stringify({ type: input.answer.type, value: input.answer.value });

  const material = [
    input.provider,
    input.providerSessionId,
    input.sourceOrdinal,
    normalizedPrompt,
    normalizedChoices,
    normalizedAnswer,
  ].join(FIELD_SEP);

  return createHash("sha256").update(material, "utf8").digest("hex");
}
