import {
  projectAssessedEvent,
  projectFinalizedEvent,
  ce0TurnId,
  CE0_WORK_TYPE_UNKNOWN,
} from "../../../src/lib/rules/ce0-telemetry-project";
import { hashMarkerSet } from "../../../src/lib/rules/ce0-telemetry";
import { deterministicEventId } from "../../../src/lib/analytics/event-id";
import type {
  TurnMemoryAssessmentRecord,
  TurnRuleObligationRecord,
  ConsultationAttemptRecord,
  RequirementSubject,
} from "../../../src/lib/rules/ce0-store";

// The offline telemetry sweep (`mla evidence ce0-emit-telemetry`) is a PURE projection of the CE0
// durable store into the §6.4 analytics events. Brutal honesty about scope: the store is a GRADING
// store, not a complete telemetry source, so only the two events it honestly backs are projected.
//
//   memory_requirement_assessed   one per assessment row (the precision/recall denominator)
//   evidence_obligation_finalized one per FINALIZED obligation row
//
// The store does NOT classify work_type and the human answer_disposition is set offline, so those
// ride as accurate "not recorded" constants (work_type "unknown", disposition null). The
// sampling_bucket is NOT a constant: the store records every turn's deterministic bucket (R3 P0.9),
// and the projection carries it verbatim so the offline unflagged-recall sample is reconstructible.
// satisfied_by_sources is ALSO recomputed, not constant: the live subjectSatisfaction is always [],
// so the projector replays the deterministic reducer over the turn's consultations (bounded by the
// frozen deadline) and resolves each proof back to its §1.6 source. Emitting a fabricated latency_ms
// (evidence_consultation_completed) or per-hook timing (evidence_hook_health) would be a false
// measurement, so those two live-only events are deliberately NOT projected here.

const assessment: TurnMemoryAssessmentRecord = {
  assessmentId: "asm_1",
  workspaceId: "ws_abc",
  sessionId: "sess_1",
  localTurnSequence: 7,
  requirement: "REQUIRED",
  markersMatched: ["what did we decide", "canonical"],
  exclusionsMatched: [],
  classifierVersion: "raw-prompt-substring-v1",
  markerSetVersion: "seed-v1",
  exclusionSetVersion: "seed-v1",
  createdAt: 1718700000000,
  samplingBucket: "bucket_asm_1",
  promptHash: "ph_asm_1",
};

const finalizedObligation: TurnRuleObligationRecord = {
  obligationId: "obl_1",
  workspaceId: "ws_abc",
  sessionId: "sess_1",
  localTurnSequence: 7,
  ruleId: "consult-evidence",
  ruleVersionId: "consult-evidence@ce0-v1",
  requiredSubjects: [],
  subjectSatisfaction: [],
  status: "FINALIZED",
  stateVersion: 4,
  deadlineClaimedAt: 3,
  deadlineClaimedVersion: 0,
  responseHash: "rh_deadbeef",
  outcome: "COMPLIANT_ON_TIME",
  canonicalPayloadHash: "cph_cafef00d",
};

function subject(over: Partial<RequirementSubject> = {}): RequirementSubject {
  return {
    subjectId: "subj_softgate",
    normalizedTerms: ["soft", "gate", "enforcement"],
    entityIds: ["ent_softgate"],
    decisionIds: [],
    conceptIds: [],
    fingerprint: "fp_subject_softgate",
    ...over,
  };
}

function consult(over: Partial<ConsultationAttemptRecord> = {}): ConsultationAttemptRecord {
  return {
    consultationId: "con_1",
    workspaceId: "ws_abc",
    sessionId: "sess_1",
    localTurnSequence: 7,
    source: "AGENT_PULL",
    consultationSubjects: [subject()],
    execution: "COMPLETE",
    result: "RESULTS_RETURNED",
    deliveredToAnsweringContext: true,
    orderingToken: 1,
    createdAt: 1718700000500,
    ...over,
  };
}

describe("ce0TurnId: the CE0 turn coordinate", () => {
  it("joins session and local turn sequence as `${session}:${seq}`", () => {
    expect(ce0TurnId("sess_1", 7)).toBe("sess_1:7");
  });
});

describe("projectAssessedEvent: an assessment row -> memory_requirement_assessed", () => {
  it("maps the row, carrying the real sampling bucket and an honest work_type constant", () => {
    expect(projectAssessedEvent(assessment)).toEqual({
      eventType: "memory_requirement_assessed",
      eventId: deterministicEventId("asm_1", 0),
      payload: {
        assessment_id: "asm_1",
        turn_id: "sess_1:7",
        local_turn_sequence: 7,
        memory_requirement: "REQUIRED",
        work_type: CE0_WORK_TYPE_UNKNOWN,
        classifier_version: "raw-prompt-substring-v1",
        marker_set_version: "seed-v1",
        markers_matched_hashed: hashMarkerSet(["what did we decide", "canonical"]),
        sampling_bucket: "bucket_asm_1",
      },
    });
  });

  it("carries the assessment's deterministic sampling bucket verbatim, not a constant (R3 P0.9)", () => {
    const ev = projectAssessedEvent({ ...assessment, samplingBucket: "f00dcafe" });
    expect(ev.payload.sampling_bucket).toBe("f00dcafe");
  });

  it("the one honest constant left is work_type 'unknown' (CE0 does not classify the turn)", () => {
    expect(CE0_WORK_TYPE_UNKNOWN).toBe("unknown");
  });

  it("projects a NOT_REQUIRED assessment too (it is the negative half of the denominator)", () => {
    const ev = projectAssessedEvent({ ...assessment, requirement: "NOT_REQUIRED" });
    expect(ev.payload.memory_requirement).toBe("NOT_REQUIRED");
  });
});

describe("projectFinalizedEvent: a FINALIZED obligation row -> evidence_obligation_finalized", () => {
  it("maps the row, with empty sources and a null disposition when nothing proved a subject", () => {
    expect(projectFinalizedEvent(finalizedObligation, [])).toEqual({
      eventType: "evidence_obligation_finalized",
      eventId: deterministicEventId("obl_1", 4),
      payload: {
        obligation_id: "obl_1",
        local_turn_sequence: 7,
        rule_version_id: "consult-evidence@ce0-v1",
        state_version: 4,
        outcome: "COMPLIANT_ON_TIME",
        satisfied_by_sources: [],
        answer_disposition: null,
      },
    });
  });

  it("resolves satisfied_by_sources from the sources of the consultations that proved a subject", () => {
    const obl = { ...finalizedObligation, requiredSubjects: [subject()], deadlineClaimedAt: 2 };
    const ev = projectFinalizedEvent(obl, [consult({ consultationId: "con_cover", orderingToken: 1 })]);
    expect(ev.payload.satisfied_by_sources).toEqual(["AGENT_PULL"]);
  });

  it("dedupes and sorts satisfied_by_sources in canonical CONSULTATION_SOURCES order", () => {
    // Disjoint terms AND ids so each subject is covered only by its own consultation (the matcher
    // is idIntersect OR term-containment; shared terms would let one consultation cover all three).
    const subjA = subject({ subjectId: "a", normalizedTerms: ["alpha"], entityIds: ["ent_a"], fingerprint: "fp_a" });
    const subjB = subject({ subjectId: "b", normalizedTerms: ["bravo"], entityIds: ["ent_b"], fingerprint: "fp_b" });
    const subjC = subject({ subjectId: "c", normalizedTerms: ["charlie"], entityIds: ["ent_c"], fingerprint: "fp_c" });
    const obl = { ...finalizedObligation, requiredSubjects: [subjA, subjB, subjC], deadlineClaimedAt: 3 };
    const ev = projectFinalizedEvent(obl, [
      consult({ consultationId: "c1", orderingToken: 1, consultationSubjects: [subjA] }),
      consult({ consultationId: "c2", orderingToken: 2, consultationSubjects: [subjB] }),
      consult({
        consultationId: "c3",
        orderingToken: 3,
        source: "PROACTIVE_PUSH",
        consultationSubjects: [subjC],
      }),
    ]);
    // two AGENT_PULL proofs collapse to one; PROACTIVE_PUSH sorts ahead of AGENT_PULL.
    expect(ev.payload.satisfied_by_sources).toEqual(["PROACTIVE_PUSH", "AGENT_PULL"]);
  });

  it("ignores consultations beyond the claimed deadline boundary (eligibility is frozen)", () => {
    const obl = { ...finalizedObligation, requiredSubjects: [subject()], deadlineClaimedAt: 1 };
    const ev = projectFinalizedEvent(obl, [
      consult({ consultationId: "late", orderingToken: 2, source: "PROACTIVE_PUSH" }),
    ]);
    expect(ev.payload.satisfied_by_sources).toEqual([]);
  });

  it("keys the eventId on (obligationId, stateVersion) so a re-import at the same version dedupes", () => {
    const a = projectFinalizedEvent(finalizedObligation, []);
    const b = projectFinalizedEvent({ ...finalizedObligation, stateVersion: 5 }, []);
    expect(a.eventId).toBe(deterministicEventId("obl_1", 4));
    expect(b.eventId).toBe(deterministicEventId("obl_1", 5));
    expect(a.eventId).not.toBe(b.eventId);
  });

  it("throws on an obligation with no outcome (a non-finalized row is not a telemetry fact)", () => {
    expect(() => projectFinalizedEvent({ ...finalizedObligation, outcome: null }, [])).toThrow(/obl_1/);
  });
});
