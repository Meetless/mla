// Event identity (spec section 10.2, INV-IDEMPOTENCY-1, INV-REMOTE-DEDUPE-1).
//
// Two minting strategies, picked by who is the system of record for the event:
//
//  - CLI-ORIGIN events (mla_command, mla_evidence_inject): the CLI is the only
//    writer, the event is produced exactly once, and a re-ship must reuse the
//    SAME id. So we mint a UUID once and persist it in the local jsonl; every
//    later forward reads it back. We do NOT content-hash these: identical
//    commands at the same second would collide, and any serialization change
//    would silently drift the id.
//
//  - SERVER-RECOMPUTABLE events (mla_evidence_outcome, mla_review_decision):
//    these are derived from a business key plus a monotonic version, and may be
//    recomputed by more than one writer (the correlator, a backfill). A
//    deterministic id makes that idempotent: sha256(businessKey + ":" + version).
//
// Control dedupes on the PAIR (workspace_id, event_id), so a deterministic id
// scoped only by business key never collides across workspaces.

import * as crypto from "crypto";

// Mint a fresh, persisted-once id for a CLI-origin event. uuid (not a hash) so
// two structurally identical events are still distinct, and so the id is stable
// across re-serialization.
export function mintEventId(): string {
  return crypto.randomUUID();
}

// Deterministic id for a server-recomputable event. businessKey is the stable
// natural key (e.g. an inject_id or decision_id); version is a monotonically
// increasing integer so a corrected recomputation produces a NEW id rather than
// silently overwriting the prior landing. The ":" separator is unambiguous
// because neither side contains it (ids are uuids/hex, version is an integer).
export function deterministicEventId(businessKey: string, version: number): string {
  if (!businessKey) {
    throw new Error("deterministicEventId requires a non-empty businessKey");
  }
  if (!Number.isInteger(version) || version < 0) {
    throw new Error(`deterministicEventId requires a non-negative integer version, got ${version}`);
  }
  return crypto.createHash("sha256").update(`${businessKey}:${version}`).digest("hex");
}

// Convenience wrappers naming the two server-recomputable event families, so
// callers can't accidentally pass the wrong version field.
export function outcomeEventId(injectId: string, outcomeVersion: number): string {
  return deterministicEventId(injectId, outcomeVersion);
}

export function reviewDecisionEventId(decisionId: string, decisionVersion: number): string {
  return deterministicEventId(decisionId, decisionVersion);
}

// The enforcement OUTCOME (STAR's R) shares its incident's incident_id as the business
// key, but the incident already mints its OWN event_id from the bare incident_id at v0
// (enforcement-incident.ts: deterministicEventId(incidentId, 0)). Reusing the bare key
// here would collide the two events on control's (workspace_id, event_id) dedupe. The
// `enf-outcome:` namespace keeps the outcome's id distinct while staying deterministic,
// so a re-run of the correlator dedups instead of double-counting.
export function enforcementOutcomeEventId(incidentId: string, outcomeVersion: number): string {
  return deterministicEventId(`enf-outcome:${incidentId}`, outcomeVersion);
}
