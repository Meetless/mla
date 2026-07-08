import { randomUUID } from "crypto";

import {
  appendConsultationAttempt,
  resolveLatestTurnIdentity,
  type Ce0Store,
  type ConsultationAttemptDraft,
} from "./ce0-store";
import {
  buildConsultationSubjectFromQuery,
  type ConsultationExecution,
  type ConsultationResult,
} from "./requirement-subject";

// Commit 7b: the CE0 PostToolUse capture adapter, the AGENT_PULL seam
// (notes/20260617-evidence-consultation-forcing-function-proposal.md §1.6). When the agent
// calls a governed-memory tool mid-turn, this records the FACT of that consultation as a
// ConsultationAttempt under the current turn's LocalTurnIdentity.
//
// It mirrors the prompt-submit adapter's discipline, and is likewise SYNCHRONOUS: the
// classifier, the extractor, and better-sqlite3 are all synchronous, so there is no
// timeout and no async surface. Its guarantees:
//   - It NEVER injects. The hook response is the empty object on EVERY branch. The CE0/CE1
//     response ceiling is RECORD_ONLY: a PostToolUse capture observes and records; it never
//     steers, asks, or denies. PROACTIVE_PUSH injection is a CE2 concern that demands a new
//     immutable rule version.
//   - It NEVER turns an infrastructure problem into a write or a throw. Malformed input, a
//     missing session coordinate, a missing query, no turn to anchor, and a persistence
//     failure all surface as INFRA with a diagnostic and an empty response, never an error.
//   - It records the FACT regardless of how the retrieval went. A FAILED or UNKNOWN
//     execution is still a recorded consultation; it simply never contributes a proof. The
//     satisfaction reducer, not this adapter, decides what counts.
//   - It does NOT run the matcher or advance any obligation. Coverage is recomputed
//     deterministically later (the first-Stop deadline claim, Commit 8); 7b only captures.
//
// CE0 has exactly one capture path today, AGENT_PULL, and that is what every consultation this
// adapter writes carries in its `source`. The column is persisted, not just reported on the
// outcome: the offline projector resolves a finalized obligation's `satisfiedBySources` from the
// stored source of each proving consultation, so the value has to survive on the row.
// STOP_RECOVERY_PULL and PROACTIVE_PUSH are held seams in the enum; CE0 (RECORD_ONLY) never
// writes them, but their ordering is fixed up front so the projector's sort is stable.

/** The three governed-memory PULL tools, as the canonical proposal §1.6 counts them. The
 * verdict write (relationship_verdict) is deliberately NOT here: it is a write, not a pull. */
export type ConsultationTool = "retrieve_knowledge" | "kb_doc_detail" | "query";

/** The real PostToolUse hook input shape (snake_case, as delivered on stdin). */
export interface PostToolUseInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_response?: unknown;
}

/** The hook response. Intentionally empty: PostToolUse cannot inject, and CE0 would not
 * anyway. This is provably empty on every branch. */
export type ConsultationCaptureHookResponse = Record<string, never>;

/**
 * What the adapter did with one PostToolUse event.
 *   - NOT_APPLICABLE: the tool was not a governed-memory pull; nothing recorded.
 *   - CAPTURED: a ConsultationAttempt fact was persisted under the turn's identity.
 *   - INFRA: an infrastructure problem prevented capture; explicitly not a verdict.
 */
export type ConsultationCaptureOutcome =
  | { kind: "NOT_APPLICABLE" }
  | {
      kind: "CAPTURED";
      consultationId: string;
      source: "AGENT_PULL";
      execution: ConsultationExecution;
      result: ConsultationResult | null;
      localTurnSequence: number;
      orderingToken: number;
    }
  | { kind: "INFRA"; diagnostic: string };

export interface ConsultationCaptureResult {
  response: ConsultationCaptureHookResponse;
  outcome: ConsultationCaptureOutcome;
}

export interface ConsultationCaptureConfig {
  store: Ce0Store;
  /** The hook input carries no workspace, so the caller supplies the logged-in one. */
  workspaceId: string;
  /** Injectable clock for the consultation's createdAt. Production default: Date.now. */
  now?: () => number;
  /** Injectable consultation-id minter. Production default: a prefixed UUID. */
  newId?: () => string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function defaultNewId(): string {
  return `con:${randomUUID()}`;
}

const CONSULTATION_TOOL_PATTERN = /(?:^|__)meetless__(retrieve_knowledge|kb_doc_detail|query)$/;

/**
 * Recognize the governed-memory pull surface from the real (double-prefixed) hook tool name,
 * e.g. `mcp__meetless__meetless__retrieve_knowledge`. Returns null for everything else,
 * including the verdict write and a same-named tool on a foreign server.
 */
export function classifyConsultationTool(toolName: string): ConsultationTool | null {
  const match = CONSULTATION_TOOL_PATTERN.exec(toolName);
  return match ? (match[1] as ConsultationTool) : null;
}

/** The subject text of a pull: the query for retrieve_knowledge / query, the document id
 * for kb_doc_detail. Null (a missing or blank field) makes the event uncapturable. */
function extractConsultationText(
  tool: ConsultationTool,
  toolInput: Record<string, unknown>,
): string | null {
  const field = tool === "kb_doc_detail" ? "document_id" : "query";
  const value = toolInput[field];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function extractResultPayload(response: Record<string, unknown>): Record<string, unknown> | null {
  const content = response.content;
  if (!Array.isArray(content) || content.length === 0) return null;
  const first = content[0];
  if (!isPlainObject(first) || typeof first.text !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(first.text);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** A clean empty governed result (count 0, or an empty candidates/results array) is a
 * NO_MATCH; any other parseable success carries a result. kb_doc_detail and ask answers
 * have no emptiness signal, so they read as RESULTS_RETURNED. */
function payloadCarriesResults(payload: Record<string, unknown>): boolean {
  if (typeof payload.count === "number") return payload.count > 0;
  if (Array.isArray(payload.candidates)) return payload.candidates.length > 0;
  if (Array.isArray(payload.results)) return payload.results.length > 0;
  return true;
}

/**
 * Classify the MCP CallToolResult envelope into the §1.6 execution / result pair. Only an
 * explicit handler error is FAILED; a valid parseable response is COMPLETE (with a result
 * subtype that is telemetry only and does not gate satisfaction); anything malformed,
 * missing, or uncorrelatable is UNKNOWN. result is present iff COMPLETE.
 */
export function classifyRetrievalEnvelope(toolResponse: unknown): {
  execution: ConsultationExecution;
  result?: ConsultationResult;
} {
  if (!isPlainObject(toolResponse)) {
    return { execution: "UNKNOWN" };
  }
  if (toolResponse.isError === true) {
    return { execution: "FAILED" };
  }
  const payload = extractResultPayload(toolResponse);
  if (payload === null) {
    return { execution: "UNKNOWN" };
  }
  return {
    execution: "COMPLETE",
    result: payloadCarriesResults(payload) ? "RESULTS_RETURNED" : "NO_MATCH",
  };
}

/**
 * Parse and minimally validate the raw PostToolUse payload. Accepts either an already
 * parsed object or the raw JSON string. Returns null for any shape that is not a usable
 * PostToolUse event (a non-empty string tool_name and an object tool_input); the adapter
 * maps that null to INFRA. The session coordinate is checked separately so its absence
 * gets a distinct diagnostic.
 */
export function parsePostToolUseInput(raw: unknown): PostToolUseInput | null {
  let obj: unknown = raw;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!isPlainObject(obj)) return null;
  const toolName = obj.tool_name;
  if (typeof toolName !== "string" || toolName.length === 0) return null;
  if (!isPlainObject(obj.tool_input)) return null;
  const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
  return {
    session_id: str(obj.session_id),
    transcript_path: str(obj.transcript_path),
    cwd: str(obj.cwd),
    hook_event_name: str(obj.hook_event_name),
    tool_name: toolName,
    tool_input: obj.tool_input,
    tool_response: obj.tool_response,
  };
}

/**
 * Capture one governed-memory consultation. Records a ConsultationAttempt fact under the
 * turn's LocalTurnIdentity and returns an empty (injection-free) hook response.
 */
export function captureMemoryConsultation(
  rawInput: unknown,
  config: ConsultationCaptureConfig,
): ConsultationCaptureResult {
  const NO_INJECTION: ConsultationCaptureHookResponse = {};

  const parsed = parsePostToolUseInput(rawInput);
  if (!parsed) {
    return { response: NO_INJECTION, outcome: { kind: "INFRA", diagnostic: "malformed hook input" } };
  }

  const tool = classifyConsultationTool(parsed.tool_name);
  if (!tool) {
    return { response: NO_INJECTION, outcome: { kind: "NOT_APPLICABLE" } };
  }

  if (!parsed.session_id) {
    return {
      response: NO_INJECTION,
      outcome: { kind: "INFRA", diagnostic: "missing session_id coordinate" },
    };
  }

  const queryText = extractConsultationText(tool, parsed.tool_input);
  if (queryText === null) {
    return {
      response: NO_INJECTION,
      outcome: { kind: "INFRA", diagnostic: "missing consultation query" },
    };
  }

  const identity = resolveLatestTurnIdentity(config.store, {
    workspaceId: config.workspaceId,
    sessionId: parsed.session_id,
  });
  if (!identity) {
    return {
      response: NO_INJECTION,
      outcome: { kind: "INFRA", diagnostic: "no turn identity for session" },
    };
  }

  const now = config.now ?? Date.now;
  const newId = config.newId ?? defaultNewId;
  const envelope = classifyRetrievalEnvelope(parsed.tool_response);

  try {
    const draft: ConsultationAttemptDraft = {
      consultationId: newId(),
      workspaceId: config.workspaceId,
      sessionId: parsed.session_id,
      localTurnSequence: identity.localTurnSequence,
      source: "AGENT_PULL",
      consultationSubjects: [buildConsultationSubjectFromQuery(queryText)],
      execution: envelope.execution,
      result: envelope.result ?? null,
      deliveredToAnsweringContext: true,
      createdAt: now(),
    };
    const rec = appendConsultationAttempt(config.store, draft);
    return {
      response: NO_INJECTION,
      outcome: {
        kind: "CAPTURED",
        consultationId: rec.consultationId,
        source: "AGENT_PULL",
        execution: rec.execution,
        result: rec.result,
        localTurnSequence: rec.localTurnSequence,
        orderingToken: rec.orderingToken,
      },
    };
  } catch (err) {
    return {
      response: NO_INJECTION,
      outcome: { kind: "INFRA", diagnostic: `persistence failure: ${describeError(err)}` },
    };
  }
}
