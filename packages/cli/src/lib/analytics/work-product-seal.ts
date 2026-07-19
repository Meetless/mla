// Seal-on-window-close glue for the Evidence material-incorporation correlator
// (notes/20260716-evidence-material-incorporation-correlator.md §8, §10.6, §12.1).
//
// The correlator closes an inject's deterministic window (deriveOutcome, unchanged v3
// floor). At that same moment, for an inject that closed in `all_decided` (referenced OR
// ignored) and is capture-capable + live-consented, the CLI seals its work-product window
// and makes ONE atomic capture-intake POST. This module is the pure bridge between the
// local capture store (§5 digest builder) and that POST:
//
//   buildSealBody   -- pure: window captures + per-turn user prompts -> the exact POST body
//                      (status sealed with the §5 digest, or status failed with no digest).
//   buildPromptsBySession -- index ask-traces lines to (session -> turn -> prompts[]).
//   postWorkProductCapture -- the thin HTTP wrapper (control recomputes the hash, §10.6).
//
// WHY A POST BODY, NOT THE HASH. Per §10.6 the CLI never sends a trusted input_digest_hash:
// it POSTs the sealed, canonically-ordered digest (as a JSON string, sidestepping the
// ValidationPipe implicit-conversion coercion control's DTO documents) plus sealed_at, and
// control recomputes the hash inside its intake transaction. Idempotency and 200/409/failed
// resolution are entirely control's (durable-seal-first), so this module makes exactly one
// best-effort call and never retries.

import { CliConfig } from "../config";
import { post } from "../http";
import {
  CaptureRecord,
  DigestTurnInput,
  WorkProductDigest,
  assembleTurnCaptures,
  buildWorkProductDigest,
} from "./work-product-capture";

// The §10.6 atomic capture-intake route. The CLI authenticates with the same bearer +
// X-Trace-ID the analytics forwarder uses; the analytics guard stack fences workspaceId.
export const WORK_PRODUCT_CAPTURE_PATH =
  "/internal/v1/evidence/work-product-capture";

// Same 3s budget the analytics forward uses: the seal rides off the session's hot path
// (the correlator is spawned detached from Stop), so a slow control never stalls a user.
const CAPTURE_POST_TIMEOUT_MS = 3000;

// The two seal statuses, mirrored from control's materiality-contract (CAPTURE_STATUS_*).
// Defined locally because control is a separate package the CLI does not import.
export const SEAL_STATUS_SEALED = "sealed";
export const SEAL_STATUS_FAILED = "failed";

// The POST body: the WorkProductCaptureDto shape (camelCase to match the DTO). The digest
// rides as a JSON STRING under workProductDigest, present iff status === sealed; a failed
// seal carries NO digest (seal event only, §6.4/§10.6 step 4).
export interface WorkProductCaptureBody {
  workspaceId: string;
  injectId: string;
  captureContractVersion: number;
  status: typeof SEAL_STATUS_SEALED | typeof SEAL_STATUS_FAILED;
  capturedTurnStart: number;
  capturedTurnEnd: number;
  truncated: boolean;
  redactedSubstance: boolean;
  workProductDigest?: string;
}

// The minimal inject view the seal needs, resolved from the closed inject event.
export interface SealEligibleInject {
  injectId: string;
  workspaceId: string;
  sessionId: string;
  turnIndex: number;
}

export interface BuildSealBodyArgs {
  inject: SealEligibleInject;
  // ALL staged captures for the inject's session (readCaptures); filtered to the window here.
  captures: CaptureRecord[];
  // Every direct user prompt for the inject's session, keyed by turn (buildPromptsBySession).
  promptsByTurn: Map<number, string[]>;
  // The effective correlation window (WINDOW_TURNS, or the correlator's test override).
  window: number;
  // The inject's EMIT-TIME work_product_capture_version: the contract the capture was made
  // under, so cohort(g) pins the seal to the generation that emitted the inject (§9.1).
  captureContractVersion: number;
  // sealed_at, stamped once by the correlator (the same nowIso the sweep uses).
  sealedAtIso: string;
}

// Assemble the capture-intake POST body for one closed inject. Pure over its inputs. The
// window is the exact `[turn, turn + window]` deriveOutcome closed on. A turn enters the
// digest if it carries ANY captured work product OR any user prompt in the window; the
// digest builder folds prompts/outputs/hunks and computes per-turn completeness.
//
// status = sealed iff at least one turn carries a real work product (an assistant output or
// a changed hunk); prompts alone are the user's ask, not the agent's product, so a window
// with only prompts (or nothing) seals as `failed` -- the consented capture produced nothing
// to judge. A failed seal carries no digest and stays in the honest cohort (§9.1 Blocker 3).
export function buildSealBody(args: BuildSealBodyArgs): WorkProductCaptureBody {
  const start = args.inject.turnIndex;
  const end = start + args.window;

  const windowCaptures = args.captures.filter(
    (c) => c.turn_index >= start && c.turn_index <= end,
  );
  const byTurn = assembleTurnCaptures(windowCaptures);

  // Union of turns with captures OR in-window prompts, so the judge's direct-prompt
  // exclusion sees the user's ask even for a turn that produced no captured output.
  const turnSet = new Set<number>();
  for (const t of byTurn.keys()) turnSet.add(t);
  for (const t of args.promptsByTurn.keys()) {
    if (t >= start && t <= end) turnSet.add(t);
  }

  const turns: DigestTurnInput[] = [];
  for (const turn of turnSet) {
    const slot = byTurn.get(turn) ?? { assistant_outputs: [], hunks: [] };
    turns.push({
      turn_index: turn,
      user_prompts: args.promptsByTurn.get(turn) ?? [],
      assistant_outputs: slot.assistant_outputs,
      hunks: slot.hunks,
    });
  }

  const digest: WorkProductDigest = buildWorkProductDigest({
    windowStartTurn: start,
    windowEndTurn: end,
    captureContractVersion: args.captureContractVersion,
    sealedAtIso: args.sealedAtIso,
    turns,
  });

  const hasWorkProduct = digest.turns.some(
    (t) => t.assistant_outputs.length > 0 || t.changed_hunks.length > 0,
  );
  // Window-level completeness carried on the seal event = OR across every turn (the per-turn
  // completeness stays inside the digest for the judge to read).
  const truncated = digest.turns.some((t) => t.completeness.truncated);
  const redactedSubstance = digest.turns.some(
    (t) => t.completeness.redacted_substance,
  );

  const base = {
    workspaceId: args.inject.workspaceId,
    injectId: args.inject.injectId,
    captureContractVersion: args.captureContractVersion,
    capturedTurnStart: start,
    capturedTurnEnd: end,
    truncated,
    redactedSubstance,
  };

  if (!hasWorkProduct) {
    return { ...base, status: SEAL_STATUS_FAILED };
  }
  return {
    ...base,
    status: SEAL_STATUS_SEALED,
    workProductDigest: JSON.stringify(digest),
  };
}

// Index ask-traces lines to (session_id -> turn_index -> prompts[]), preserving occurrence
// order per turn. The prompt is at `input.prompt` (user-prompt-submit.sh); a line with no
// session/turn/prompt contributes nothing.
export function buildPromptsBySession(
  asks: Record<string, unknown>[],
): Map<string, Map<number, string[]>> {
  const bySession = new Map<string, Map<number, string[]>>();
  for (const a of asks) {
    const sid = typeof a.session_id === "string" ? a.session_id : "";
    if (!sid) continue;
    const turn =
      typeof a.turn_index === "number" && Number.isInteger(a.turn_index)
        ? a.turn_index
        : null;
    if (turn === null) continue;
    const input =
      a.input && typeof a.input === "object"
        ? (a.input as Record<string, unknown>)
        : null;
    const prompt = input && typeof input.prompt === "string" ? input.prompt : "";
    if (!prompt) continue;
    let byTurn = bySession.get(sid);
    if (!byTurn) {
      byTurn = new Map();
      bySession.set(sid, byTurn);
    }
    const arr = byTurn.get(turn) ?? [];
    arr.push(prompt);
    byTurn.set(turn, arr);
  }
  return bySession;
}

// The one atomic capture-intake call. Best-effort by the correlator's contract: control
// owns idempotency (§10.6), so a 200 (idempotent), a 409 (a differing re-seal, which throws),
// or a transport error are all handled the same way by the caller -- swallowed.
export async function postWorkProductCapture(
  cfg: CliConfig,
  body: WorkProductCaptureBody,
  timeoutMs: number = CAPTURE_POST_TIMEOUT_MS,
): Promise<void> {
  await post(cfg, WORK_PRODUCT_CAPTURE_PATH, body, timeoutMs);
}
