// src/lib/agent-decision/validate.ts
//
// Hand-rolled structural validator for the canonical agent-decision contract.
//
// Deviation noted (spec build-order item 1 suggested "TypeScript / Zod"): the mla
// CLI deliberately keeps a minimal dependency surface and ships NO Zod. This
// validator is the contract's teeth instead: it enforces every field rule and the
// cross-field invariants (INV-CHOICE-ID, decisionKind/multiSelect coherence,
// free_text/no_match coupling) that the spec spells out in sections 6 and 7. It
// returns a flat list of human-readable error strings; empty means valid.
//
// It is used by the contract tests and, fail-soft, at capture time so a malformed
// decision is logged and skipped rather than crashing the hook it rides on.

import type {
  AnswerType,
  CanonicalAnswer,
  CanonicalChoice,
  CanonicalDecisionPayload,
  ChoiceMatchStatus,
  DecisionKind,
} from "./types";

const DECISION_KINDS: readonly DecisionKind[] = ["choice", "multi_choice", "free_text"];
const ANSWER_TYPES: readonly AnswerType[] = ["choice_label", "multi_choice_labels", "free_text"];
const MATCH_STATUSES: readonly ChoiceMatchStatus[] = ["exact_unique", "exact_ambiguous", "no_match"];
const CAPTURED_BY = ["post_tool_use", "stop_transcript_scan"] as const;

const CHOICE_ID_RE = /^choice_\d+$/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function validatePrompt(prompt: unknown, errs: string[]): void {
  if (!isPlainObject(prompt)) {
    errs.push("prompt: must be an object {title, body}");
    return;
  }
  if (typeof prompt.title !== "string") errs.push("prompt.title: must be a string");
  if (typeof prompt.body !== "string") errs.push("prompt.body: must be a string");
}

function validateChoices(choices: unknown, errs: string[]): Set<string> {
  const ids = new Set<string>();
  if (!Array.isArray(choices)) {
    errs.push("choices: must be an array");
    return ids;
  }
  choices.forEach((c, i) => {
    if (!isPlainObject(c)) {
      errs.push(`choices[${i}]: must be an object {id,label,description?}`);
      return;
    }
    // INV-CHOICE-ID: positional, collision-safe, never a slug.
    if (typeof c.id !== "string" || !CHOICE_ID_RE.test(c.id)) {
      errs.push(`choices[${i}].id: must match choice_<index>, got ${JSON.stringify(c.id)}`);
    } else {
      if (ids.has(c.id)) errs.push(`choices[${i}].id: duplicate id ${c.id}`);
      ids.add(c.id);
    }
    if (typeof c.label !== "string") errs.push(`choices[${i}].label: must be a string`);
    if (c.description !== undefined && typeof c.description !== "string") {
      errs.push(`choices[${i}].description: must be a string when present`);
    }
  });
  return ids;
}

function validateAnswer(answer: unknown, choiceIds: Set<string>, errs: string[]): void {
  if (!isPlainObject(answer)) {
    errs.push("answer: must be an object");
    return;
  }
  const a = answer as Partial<CanonicalAnswer> & Record<string, unknown>;

  if (typeof a.type !== "string" || !ANSWER_TYPES.includes(a.type as AnswerType)) {
    errs.push(`answer.type: must be one of ${ANSWER_TYPES.join(", ")}`);
  }
  if (typeof a.choiceMatchStatus !== "string" || !MATCH_STATUSES.includes(a.choiceMatchStatus as ChoiceMatchStatus)) {
    errs.push(`answer.choiceMatchStatus: must be one of ${MATCH_STATUSES.join(", ")}`);
  }
  if (!("raw" in a)) {
    errs.push("answer.raw: must be present (INV-RAW-PRESERVATION applies to the raw answer too)");
  }

  // value shape depends on type.
  if (a.type === "multi_choice_labels") {
    if (!Array.isArray(a.value) || !a.value.every((x) => typeof x === "string")) {
      errs.push("answer.value: must be a string[] when type is multi_choice_labels");
    }
  } else if (a.type === "choice_label" || a.type === "free_text") {
    if (typeof a.value !== "string") {
      errs.push(`answer.value: must be a string when type is ${a.type}`);
    }
  }

  // choiceId presence/format rules (single-select).
  if (a.choiceId !== undefined) {
    if (typeof a.choiceId !== "string" || !CHOICE_ID_RE.test(a.choiceId)) {
      errs.push(`answer.choiceId: must match choice_<index>, got ${JSON.stringify(a.choiceId)}`);
    } else if (!choiceIds.has(a.choiceId)) {
      errs.push(`answer.choiceId: ${a.choiceId} is not one of the offered choices`);
    }
  }
  if (a.choiceIds !== undefined) {
    if (!Array.isArray(a.choiceIds) || !a.choiceIds.every((x) => typeof x === "string" && CHOICE_ID_RE.test(x))) {
      errs.push("answer.choiceIds: must be an array of choice_<index> ids when present");
    } else {
      for (const cid of a.choiceIds) {
        if (!choiceIds.has(cid)) errs.push(`answer.choiceIds: ${cid} is not one of the offered choices`);
      }
    }
  }

  // Cross-field coupling (spec section 6, derivation refined for multi-select).
  // no_match is incompatible only with a singular choice_label claim. A single
  // free_text answer carries it, and a multi_choice answer where no provided
  // value matched an offered label may carry it too.
  if (a.choiceMatchStatus === "no_match" && a.choiceId !== undefined) {
    errs.push("answer: no_match must not carry a choiceId");
  }
  if (a.type === "choice_label") {
    if (a.choiceMatchStatus === "no_match") {
      errs.push("answer: choice_label cannot have choiceMatchStatus no_match");
    }
    if (a.choiceId === undefined) {
      errs.push("answer: choice_label requires a choiceId");
    }
    if (a.choiceIds !== undefined) {
      errs.push("answer: choice_label is single-select; use choiceId, not choiceIds");
    }
  }
  if (a.type === "free_text") {
    if (a.choiceMatchStatus !== "no_match") {
      errs.push("answer: free_text requires choiceMatchStatus no_match");
    }
    if (a.choiceId !== undefined) errs.push("answer: free_text must not carry a choiceId");
    if (a.choiceIds !== undefined) errs.push("answer: free_text must not carry choiceIds");
  }
  if (a.type === "multi_choice_labels" && a.choiceId !== undefined) {
    errs.push("answer: multi_choice_labels is multi-select; use choiceIds, not a singular choiceId");
  }
}

// Returns a flat list of validation errors; empty array means the payload
// satisfies the canonical contract.
export function validateCanonicalDecisionPayload(payload: unknown): string[] {
  const errs: string[] = [];
  if (!isPlainObject(payload)) {
    return ["payload: must be an object"];
  }
  const p = payload as Partial<CanonicalDecisionPayload> & Record<string, unknown>;

  if (!isNonEmptyString(p.provider)) errs.push("provider: must be a non-empty string");
  if (!isNonEmptyString(p.providerSource)) errs.push("providerSource: must be a non-empty string");
  if (!isNonEmptyString(p.providerEventId)) errs.push("providerEventId: must be a non-empty string");
  if (p.providerToolName !== undefined && p.providerToolName !== null && typeof p.providerToolName !== "string") {
    errs.push("providerToolName: must be a string, null, or omitted");
  }
  if (p.providerSessionId !== undefined && p.providerSessionId !== null && typeof p.providerSessionId !== "string") {
    errs.push("providerSessionId: must be a string, null, or omitted");
  }

  if (typeof p.decisionKind !== "string" || !DECISION_KINDS.includes(p.decisionKind as DecisionKind)) {
    errs.push(`decisionKind: must be one of ${DECISION_KINDS.join(", ")}`);
  }

  validatePrompt(p.prompt, errs);
  const choiceIds = validateChoices(p.choices, errs);
  validateAnswer(p.answer, choiceIds, errs);

  // decisionKind is derived from multiSelect + match outcome (spec section 6);
  // enforce the coupling so the three fields can never drift.
  const ansType = isPlainObject(p.answer) ? (p.answer as { type?: unknown }).type : undefined;
  if (p.decisionKind === "multi_choice" && ansType !== "multi_choice_labels") {
    errs.push("answer.type: must be multi_choice_labels when decisionKind is multi_choice");
  }
  if (p.decisionKind === "choice" && ansType !== "choice_label") {
    errs.push("answer.type: must be choice_label when decisionKind is choice");
  }
  if (p.decisionKind === "free_text" && ansType !== "free_text") {
    errs.push("answer.type: must be free_text when decisionKind is free_text");
  }

  if (typeof p.multiSelect !== "boolean") {
    errs.push("multiSelect: must be a boolean");
  } else {
    // Biconditional per spec section 6: multiSelect true iff decisionKind multi_choice.
    if (p.multiSelect && p.decisionKind !== "multi_choice") {
      errs.push("decisionKind: must be multi_choice when multiSelect is true");
    }
    if (!p.multiSelect && p.decisionKind === "multi_choice") {
      errs.push("multiSelect: must be true when decisionKind is multi_choice");
    }
  }

  if (typeof p.capturedBy !== "string" || !CAPTURED_BY.includes(p.capturedBy as (typeof CAPTURED_BY)[number])) {
    errs.push(`capturedBy: must be one of ${CAPTURED_BY.join(", ")}`);
  }

  if (p.turnIndex !== undefined && p.turnIndex !== null && typeof p.turnIndex !== "number") {
    errs.push("turnIndex: must be a number, null, or omitted");
  }
  if (p.traceId !== undefined && p.traceId !== null && typeof p.traceId !== "string") {
    errs.push("traceId: must be a string, null, or omitted");
  }
  if (p.actorDisplayName !== undefined && p.actorDisplayName !== null && typeof p.actorDisplayName !== "string") {
    errs.push("actorDisplayName: must be a string, null, or omitted");
  }
  if (!("rawProviderPayload" in p)) {
    errs.push("rawProviderPayload: must be present (INV-RAW-PRESERVATION)");
  }
  if (p.occurredAt !== undefined && typeof p.occurredAt !== "string") {
    errs.push("occurredAt: must be an ISO string when present");
  }

  return errs;
}

export function isValidCanonicalDecisionPayload(payload: unknown): payload is CanonicalDecisionPayload {
  return validateCanonicalDecisionPayload(payload).length === 0;
}
