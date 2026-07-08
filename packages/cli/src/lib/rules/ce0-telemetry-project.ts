// CE0 offline telemetry projection: the CE0 durable store -> the §6.4 analytics events the harness
// measures precision/recall and outcome rates with. Pure: a store record in, an analytics
// RecordInput out; no I/O, no clock (the `mla evidence ce0-emit-telemetry` sweep supplies the store
// and the recorder supplies the envelope).
//
// Brutal honesty about scope. The CE0 store is a GRADING store, not a complete telemetry source, so
// only the two events it honestly backs are projected:
//
//   memory_requirement_assessed   one per assessment row (the precision/recall denominator)
//   evidence_obligation_finalized one per FINALIZED obligation row
//
// The other two §6.4 events are live-only and deliberately NOT projected here: a fabricated
// latency_ms (evidence_consultation_completed) or per-hook duration (evidence_hook_health) has no
// honest offline value, and zero would be a false measurement.
//
// work_type rides as an accurate "not recorded" constant (CE0 does not classify the turn), as does
// the finalized event's answer_disposition (a human label set offline, never on the live obligation,
// so null is honest here). The sampling_bucket is NOT a constant: every assessment row carries its
// own deterministic bucket (R3 P0.9), projected verbatim so the offline unflagged-recall sample is
// reconstructible. satisfied_by_sources is ALSO not a constant: the live obligation's
// subjectSatisfaction is always [] (the runtime only records facts), so the projector recomputes the
// proof set offline exactly as ce0-export does, then resolves each proof's consultation back to the
// §1.6 source that initiated it. The recompute is bounded by the same frozen deadline the first Stop
// claimed, so a late consultation can never manufacture an on-time source.

import type { RecordInput } from "../analytics/recorder";
import type { ObligationOutcomeLabel } from "../analytics/envelope";
import {
  consultationRecordToReducerInput,
  type TurnMemoryAssessmentRecord,
  type TurnRuleObligationRecord,
  type ConsultationAttemptRecord,
  type ConsultationSource,
} from "./ce0-store";
import {
  selectEligibleConsultations,
  recomputeSubjectSatisfaction,
  CONSULTATION_SOURCES,
} from "./requirement-subject";
import {
  buildMemoryRequirementAssessedEvent,
  buildEvidenceObligationFinalizedEvent,
} from "./ce0-telemetry";

/** CE0 does not classify the turn's work type. */
export const CE0_WORK_TYPE_UNKNOWN = "unknown";

/** The CE0 turn coordinate carried in telemetry: the (session, sequence) pair the analytics side
 * joins on. The assessment/obligation rows store both halves; this is their canonical rendering. */
export function ce0TurnId(sessionId: string, localTurnSequence: number): string {
  return `${sessionId}:${localTurnSequence}`;
}

/** Project one assessment row into a memory_requirement_assessed event. EVERY assessment is a
 * telemetry fact (REQUIRED or not): the negative half is the precision/recall denominator. */
export function projectAssessedEvent(rec: TurnMemoryAssessmentRecord): RecordInput {
  return buildMemoryRequirementAssessedEvent({
    assessmentId: rec.assessmentId,
    turnId: ce0TurnId(rec.sessionId, rec.localTurnSequence),
    localTurnSequence: rec.localTurnSequence,
    memoryRequirement: rec.requirement,
    workType: CE0_WORK_TYPE_UNKNOWN,
    classifierVersion: rec.classifierVersion,
    markerSetVersion: rec.markerSetVersion,
    markersMatched: rec.markersMatched,
    samplingBucket: rec.samplingBucket,
  });
}

/**
 * Recompute the distinct §1.6 sources that proved a required subject for this obligation, in
 * canonical CONSULTATION_SOURCES order. The live subjectSatisfaction is always [] in CE0, so this
 * mirrors ce0-export: map the turn's consultations onto the reducer input, take the eligible set
 * bounded by the frozen deadline, recompute the proof set, then resolve each proof's consultation
 * back to its source. Deduped (the tuple lists each source once) and stably ordered.
 */
function resolveSatisfiedSources(
  obl: TurnRuleObligationRecord,
  consultations: readonly ConsultationAttemptRecord[],
): ConsultationSource[] {
  const eligible = selectEligibleConsultations(
    consultations.map(consultationRecordToReducerInput),
    obl.deadlineClaimedAt,
  );
  const proofs = recomputeSubjectSatisfaction(obl.requiredSubjects, eligible);
  const sourceById = new Map(consultations.map((c) => [c.consultationId, c.source]));
  const proven = new Set<ConsultationSource>();
  for (const proof of proofs) {
    const source = sourceById.get(proof.consultationId);
    if (source) proven.add(source);
  }
  return CONSULTATION_SOURCES.filter((s) => proven.has(s));
}

/** Project one FINALIZED obligation row into an evidence_obligation_finalized event. The DB
 * invariant ties FINALIZED to a non-null outcome, so a null outcome means the caller handed in a
 * non-finalized row; reject it loudly rather than emit a malformed event. The turn's consultations
 * are passed alongside the obligation so the projector can recompute which sources proved a subject
 * (the live subjectSatisfaction is always [] in CE0). */
export function projectFinalizedEvent(
  obl: TurnRuleObligationRecord,
  consultations: readonly ConsultationAttemptRecord[],
): RecordInput {
  if (obl.outcome === null) {
    throw new Error(
      `projectFinalizedEvent: obligation ${obl.obligationId} has no outcome (not FINALIZED)`,
    );
  }
  return buildEvidenceObligationFinalizedEvent({
    obligationId: obl.obligationId,
    localTurnSequence: obl.localTurnSequence,
    ruleVersionId: obl.ruleVersionId,
    stateVersion: obl.stateVersion,
    outcome: obl.outcome as ObligationOutcomeLabel,
    satisfiedBySources: resolveSatisfiedSources(obl, consultations),
    answerDisposition: null,
  });
}
