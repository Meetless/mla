// Shared types + the mechanical-validity classifier for the B5 agent-proxy review
// commands (`mla kb pending`, `mla kb review`). See
// notes/20260603-mla-kb-agent-proxy-and-evidence-adoption.md §3 (B5) and P2.
//
// The classifier is the enforcement point of the P2 reject-only auto-resolution
// policy: an automated proxy (`mla kb review --agent`) may auto-REJECT a candidate
// ONLY when this returns autoRejectable, and may never auto-accept anything. So
// this gate must be conservative to the point of paranoia: a FALSE POSITIVE here
// discards a real edge (the exact "poison" the doc warns against), whereas a false
// negative merely routes the candidate to a human. We therefore implement only the
// mechanical conditions that are decidable from the candidate row alone with zero
// ambiguity, and deliberately SKIP the conditions that need server round-trips or
// the relation-type registry (deleted-doc, duplicate-of-accepted-LIVE-edge,
// invalid-relation-type, non-LIVE-revision). Those are surfaced to a human instead.
// The CLI also intentionally does not depend on @meetless/utils, so coupling the
// gate to RELATION_TYPE_REGISTRY (and risking false rejects on registry drift) is
// off the table by construction.

// Confidence below this floor, combined with no supporting quote, marks a candidate
// as mechanical noise. Set below the detector's "medium" tier (~0.45) so it only
// ever fires on the genuinely unsupported tail, never on a borderline-real edge.
export const AUTO_REJECT_CONFIDENCE_FLOOR = 0.3;

export interface CandidateEvidence {
  sourceQuote?: string | null;
  targetQuote?: string | null;
  reasoning?: string | null;
  [k: string]: unknown;
}

// The subset of the control RelationshipCandidate row the CLI consumes. The control
// list/detail routes return raw Prisma rows; we read only these fields.
export interface RelationshipCandidate {
  id: string;
  workspaceId: string;
  relationTypeId: string;
  statusId: string;
  reviewModeId: string;
  promotionStatusId: string;
  postureId: string;
  sourceType: string;
  sourceArtifactId: string;
  targetType: string | null;
  targetArtifactId: string | null;
  confidence: number;
  detectorFamily: string;
  detectorVersion: string;
  evidenceJson: CandidateEvidence | null;
  createdAt: string;
  updatedAt: string;
}

export type MechanicalReasonCode = "self_edge" | "low_confidence_no_quote";

export interface MechanicalVerdict {
  autoRejectable: boolean;
  reasonCode: MechanicalReasonCode | null;
  reason: string | null;
}

function hasSupportingQuote(ev: CandidateEvidence | null): boolean {
  if (!ev) return false;
  const src = typeof ev.sourceQuote === "string" ? ev.sourceQuote.trim() : "";
  const tgt = typeof ev.targetQuote === "string" ? ev.targetQuote.trim() : "";
  return src.length > 0 || tgt.length > 0;
}

// Decide whether a candidate is MECHANICALLY invalid (unambiguous noise an agent may
// auto-reject). Pure; no I/O. See the module header for why this is conservative.
export function classifyMechanicalInvalidity(c: RelationshipCandidate): MechanicalVerdict {
  // 1. Self-edge: same artifact on both endpoints. A relation from a doc to itself
  //    is structurally meaningless regardless of confidence. (A unary candidate with
  //    a null target is NOT a self-edge.)
  if (
    c.targetArtifactId !== null &&
    c.sourceArtifactId === c.targetArtifactId &&
    (c.targetType === null || c.sourceType === c.targetType)
  ) {
    return {
      autoRejectable: true,
      reasonCode: "self_edge",
      reason: `self-edge: source and target are the same artifact (${c.sourceArtifactId})`,
    };
  }

  // 2. Very-low confidence AND no supporting quote: the detector neither believed it
  //    nor anchored it in text. With a quote present we defer to a human (the quote
  //    may carry the signal the score missed).
  if (c.confidence < AUTO_REJECT_CONFIDENCE_FLOOR && !hasSupportingQuote(c.evidenceJson)) {
    return {
      autoRejectable: true,
      reasonCode: "low_confidence_no_quote",
      reason: `confidence ${c.confidence.toFixed(2)} below floor ${AUTO_REJECT_CONFIDENCE_FLOOR.toFixed(
        2,
      )} with no supporting quote`,
    };
  }

  return { autoRejectable: false, reasonCode: null, reason: null };
}

// Canonical Console deep link for a relationship candidate. consoleBase must already
// be trailing-slash-stripped (see getConsoleUrl).
export function candidateConsoleUrl(consoleBase: string, candidateId: string): string {
  return `${consoleBase}/relationships/${candidateId}`;
}
