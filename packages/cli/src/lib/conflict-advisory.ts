// tools/meetless-agent/src/lib/conflict-advisory.ts
//
// NORMATIVE V1 conflict-advisory flag policy (Phase 1, Active Review).
//
// Active Review reviews the PRIOR turn's produced docs against the workspace's
// governed knowledge and turns intel's relationship detections into AT MOST one
// terse advisory per cited document. This module is the single source of truth
// for WHICH detections become advisories. The policy is deliberately narrow and
// silent by default:
//
//   1. ONLY conflict relation types flag. CONTRADICTS, SUPERSEDES, and
//      STALE_RELIES_ON are the conflict set. Everything else (REFERENCES,
//      RELATES_TO, plausibly-helpful "see also" edges, etc.) is silent: a
//      related doc is not a conflict, and surfacing it would be noise.
//   2. ONLY over an APPROVED, VISIBLE cited document. The cited doc must be
//      either a LIVE posture (published / governed) OR a SHADOW posture that is
//      ACCEPTED (an approved private edge). A PENDING_REVIEW or REJECTED edge,
//      or an un-approved SHADOW, never flags: we do not warn the agent about a
//      contradiction with something nobody has signed off on yet.
//   3. ONLY at or above the confidence floor. A detection below minConfidence is
//      a weak signal; the caller may log it for tuning, but it produces no
//      advisory.
//   4. ONE advisory per cited doc. A single document can yield many chunk-level
//      detections; they collapse to one flag (the highest-confidence one) so the
//      agent sees one line per conflicting doc, never a chunk storm.
//
// Pure and side-effect-free so the policy is unit-testable in isolation; the
// runner (active-review-runner.ts) supplies the detections and renders the
// advisory text. advise-never-block (P6): an advisory is informational only.

export interface Detection {
  relationType: string;
  citedKbId: string;
  confidence: number;
  citedQuote: string;
  candidatePath: string;
  posture: "LIVE" | "SHADOW";
  status: "ACCEPTED" | "PENDING_REVIEW" | "REJECTED";
}

export interface Advisory {
  citedKbId: string;
  relationType: string;
  candidatePath: string;
  citedQuote: string;
  confidence: number;
}

export interface AdvisoryOpts {
  minConfidence: number;
}

// The conflict relation types. Only these flag; every other relation type is
// silent (a related doc is not a conflict).
export const CONFLICT_RELATION_TYPES = new Set(["CONTRADICTS", "SUPERSEDES", "STALE_RELIES_ON"]);

// A cited doc is eligible to flag only when it is approved AND visible: a LIVE
// posture, or a SHADOW posture that has been ACCEPTED (an approved private edge).
function isEligible(d: Detection): boolean {
  return d.posture === "LIVE" || (d.posture === "SHADOW" && d.status === "ACCEPTED");
}

export function advisoriesFromDetections(detections: Detection[], opts: AdvisoryOpts): Advisory[] {
  // Collapse to one advisory per cited doc, keeping the highest-confidence one.
  const byCitedId = new Map<string, Advisory>();
  for (const d of detections) {
    if (!CONFLICT_RELATION_TYPES.has(d.relationType)) continue; // related is not conflict
    if (d.confidence < opts.minConfidence) continue; // below the floor: log only, no advisory
    if (!isEligible(d)) continue; // not over an approved, visible cited doc
    const existing = byCitedId.get(d.citedKbId);
    if (existing && existing.confidence >= d.confidence) continue; // keep the strongest
    byCitedId.set(d.citedKbId, {
      citedKbId: d.citedKbId,
      relationType: d.relationType,
      candidatePath: d.candidatePath,
      citedQuote: d.citedQuote,
      confidence: d.confidence,
    });
  }
  return Array.from(byCitedId.values());
}
