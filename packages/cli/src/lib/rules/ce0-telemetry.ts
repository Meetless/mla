// CE0 minimal telemetry: the EXACTLY four PostHog events the harness needs to measure
// precision, recall, the consultation rate, and hook health
// (notes/20260617-evidence-consultation-forcing-function-proposal.md §6.4, R3 P1.6):
//
//   memory_requirement_assessed      every classified turn (the precision/recall denominator)
//   evidence_consultation_completed  every governed-memory consultation, keyed by the consultation
//   evidence_obligation_finalized    emitted offline by the label importer (§2.3)
//   evidence_hook_health             the latency/health watchdog
//
// These are PURE projections: a CE0 record -> the analytics RecordInput the recorder ships. No I/O,
// no clock; the recorder supplies the envelope (workspace, session, run, trace, timestamps). The
// privacy boundary (INV-POSTHOG-PII-1) holds field by field: ids, enums, counts, booleans,
// durations, and hashes only. markersMatched is hashed here, never emitted verbatim.
//
// eventId strategy mirrors event-id.ts's server-recomputable family. ALL FOUR events carry a
// deterministic id so a hook re-firing across processes dedupes on (businessKey, version): the
// assessment on (assessmentId, 0), the consultation on (consultationId, 0), the finalization on
// (obligationId, stateVersion), and the health watchdog on (hook + operationIdentity, 0). The health
// event's operationIdentity is the stable per-hook coordinate the hook acted on (§6.4 P0.2), so a
// retried hook hashes to the same id rather than minting a fresh CLI-origin id and double-counting.

import * as crypto from "crypto";

import { deterministicEventId } from "../analytics/event-id";
import type { RecordInput } from "../analytics/recorder";
import {
  OBLIGATION_OUTCOME_LABELS,
  type MemoryRequirementLabel,
  type ConsultationExecutionLabel,
  type ConsultationResultLabel,
  type ObligationOutcomeLabel,
  type Ce0Hook,
} from "../analytics/envelope";

const OBLIGATION_OUTCOME_SET: ReadonlySet<string> = new Set(OBLIGATION_OUTCOME_LABELS);

/** Hash a marker set to a stable hex digest. Order-independent (the SET, not the sequence, is the
 * identity) and one-way, so the matched markers never leave the device as raw text (§6.4 privacy). */
export function hashMarkerSet(markers: string[]): string {
  const canonical = [...new Set(markers)].sort().join("\n");
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

export interface MemoryRequirementAssessedInput {
  assessmentId: string;
  turnId: string;
  localTurnSequence: number;
  memoryRequirement: MemoryRequirementLabel;
  workType: string;
  classifierVersion: string;
  markerSetVersion: string;
  markersMatched: string[];
  samplingBucket: string;
}

/** One event per classified turn (REQUIRED or not). Without it the precision/recall denominator
 * (the turns you did NOT flag) is unobservable. Carries no obligationId by design. */
export function buildMemoryRequirementAssessedEvent(
  input: MemoryRequirementAssessedInput,
): RecordInput {
  return {
    eventType: "memory_requirement_assessed",
    eventId: deterministicEventId(input.assessmentId, 0),
    payload: {
      assessment_id: input.assessmentId,
      turn_id: input.turnId,
      local_turn_sequence: input.localTurnSequence,
      memory_requirement: input.memoryRequirement,
      work_type: input.workType,
      classifier_version: input.classifierVersion,
      marker_set_version: input.markerSetVersion,
      markers_matched_hashed: hashMarkerSet(input.markersMatched),
      sampling_bucket: input.samplingBucket,
    },
  };
}

export interface EvidenceConsultationCompletedInput {
  consultationId: string;
  localTurnSequence: number;
  /** OPTIONAL (§6.4 R4 P1.2): present only when the turn holds an obligation and therefore a rule
   * version. A consultation can fire on a NOT_REQUIRED / UNKNOWN turn that carries neither, so the
   * field is omitted from the payload rather than forced to a placeholder. */
  ruleVersionId?: string;
  source: string;
  execution: ConsultationExecutionLabel;
  result: ConsultationResultLabel | null;
  deliveredToAnsweringContext: boolean;
  /** OPTIONAL (§6.4 P0.2): the monotonic retrieval-start to result-capture latency of this one
   * consultation; absent when no retrieval was timed (a proactive push observed after the fact). */
  latencyMs?: number;
}

/** One event per governed-memory consultation, keyed by the consultation (NOT the obligation). No
 * FULL/PARTIAL/NONE coverage summary in CE0: coverage grading is offline (§1.6). `ruleVersionId` and
 * `latencyMs` are optional (§6.4 P1.2 / P0.2) and carried only when the turn supplies them, mirroring
 * the health event's optional `turnId`. */
export function buildEvidenceConsultationCompletedEvent(
  input: EvidenceConsultationCompletedInput,
): RecordInput {
  // §6.4 / P0.3: result is present IFF the consultation is COMPLETE.
  const complete = input.execution === "COMPLETE";
  if (complete !== (input.result !== null)) {
    throw new Error(
      `evidence_consultation_completed: result must be present IFF execution is COMPLETE ` +
        `(execution=${input.execution}, result=${input.result})`,
    );
  }
  const payload: Record<string, unknown> = {
    consultation_id: input.consultationId,
    local_turn_sequence: input.localTurnSequence,
    source: input.source,
    execution: input.execution,
    result: input.result,
    delivered_to_answering_context: input.deliveredToAnsweringContext,
  };
  if (input.ruleVersionId !== undefined) payload.rule_version_id = input.ruleVersionId;
  if (input.latencyMs !== undefined) payload.latency_ms = input.latencyMs;
  return {
    eventType: "evidence_consultation_completed",
    eventId: deterministicEventId(input.consultationId, 0),
    payload,
  };
}

export interface EvidenceObligationFinalizedInput {
  obligationId: string;
  localTurnSequence: number;
  ruleVersionId: string;
  stateVersion: number;
  outcome: ObligationOutcomeLabel;
  /** The distinct §1.6 sources that proved a required subject, in canonical order. Plural because
   * one turn can be satisfied jointly by an agent pull and a proactive push; empty when nothing
   * proved a subject. */
  satisfiedBySources: string[];
  answerDisposition: string | null;
}

/** Emitted by the offline label importer (§2.3) when an obligation finalizes. Server-recomputable on
 * (obligationId, stateVersion): a re-import at the same stateVersion dedupes; a later finalization
 * (a new stateVersion) is a distinct row. */
export function buildEvidenceObligationFinalizedEvent(
  input: EvidenceObligationFinalizedInput,
): RecordInput {
  if (!OBLIGATION_OUTCOME_SET.has(input.outcome)) {
    throw new Error(
      `evidence_obligation_finalized: outcome "${input.outcome}" is not a §6.4 ObligationOutcome`,
    );
  }
  return {
    eventType: "evidence_obligation_finalized",
    eventId: deterministicEventId(input.obligationId, input.stateVersion),
    payload: {
      obligation_id: input.obligationId,
      local_turn_sequence: input.localTurnSequence,
      rule_version_id: input.ruleVersionId,
      state_version: input.stateVersion,
      outcome: input.outcome,
      satisfied_by_sources: input.satisfiedBySources,
      answer_disposition: input.answerDisposition,
    },
  };
}

export interface EvidenceHookHealthInput {
  hook: Ce0Hook;
  /** The stable per-hook coordinate the hook acted on (§6.4): USER_PROMPT_SUBMIT -> assessmentId,
   * CONSULTATION_CAPTURE -> consultationId, STOP -> the LocalTurnIdentity, OFFLINE_LABEL_IMPORT ->
   * obligationId + final stateVersion. It keys the deterministic eventId so a re-fired hook dedups. */
  operationIdentity: string;
  durationMs: number;
  failed: boolean;
  reason: string | null;
  /** OPTIONAL harness turn id; carried only when supplied (the LocalTurnIdentity on the envelope is
   * authoritative, R3 P0.5). */
  turnId?: string;
}

/** The latency/health watchdog: one row per hook invocation. Keyed by (hook, operationIdentity) so a
 * hook that re-fires across processes (a Stop continuation, a retry) re-appends the SAME deterministic
 * eventId and the projection dedups it instead of double-counting (§6.4 P0.2). */
export function buildEvidenceHookHealthEvent(input: EvidenceHookHealthInput): RecordInput {
  const payload: Record<string, unknown> = {
    hook: input.hook,
    operation_identity: input.operationIdentity,
    duration_ms: input.durationMs,
    failed: input.failed,
    reason: input.reason,
  };
  if (input.turnId !== undefined) payload.turn_id = input.turnId;
  return {
    eventType: "evidence_hook_health",
    eventId: deterministicEventId(`${input.hook}:${input.operationIdentity}`, 0),
    payload,
  };
}
