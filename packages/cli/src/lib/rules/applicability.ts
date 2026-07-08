import { ApplicabilityParseResult, PathOrArgMatcher, TurnTrigger } from "./types";

// R0 applicability parser. Turns a raw, untrusted descriptor into an explicit
// OK / DISABLED / INVALID result. The cardinal rule: NEVER infer a mode from
// absence. A missing, malformed, or unknown mode is a diagnostic, not a silent
// fall-through to "ambient".
//
// This is the SINGLE owner of the applicability grammar, including the `turn`
// trigger struct (targeted-rule-injection §3.2, §5.1). Other consumers that need a
// narrower mode set (e.g. the observed-snapshot attestation path) reuse this parser
// and then post-check the mode; none re-implements the grammar, so a change here can
// never let a mode parse in one path and be rejected in another.

// The closed field set of a v1 TurnTrigger. A trigger carrying any other field is a
// diagnostic, not a silently-dropped extra: the struct is deliberately closed (not a
// DSL), so an unrecognized key is far more likely a typo or a forward-schema payload
// than something safe to ignore.
const TURN_TRIGGER_KEYS = new Set(["promptAny", "explicitPathAny"]);

function invalid(diagnostic: string): ApplicabilityParseResult {
  return { status: "INVALID", diagnostic };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Validate one TurnTrigger list field (promptAny / explicitPathAny): present means a
// non-empty array of non-BLANK strings. Absent is allowed (the caller enforces that at
// least one of the two is present). "Non-blank" (trimmed length > 0), not merely
// "non-empty": a whitespace-only needle carries no signal and, worse, a promptAny needle
// like "   " normalizes to "" at match time, and `norm.includes("")` is true for EVERY
// prompt, so the rule would silently fire on every turn, reinstating the exact every-turn
// floor tax the turn variant exists to remove (§5.5). Reject it at the grammar owner so it
// is a parse diagnostic, not a silent match-all; every reader (CLI write path AND the
// injectionTupleOK read boundary) re-parses through here, so this closes both surfaces.
function parseTriggerList(raw: unknown, field: string): string[] | { error: string } | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length === 0) {
    return { error: `turn trigger ${field} must be a non-empty array when present` };
  }
  if (!raw.every((s) => typeof s === "string" && s.trim().length > 0)) {
    return { error: `turn trigger ${field} must contain only non-blank strings` };
  }
  return raw as string[];
}

function parseTurnTrigger(raw: unknown): { trigger: TurnTrigger } | { error: string } {
  if (!isPlainObject(raw)) {
    return { error: "turn applicability requires a trigger object" };
  }
  const unknown = Object.keys(raw).find((k) => !TURN_TRIGGER_KEYS.has(k));
  if (unknown) {
    return { error: `unknown field '${unknown}' in turn trigger` };
  }
  const trigger: TurnTrigger = {};
  const promptAny = parseTriggerList(raw.promptAny, "promptAny");
  if (promptAny !== undefined) {
    if ("error" in promptAny) return promptAny;
    trigger.promptAny = promptAny;
  }
  const explicitPathAny = parseTriggerList(raw.explicitPathAny, "explicitPathAny");
  if (explicitPathAny !== undefined) {
    if ("error" in explicitPathAny) return explicitPathAny;
    trigger.explicitPathAny = explicitPathAny;
  }
  if (trigger.promptAny === undefined && trigger.explicitPathAny === undefined) {
    return { error: "turn trigger requires at least one of promptAny or explicitPathAny" };
  }
  return { trigger };
}

function parseMatcher(raw: unknown): PathOrArgMatcher | { error: string } {
  if (!isPlainObject(raw)) {
    return { error: "action applicability requires a matcher object" };
  }
  if (typeof raw.field !== "string" || raw.field.length === 0) {
    return { error: "action matcher requires a non-empty string field" };
  }
  const matcher: PathOrArgMatcher = { field: raw.field };
  if (raw.glob !== undefined) {
    if (typeof raw.glob !== "string" || raw.glob.length === 0) {
      return { error: "action matcher glob must be a non-empty string when present" };
    }
    matcher.glob = raw.glob;
  }
  return matcher;
}

export function parseApplicability(raw: unknown): ApplicabilityParseResult {
  if (!isPlainObject(raw)) {
    return invalid("applicability must be an object with an explicit mode");
  }
  if (typeof raw.mode !== "string") {
    return invalid("applicability.mode is missing; ambient is never inferred from absence");
  }

  switch (raw.mode) {
    case "ambient":
      return { status: "OK", applicability: { mode: "ambient" } };

    case "action": {
      if (!Array.isArray(raw.tools) || raw.tools.length === 0) {
        return invalid("action applicability requires a non-empty tools array");
      }
      if (!raw.tools.every((t) => typeof t === "string" && t.length > 0)) {
        return invalid("action applicability tools must all be non-empty strings");
      }
      const matcher = parseMatcher(raw.matcher);
      if ("error" in matcher) {
        return invalid(matcher.error);
      }
      return {
        status: "OK",
        applicability: { mode: "action", tools: raw.tools as string[], matcher },
      };
    }

    case "turn": {
      const parsed = parseTurnTrigger(raw.trigger);
      if ("error" in parsed) {
        return invalid(parsed.error);
      }
      return { status: "OK", applicability: { mode: "turn", trigger: parsed.trigger } };
    }

    default:
      return invalid(`unknown applicability mode: ${raw.mode}`);
  }
}
