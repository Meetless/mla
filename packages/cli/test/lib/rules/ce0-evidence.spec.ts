import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  openCe0Store,
  closeCe0Store,
  insertTurnRuleObligation,
  insertConsultationAttempt,
  type Ce0Store,
  type TurnRuleObligationRecord,
  type ConsultationAttemptRecord,
  type RequirementSubject,
} from "../../../src/lib/rules/ce0-store";
import {
  assembleCe0ExportRows,
  serializeCe0ExportRows,
  parseCe0ExportRows,
  parseCe0ExportLines,
  runCe0Export,
  parseCe0LabelRows,
  reconcileCe0Labels,
  runCe0ImportLabels,
  type Ce0ExportRow,
  type Ce0LabelRow,
} from "../../../src/lib/rules/ce0-evidence";
import { getTurnRuleObligation } from "../../../src/lib/rules/ce0-store";

// Commit 9a: the `mla evidence ce0-export` read path
// (notes/20260617-evidence-consultation-forcing-function-proposal.md §2.3). The export writes a
// JSONL of the three-record facts a labeler needs: each deadline-claimed obligation with its
// frozen status / stateVersion / responseHash / requiredSubjects, plus its ConsultationAttempts.
//
// The CE0 nuance this slice carries: the live store never writes subjectSatisfaction (the live
// accumulator is a CE2 concern), so the obligation's stored subjectSatisfaction is []. The export
// is where the deterministic reducer FINALLY runs over the frozen eligible set
// (selectEligibleConsultations bounded by deadlineClaimedAt, then recomputeSubjectSatisfaction),
// producing the machine baseline the human audits. The export row's subjectSatisfaction is that
// recomputed baseline, NOT the live [].

let dir: string;
let store: Ce0Store;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ce0-evidence-"));
  store = openCe0Store(path.join(dir, "ce0.db"));
});

afterEach(() => {
  closeCe0Store(store);
  fs.rmSync(dir, { recursive: true, force: true });
});

const subject = (over: Partial<RequirementSubject> = {}): RequirementSubject => ({
  subjectId: "subj_softgate",
  normalizedTerms: ["enforcement", "gate", "soft"],
  entityIds: ["ent_softgate"],
  decisionIds: [],
  conceptIds: [],
  fingerprint: "fp_subject_softgate",
  ...over,
});

/** A deadline-claimed obligation in the realistic CE0 live state: status OPEN, the live
 * subjectSatisfaction still [] (no live accumulator), deadline frozen at `deadlineClaimedAt`. */
function seedObligation(over: Partial<TurnRuleObligationRecord> = {}): TurnRuleObligationRecord {
  const rec: TurnRuleObligationRecord = {
    obligationId: "obl_1",
    workspaceId: "ws_abc",
    sessionId: "sess_1",
    localTurnSequence: 7,
    ruleId: "consult-evidence",
    ruleVersionId: "consult-evidence@ce0-v1",
    requiredSubjects: [subject()],
    subjectSatisfaction: [],
    status: "OPEN",
    stateVersion: 1,
    deadlineClaimedAt: 2,
    deadlineClaimedVersion: 0,
    responseHash: "rh_deadbeef",
    outcome: null,
    canonicalPayloadHash: "cph_cafef00d",
    ...over,
  };
  insertTurnRuleObligation(store, rec);
  return rec;
}

function seedConsultation(over: Partial<ConsultationAttemptRecord> = {}): ConsultationAttemptRecord {
  const rec: ConsultationAttemptRecord = {
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
  insertConsultationAttempt(store, rec);
  return rec;
}

function onlyRow(): Ce0ExportRow {
  const rows = assembleCe0ExportRows(store, "ws_abc");
  expect(rows).toHaveLength(1);
  return rows[0];
}

describe("assembleCe0ExportRows: which obligations export", () => {
  it("exports one row per deadline-claimed, non-finalized obligation", () => {
    seedObligation({ obligationId: "obl_claimed" });
    seedObligation({ obligationId: "obl_live", localTurnSequence: 8, deadlineClaimedAt: null, deadlineClaimedVersion: null });
    const rows = assembleCe0ExportRows(store, "ws_abc");
    expect(rows.map((r) => r.obligationId)).toEqual(["obl_claimed"]);
  });

  it("skips FINALIZED obligations (already labeled; not awaiting a label)", () => {
    seedObligation({ obligationId: "obl_open" });
    seedObligation({ obligationId: "obl_final", localTurnSequence: 8, status: "FINALIZED", outcome: "COMPLIANT_ON_TIME" });
    expect(assembleCe0ExportRows(store, "ws_abc").map((r) => r.obligationId)).toEqual(["obl_open"]);
  });

  it("scopes to the workspace", () => {
    seedObligation({ obligationId: "obl_mine" });
    seedObligation({ obligationId: "obl_theirs", workspaceId: "ws_other" });
    expect(assembleCe0ExportRows(store, "ws_abc").map((r) => r.obligationId)).toEqual(["obl_mine"]);
  });
});

describe("assembleCe0ExportRows: the row carries the frozen obligation facts", () => {
  it("carries the import-CAS coordinates and the frozen lifecycle fields", () => {
    seedObligation();
    const row = onlyRow();
    expect(row).toMatchObject({
      obligationId: "obl_1",
      workspaceId: "ws_abc",
      sessionId: "sess_1",
      localTurnSequence: 7,
      ruleId: "consult-evidence",
      ruleVersionId: "consult-evidence@ce0-v1",
      status: "OPEN",
      stateVersion: 1,
      deadlineClaimedAt: 2,
      deadlineClaimedVersion: 0,
      responseHash: "rh_deadbeef",
      requiredSubjects: [subject()],
    });
  });
});

describe("assembleCe0ExportRows: subjectSatisfaction is the reducer baseline, not the live []", () => {
  it("recomputes a proof for a covered subject even though the stored subjectSatisfaction is []", () => {
    seedObligation(); // requiredSubjects [subj_softgate], deadline 2, live subjectSatisfaction []
    seedConsultation({ consultationId: "con_cover", orderingToken: 1 }); // covers subj_softgate (shared entityId)
    const row = onlyRow();
    expect(row.subjectSatisfaction).toEqual([{ subjectId: "subj_softgate", consultationId: "con_cover" }]);
    expect(row.machineSatisfied).toBe(true);
  });

  it("leaves machineSatisfied false when a required subject is uncovered", () => {
    seedObligation({
      requiredSubjects: [
        subject(),
        // Disjoint on BOTH match arms: distinct entityIds AND distinct normalizedTerms, so the
        // single consultation cannot cover it by id intersection or by term containment.
        subject({ subjectId: "subj_two", entityIds: ["ent_two"], normalizedTerms: ["rollout", "canary"], fingerprint: "fp_two" }),
      ],
    });
    seedConsultation({ consultationId: "con_cover", orderingToken: 1 }); // covers only subj_softgate
    const row = onlyRow();
    expect(row.subjectSatisfaction).toEqual([{ subjectId: "subj_softgate", consultationId: "con_cover" }]);
    expect(row.machineSatisfied).toBe(false);
  });

  it("does not count a consultation recorded after the frozen deadline boundary", () => {
    seedObligation({ deadlineClaimedAt: 1 }); // boundary at token 1
    seedConsultation({ consultationId: "con_late", orderingToken: 2 }); // after the boundary
    const row = onlyRow();
    expect(row.subjectSatisfaction).toEqual([]);
    expect(row.machineSatisfied).toBe(false);
  });

  it("treats an empty required set as unsatisfied (fail toward silence), still emitting the row", () => {
    seedObligation({ requiredSubjects: [] });
    const row = onlyRow();
    expect(row.subjectSatisfaction).toEqual([]);
    expect(row.machineSatisfied).toBe(false);
  });
});

describe("assembleCe0ExportRows: the raw consultation facts and their eligibility flag", () => {
  it("carries every consultation in (orderingToken, consultationId) order with an eligibility flag", () => {
    seedObligation({ deadlineClaimedAt: 2 });
    seedConsultation({ consultationId: "con_a", orderingToken: 1 }); // eligible: COMPLETE, delivered, <= 2
    seedConsultation({ consultationId: "con_late", orderingToken: 3 }); // ineligible: after boundary
    seedConsultation({ consultationId: "con_failed", orderingToken: 2, execution: "FAILED", result: null }); // ineligible: not COMPLETE
    const row = onlyRow();
    expect(row.consultations.map((c) => [c.consultationId, c.eligible])).toEqual([
      ["con_a", true],
      ["con_failed", false],
      ["con_late", false],
    ]);
  });

  it("flags an undelivered consultation ineligible", () => {
    seedObligation({ deadlineClaimedAt: 2 });
    seedConsultation({ consultationId: "con_undelivered", orderingToken: 1, deliveredToAnsweringContext: false });
    expect(onlyRow().consultations[0]).toMatchObject({ consultationId: "con_undelivered", eligible: false });
  });

  it("carries the consultation's execution and result subtype verbatim for the audit", () => {
    seedObligation();
    seedConsultation({ consultationId: "con_nomatch", orderingToken: 1, execution: "COMPLETE", result: "NO_MATCH" });
    expect(onlyRow().consultations[0]).toMatchObject({
      consultationId: "con_nomatch",
      execution: "COMPLETE",
      result: "NO_MATCH",
      eligible: true, // a clean no-match still attests consultation
    });
  });

  it("carries the consultation's source verbatim (not a constant) so the labeler can audit how it was initiated", () => {
    seedObligation();
    // CE0 only writes AGENT_PULL today, but the export must carry the stored value, not a
    // hard-wired constant; seed a different held source to prove it passes through verbatim.
    seedConsultation({ consultationId: "con_push", orderingToken: 1, source: "PROACTIVE_PUSH" });
    expect(onlyRow().consultations[0]).toMatchObject({
      consultationId: "con_push",
      source: "PROACTIVE_PUSH",
    });
  });
});

describe("serializeCe0ExportRows / parseCe0ExportRows: JSONL round-trip", () => {
  it("serializes one newline-terminated JSON object per row and round-trips", () => {
    seedObligation();
    seedConsultation();
    const rows = assembleCe0ExportRows(store, "ws_abc");
    const jsonl = serializeCe0ExportRows(rows);
    expect(jsonl.endsWith("\n")).toBe(true);
    expect(jsonl.trimEnd().split("\n")).toHaveLength(1);
    expect(parseCe0ExportRows(jsonl)).toEqual(rows);
  });

  it("serializes an empty set to an empty string and parses it back to []", () => {
    expect(serializeCe0ExportRows([])).toBe("");
    expect(parseCe0ExportRows("")).toEqual([]);
    expect(parseCe0ExportRows("\n  \n")).toEqual([]);
  });
});

describe("runCe0Export: assemble then serialize", () => {
  it("wraps each obligation as a PRECISION line of the two-population export stream", () => {
    seedObligation();
    seedConsultation();
    // No assessments seeded here, so the stream is precision-only; the recall population is covered in
    // ce0-export-lines.spec.ts.
    const lines = parseCe0ExportLines(runCe0Export(store, "ws_abc"));
    expect(lines).toEqual([{ population: "PRECISION", obligation: assembleCe0ExportRows(store, "ws_abc")[0] }]);
  });
});

// Commit 9b: the `mla evidence ce0-import-labels` write path
// (notes/20260617-evidence-consultation-forcing-function-proposal.md §2.3). CE0 finalization is a
// human-driven local JSONL workflow: the labeler reads the export, assigns each obligation a
// terminal outcome and per-subject coverage grades, and imports the labeled file. The import
// verifies the obligation id and the expected stateVersion, writes the outcome, and moves status
// to FINALIZED (telemetry deferred to Commit 10). reconcileCe0Labels is the pure pre-flight
// validation; runCe0ImportLabels assembles the live export set, reconciles, then CAS-finalizes.

const label = (over: Partial<Ce0LabelRow> = {}): Ce0LabelRow => ({
  obligationId: "obl_1",
  expectedStateVersion: 1,
  outcome: "COMPLIANT_ON_TIME",
  perSubject: [{ subjectId: "subj_softgate", grade: "FULL" }],
  labeledBy: "HUMAN",
  labeledAt: "2026-06-18T00:00:00Z",
  ...over,
});

/** Build the export-row snapshot reconcile validates against, straight from a seeded store. */
function exportRowsFor(over: Parameters<typeof seedObligation>[0] = {}): Ce0ExportRow[] {
  seedObligation(over);
  seedConsultation({ consultationId: "con_cover", orderingToken: 1 }); // covers subj_softgate
  return assembleCe0ExportRows(store, "ws_abc");
}

function labelJsonl(rows: Ce0LabelRow[]): string {
  return rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length > 0 ? "\n" : "");
}

describe("reconcileCe0Labels: pure validation of a labeled file against the export snapshot", () => {
  it("accepts a well-formed label and emits a finalization command", () => {
    const rows = exportRowsFor();
    const out = reconcileCe0Labels(rows, [label()]);
    expect(out.finalizations).toEqual([
      { obligationId: "obl_1", expectedStateVersion: 1, outcome: "COMPLIANT_ON_TIME" },
    ]);
    expect(out.rejections).toEqual([]);
  });

  it("rejects a label whose obligation is not in the export set (unknown / already finalized)", () => {
    const rows = exportRowsFor();
    const out = reconcileCe0Labels(rows, [label({ obligationId: "obl_ghost" })]);
    expect(out.finalizations).toEqual([]);
    expect(out.rejections).toHaveLength(1);
    expect(out.rejections[0].obligationId).toBe("obl_ghost");
    expect(out.rejections[0].reason).toMatch(/unknown|not awaiting|not in export/i);
  });

  it("rejects a label whose expectedStateVersion does not match the export row", () => {
    const rows = exportRowsFor(); // stateVersion 1
    const out = reconcileCe0Labels(rows, [label({ expectedStateVersion: 0 })]);
    expect(out.finalizations).toEqual([]);
    expect(out.rejections[0].reason).toMatch(/stateVersion/i);
  });

  it("rejects an outcome outside the seven-value enum", () => {
    const rows = exportRowsFor();
    const out = reconcileCe0Labels(rows, [label({ outcome: "WHATEVER" as Ce0LabelRow["outcome"] })]);
    expect(out.finalizations).toEqual([]);
    expect(out.rejections[0].reason).toMatch(/outcome/i);
  });

  it("rejects a per-subject grade outside FULL / PARTIAL / NONE / UNKNOWN", () => {
    const rows = exportRowsFor();
    const out = reconcileCe0Labels(rows, [
      label({ perSubject: [{ subjectId: "subj_softgate", grade: "MEH" as never }] }),
    ]);
    expect(out.finalizations).toEqual([]);
    expect(out.rejections[0].reason).toMatch(/grade/i);
  });

  it("rejects a label that leaves a required subject ungraded", () => {
    const rows = exportRowsFor({
      requiredSubjects: [
        subject(),
        subject({ subjectId: "subj_two", entityIds: ["ent_two"], normalizedTerms: ["rollout"], fingerprint: "fp_two" }),
      ],
    });
    const out = reconcileCe0Labels(rows, [label()]); // grades only subj_softgate
    expect(out.finalizations).toEqual([]);
    expect(out.rejections[0].reason).toMatch(/subject/i);
  });

  it("rejects a label that grades a subject the obligation does not require", () => {
    const rows = exportRowsFor();
    const out = reconcileCe0Labels(rows, [
      label({
        perSubject: [
          { subjectId: "subj_softgate", grade: "FULL" },
          { subjectId: "subj_extra", grade: "FULL" },
        ],
      }),
    ]);
    expect(out.finalizations).toEqual([]);
    expect(out.rejections[0].reason).toMatch(/subject/i);
  });

  it("accepts every one of the seven terminal outcomes", () => {
    const rows = exportRowsFor();
    for (const outcome of [
      "NOT_DUE",
      "COMPLIANT_ON_TIME",
      "CONSULTED_LATE_WITH_EVIDENCE",
      "CONSULTED_LATE_NO_EVIDENCE",
      "MISSED",
      "UNKNOWN",
      "CANCELLED",
    ] as Ce0LabelRow["outcome"][]) {
      const out = reconcileCe0Labels(rows, [label({ outcome })]);
      expect(out.rejections).toEqual([]);
      expect(out.finalizations[0].outcome).toBe(outcome);
    }
  });

  it("accepts an empty required set graded by an empty perSubject (vacuously complete)", () => {
    seedObligation({ requiredSubjects: [] });
    const rows = assembleCe0ExportRows(store, "ws_abc");
    const out = reconcileCe0Labels(rows, [label({ outcome: "NOT_DUE", perSubject: [] })]);
    expect(out.rejections).toEqual([]);
    expect(out.finalizations).toHaveLength(1);
  });

  it("summarizes machine-vs-human agreement, with null for non-satisfaction outcomes", () => {
    const rows = exportRowsFor(); // machineSatisfied true (subj covered on time)
    const agree = reconcileCe0Labels(rows, [label({ outcome: "COMPLIANT_ON_TIME" })]).agreement;
    expect(agree).toEqual([{ obligationId: "obl_1", machineSatisfied: true, humanOutcome: "COMPLIANT_ON_TIME", agrees: true }]);

    const disagree = reconcileCe0Labels(rows, [label({ outcome: "MISSED" })]).agreement;
    expect(disagree[0]).toMatchObject({ machineSatisfied: true, humanOutcome: "MISSED", agrees: false });

    const na = reconcileCe0Labels(rows, [label({ outcome: "NOT_DUE" })]).agreement;
    expect(na[0]).toMatchObject({ humanOutcome: "NOT_DUE", agrees: null });
  });
});

describe("parseCe0LabelRows: JSONL of labels round-trips, blank lines skipped", () => {
  it("parses a newline-terminated label JSONL and ignores blank lines", () => {
    const rows = [label(), label({ obligationId: "obl_2", outcome: "MISSED", perSubject: [] })];
    expect(parseCe0LabelRows(labelJsonl(rows))).toEqual(rows);
    expect(parseCe0LabelRows("")).toEqual([]);
    expect(parseCe0LabelRows("\n   \n")).toEqual([]);
  });
});

describe("runCe0ImportLabels: assemble, reconcile, then CAS-finalize", () => {
  it("finalizes the labeled obligation: status FINALIZED, outcome written, stateVersion advanced", () => {
    seedObligation(); // OPEN, v1
    seedConsultation({ consultationId: "con_cover", orderingToken: 1 });
    const report = runCe0ImportLabels(store, "ws_abc", labelJsonl([label()]));
    expect(report.finalized).toEqual([{ obligationId: "obl_1", outcome: "COMPLIANT_ON_TIME", stateVersion: 2 }]);
    expect(report.rejected).toEqual([]);
    expect(getTurnRuleObligation(store, "obl_1")).toMatchObject({
      status: "FINALIZED",
      outcome: "COMPLIANT_ON_TIME",
      stateVersion: 2,
    });
  });

  it("leaves an unlabeled deadline-claimed obligation frozen and OPEN", () => {
    seedObligation({ obligationId: "obl_labeled" });
    seedObligation({ obligationId: "obl_untouched", localTurnSequence: 8 });
    runCe0ImportLabels(store, "ws_abc", labelJsonl([label({ obligationId: "obl_labeled" })]));
    expect(getTurnRuleObligation(store, "obl_untouched")).toMatchObject({ status: "OPEN", outcome: null });
  });

  it("reports a rejection and finalizes nothing for a label targeting an unknown obligation", () => {
    seedObligation();
    const report = runCe0ImportLabels(store, "ws_abc", labelJsonl([label({ obligationId: "obl_ghost" })]));
    expect(report.finalized).toEqual([]);
    expect(report.rejected).toHaveLength(1);
    expect(getTurnRuleObligation(store, "obl_1")).toMatchObject({ status: "OPEN" });
  });

  it("does not re-finalize an already-FINALIZED obligation (its label is rejected as not awaiting)", () => {
    seedObligation({ obligationId: "obl_done", status: "FINALIZED", outcome: "COMPLIANT_ON_TIME", stateVersion: 5 });
    const report = runCe0ImportLabels(
      store,
      "ws_abc",
      labelJsonl([label({ obligationId: "obl_done", expectedStateVersion: 5, outcome: "MISSED" })]),
    );
    expect(report.finalized).toEqual([]);
    expect(report.rejected).toHaveLength(1);
    expect(getTurnRuleObligation(store, "obl_done")).toMatchObject({ outcome: "COMPLIANT_ON_TIME", stateVersion: 5 });
  });
});
