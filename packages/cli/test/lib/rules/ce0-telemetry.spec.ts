import * as crypto from "crypto";

import { deterministicEventId } from "../../../src/lib/analytics/event-id";
import {
  hashMarkerSet,
  buildMemoryRequirementAssessedEvent,
  buildEvidenceConsultationCompletedEvent,
  buildEvidenceObligationFinalizedEvent,
  buildEvidenceHookHealthEvent,
  type MemoryRequirementAssessedInput,
  type EvidenceConsultationCompletedInput,
  type EvidenceObligationFinalizedInput,
  type EvidenceHookHealthInput,
} from "../../../src/lib/rules/ce0-telemetry";

// Commit 10: CE0 minimal telemetry is EXACTLY four PostHog events (notes/20260617-evidence-
// consultation-forcing-function-proposal.md §6.4, R3 P1.6): memory_requirement_assessed,
// evidence_consultation_completed, evidence_obligation_finalized, evidence_hook_health. These
// pure builders project a CE0 record into the analytics RecordInput the recorder ships. The
// privacy boundary (INV-POSTHOG-PII-1): ids / enums / counts / booleans / durations only, never
// raw governed text; markersMatched is hashed, never emitted verbatim. ALL FOUR events carry a
// deterministic, server-recomputable eventId so a hook re-fire across processes dedupes; the health
// watchdog keys its id on (hook, operationIdentity) (§6.4 P0.2).

describe("hashMarkerSet", () => {
  it("hashes a marker set to a 64-char hex digest, never the raw text", () => {
    const digest = hashMarkerSet(["softgate", "enforcement"]);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).not.toContain("softgate");
    expect(digest).not.toContain("enforcement");
  });

  it("is order-independent (the set, not the sequence, is the identity)", () => {
    expect(hashMarkerSet(["a", "b"])).toBe(hashMarkerSet(["b", "a"]));
  });

  it("distinguishes distinct marker sets", () => {
    expect(hashMarkerSet(["a", "b"])).not.toBe(hashMarkerSet(["a", "c"]));
  });
});

const assessmentInput = (
  over: Partial<MemoryRequirementAssessedInput> = {},
): MemoryRequirementAssessedInput => ({
  assessmentId: "asmt_1",
  turnId: "turn_7",
  localTurnSequence: 7,
  memoryRequirement: "REQUIRED",
  workType: "code_change",
  classifierVersion: "memreq-v1",
  markerSetVersion: "marker-seed-v1",
  markersMatched: ["softgate", "enforcement"],
  samplingBucket: "bucket_3",
  ...over,
});

describe("buildMemoryRequirementAssessedEvent", () => {
  it("projects the §6.4 payload with a deterministic eventId keyed by (assessmentId, 0)", () => {
    const ev = buildMemoryRequirementAssessedEvent(assessmentInput());

    expect(ev.eventType).toBe("memory_requirement_assessed");
    expect(ev.eventId).toBe(deterministicEventId("asmt_1", 0));
    expect(ev.payload).toEqual({
      assessment_id: "asmt_1",
      turn_id: "turn_7",
      local_turn_sequence: 7,
      memory_requirement: "REQUIRED",
      work_type: "code_change",
      classifier_version: "memreq-v1",
      marker_set_version: "marker-seed-v1",
      markers_matched_hashed: hashMarkerSet(["softgate", "enforcement"]),
      sampling_bucket: "bucket_3",
    });
  });

  it("never carries the raw matched markers in the serialized payload (privacy)", () => {
    const ev = buildMemoryRequirementAssessedEvent(assessmentInput());
    const json = JSON.stringify(ev.payload);
    expect(json).not.toContain("softgate");
    expect(json).not.toContain("enforcement");
  });
});

const consultationInput = (
  over: Partial<EvidenceConsultationCompletedInput> = {},
): EvidenceConsultationCompletedInput => ({
  consultationId: "con_1",
  localTurnSequence: 7,
  ruleVersionId: "consult-evidence@ce0-v1",
  source: "MCP_RETRIEVE_KNOWLEDGE",
  execution: "COMPLETE",
  result: "RESULTS_RETURNED",
  deliveredToAnsweringContext: true,
  latencyMs: 42,
  ...over,
});

describe("buildEvidenceConsultationCompletedEvent", () => {
  it("projects the §6.4 payload with a deterministic eventId keyed by (consultationId, 0)", () => {
    const ev = buildEvidenceConsultationCompletedEvent(consultationInput());

    expect(ev.eventType).toBe("evidence_consultation_completed");
    expect(ev.eventId).toBe(deterministicEventId("con_1", 0));
    expect(ev.payload).toEqual({
      consultation_id: "con_1",
      local_turn_sequence: 7,
      rule_version_id: "consult-evidence@ce0-v1",
      source: "MCP_RETRIEVE_KNOWLEDGE",
      execution: "COMPLETE",
      result: "RESULTS_RETURNED",
      delivered_to_answering_context: true,
      latency_ms: 42,
    });
  });

  it("carries a null result for a non-COMPLETE consultation", () => {
    const ev = buildEvidenceConsultationCompletedEvent(
      consultationInput({ execution: "FAILED", result: null }),
    );
    expect(ev.payload).toMatchObject({ execution: "FAILED", result: null });
  });

  it("rejects a result on a non-COMPLETE consultation (result present IFF COMPLETE)", () => {
    expect(() =>
      buildEvidenceConsultationCompletedEvent(
        consultationInput({ execution: "FAILED", result: "NO_MATCH" }),
      ),
    ).toThrow(/COMPLETE/i);
  });

  it("rejects a COMPLETE consultation with no result (result present IFF COMPLETE)", () => {
    expect(() =>
      buildEvidenceConsultationCompletedEvent(
        consultationInput({ execution: "COMPLETE", result: null }),
      ),
    ).toThrow(/COMPLETE/i);
  });

  it("omits rule_version_id for a consultation on a NOT_REQUIRED / UNKNOWN turn that holds no rule version (P1.2)", () => {
    const ev = buildEvidenceConsultationCompletedEvent({
      consultationId: "con_2",
      localTurnSequence: 4,
      source: "AGENT_PULL",
      execution: "COMPLETE",
      result: "NO_MATCH",
      deliveredToAnsweringContext: false,
      latencyMs: 9,
    });
    expect(ev.payload).not.toHaveProperty("rule_version_id");
    // still keyed by the consultation, and the rest of the §6.4 payload is intact
    expect(ev.eventId).toBe(deterministicEventId("con_2", 0));
    expect(ev.payload).toMatchObject({ consultation_id: "con_2", source: "AGENT_PULL", latency_ms: 9 });
  });

  it("omits latency_ms for a push consultation observed after the fact, with no timed retrieval (P0.2)", () => {
    const ev = buildEvidenceConsultationCompletedEvent({
      consultationId: "con_3",
      localTurnSequence: 5,
      ruleVersionId: "consult-evidence@ce0-v1",
      source: "PROACTIVE_PUSH",
      execution: "UNKNOWN",
      result: null,
      deliveredToAnsweringContext: true,
    });
    expect(ev.payload).not.toHaveProperty("latency_ms");
    expect(ev.payload).toMatchObject({
      consultation_id: "con_3",
      rule_version_id: "consult-evidence@ce0-v1",
      source: "PROACTIVE_PUSH",
    });
  });

  it("carries both optional fields when the turn supplies them (presence is allowed, not forbidden)", () => {
    const ev = buildEvidenceConsultationCompletedEvent(consultationInput());
    expect(ev.payload).toMatchObject({ rule_version_id: "consult-evidence@ce0-v1", latency_ms: 42 });
  });
});

const finalizedInput = (
  over: Partial<EvidenceObligationFinalizedInput> = {},
): EvidenceObligationFinalizedInput => ({
  obligationId: "obl_1",
  localTurnSequence: 7,
  ruleVersionId: "consult-evidence@ce0-v1",
  stateVersion: 2,
  outcome: "COMPLIANT_ON_TIME",
  satisfiedBySources: ["AGENT_PULL"],
  answerDisposition: null,
  ...over,
});

describe("buildEvidenceObligationFinalizedEvent", () => {
  it("projects the §6.4 payload with a deterministic eventId keyed by (obligationId, stateVersion)", () => {
    const ev = buildEvidenceObligationFinalizedEvent(finalizedInput());

    expect(ev.eventType).toBe("evidence_obligation_finalized");
    expect(ev.eventId).toBe(deterministicEventId("obl_1", 2));
    expect(ev.payload).toEqual({
      obligation_id: "obl_1",
      local_turn_sequence: 7,
      rule_version_id: "consult-evidence@ce0-v1",
      state_version: 2,
      outcome: "COMPLIANT_ON_TIME",
      satisfied_by_sources: ["AGENT_PULL"],
      answer_disposition: null,
    });
  });

  it("gives a re-finalized obligation (next stateVersion) a fresh deterministic id", () => {
    const a = buildEvidenceObligationFinalizedEvent(finalizedInput({ stateVersion: 2 }));
    const b = buildEvidenceObligationFinalizedEvent(finalizedInput({ stateVersion: 3 }));
    expect(a.eventId).not.toBe(b.eventId);
  });

  it("rejects an outcome outside the §6.4 enum", () => {
    expect(() =>
      buildEvidenceObligationFinalizedEvent(
        finalizedInput({ outcome: "TOTALLY_BOGUS" as EvidenceObligationFinalizedInput["outcome"] }),
      ),
    ).toThrow(/outcome/i);
  });
});

const healthInput = (over: Partial<EvidenceHookHealthInput> = {}): EvidenceHookHealthInput => ({
  hook: "USER_PROMPT_SUBMIT",
  operationIdentity: "asmt_1",
  durationMs: 12,
  failed: false,
  reason: null,
  ...over,
});

describe("buildEvidenceHookHealthEvent", () => {
  it("projects the §6.4 payload with a deterministic eventId keyed by (hook, operationIdentity)", () => {
    const ev = buildEvidenceHookHealthEvent(healthInput());

    expect(ev.eventType).toBe("evidence_hook_health");
    expect(ev.eventId).toBe(deterministicEventId("USER_PROMPT_SUBMIT:asmt_1", 0));
    expect(ev.payload).toEqual({
      hook: "USER_PROMPT_SUBMIT",
      operation_identity: "asmt_1",
      duration_ms: 12,
      failed: false,
      reason: null,
    });
  });

  it("re-fires to the SAME eventId for one (hook, operationIdentity) so a retried hook dedups (P0.2)", () => {
    const a = buildEvidenceHookHealthEvent(healthInput());
    const b = buildEvidenceHookHealthEvent(healthInput({ durationMs: 99, failed: true, reason: "TIMEOUT" }));
    expect(a.eventId).toBe(b.eventId);
  });

  it("distinguishes the same operation coordinate observed by two different hooks", () => {
    const stop = buildEvidenceHookHealthEvent(healthInput({ hook: "STOP", operationIdentity: "ws:sess:7" }));
    const capture = buildEvidenceHookHealthEvent(
      healthInput({ hook: "CONSULTATION_CAPTURE", operationIdentity: "ws:sess:7" }),
    );
    expect(stop.eventId).not.toBe(capture.eventId);
  });

  it("carries an optional turnId as turn_id only when the harness supplies one", () => {
    const without = buildEvidenceHookHealthEvent(healthInput());
    expect(without.payload).not.toHaveProperty("turn_id");

    const withTurn = buildEvidenceHookHealthEvent(healthInput({ turnId: "turn_7" }));
    expect(withTurn.payload).toMatchObject({ turn_id: "turn_7" });
  });

  it("carries a classified failure reason code when a hook fails", () => {
    const ev = buildEvidenceHookHealthEvent(
      healthInput({
        hook: "OFFLINE_LABEL_IMPORT",
        operationIdentity: "obl_1:2",
        durationMs: 88,
        failed: true,
        reason: "DB_LOCKED",
      }),
    );
    expect(ev.payload).toMatchObject({ hook: "OFFLINE_LABEL_IMPORT", failed: true, reason: "DB_LOCKED" });
  });
});
