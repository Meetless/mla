import { randomUUID } from "crypto";

import { type ConsultEvidenceRuleBinding } from "./consult-evidence-binding";
import {
  openTurnAtomically,
  type Ce0Store,
  type TurnMemoryAssessmentDraft,
} from "./ce0-store";
import { sha256Hex } from "./canonical-json";
import { classifyMemoryRequirement, type MemoryRequirement } from "./memory-requirement";
import { buildRequiredSubjectFromPrompt } from "./requirement-subject";

// Commit 6c: the CE0 UserPromptSubmit adapter, the obligation-creation seam
// (notes/20260617-evidence-consultation-forcing-function-proposal.md §1.3, req 1).
//
// This is NOT a second obligation framework. The canonical Rules primitive (types.ts /
// applicability.ts, commit 7cdbee1a) models PreToolUse ACTION gates and its "turn" mode
// is explicitly inert there; the turn-scoped obligation therefore lives as the
// TurnRuleObligation record, created HERE and stamped with the consult-evidence rule
// identity the CALLER resolved (config.ruleBinding): the LIVE attested version when the
// rule is armed in this runtime scope, the frozen compile-time identity when unarmed. The
// adapter never reads ce0-rule's constants directly, so arming a version binds with no
// change to this file (GAP 3 slice 3).
//
// It mirrors the observe-only PreToolUse adapter's discipline, with one difference: this
// adapter is SYNCHRONOUS. It does no network or filesystem work (the classifier and the
// extractor are pure; the store is synchronous better-sqlite3), so there is no timeout
// and no async surface. Its guarantees:
//   - It NEVER injects. The hook response is the empty object on EVERY branch, even when
//     it creates an obligation. The CE0/CE1 response ceiling is RECORD_ONLY: observe and
//     record, never steer, ask, or deny. additionalContext injection is a CE2 concern
//     that demands a new immutable rule version.
//   - It NEVER turns an infrastructure problem into anything else. Malformed input, a
//     missing session coordinate, or a persistence failure surface as INFRA with a
//     diagnostic, never a thrown error.
//   - It records a TurnMemoryAssessment for EVERY well-formed turn (memory_requirement
//     telemetry is per-turn) but creates a TurnRuleObligation ONLY for a REQUIRED turn.

/** The real UserPromptSubmit hook input shape (snake_case, as delivered on stdin). */
export interface UserPromptSubmitInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  prompt: string;
}

/** The hook response. Intentionally empty: no additionalContext, no decision. This is
 * the seam a later (CE2) slice may fill; in CE0 it is provably empty. */
export type PromptSubmitHookResponse = Record<string, never>;

/**
 * What the adapter did with a single user turn.
 *   - ASSESSED: the turn was classified and its assessment persisted. `obligationId` is
 *     the created obligation's id on a REQUIRED turn, or null on NOT_REQUIRED / UNKNOWN.
 *   - INFRA: an infrastructure problem prevented assessment; explicitly not a verdict.
 */
export type PromptSubmitOutcome =
  | {
      kind: "ASSESSED";
      requirement: MemoryRequirement;
      assessmentId: string;
      localTurnSequence: number;
      obligationId: string | null;
    }
  | { kind: "INFRA"; diagnostic: string };

export interface PromptSubmitResult {
  response: PromptSubmitHookResponse;
  outcome: PromptSubmitOutcome;
}

export interface PromptSubmitAdapterConfig {
  store: Ce0Store;
  /** The hook input carries no workspace, so the caller supplies the logged-in one. */
  workspaceId: string;
  /** The resolved consult-evidence obligation identity triple {ruleId, ruleVersionId,
   *  canonicalPayloadHash} the entrypoint resolved for the active runtime scope (live attested version
   *  when armed, the frozen compile-time identity when unarmed). The adapter stamps every obligation from
   *  THIS, never from a compile-time constant, so an attested version binds without touching this file. */
  ruleBinding: ConsultEvidenceRuleBinding;
  /** Injectable clock for the assessment's createdAt. Production default: Date.now. */
  now?: () => number;
  /** Injectable id minter. Production default: a prefixed UUID per kind. */
  newId?: (kind: "assessment" | "obligation") => string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function defaultNewId(kind: "assessment" | "obligation"): string {
  return `${kind === "assessment" ? "asm" : "obl"}:${randomUUID()}`;
}

/**
 * Parse and minimally validate the raw hook payload. Accepts either an already parsed
 * object or the raw JSON string delivered on stdin. Returns null for any shape that is
 * not a usable UserPromptSubmit turn (the adapter maps that null to INFRA). A turn is
 * usable iff it carries a non-empty string `prompt`; the session coordinate is checked
 * separately so its absence gets a distinct diagnostic.
 */
export function parseUserPromptSubmitInput(raw: unknown): UserPromptSubmitInput | null {
  let obj: unknown = raw;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!isPlainObject(obj)) {
    return null;
  }
  const prompt = obj.prompt;
  if (typeof prompt !== "string" || prompt.length === 0) {
    return null;
  }
  const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
  return {
    session_id: str(obj.session_id),
    transcript_path: str(obj.transcript_path),
    cwd: str(obj.cwd),
    hook_event_name: str(obj.hook_event_name),
    prompt,
  };
}

/**
 * Observe a single user turn: classify its memory requirement, mint its LocalTurnIdentity
 * and persist the assessment, and create a TurnRuleObligation iff the turn is REQUIRED.
 * Always returns an empty (injection-free) hook response.
 */
export function observeUserPromptSubmit(
  rawInput: unknown,
  config: PromptSubmitAdapterConfig,
): PromptSubmitResult {
  const NO_INJECTION: PromptSubmitHookResponse = {};

  const parsed = parseUserPromptSubmitInput(rawInput);
  if (!parsed) {
    return { response: NO_INJECTION, outcome: { kind: "INFRA", diagnostic: "malformed hook input" } };
  }
  if (!parsed.session_id) {
    return {
      response: NO_INJECTION,
      outcome: { kind: "INFRA", diagnostic: "missing session_id coordinate" },
    };
  }

  const now = config.now ?? Date.now;
  const newId = config.newId ?? defaultNewId;
  const classification = classifyMemoryRequirement(parsed.prompt);
  // Narrow the session coordinate once, past the guard above, so it stays `string` inside the
  // obligation builder closure (a property read on the mutable `parsed` would widen back to optional).
  const sessionId = parsed.session_id;

  try {
    const draft: TurnMemoryAssessmentDraft = {
      assessmentId: newId("assessment"),
      workspaceId: config.workspaceId,
      sessionId,
      requirement: classification.requirement,
      markersMatched: classification.markersMatched,
      exclusionsMatched: classification.exclusionsMatched,
      classifierVersion: classification.classifierVersion,
      markerSetVersion: classification.markerSetVersion,
      exclusionSetVersion: classification.exclusionSetVersion,
      createdAt: now(),
      // R4 P0.1 recall snapshot (proposal lines 287-295): the prompt's identity-only hash, born
      // here at classification. Content-free: the raw prompt is never duplicated into the record.
      promptHash: sha256Hex(parsed.prompt),
    };

    // Open the turn ATOMICALLY: the assessment and (for a REQUIRED turn) its obligation are written in
    // one BEGIN IMMEDIATE transaction, so a persistence failure can never leave a REQUIRED assessment
    // without the obligation that grades it (proposal §1.3 req 1, R4 P0.4). The obligation is built
    // INSIDE the transaction from the freshly minted assessment so it carries the same localTurnSequence;
    // a non-REQUIRED turn returns null and records only its assessment.
    const { assessment, obligation } = openTurnAtomically(config.store, draft, (a) =>
      classification.requirement !== "REQUIRED"
        ? null
        : {
            obligationId: newId("obligation"),
            workspaceId: config.workspaceId,
            sessionId,
            localTurnSequence: a.localTurnSequence,
            ruleId: config.ruleBinding.ruleId,
            ruleVersionId: config.ruleBinding.ruleVersionId,
            requiredSubjects: [buildRequiredSubjectFromPrompt(parsed.prompt)],
            subjectSatisfaction: [],
            status: "OPEN",
            stateVersion: 0,
            deadlineClaimedAt: null,
            deadlineClaimedVersion: null,
            responseHash: null,
            outcome: null,
            canonicalPayloadHash: config.ruleBinding.canonicalPayloadHash,
          },
    );

    return {
      response: NO_INJECTION,
      outcome: {
        kind: "ASSESSED",
        requirement: classification.requirement,
        assessmentId: assessment.assessmentId,
        localTurnSequence: assessment.localTurnSequence,
        obligationId: obligation ? obligation.obligationId : null,
      },
    };
  } catch (err) {
    return {
      response: NO_INJECTION,
      outcome: { kind: "INFRA", diagnostic: `persistence failure: ${describeError(err)}` },
    };
  }
}
