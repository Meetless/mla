// The offline recall-sampling threshold for `ce0-export`
// (notes/20260617-evidence-consultation-forcing-function-proposal.md lines 1010-1019, 2129).
//
// The durable store stamps EVERY classified turn with a uniform `samplingBucket` (a sha256 hex digest
// over the turn's natural key; see ce0-sampling-bucket.ts) and bakes in NO sampling rate. Recall (the
// false-negative rate) is constructible only from the NOT_REQUIRED / UNKNOWN turns we did not flag, so
// the OFFLINE export must choose WHICH of those unflagged turns to put in front of a grader. It does so
// by THRESHOLDING the bucket: read the leading 32 bits of the digest as a uniform fraction in [0, 1) and
// sample the turn iff that fraction is below the rate. Because the bucket is reconstructible from the
// turn's logical coordinate alone, sample membership is reproducible offline with no runtime random draw.
//
// The threshold is monotonic in the rate: a turn in the sample at rate r is in the sample at every rate
// above r. Widening the rate only ever ADDS turns, so a later, more generous export is a superset of an
// earlier one over the same store.

import {
  listTurnMemoryAssessments,
  type Ce0Store,
  type MemoryRequirement,
  type ResponseSourceRefV1,
} from "./ce0-store";

/**
 * The pinned default recall sampling rate: 1.0, i.e. sample EVERY unflagged (NOT_REQUIRED / UNKNOWN)
 * turn. At dogfood / measurement-harness scale the recall gate needs at least 100 sampled unflagged
 * turns before recall is observable at all (proposal line 2129; line 2145: recall unmeasurable -> do
 * not authorize CE1). Sampling DOWN from that starves the gate, so the default measures everything.
 * The threshold machinery below exists so the rate can be dialed under 1.0 once a real pilot's volume
 * forces a grader-load bound; it is not exercised by the default path.
 */
export const DEFAULT_RECALL_SAMPLE_RATE = 1;

/** The number of leading hex chars (32 bits) of the digest read as the sampling fraction. */
const PREFIX_HEX_CHARS = 8;
/** 2^32: the denominator that turns the 32-bit prefix into a fraction in [0, 1). */
const PREFIX_SPACE = 0x1_0000_0000;

/**
 * Whether a turn whose assessment carries `samplingBucket` falls in the offline recall sample at `rate`.
 * Reads the leading 32 bits of the digest as a uniform fraction and samples iff it is strictly below the
 * rate. `rate >= 1` samples every turn; `rate <= 0` samples none. A malformed bucket (not a hex digest
 * of at least 8 chars) is never sampled: the real producer always emits a 64-char sha256 digest, and a
 * conservative exclude keeps a parse fault from silently corrupting the recall denominator.
 */
export function isInRecallSample(samplingBucket: string, rate: number): boolean {
  if (samplingBucket.length < PREFIX_HEX_CHARS) return false;
  const prefix = samplingBucket.slice(0, PREFIX_HEX_CHARS);
  if (!/^[0-9a-f]{8}$/.test(prefix)) return false;
  // The fraction is always in [0, 1) (the largest 32-bit prefix is 0xffffffff / 2^32 < 1), so this
  // single comparison subsumes the rate bounds: rate >= 1 samples every valid bucket, rate <= 0 none.
  const fraction = parseInt(prefix, 16) / PREFIX_SPACE;
  return fraction < rate;
}

// ---------------------------------------------------------------------------
// The recall (false-negative) population of `ce0-export`
// (notes/20260617-evidence-consultation-forcing-function-proposal.md lines 1010-1019).
//
// The store stamps EVERY classified turn with a TurnMemoryAssessment. Precision is measured from the
// REQUIRED turns (exported with their obligation section by assembleCe0ExportRows); recall is measured
// from the turns we did NOT flag. assembleCe0RecallSampleRows is the recall half: it reads every
// assessment, keeps the NOT_REQUIRED / UNKNOWN turns whose deterministic samplingBucket falls in the
// sample at `rate`, and emits one assessment-keyed row per kept turn. By construction these turns have
// no obligation (only REQUIRED turns open one), so the row carries NO obligation section -- it carries
// only the facts a human needs to grade whether the classifier's "did not require memory" call was a
// false negative.
//
// Labelability is store-knowable here and nothing more: the only transcript handle a stored assessment
// carries is `responseSourceRef`. A turn that never got a Stage-B response snapshot has no pointer to
// resolve its content, so it is exported UNLABELABLE with a stable reason, counted, never silently
// dropped (proposal lines 1016-1018). A turn that HAS the pointer is LABELABLE at this layer; actually
// reading the transcript bytes (and downgrading a stale / missing ref to UNLABELABLE) is a later
// export-time concern, not a store read.
// ---------------------------------------------------------------------------

/** Whether the recall grader can resolve this turn's local content. UNLABELABLE rows are still
 * exported and counted (proposal lines 1016-1018); they are never silently dropped. */
export type Ce0RecallLabelability = "LABELABLE" | "UNLABELABLE";

/** The stable reason a recall row is UNLABELABLE. NO_RESPONSE_SNAPSHOT: Stage B never captured a
 * `responseSourceRef`, so there is no transcript handle to resolve the turn's asserted answer. */
export type Ce0RecallLabelabilityReason = "NO_RESPONSE_SNAPSHOT";

/** One turn in the recall (false-negative) population: an unflagged (NOT_REQUIRED / UNKNOWN)
 * assessment that fell in the offline sample. Assessment-keyed, never obligation-keyed; the human
 * grades `requirement` against the turn's resolved content. */
export interface Ce0RecallSampleRow {
  assessmentId: string;
  workspaceId: string;
  sessionId: string;
  localTurnSequence: number;
  /** The classifier's call this row exists to audit: NOT_REQUIRED or UNKNOWN (REQUIRED turns are the
   * precision population, exported separately). */
  requirement: MemoryRequirement;
  /** The deterministic bucket that put this turn in the sample, so a grader can reconstruct membership. */
  samplingBucket: string;
  /** Identity-only pointer to the classified prompt (content-free; the raw prompt is never duplicated). */
  promptHash: string;
  /** The asserted-answer hash when Stage B snapshotted one; null otherwise. */
  responseHash: string | null;
  /** The transcript pointer Stage B captured; null when no snapshot was taken. */
  responseSourceRef: ResponseSourceRefV1 | null;
  labelability: Ce0RecallLabelability;
  /** A stable code when UNLABELABLE; null when LABELABLE. */
  labelabilityReason: Ce0RecallLabelabilityReason | null;
}

/**
 * Build the recall-sample rows for a workspace: one per NOT_REQUIRED / UNKNOWN assessment whose
 * samplingBucket falls in the sample at `rate`. Reads the store's ordered assessment list, so the rows
 * inherit its (session, sequence, assessmentId) order. Deterministic and side-effect-free.
 */
export function assembleCe0RecallSampleRows(
  store: Ce0Store,
  workspaceId: string,
  rate: number,
): Ce0RecallSampleRow[] {
  const rows: Ce0RecallSampleRow[] = [];
  for (const a of listTurnMemoryAssessments(store, workspaceId)) {
    // REQUIRED turns are the precision population (assembleCe0ExportRows); the recall sample is the
    // unflagged turns only.
    if (a.requirement === "REQUIRED") continue;
    if (!isInRecallSample(a.samplingBucket, rate)) continue;
    const ref = a.responseSourceRef ?? null;
    rows.push({
      assessmentId: a.assessmentId,
      workspaceId: a.workspaceId,
      sessionId: a.sessionId,
      localTurnSequence: a.localTurnSequence,
      requirement: a.requirement,
      samplingBucket: a.samplingBucket,
      promptHash: a.promptHash,
      responseHash: a.responseHash ?? null,
      responseSourceRef: ref,
      labelability: ref ? "LABELABLE" : "UNLABELABLE",
      labelabilityReason: ref ? null : "NO_RESPONSE_SNAPSHOT",
    });
  }
  return rows;
}
