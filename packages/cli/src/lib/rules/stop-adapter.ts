import {
  claimFirstStop,
  recordStopResponseSnapshot,
  resolveLatestTurnIdentity,
  type Ce0Store,
  type DeadlineClaimResult,
  type LocalTurnIdentity,
} from "./ce0-store";
import {
  readStopResponseSnapshot,
  type StopSnapshotUnlabelableReason,
} from "./stop-response-snapshot";

// Commit 8: the CE0 Stop adapter, the §2.3 two-stage Stop seam
// (notes/20260617-evidence-consultation-forcing-function-proposal.md §2.3, lines 1091-1149). When the
// agent finishes answering, the first parent Stop hook resolves the turn's LocalTurnIdentity and runs
// the two stages in order:
//   - Stage A (claimFirstStop): the immediate, I/O-free deadline claim. It stamps stopObservedAt
//     if-null on the turn's assessment for EVERY classified turn and, when an obligation is present,
//     freezes its eligibility boundary at the high-water orderingToken. Every consultation recorded
//     before that boundary is eligible to contribute a proof; one that lands after it cannot
//     retroactively count. Satisfaction itself is recomputed offline (Commit 9); Stage A only stamps
//     the observation and freezes the boundary, never declaring the obligation satisfied.
//   - Stage B (readStopResponseSnapshot then recordStopResponseSnapshot): the best-effort response
//     snapshot, OUTSIDE and AFTER the Stage A transaction. It reads transcript_path, selects the
//     latest top-level parent assistant answer, and records responseHash + a byte-exact
//     responseSourceRef onto the same assessment. It runs for every classified turn (REQUIRED or not)
//     so the offline false-negative recall sample carries the same answer evidence as a flagged turn.
//     A slow / failed / absent transcript leaves the snapshot null, marks the sample UNLABELABLE with
//     a stable reason, and NEVER delays Stop, fails Stop, or rolls back the deadline.
//
// It is SYNCHRONOUS (resolve + claim are synchronous better-sqlite3 reads/writes, and the Stage B
// transcript read is a bounded synchronous file read) and mirrors the sibling adapters' discipline:
//   - It NEVER injects. The hook response is the empty object on EVERY branch. The CE0/CE1 response
//     ceiling is RECORD_ONLY: a Stop observes and freezes; it never steers, asks, or denies.
//     Continuation injection is a CE2 concern that demands a new immutable rule version.
//   - It NEVER turns an infrastructure problem into a write or a throw. Malformed input, a missing
//     session coordinate, and a Stage A persistence failure all surface as INFRA with a diagnostic and
//     an empty response, never an error.
//   - A turn with no obligation (a NOT_REQUIRED turn, or a Stop for a session CE0 never assessed) is
//     NOT_APPLICABLE for Stage A: there is nothing to freeze. Stage B still runs when the turn was
//     assessed, so its answer evidence is captured all the same.
//   - It is idempotent. A later Stop reports ALREADY_CLAIMED for the deadline and ALREADY_RECORDED for
//     a completed snapshot, and never moves the boundary or overwrites the snapshot.

/** The real Stop hook input shape (snake_case, as delivered on stdin). The session coordinate is the
 * Stage A load-bearing field; transcript_path feeds Stage B (the real Stop payload carries the path,
 * not the answer inline, so CE0 adds no new payload field). */
export interface StopHookInput {
  session_id?: string;
  transcript_path?: string;
}

/** The hook response. Intentionally empty: a Stop cannot inject in CE0, and would not anyway.
 * This is provably empty on every branch. */
export type StopHookResponse = Record<string, never>;

/**
 * What Stage A did with one Stop event.
 *   - NOT_APPLICABLE: the turn has no obligation to freeze; nothing changed.
 *   - CLAIMED: this Stop froze the eligibility boundary at deadlineClaimedAt.
 *   - ALREADY_CLAIMED: a prior Stop already froze it; an idempotent no-op.
 *   - INFRA: an infrastructure problem prevented the claim; explicitly not a verdict.
 */
export type StopObserveOutcome =
  | { kind: "NOT_APPLICABLE" }
  | {
      kind: "CLAIMED";
      obligationId: string;
      localTurnSequence: number;
      deadlineClaimedAt: number;
      deadlineClaimedVersion: number;
      stateVersion: number;
    }
  | {
      kind: "ALREADY_CLAIMED";
      obligationId: string;
      localTurnSequence: number;
      deadlineClaimedAt: number;
    }
  | { kind: "INFRA"; diagnostic: string };

/**
 * What Stage B did with the response snapshot.
 *   - RECORDED: this Stop filled the still-missing responseHash + responseSourceRef pair.
 *   - ALREADY_RECORDED: a prior Stop already completed the snapshot; an idempotent no-op (P0.6).
 *   - NO_ASSESSMENT: the assessment row vanished between identity resolution and the write (a race);
 *     there is nothing to snapshot.
 *   - UNLABELABLE: the transcript could not be snapshotted; the sample stays UNLABELABLE with a stable
 *     reason and the snapshot fields stay null. Counted in the offline unlabelable total (§6.3).
 */
export type StopSnapshotDisposition =
  | { kind: "RECORDED" }
  | { kind: "ALREADY_RECORDED" }
  | { kind: "NO_ASSESSMENT" }
  | { kind: "UNLABELABLE"; reason: StopSnapshotUnlabelableReason };

export interface StopObserveResult {
  response: StopHookResponse;
  outcome: StopObserveOutcome;
  /** Stage B's disposition. Absent only when Stage B did not run: malformed / missing input, a Stop
   * for a session CE0 never assessed, or a Stage A INFRA failure. */
  snapshot?: StopSnapshotDisposition;
}

export interface StopAdapterConfig {
  store: Ce0Store;
  /** The hook input carries no workspace, so the caller supplies the logged-in one. */
  workspaceId: string;
  /** The consult-evidence version id the obligation was stamped with at prompt-submit, re-resolved by
   *  the entrypoint from the active runtime scope (the LIVE attested version when armed, the frozen
   *  compile-time identity when unarmed). claimFirstStop joins the obligation lookup on
   *  (workspaceId, sessionId, localTurnSequence, ruleVersionId), so a Stop MUST claim with the SAME bound
   *  version the turn-open adapter stamped or it would orphan the obligation and never freeze its boundary.
   *  This is the Stop half of the symmetric binding (GAP 3 slice 4); the adapter never reads ce0-rule's
   *  constant directly, so arming a version binds with no change to this file. */
  ruleVersionId: string;
  /** Injectable clock for Stage A's stopObservedAt stamp; defaults to Date.now. */
  now?: () => number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Parse the raw Stop payload. Accepts either an already parsed object or the raw JSON string.
 * A Stop has no required payload field beyond being an object, so the only null case is a shape
 * that is not a plain object (or an unparseable string); the adapter maps that null to INFRA.
 * The session coordinate and transcript_path are read but not required here, so their absence gets a
 * distinct diagnostic / disposition at the adapter rather than collapsing into "malformed".
 */
export function parseStopInput(raw: unknown): StopHookInput | null {
  let obj: unknown = raw;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!isPlainObject(obj)) return null;
  const session = obj.session_id;
  const transcript = obj.transcript_path;
  return {
    session_id: typeof session === "string" ? session : undefined,
    transcript_path: typeof transcript === "string" ? transcript : undefined,
  };
}

/** Map a Stage A deadline-claim result onto the adapter's Stage A outcome. */
function stageAOutcome(result: DeadlineClaimResult, identity: LocalTurnIdentity): StopObserveOutcome {
  switch (result.status) {
    case "NO_OBLIGATION":
      return { kind: "NOT_APPLICABLE" };
    case "CLAIMED":
      return {
        kind: "CLAIMED",
        obligationId: result.claim.obligationId,
        localTurnSequence: identity.localTurnSequence,
        deadlineClaimedAt: result.claim.deadlineClaimedAt,
        deadlineClaimedVersion: result.claim.deadlineClaimedVersion,
        stateVersion: result.claim.stateVersion,
      };
    case "ALREADY_CLAIMED":
      return {
        kind: "ALREADY_CLAIMED",
        obligationId: result.claim.obligationId,
        localTurnSequence: identity.localTurnSequence,
        deadlineClaimedAt: result.claim.deadlineClaimedAt,
      };
  }
}

/**
 * Stage B: best-effort, outside the Stage A transaction. Read the transcript snapshot and, when it
 * succeeds, record the response pair idempotently onto the turn's assessment. readStopResponseSnapshot
 * never throws; a transcript failure resolves to UNLABELABLE with a stable reason and the snapshot
 * fields stay null. A Stage B store-write fault is the same DB-fault class Stage A already surfaces as
 * INFRA, so it is left to propagate to the adapter's outer catch rather than masked here.
 */
function recordStageB(
  store: Ce0Store,
  identity: LocalTurnIdentity,
  transcriptPath: string | undefined,
): StopSnapshotDisposition {
  const snap = readStopResponseSnapshot(transcriptPath);
  if (!snap.ok) return { kind: "UNLABELABLE", reason: snap.reason };
  const written = recordStopResponseSnapshot(store, identity, {
    responseHash: snap.responseHash,
    responseSourceRef: snap.responseSourceRef,
  });
  return { kind: written.status };
}

/**
 * Observe one Stop. Resolves the turn's LocalTurnIdentity, runs Stage A (freeze the obligation's
 * eligibility boundary and stamp the observation) and Stage B (best-effort response snapshot), and
 * returns an empty (injection-free) hook response.
 */
export function observeStop(rawInput: unknown, config: StopAdapterConfig): StopObserveResult {
  const NO_INJECTION: StopHookResponse = {};
  const now = config.now ?? Date.now;

  const parsed = parseStopInput(rawInput);
  if (!parsed) {
    return { response: NO_INJECTION, outcome: { kind: "INFRA", diagnostic: "malformed hook input" } };
  }
  if (!parsed.session_id) {
    return {
      response: NO_INJECTION,
      outcome: { kind: "INFRA", diagnostic: "missing session_id coordinate" },
    };
  }

  try {
    const identity = resolveLatestTurnIdentity(config.store, {
      workspaceId: config.workspaceId,
      sessionId: parsed.session_id,
    });
    if (!identity) {
      return { response: NO_INJECTION, outcome: { kind: "NOT_APPLICABLE" } };
    }

    const claim = claimFirstStop(config.store, identity, config.ruleVersionId, now);
    const outcome = stageAOutcome(claim, identity);
    const snapshot = recordStageB(config.store, identity, parsed.transcript_path);
    return { response: NO_INJECTION, outcome, snapshot };
  } catch (err) {
    return {
      response: NO_INJECTION,
      outcome: { kind: "INFRA", diagnostic: `persistence failure: ${describeError(err)}` },
    };
  }
}
