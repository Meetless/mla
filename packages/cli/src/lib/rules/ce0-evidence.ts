// Commit 9: the `mla evidence` CE0 labeling workflow, export half
// (notes/20260617-evidence-consultation-forcing-function-proposal.md §2.3). CE0 finalization is
// a human-driven LOCAL JSONL workflow: no model call, no external egress, no second deterministic
// finalizer. `ce0-export` writes a JSONL of the three-record facts a labeler needs for answer
// disposition and per-subject coverage audit; `ce0-import-labels` (slice 9b) reads the labeled
// file back, verifies each obligation's id and expected stateVersion, writes the terminal outcome,
// and moves status to FINALIZED.
//
// The CE0 nuance this module resolves: the live store never writes subjectSatisfaction. The
// runtime adapters only record facts (the assessment, the consultation attempts) and the first
// Stop freezes the eligibility boundary; the live subjectSatisfaction stays []. So the export is
// the one place the deterministic satisfaction reducer runs: it selects the eligible consultations
// (those that contributed a proof AND landed on or before the frozen deadline boundary) and
// recomputes the per-subject proof set. That recomputed set, NOT the live [], is the machine
// baseline the human audits against the terminal outcome they assign.

import {
  listDeadlineClaimedObligations,
  listConsultationsForTurn,
  finalizeObligation,
  consultationRecordToReducerInput,
  type Ce0Store,
  type RequirementSubject,
  type SubjectSatisfactionProof,
  type ConsultationExecution,
  type ConsultationResult,
  type ConsultationSource,
} from "./ce0-store";
import {
  selectEligibleConsultations,
  recomputeSubjectSatisfaction,
  isObligationSatisfied,
} from "./requirement-subject";
import {
  assembleCe0RecallSampleRows,
  DEFAULT_RECALL_SAMPLE_RATE,
  type Ce0RecallSampleRow,
} from "./ce0-recall-sample";

/** One consultation as it appears in the export: the persisted fact verbatim, plus the single
 * derived signal the labeler should not have to re-derive by hand, `eligible` (did it contribute
 * a proof AND land on or before the frozen deadline boundary?). */
export interface Ce0ExportConsultation {
  consultationId: string;
  /** How the consultation was initiated (the §1.6 source). Carried verbatim from the stored
   * record so the labeler sees whether a proof came from an agent pull or a proactive push. */
  source: ConsultationSource;
  consultationSubjects: RequirementSubject[];
  execution: ConsultationExecution;
  result: ConsultationResult | null;
  deliveredToAnsweringContext: boolean;
  orderingToken: number;
  /** Within the frozen boundary AND COMPLETE AND delivered: the §1.6 proof-eligibility test. */
  eligible: boolean;
}

/** One obligation as it appears in the export. Carries the frozen obligation facts (§2.3) plus
 * the deterministic machine baseline recomputed over the eligible set. `obligationId` and
 * `stateVersion` are the coordinates ce0-import-labels verifies before finalizing. */
export interface Ce0ExportRow {
  obligationId: string;
  workspaceId: string;
  sessionId: string;
  localTurnSequence: number;
  ruleId: string;
  ruleVersionId: string;
  requiredSubjects: RequirementSubject[];
  /** The frozen live lifecycle (CE0: OPEN; never SATISFIED, as there is no live accumulator).
   * Import does not branch on this; it CAS-verifies stateVersion. */
  status: string;
  /** The CAS token ce0-import-labels must match to finalize this obligation. */
  stateVersion: number;
  /** The frozen eligibility boundary: the turn's high-water orderingToken at the first Stop. */
  deadlineClaimedAt: number;
  deadlineClaimedVersion: number;
  responseHash: string | null;
  /** The deterministic machine baseline: recomputeSubjectSatisfaction over the eligible set. NOT
   * the live stored value (which is always [] in CE0). */
  subjectSatisfaction: SubjectSatisfactionProof[];
  /** isObligationSatisfied(requiredSubjects, subjectSatisfaction): the machine's on-time verdict
   * the human compares their disposition against. */
  machineSatisfied: boolean;
  consultations: Ce0ExportConsultation[];
}

/**
 * Build the export rows for a workspace: one per deadline-claimed, non-finalized obligation. For
 * each, read the turn's consultations, run the deterministic reducer over the eligible set bounded
 * by the frozen deadline, and carry the recomputed proof set plus the raw consultation facts with
 * their eligibility flag. Deterministic and side-effect-free; the store reads are already ordered.
 */
export function assembleCe0ExportRows(store: Ce0Store, workspaceId: string): Ce0ExportRow[] {
  const rows: Ce0ExportRow[] = [];
  for (const obl of listDeadlineClaimedObligations(store, workspaceId)) {
    // FINALIZED obligations are already labeled; the export is for the set awaiting a label.
    if (obl.status === "FINALIZED") continue;

    const consultations = listConsultationsForTurn(store, {
      workspaceId: obl.workspaceId,
      sessionId: obl.sessionId,
      localTurnSequence: obl.localTurnSequence,
    });
    const reducerInputs = consultations.map(consultationRecordToReducerInput);
    const eligible = selectEligibleConsultations(reducerInputs, obl.deadlineClaimedAt);
    const eligibleIds = new Set(eligible.map((c) => c.consultationId));
    const subjectSatisfaction = recomputeSubjectSatisfaction(obl.requiredSubjects, eligible);

    rows.push({
      obligationId: obl.obligationId,
      workspaceId: obl.workspaceId,
      sessionId: obl.sessionId,
      localTurnSequence: obl.localTurnSequence,
      ruleId: obl.ruleId,
      ruleVersionId: obl.ruleVersionId,
      requiredSubjects: obl.requiredSubjects,
      status: obl.status,
      stateVersion: obl.stateVersion,
      deadlineClaimedAt: obl.deadlineClaimedAt as number,
      deadlineClaimedVersion: obl.deadlineClaimedVersion as number,
      responseHash: obl.responseHash,
      subjectSatisfaction,
      machineSatisfied: isObligationSatisfied(obl.requiredSubjects, subjectSatisfaction),
      consultations: consultations.map((c) => ({
        consultationId: c.consultationId,
        source: c.source,
        consultationSubjects: c.consultationSubjects,
        execution: c.execution,
        result: c.result,
        deliveredToAnsweringContext: c.deliveredToAnsweringContext,
        orderingToken: c.orderingToken,
        eligible: eligibleIds.has(c.consultationId),
      })),
    });
  }
  return rows;
}

/** Serialize export rows as JSONL: one JSON object per line, newline-terminated. An empty set
 * serializes to the empty string (no spurious blank line). */
export function serializeCe0ExportRows(rows: readonly Ce0ExportRow[]): string {
  return rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length > 0 ? "\n" : "");
}

/** Parse a JSONL export back into rows, ignoring blank lines so a trailing newline round-trips. */
export function parseCe0ExportRows(jsonl: string): Ce0ExportRow[] {
  return jsonl
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Ce0ExportRow);
}

// ---------------------------------------------------------------------------
// The two-population export file (R4 P0.1 / P0.2, proposal lines 1010-1019). ce0-export is a
// precision/recall evaluation artifact, not just an obligation dump. Precision needs the REQUIRED
// turns (the obligation rows above); recall needs the unflagged turns we sampled (Ce0RecallSampleRow).
// Both ride one JSONL so precision and recall share a single labeled file. `population` is a property
// of the LINE, not of the obligation or the assessment: an explicit discriminant lets a human (and any
// downstream parser) split the two populations without structural guessing.
// ---------------------------------------------------------------------------

/** One line of the ce0-export JSONL: a discriminated envelope over the two populations. A PRECISION
 * line carries a deadline-claimed obligation (Ce0ExportRow); a RECALL line carries a sampled unflagged
 * assessment (Ce0RecallSampleRow), which by construction has no obligation. */
export type Ce0ExportLine =
  | { population: "PRECISION"; obligation: Ce0ExportRow }
  | { population: "RECALL"; recall: Ce0RecallSampleRow };

/**
 * Assemble the full export stream for a workspace: every precision (obligation) line first, then every
 * recall (sampled unflagged assessment) line. `recallSampleRate` thresholds the recall population only;
 * the precision population is always complete. Deterministic and side-effect-free.
 */
export function assembleCe0ExportLines(
  store: Ce0Store,
  workspaceId: string,
  recallSampleRate: number,
): Ce0ExportLine[] {
  const lines: Ce0ExportLine[] = [];
  for (const obligation of assembleCe0ExportRows(store, workspaceId)) {
    lines.push({ population: "PRECISION", obligation });
  }
  for (const recall of assembleCe0RecallSampleRows(store, workspaceId, recallSampleRate)) {
    lines.push({ population: "RECALL", recall });
  }
  return lines;
}

/** Serialize export lines as JSONL: one JSON object per line, newline-terminated. An empty stream
 * serializes to the empty string (no spurious blank line). */
export function serializeCe0ExportLines(lines: readonly Ce0ExportLine[]): string {
  return lines.map((l) => JSON.stringify(l)).join("\n") + (lines.length > 0 ? "\n" : "");
}

/** Parse a JSONL export back into lines, ignoring blank lines so a trailing newline round-trips. */
export function parseCe0ExportLines(jsonl: string): Ce0ExportLine[] {
  return jsonl
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Ce0ExportLine);
}

/** The `mla evidence ce0-export` core: assemble the workspace's two-population stream and serialize it.
 * `recallSampleRate` defaults to the pinned DEFAULT_RECALL_SAMPLE_RATE (sample every unflagged turn). */
export function runCe0Export(
  store: Ce0Store,
  workspaceId: string,
  recallSampleRate: number = DEFAULT_RECALL_SAMPLE_RATE,
): string {
  return serializeCe0ExportLines(assembleCe0ExportLines(store, workspaceId, recallSampleRate));
}

// ---------------------------------------------------------------------------
// The import half: `mla evidence ce0-import-labels`. The human labeler reads the export, assigns
// each obligation a terminal outcome and per-subject coverage grades, and imports the labeled
// JSONL. reconcileCe0Labels is the pure pre-flight validation against the export snapshot;
// runCe0ImportLabels assembles the live export set, reconciles, then CAS-finalizes each valid
// label. No model call, no external egress (gate 8): finalization is a local human decision.
// ---------------------------------------------------------------------------

/** The seven terminal outcomes a labeler may assign (§2.3). NOT_DUE is deliberately distinct from
 * CANCELLED: they have opposite denominator effects in the §6.3 metrics and are never merged. */
export type ObligationOutcome =
  | "NOT_DUE"
  | "COMPLIANT_ON_TIME"
  | "CONSULTED_LATE_WITH_EVIDENCE"
  | "CONSULTED_LATE_NO_EVIDENCE"
  | "MISSED"
  | "UNKNOWN"
  | "CANCELLED";

const OBLIGATION_OUTCOMES: ReadonlySet<string> = new Set<ObligationOutcome>([
  "NOT_DUE",
  "COMPLIANT_ON_TIME",
  "CONSULTED_LATE_WITH_EVIDENCE",
  "CONSULTED_LATE_NO_EVIDENCE",
  "MISSED",
  "UNKNOWN",
  "CANCELLED",
]);

/** The four offline coverage grades a labeler may give a required subject (§1.6 CoverageAuditLabel). */
export type CoverageGrade = "FULL" | "PARTIAL" | "NONE" | "UNKNOWN";

const COVERAGE_GRADES: ReadonlySet<string> = new Set<CoverageGrade>([
  "FULL",
  "PARTIAL",
  "NONE",
  "UNKNOWN",
]);

/** One labeled obligation in the imported JSONL: the CAS coordinates (obligationId +
 * expectedStateVersion), the human's terminal outcome, and the per-subject CoverageAuditLabel.
 * `labeledBy` is always HUMAN in CE0 (no model egress). */
export interface Ce0LabelRow {
  obligationId: string;
  expectedStateVersion: number;
  outcome: ObligationOutcome;
  perSubject: { subjectId: string; grade: CoverageGrade }[];
  labeledBy: "HUMAN";
  labeledAt: string;
}

/** A label that passed validation: a command to finalize one obligation. */
export interface Ce0Finalization {
  obligationId: string;
  expectedStateVersion: number;
  outcome: ObligationOutcome;
}

/** A label that failed validation, with a human-readable reason; nothing is written for it. */
export interface Ce0LabelRejection {
  obligationId: string;
  reason: string;
}

/** Machine-vs-human agreement for one accepted label. `agrees` is null for outcomes that are not
 * a satisfaction claim (NOT_DUE / UNKNOWN / CANCELLED). */
export interface Ce0AgreementEntry {
  obligationId: string;
  machineSatisfied: boolean;
  humanOutcome: ObligationOutcome;
  agrees: boolean | null;
}

export interface Ce0Reconciliation {
  finalizations: Ce0Finalization[];
  rejections: Ce0LabelRejection[];
  agreement: Ce0AgreementEntry[];
}

/** Whether an outcome asserts the obligation was satisfied on time (true), missed (false), or is
 * not a satisfaction claim at all (null). The agreement check compares this to the machine baseline. */
function satisfactionExpectation(outcome: ObligationOutcome): boolean | null {
  switch (outcome) {
    case "COMPLIANT_ON_TIME":
      return true;
    case "CONSULTED_LATE_WITH_EVIDENCE":
    case "CONSULTED_LATE_NO_EVIDENCE":
    case "MISSED":
      return false;
    case "NOT_DUE":
    case "UNKNOWN":
    case "CANCELLED":
      return null;
  }
}

/**
 * Validate a labeled file against the export snapshot, producing the finalization commands, the
 * rejections, and the machine-vs-human agreement summary. Pure: no store access, no side effects.
 * Each label is checked in order (unknown obligation, stale stateVersion, bad outcome, bad grade,
 * subject-coverage mismatch); the first failure rejects the label and no finalization is emitted.
 */
export function reconcileCe0Labels(
  exportRows: readonly Ce0ExportRow[],
  labelRows: readonly Ce0LabelRow[],
): Ce0Reconciliation {
  const byId = new Map(exportRows.map((r) => [r.obligationId, r]));
  const out: Ce0Reconciliation = { finalizations: [], rejections: [], agreement: [] };

  for (const label of labelRows) {
    const row = byId.get(label.obligationId);
    if (!row) {
      out.rejections.push({
        obligationId: label.obligationId,
        reason: "unknown obligation: not in the export set (already finalized or never claimed)",
      });
      continue;
    }
    if (label.expectedStateVersion !== row.stateVersion) {
      out.rejections.push({
        obligationId: label.obligationId,
        reason: `stale label: expected stateVersion ${label.expectedStateVersion}, export is ${row.stateVersion}`,
      });
      continue;
    }
    if (!OBLIGATION_OUTCOMES.has(label.outcome)) {
      out.rejections.push({
        obligationId: label.obligationId,
        reason: `invalid outcome: ${String(label.outcome)} is not one of the seven terminal outcomes`,
      });
      continue;
    }
    const badGrade = label.perSubject.find((p) => !COVERAGE_GRADES.has(p.grade));
    if (badGrade) {
      out.rejections.push({
        obligationId: label.obligationId,
        reason: `invalid grade: ${String(badGrade.grade)} for subject ${badGrade.subjectId}`,
      });
      continue;
    }
    const requiredIds = new Set(row.requiredSubjects.map((s) => s.subjectId));
    const gradedIds = new Set(label.perSubject.map((p) => p.subjectId));
    const extra = [...gradedIds].find((id) => !requiredIds.has(id));
    if (extra) {
      out.rejections.push({
        obligationId: label.obligationId,
        reason: `grades a subject the obligation does not require: ${extra}`,
      });
      continue;
    }
    const ungraded = [...requiredIds].find((id) => !gradedIds.has(id));
    if (ungraded) {
      out.rejections.push({
        obligationId: label.obligationId,
        reason: `leaves a required subject ungraded: ${ungraded}`,
      });
      continue;
    }

    out.finalizations.push({
      obligationId: label.obligationId,
      expectedStateVersion: label.expectedStateVersion,
      outcome: label.outcome,
    });
    const expectation = satisfactionExpectation(label.outcome);
    out.agreement.push({
      obligationId: label.obligationId,
      machineSatisfied: row.machineSatisfied,
      humanOutcome: label.outcome,
      agrees: expectation === null ? null : expectation === row.machineSatisfied,
    });
  }
  return out;
}

/** Parse a labeled JSONL back into rows, ignoring blank lines (mirrors parseCe0ExportRows). */
export function parseCe0LabelRows(jsonl: string): Ce0LabelRow[] {
  return jsonl
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Ce0LabelRow);
}

/** The result of one import run: what finalized, what CAS-conflicted at write time, what was
 * rejected in pre-flight, and the agreement summary for the accepted labels. */
export interface Ce0ImportReport {
  finalized: { obligationId: string; outcome: string; stateVersion: number }[];
  conflicts: { obligationId: string; expectedStateVersion: number; actualStateVersion: number }[];
  rejected: Ce0LabelRejection[];
  agreement: Ce0AgreementEntry[];
}

/**
 * The `mla evidence ce0-import-labels` core: assemble the workspace's current export snapshot,
 * reconcile the labeled JSONL against it, then CAS-finalize each accepted label. The reconcile
 * pre-flight gives clean human-facing rejections; the store's compare-and-swap is the authoritative
 * write guard, so an already-finalized or concurrently-changed obligation can never be double-written.
 */
export function runCe0ImportLabels(
  store: Ce0Store,
  workspaceId: string,
  labelJsonl: string,
): Ce0ImportReport {
  const exportRows = assembleCe0ExportRows(store, workspaceId);
  const labels = parseCe0LabelRows(labelJsonl);
  const reconciliation = reconcileCe0Labels(exportRows, labels);

  const report: Ce0ImportReport = {
    finalized: [],
    conflicts: [],
    rejected: [...reconciliation.rejections],
    agreement: reconciliation.agreement,
  };

  for (const cmd of reconciliation.finalizations) {
    const result = finalizeObligation(store, cmd);
    switch (result.status) {
      case "FINALIZED":
        report.finalized.push({
          obligationId: result.obligationId,
          outcome: result.outcome,
          stateVersion: result.stateVersion,
        });
        break;
      case "CAS_CONFLICT":
        report.conflicts.push({
          obligationId: result.obligationId,
          expectedStateVersion: result.expectedStateVersion,
          actualStateVersion: result.actualStateVersion,
        });
        break;
      case "NO_OBLIGATION":
        report.rejected.push({
          obligationId: result.obligationId,
          reason: "obligation vanished between reconcile and finalize",
        });
        break;
    }
  }
  return report;
}
