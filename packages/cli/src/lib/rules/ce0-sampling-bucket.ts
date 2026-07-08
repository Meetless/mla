import { canonicalize, sha256Hex, type CanonicalValue } from "./canonical-json";

// CE0 sampling bucket (proposal R3 P0.9, line 280; offline selection at line 997). Every classified
// turn carries a deterministic bucket so the OFFLINE unflagged-recall sample is RECONSTRUCTIBLE: the
// runtime makes no random draw, and a grader can recompute which NOT_REQUIRED / UNKNOWN turns fall in
// the sample from the turn's coordinates alone. The store records EVERY turn's bucket; the offline
// `ce0-export` decides the sampling RATE by thresholding it, so nothing here bakes in a cardinality.

/** The stable turn coordinate a sampling bucket is derived from: the assessment's natural identity
 * key (the same (workspace, session, sequence) tuple that is its UNIQUE constraint). Deriving from
 * the logical coordinate, not the random assessmentId, is what makes the offline sample
 * reconstructible. */
export interface SamplingBucketKey {
  workspaceId: string;
  sessionId: string;
  localTurnSequence: number;
}

/** Deterministic, uniform sampling bucket for one assessment: sha256 over the canonical natural key,
 * the same hashing discipline as the rule and subject fingerprints (canonical-json). The full digest
 * carries maximum entropy and bakes in no sampling cardinality; the offline export thresholds it to
 * pick the rate. */
export function samplingBucketFor(key: SamplingBucketKey): string {
  return sha256Hex(
    canonicalize({
      workspaceId: key.workspaceId,
      sessionId: key.sessionId,
      localTurnSequence: key.localTurnSequence,
    } as CanonicalValue),
  );
}
