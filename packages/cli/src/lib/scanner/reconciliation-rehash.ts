// Prompt-time reconciliation rehash gate (ADR §3.3 item 9,
// notes/20260717-adr-decision-record-projection-and-reconciliation.md).
//
// A reconciliation finding cites one instruction-file path plus the
// `content-normalization-v1` digest of that path AT EVALUATION TIME
// (`evaluatedDigest`). Between evaluation and this prompt the operator may have
// edited the file. This gate re-derives the digest from the file's CURRENT bytes
// through the SAME vendored normalization helper the scan path uses and keeps the
// finding only when it still matches. A mismatch (or an unreadable file, or a
// normalization the helper refuses) is NEEDS_REEVALUATION: the finding is dropped
// from THIS prompt's injection, never asserted stale and NEVER auto-resolved
// (item #6 — a drifted file means "re-evaluate", not "the concern went away").
//
// The gate is a pure function of (findings, byte-reader). It never throws: a
// per-finding failure is contained and classified, so one bad path can never sink
// the batch or the assembler around it. In Phase 2A there is no detector to emit
// findings (that is Phase 2B, blocked), so every 2A cache carries none and this
// gate is a clean no-op; it exists, is wired, and is testable now so the primitive
// is proven before the detector arrives.
import {
  CONTENT_NORMALIZATION_V1,
  normalizedContentHash,
} from "./content-normalization";
import type { ReconciliationFinding } from "./types";

// Why a finding landed in its partition. `digest_match` is the only KEPT reason;
// the other three are the NEEDS_REEVALUATION reasons, kept distinct so the audit
// (and a future Phase-3 renderer) can tell an intentional edit (`digest_drift`)
// apart from an environmental miss (`unreadable`) or a fail-closed refusal
// (`normalization_error`).
export type RehashReason =
  | "digest_match"
  | "digest_drift"
  | "unreadable"
  | "normalization_error";

export interface RehashOutcome {
  finding: ReconciliationFinding;
  reason: RehashReason;
}

export interface ReconciliationRehashResult {
  // Findings whose cited file still hashes to `evaluatedDigest`: eligible to inject
  // (the Phase-3 renderer, blocked, is their only consumer).
  kept: RehashOutcome[];
  // Findings held back from this prompt because the file drifted, could not be read,
  // or failed normalization. Dropped from injection; never auto-resolved.
  needsReevaluation: RehashOutcome[];
}

// A byte reader for a repo-relative instruction path. Returns null when the path is
// unreadable (missing, escaped containment, io error); the assembler supplies a
// containment-guarded default and tests inject a fake.
export type ArtifactByteReader = (path: string) => string | null;

/**
 * Partition reconciliation findings into KEPT vs NEEDS_REEVALUATION by rehashing
 * each cited file's current bytes. Pure and total: never throws, reads each path at
 * most once, and preserves input order within each partition.
 */
export function filterReconciliationFindings(
  findings: ReconciliationFinding[],
  readBytes: ArtifactByteReader,
): ReconciliationRehashResult {
  const kept: RehashOutcome[] = [];
  const needsReevaluation: RehashOutcome[] = [];
  for (const finding of findings) {
    const reason = rehashOne(finding, readBytes);
    if (reason === "digest_match") {
      kept.push({ finding, reason });
    } else {
      needsReevaluation.push({ finding, reason });
    }
  }
  return { kept, needsReevaluation };
}

// Rehash one finding. Isolated so a throw from the reader or the normalizer is
// contained to a single classification, never the batch.
function rehashOne(finding: ReconciliationFinding, readBytes: ArtifactByteReader): RehashReason {
  let bytes: string | null;
  try {
    bytes = readBytes(finding.path);
  } catch {
    // A reader that throws is treated exactly like one that returns null: the file
    // is unreadable for the purposes of this prompt.
    return "unreadable";
  }
  if (bytes === null) return "unreadable";

  let localDigest: string;
  try {
    localDigest = normalizedContentHash(
      bytes,
      finding.contentNormalizationVersion ?? CONTENT_NORMALIZATION_V1,
    );
  } catch {
    // ContentNormalizationError (unknown version, non-string): fail-closed. We
    // cannot verify the digest, so we must not assert the finding still holds.
    return "normalization_error";
  }

  return localDigest === finding.evaluatedDigest ? "digest_match" : "digest_drift";
}
