// The rule-injection cost meter (audit 6.G / 7.10): the coercion + payload builder behind
// `mla_rule_injection`, the one event that says what our rules COST the user per turn. The types
// themselves live in the event catalog (envelope.ts: RuleMeterFile, RuleInjectionPayload).
//
// WHY THIS EXISTS. The floor is billed to every user on every turn, forever. Roughly 2,181 tokens
// of always-on rules rode in every single prompt and nobody could name the number, which made two
// questions unanswerable: what does governance cost per turn (the pricing input), and is scoping
// buying anything (the design bet). Both are now one event.
//
// WHY THE METER TAKES SUCH A LONG ROUTE (assembler -> temp file -> detached spawn). The numbers
// are only knowable inside assembleContext(), which runs on the UserPromptSubmit HOT PATH, and
// that path may never make a network call, so it cannot emit. The three shorter routes are all
// worse:
//   - recompute the meter inside the detached process: it would need the PROMPT (turn triggers
//     match on prompt text), putting the user's raw prompt in argv where every `ps` on the box can
//     read it. The prompt is PII. Non-starter.
//   - read the assemble-audit file from the detached process: that file is per-WORKSPACE and
//     last-write-wins, and 10+ concurrent sessions clobber it, so the meter would be attributed to
//     whichever turn happened to write last.
//   - flush from the hot path: a network round-trip on every prompt.
// So the hot path writes pure numbers to a caller-named temp file and the hook hands that JSON to
// a detached process. Nothing but integers ever leaves the assembler.

import { RuleInjectionPayload, RuleMeterFile, SCHEMA_VERSION } from "./envelope";
import { deterministicEventId, mintEventId } from "./event-id";

const BYTES_PER_TOKEN = 4;

/** Estimated tokens for a byte count. Ceil, so a nonzero cost never rounds down to a free one. */
export function estimateTokens(bytes: number): number {
  return Math.ceil(Math.max(0, bytes) / BYTES_PER_TOKEN);
}

function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

/**
 * Parse the meter JSON handed across the process boundary. Every field is coerced to a
 * non-negative integer and a missing field reads 0: a garbled meter must degrade to a boring zero
 * row, never throw inside a detached process whose only job is telemetry.
 */
export function coerceRuleMeter(raw: unknown): RuleMeterFile | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  return {
    base_bytes: num(r.base_bytes),
    always_on_bytes: num(r.always_on_bytes),
    always_on_rules: num(r.always_on_rules),
    scoped_bytes: num(r.scoped_bytes),
    scoped_rules: num(r.scoped_rules),
    scoped_configured: num(r.scoped_configured),
    avoided_bytes: num(r.avoided_bytes),
    omitted_rules: num(r.omitted_rules),
    head_bytes: num(r.head_bytes),
    safe_total: num(r.safe_total),
    overflow: r.overflow === true,
    degraded: r.degraded === true,
    base_invariant: r.base_invariant === true,
  };
}

export function buildRuleInjectionPayload(
  meter: RuleMeterFile,
  opts: { turnIndex: number | null },
): RuleInjectionPayload {
  const ruleBytes = meter.always_on_bytes + meter.scoped_bytes;
  return {
    ...meter,
    schema_version: SCHEMA_VERSION,
    turn_index: opts.turnIndex,
    always_on_tokens: estimateTokens(meter.always_on_bytes),
    scoped_tokens: estimateTokens(meter.scoped_bytes),
    avoided_tokens: estimateTokens(meter.avoided_bytes),
    head_tokens: estimateTokens(meter.head_bytes),
    always_on_share_bp:
      ruleBytes > 0 ? Math.round((meter.always_on_bytes / ruleBytes) * 10000) : 0,
  };
}

/**
 * One meter per (session, turn). Deterministic on that pair so a hook that fires twice for the
 * same turn (a retried prompt, a re-spawned hook) dedupes at control on (workspace_id, event_id)
 * rather than double-charging the turn. Falls back to a random id only when there is no session to
 * key on, where a possible duplicate beats dropping the row entirely.
 */
export function ruleInjectionEventId(sessionId: string | null, turnIndex: number | null): string {
  if (!sessionId) return mintEventId();
  return deterministicEventId(`rule-injection:${sessionId}:${turnIndex ?? 0}`, 1);
}
