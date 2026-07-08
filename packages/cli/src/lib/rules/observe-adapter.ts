import {
  EvaluationResult,
  selectRule,
  SelectionResult,
  ToolCall,
  verdictForForbiddenRoot,
} from "./evaluator";
import { classifyTargetPath, NotesPathScope } from "./notes-path";
import { PathClassification, RuleApplicability } from "./types";

// R0 observe-only PreToolUse adapter. It bridges the real Claude Code hook input
// to the pure selector + four-state evaluator and the notes-path classifier.
//
// Hard guarantees of this slice (verified by the spec):
//   - It NEVER emits a permissionDecision. Observation mode omits it entirely;
//     every branch returns an empty response so Claude Code falls through to its
//     normal permission flow. Deny is a deliberately deferred later slice.
//   - It performs NO network calls. The only outbound work is the local-filesystem
//     classifier, which it calls directly (and which tests replace by injection).
//   - It NEVER turns an infrastructure problem into a rule violation. Malformed
//     input, an unsupported payload, a timeout, or an evaluator failure all surface
//     as an INFRA observation, not a VIOLATION.
//   - The evaluation is bounded by a hard timeout (production default 500ms).

/** The real PreToolUse hook input shape (snake_case, as delivered on stdin). */
export interface PreToolUseInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_use_id?: string;
  permission_mode?: string;
}

/**
 * What the adapter observed about a single tool call. This is telemetry for the
 * (future) persistence seam, never an enforcement signal in R0.
 *   - NOT_APPLICABLE: no rule selected this call.
 *   - OBSERVED: a rule applied and produced a four-state verdict.
 *   - INFRA: an infrastructure problem prevented evaluation; explicitly NOT a
 *     rule violation. Carries a human-readable diagnostic.
 */
export type ObservationOutcome =
  | { kind: "NOT_APPLICABLE" }
  | { kind: "OBSERVED"; result: EvaluationResult["result"]; reasonCode: EvaluationResult["reasonCode"] }
  | { kind: "INFRA"; diagnostic: string };

/**
 * The observe-mode hook response. It is intentionally empty: an object with no
 * keys, and in particular no permissionDecision. This is the seam where a later
 * slice may add a decision; in R0 it is provably empty.
 */
export type ObserveHookResponse = Record<string, never>;

export interface ObserveResult {
  response: ObserveHookResponse;
  observation: ObservationOutcome;
}

export interface ObserveAdapterConfig {
  applicability: RuleApplicability;
  notesScope: NotesPathScope;
  /**
   * Injectable path classifier. Defaults to the local-filesystem notes-path
   * matcher. Tests replace it to drive each branch deterministically; production
   * uses the default, which performs no network I/O.
   */
  classify?: (rawFilePath: unknown, scope: NotesPathScope) => Promise<PathClassification>;
  /** Hard evaluation timeout in milliseconds. Production default is 500ms. */
  timeoutMs?: number;
}

/** Production default for the hard evaluation timeout. */
export const OBSERVE_TIMEOUT_MS = 500;

class TimeoutError extends Error {}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Parse and minimally validate the raw hook payload. Accepts either an already
 * parsed object or the raw JSON string delivered on stdin. Returns null for any
 * shape that is not a usable PreToolUse call; the adapter maps that null to an
 * INFRA observation, never a violation.
 */
export function parsePreToolUseInput(raw: unknown): PreToolUseInput | null {
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
  const toolName = obj.tool_name;
  if (typeof toolName !== "string" || toolName.length === 0) {
    return null;
  }
  const toolInput = obj.tool_input;
  if (!isPlainObject(toolInput)) {
    return null;
  }
  const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
  return {
    session_id: str(obj.session_id),
    transcript_path: str(obj.transcript_path),
    cwd: str(obj.cwd),
    hook_event_name: str(obj.hook_event_name),
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: str(obj.tool_use_id),
    permission_mode: str(obj.permission_mode),
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError("evaluation timed out")), ms);
    if (typeof timer.unref === "function") {
      timer.unref();
    }
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Observe a single PreToolUse call. Pure of enforcement: it computes what it
 * observed and always returns an empty (decision-free) hook response.
 */
export async function observePreToolUse(
  rawInput: unknown,
  config: ObserveAdapterConfig,
): Promise<ObserveResult> {
  const NO_DECISION: ObserveHookResponse = {};

  const parsed = parsePreToolUseInput(rawInput);
  if (!parsed) {
    return { response: NO_DECISION, observation: { kind: "INFRA", diagnostic: "malformed hook input" } };
  }

  const call: ToolCall = { toolName: parsed.tool_name, toolInput: parsed.tool_input };

  let selection: SelectionResult;
  try {
    selection = selectRule(call, config.applicability);
  } catch (err) {
    return {
      response: NO_DECISION,
      observation: { kind: "INFRA", diagnostic: `selector failure: ${describeError(err)}` },
    };
  }

  // Only an action rule that selected this call can be evaluated. Ambient rules
  // (and any non-match) are never action gates, so there is nothing to observe.
  if (selection === "NOT_APPLICABLE" || config.applicability.mode !== "action") {
    return { response: NO_DECISION, observation: { kind: "NOT_APPLICABLE" } };
  }

  const rawFilePath = parsed.tool_input[config.applicability.matcher.field];
  const classify = config.classify ?? classifyTargetPath;
  const timeoutMs = config.timeoutMs ?? OBSERVE_TIMEOUT_MS;

  let classification: PathClassification;
  try {
    classification = await withTimeout(classify(rawFilePath, config.notesScope), timeoutMs);
  } catch (err) {
    const diagnostic =
      err instanceof TimeoutError ? "evaluation timed out" : `evaluator failure: ${describeError(err)}`;
    return { response: NO_DECISION, observation: { kind: "INFRA", diagnostic } };
  }

  const verdict = verdictForForbiddenRoot(classification);
  return {
    response: NO_DECISION,
    observation: { kind: "OBSERVED", result: verdict.result, reasonCode: verdict.reasonCode },
  };
}
