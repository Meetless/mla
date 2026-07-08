// src/lib/agent-decision/normalize-claude.ts
//
// The ONE normalization seam, Claude Code AskUserQuestion edition (T2-T5).
//
// Pure functions: raw AskUserQuestion (tool_input + tool_response) -> canonical
// decisions. A single tool call carrying N questions decomposes into N decisions
// (spec section 5), each with providerEventId "<tool_use.id>#<i>". Everything
// Claude-specific is confined here and to rawProviderPayload; the output is
// pure canonical contract (INV-ADAPTER-BOUNDARY, INV-NORMALIZATION).
//
// When a real second provider lands, it gets its own normalize-<provider>.ts that
// emits the same CanonicalDecisionPayload; nothing downstream changes.

import {
  type CanonicalAnswer,
  type CanonicalChoice,
  type CanonicalDecisionPayload,
  type CapturedBy,
  type DecisionKind,
} from "./types";
import { buildClaudeProviderEventId } from "./keys";

export const CLAUDE_PROVIDER = "claude_code";
export const CLAUDE_PROVIDER_SOURCE = "claude_hook";
export const CLAUDE_TOOL_NAME = "AskUserQuestion";

export interface ClaudeOption {
  label: string;
  description?: string;
}

export interface ClaudeQuestion {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options?: ClaudeOption[];
}

// What a PostToolUse hook hands us (tool_input + tool_response), or what the
// transcript-scan path reconstructs by pairing a tool_use with its toolUseResult.
export interface ClaudeAskRaw {
  toolUseId: string;
  // tool_input.questions is authoritative for the offered options.
  questions: ClaudeQuestion[];
  // tool_response.answers, keyed on the EXACT question text.
  answers: Record<string, unknown>;
}

export interface ClaudeNormalizeContext {
  providerSessionId: string;
  capturedBy: CapturedBy;
  turnIndex?: number | null;
  traceId?: string | null;
  occurredAt?: string;
  actorDisplayName?: string | null;
}

// Delimiters a multiSelect answer might use IF Claude serializes it as a string.
// Claude's real multi-select serialization is UNVERIFIED (spec section 3); the
// adapter tolerates an array (preferred) or any of these delimiters.
const MULTI_DELIMITERS = /\r?\n|,|\||;/;

function toChoices(options: ClaudeOption[] | undefined): CanonicalChoice[] {
  return (options ?? []).map((o, idx) => {
    const choice: CanonicalChoice = { id: `choice_${idx}`, label: String(o.label ?? "") };
    if (o.description !== undefined) choice.description = String(o.description);
    return choice;
  });
}

// Match one answer string against the offered labels. Exact match first
// (INV-CHOICE-ID resolution, spec section 6).
function matchLabel(
  value: string,
  choices: CanonicalChoice[],
): { choiceId?: string; status: "exact_unique" | "exact_ambiguous" | "no_match" } {
  const matches = choices.filter((c) => c.label === value);
  if (matches.length === 1) return { choiceId: matches[0].id, status: "exact_unique" };
  if (matches.length > 1) return { choiceId: matches[0].id, status: "exact_ambiguous" };
  return { status: "no_match" };
}

// One leading tolerated delimiter (plus any trailing whitespace) at the start of
// a string. Used to step past the separator between two offered labels.
const LEADING_DELIM = /^(?:\r?\n|[,|;])\s*/;

// A delimited multiSelect string can hide a delimiter INSIDE a label (e.g. an
// option literally named "Ship now, with a flag"). A naive split would shred that
// label and silently misreport what the human picked, which is an audit-integrity
// corruption in a governance product. So first try to read the whole string as a
// delimiter-joined run of offered labels, longest-label-first; return null (so the
// caller naive-splits) only when the string is NOT fully explained by offered
// labels. This also subsumes the whole-string-is-one-label case.
function matchOfferedLabelSequence(raw: string, choices: CanonicalChoice[]): string[] | null {
  const labels = choices
    .map((c) => c.label)
    .filter((l) => l.length > 0)
    .sort((a, b) => b.length - a.length);
  if (labels.length === 0) return null;

  const found: string[] = [];
  let rest = raw.trim();
  while (rest.length > 0) {
    const label = labels.find(
      (l) => rest === l || (rest.startsWith(l) && LEADING_DELIM.test(rest.slice(l.length))),
    );
    if (label === undefined) return null; // not a clean label run; caller naive-splits
    found.push(label);
    rest = rest.slice(label.length).replace(LEADING_DELIM, "").trim();
  }
  return found.length > 0 ? found : null;
}

// Coerce a raw multiSelect answer into an array of label strings, tolerating
// either a real array (preferred) or a delimited string.
function toMultiValues(raw: unknown, choices: CanonicalChoice[]): string[] {
  if (Array.isArray(raw)) return raw.map((x) => String(x));
  if (typeof raw !== "string") return raw == null ? [] : [String(raw)];
  // Prefer an exact decomposition into offered labels (handles a label that itself
  // contains a delimiter); only naive-split when that fails.
  const asLabels = matchOfferedLabelSequence(raw, choices);
  if (asLabels) return asLabels;
  return raw
    .split(MULTI_DELIMITERS)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function buildAnswer(question: ClaudeQuestion, rawAnswer: unknown, choices: CanonicalChoice[]): CanonicalAnswer {
  const multiSelect = question.multiSelect === true;

  if (multiSelect) {
    const values = toMultiValues(rawAnswer, choices);
    const matchedIds: string[] = [];
    let anyMatch = false;
    let anyAmbiguous = false;
    for (const v of values) {
      const m = matchLabel(v, choices);
      if (m.status === "no_match") continue;
      anyMatch = true;
      if (m.status === "exact_ambiguous") anyAmbiguous = true;
      if (m.choiceId) matchedIds.push(m.choiceId);
    }
    const status = !anyMatch ? "no_match" : anyAmbiguous ? "exact_ambiguous" : "exact_unique";
    const answer: CanonicalAnswer = {
      type: "multi_choice_labels",
      value: values,
      choiceMatchStatus: status,
      raw: rawAnswer as CanonicalAnswer["raw"],
    };
    if (matchedIds.length > 0) answer.choiceIds = matchedIds;
    return answer;
  }

  // Single-select. Claude returns the chosen option label, OR free text the user
  // typed for "Other". Match by exact label.
  const value = typeof rawAnswer === "string" ? rawAnswer : String(rawAnswer ?? "");
  const m = matchLabel(value, choices);
  if (m.status === "no_match") {
    return { type: "free_text", value, choiceMatchStatus: "no_match", raw: rawAnswer as CanonicalAnswer["raw"] };
  }
  // Known, unfixable limitation (spec section 6): if the user typed "Other" text
  // that exactly equals an offered label, this records it as a selection. Claude
  // does not label answer origin, so the adapter cannot tell them apart.
  return {
    type: "choice_label",
    value,
    choiceId: m.choiceId,
    choiceMatchStatus: m.status,
    raw: rawAnswer as CanonicalAnswer["raw"],
  };
}

function deriveDecisionKind(question: ClaudeQuestion, answer: CanonicalAnswer): DecisionKind {
  if (question.multiSelect === true) return "multi_choice";
  if (answer.type === "free_text") return "free_text";
  return "choice";
}

// Decompose one AskUserQuestion call into N canonical decisions, one per question.
// Questions with no entry in the answers map are skipped: a question that was not
// answered is not a captured human decision.
export function normalizeClaudeAskUserQuestion(
  raw: ClaudeAskRaw,
  ctx: ClaudeNormalizeContext,
): CanonicalDecisionPayload[] {
  const out: CanonicalDecisionPayload[] = [];
  const questions = Array.isArray(raw.questions) ? raw.questions : [];

  questions.forEach((question, i) => {
    const key = question.question;
    if (typeof key !== "string") return;
    if (!(key in (raw.answers ?? {}))) return; // unanswered -> not a decision
    const rawAnswer = raw.answers[key];

    const choices = toChoices(question.options);
    const answer = buildAnswer(question, rawAnswer, choices);
    const decisionKind = deriveDecisionKind(question, answer);

    const payload: CanonicalDecisionPayload = {
      provider: CLAUDE_PROVIDER,
      providerSource: CLAUDE_PROVIDER_SOURCE,
      providerToolName: CLAUDE_TOOL_NAME,
      providerEventId: buildClaudeProviderEventId(raw.toolUseId, i),
      providerSessionId: ctx.providerSessionId,
      decisionKind,
      prompt: {
        title: typeof question.header === "string" && question.header.trim().length > 0 ? question.header : key,
        body: key,
      },
      choices,
      answer,
      multiSelect: question.multiSelect === true,
      turnIndex: ctx.turnIndex ?? null,
      traceId: ctx.traceId ?? null,
      capturedBy: ctx.capturedBy,
      actorDisplayName: ctx.actorDisplayName ?? null,
      // Audit: preserve exactly what the provider gave us for this question.
      rawProviderPayload: { question, answer: rawAnswer },
    };
    if (ctx.occurredAt !== undefined) payload.occurredAt = ctx.occurredAt;
    out.push(payload);
  });

  return out;
}
