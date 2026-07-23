// Codex request_user_input -> provider-neutral agent-human decision payloads.
//
// Codex exposes a stable tool call id and question ids. Answers are keyed by
// question id in the response. The PostToolUse response may arrive as either a
// JSON object or a JSON-encoded string, so this adapter accepts both without
// consulting Codex's unstable transcript format.

import type {
  CanonicalAnswer,
  CanonicalChoice,
  CanonicalDecisionPayload,
  CapturedBy,
} from "./types";

export const CODEX_PROVIDER = "codex";
export const CODEX_PROVIDER_SOURCE = "codex_hook";
export const CODEX_REQUEST_USER_INPUT_TOOL = "request_user_input";

interface CodexOption {
  label?: unknown;
  description?: unknown;
}

interface CodexQuestion {
  id?: unknown;
  header?: unknown;
  question?: unknown;
  options?: unknown;
}

export interface CodexRequestUserInputRaw {
  toolUseId: string;
  questions: CodexQuestion[];
  answers: Record<string, unknown>;
}

export interface CodexNormalizeContext {
  providerSessionId: string;
  capturedBy: CapturedBy;
  turnIndex?: number | null;
  traceId?: string | null;
  occurredAt?: string;
  actorDisplayName?: string | null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function choicesFor(raw: unknown): CanonicalChoice[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((option: CodexOption, index) => {
    const choice: CanonicalChoice = {
      id: `choice_${index}`,
      label: typeof option?.label === "string" ? option.label : "",
    };
    if (typeof option?.description === "string") choice.description = option.description;
    return choice;
  });
}

function answerValue(raw: unknown): unknown {
  if (!isPlainObject(raw)) return raw;
  if ("answer" in raw) return raw.answer;
  if ("value" in raw) return raw.value;
  return raw;
}

function canonicalAnswer(raw: unknown, choices: CanonicalChoice[]): CanonicalAnswer {
  const unwrapped = answerValue(raw);
  const value = typeof unwrapped === "string" ? unwrapped : String(unwrapped ?? "");
  const matches = choices.filter((choice) => choice.label === value);
  if (matches.length === 0) {
    return { type: "free_text", value, choiceMatchStatus: "no_match", raw };
  }
  return {
    type: "choice_label",
    value,
    choiceId: matches[0].id,
    choiceMatchStatus: matches.length === 1 ? "exact_unique" : "exact_ambiguous",
    raw,
  };
}

export function normalizeCodexRequestUserInput(
  raw: CodexRequestUserInputRaw,
  ctx: CodexNormalizeContext,
): CanonicalDecisionPayload[] {
  const out: CanonicalDecisionPayload[] = [];
  raw.questions.forEach((question, index) => {
    const body = typeof question.question === "string" ? question.question : "";
    if (body.length === 0) return;
    const id = typeof question.id === "string" && question.id.length > 0 ? question.id : body;
    const answerKey = id in raw.answers ? id : body;
    if (!(answerKey in raw.answers)) return;

    const rawAnswer = raw.answers[answerKey];
    const choices = choicesFor(question.options);
    const answer = canonicalAnswer(rawAnswer, choices);
    const payload: CanonicalDecisionPayload = {
      provider: CODEX_PROVIDER,
      providerSource: CODEX_PROVIDER_SOURCE,
      providerToolName: CODEX_REQUEST_USER_INPUT_TOOL,
      providerEventId: `${raw.toolUseId}#${index}`,
      providerSessionId: ctx.providerSessionId,
      decisionKind: answer.type === "free_text" ? "free_text" : "choice",
      prompt: {
        title:
          typeof question.header === "string" && question.header.trim().length > 0
            ? question.header
            : body,
        body,
      },
      choices,
      answer,
      multiSelect: false,
      turnIndex: ctx.turnIndex ?? null,
      traceId: ctx.traceId ?? null,
      capturedBy: ctx.capturedBy,
      actorDisplayName: ctx.actorDisplayName ?? null,
      rawProviderPayload: { question, answer: rawAnswer },
    };
    if (ctx.occurredAt !== undefined) payload.occurredAt = ctx.occurredAt;
    out.push(payload);
  });
  return out;
}

export function codexAnswersFromToolResponse(value: unknown): Record<string, unknown> | null {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!isPlainObject(parsed) || !isPlainObject(parsed.answers)) return null;
  return parsed.answers;
}
