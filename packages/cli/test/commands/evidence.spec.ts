import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  openCe0Store,
  closeCe0Store,
  insertTurnRuleObligation,
  insertConsultationAttempt,
  insertTurnMemoryAssessment,
  getTurnRuleObligation,
  type Ce0Store,
  type TurnRuleObligationRecord,
  type ConsultationAttemptRecord,
  type TurnMemoryAssessmentRecord,
  type RequirementSubject,
} from "../../src/lib/rules/ce0-store";
import { parseCe0ExportLines, type Ce0ExportLine, type Ce0LabelRow } from "../../src/lib/rules/ce0-evidence";
import { runEvidence } from "../../src/commands/evidence";

/** Pull the PRECISION obligations out of a parsed two-population export stream. */
function precisionObligations(lines: Ce0ExportLine[]) {
  return lines
    .filter((l): l is Extract<Ce0ExportLine, { population: "PRECISION" }> => l.population === "PRECISION")
    .map((l) => l.obligation);
}

/** Pull the RECALL rows out of a parsed two-population export stream. */
function recallRows(lines: Ce0ExportLine[]) {
  return lines
    .filter((l): l is Extract<Ce0ExportLine, { population: "RECALL" }> => l.population === "RECALL")
    .map((l) => l.recall);
}

// Commit 9c: the `mla evidence` command glue (notes/20260617-evidence-consultation-forcing-function-
// proposal.md §2.3). The one human-only CE0 labeling workflow: `ce0-export` writes the JSONL a
// labeler audits; `ce0-import-labels <file>` reads the labeled file back and CAS-finalizes the
// matched obligations. No model call, no external egress; the command is a thin IO shell over the
// pure ce0-evidence core, with the store path and workspace resolution injected for the test.

let dir: string;
let dbPath: string;
let store: Ce0Store;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "evidence-cmd-"));
  dbPath = path.join(dir, "ce0.db");
  store = openCe0Store(dbPath);
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
    consultationId: "con_cover",
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

const IN_BUCKET = "00000000".padEnd(64, "0"); // fraction 0.0
const OUT_BUCKET = "ffffffff".padEnd(64, "f"); // fraction ~0.99999

let asmtSeq = 100;
function seedAssessment(over: Partial<TurnMemoryAssessmentRecord> = {}): TurnMemoryAssessmentRecord {
  asmtSeq += 1;
  const rec: TurnMemoryAssessmentRecord = {
    assessmentId: `asmt_${asmtSeq}`,
    workspaceId: "ws_abc",
    sessionId: "sess_1",
    localTurnSequence: asmtSeq,
    requirement: "NOT_REQUIRED",
    markersMatched: [],
    exclusionsMatched: [],
    classifierVersion: "clf-v1",
    markerSetVersion: "mk-v1",
    exclusionSetVersion: "ex-v1",
    createdAt: 1718700000000 + asmtSeq,
    samplingBucket: IN_BUCKET,
    promptHash: `ph_${asmtSeq}`,
    ...over,
  };
  insertTurnMemoryAssessment(store, rec);
  return rec;
}

const label = (over: Partial<Ce0LabelRow> = {}): Ce0LabelRow => ({
  obligationId: "obl_1",
  expectedStateVersion: 1,
  outcome: "COMPLIANT_ON_TIME",
  perSubject: [{ subjectId: "subj_softgate", grade: "FULL" }],
  labeledBy: "HUMAN",
  labeledAt: "2026-06-18T00:00:00Z",
  ...over,
});

function writeLabels(rows: Ce0LabelRow[]): string {
  const file = path.join(dir, "labels.jsonl");
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return file;
}

/** Capture stdout / stderr lines and a fixed workspace, against the seeded tmp db. */
function deps(over: { workspace?: string | undefined } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    deps: {
      storePath: dbPath,
      resolveWorkspaceId: () => ("workspace" in over ? over.workspace : "ws_abc"),
      out: (line: string) => out.push(line),
      err: (line: string) => err.push(line),
    },
  };
}

describe("mla evidence ce0-export", () => {
  it("prints the workspace's export JSONL and exits 0", async () => {
    seedObligation();
    seedConsultation();
    const { out, deps: d } = deps();

    const code = await runEvidence(["ce0-export"], d);

    expect(code).toBe(0);
    const obligations = precisionObligations(parseCe0ExportLines(out.join("\n")));
    expect(obligations).toHaveLength(1);
    expect(obligations[0].obligationId).toBe("obl_1");
    expect(obligations[0].machineSatisfied).toBe(true);
  });

  it("scopes the export to the resolved workspace", async () => {
    seedObligation({ obligationId: "obl_mine" });
    seedObligation({ obligationId: "obl_theirs", workspaceId: "ws_other" });
    const { out, deps: d } = deps();

    await runEvidence(["ce0-export"], d);

    const obligations = precisionObligations(parseCe0ExportLines(out.join("\n")));
    expect(obligations.map((r) => r.obligationId)).toEqual(["obl_mine"]);
  });

  it("by default samples every unflagged turn into the recall population", async () => {
    seedAssessment({ assessmentId: "asmt_in", samplingBucket: IN_BUCKET });
    seedAssessment({ assessmentId: "asmt_out", samplingBucket: OUT_BUCKET });
    const { out, deps: d } = deps();

    const code = await runEvidence(["ce0-export"], d);

    expect(code).toBe(0);
    const recall = recallRows(parseCe0ExportLines(out.join("\n")));
    expect(recall.map((r) => r.assessmentId).sort()).toEqual(["asmt_in", "asmt_out"]);
  });

  it("honors --recall-sample-rate, thresholding the recall population", async () => {
    seedAssessment({ assessmentId: "asmt_in", samplingBucket: IN_BUCKET });
    seedAssessment({ assessmentId: "asmt_out", samplingBucket: OUT_BUCKET });
    const { out, deps: d } = deps();

    const code = await runEvidence(["ce0-export", "--recall-sample-rate", "0.5"], d);

    expect(code).toBe(0);
    const recall = recallRows(parseCe0ExportLines(out.join("\n")));
    expect(recall.map((r) => r.assessmentId)).toEqual(["asmt_in"]);
  });

  it("accepts --recall-sample-rate=<value> joined form", async () => {
    seedAssessment({ assessmentId: "asmt_in", samplingBucket: IN_BUCKET });
    seedAssessment({ assessmentId: "asmt_out", samplingBucket: OUT_BUCKET });
    const { out, deps: d } = deps();

    await runEvidence(["ce0-export", "--recall-sample-rate=0"], d);

    const recall = recallRows(parseCe0ExportLines(out.join("\n")));
    expect(recall).toHaveLength(0);
  });

  it("rejects a non-numeric --recall-sample-rate without writing JSONL", async () => {
    seedAssessment({ assessmentId: "asmt_in" });
    const { out, err, deps: d } = deps();

    const code = await runEvidence(["ce0-export", "--recall-sample-rate", "nope"], d);

    expect(code).toBe(2);
    expect(out.join("")).toBe("");
    expect(err.join("\n")).toMatch(/recall-sample-rate/i);
  });

  it("rejects an out-of-range --recall-sample-rate without writing JSONL", async () => {
    seedAssessment({ assessmentId: "asmt_in" });
    const { out, err, deps: d } = deps();

    const code = await runEvidence(["ce0-export", "--recall-sample-rate", "1.5"], d);

    expect(code).toBe(2);
    expect(out.join("")).toBe("");
    expect(err.join("\n")).toMatch(/recall-sample-rate/i);
  });

  it("errors without writing JSONL when no workspace resolves", async () => {
    seedObligation();
    const { out, err, deps: d } = deps({ workspace: undefined });

    const code = await runEvidence(["ce0-export"], d);

    expect(code).toBe(1);
    expect(out.join("")).toBe("");
    expect(err.join("\n")).toMatch(/workspace/i);
  });
});

describe("mla evidence ce0-import-labels", () => {
  it("finalizes the labeled obligation and reports it, exiting 0", async () => {
    seedObligation();
    seedConsultation();
    const file = writeLabels([label()]);
    const { out, deps: d } = deps();

    const code = await runEvidence(["ce0-import-labels", file], d);

    expect(code).toBe(0);
    const row = getTurnRuleObligation(store, "obl_1");
    expect(row).toMatchObject({ status: "FINALIZED", outcome: "COMPLIANT_ON_TIME", stateVersion: 2 });
    const report = JSON.parse(out.join("\n"));
    expect(report.finalized).toEqual([
      { obligationId: "obl_1", outcome: "COMPLIANT_ON_TIME", stateVersion: 2 },
    ]);
    expect(report.rejected).toEqual([]);
  });

  it("reports a rejection and finalizes nothing for a label that does not match the export", async () => {
    seedObligation();
    const file = writeLabels([label({ obligationId: "obl_ghost" })]);
    const { out, deps: d } = deps();

    const code = await runEvidence(["ce0-import-labels", file], d);

    expect(code).toBe(0);
    expect(getTurnRuleObligation(store, "obl_1")).toMatchObject({ status: "OPEN", outcome: null });
    const report = JSON.parse(out.join("\n"));
    expect(report.finalized).toEqual([]);
    expect(report.rejected).toHaveLength(1);
    expect(report.rejected[0].obligationId).toBe("obl_ghost");
  });

  it("errors with usage when the labels file argument is missing", async () => {
    const { err, deps: d } = deps();

    const code = await runEvidence(["ce0-import-labels"], d);

    expect(code).toBe(2);
    expect(err.join("\n")).toMatch(/usage|labels file|ce0-import-labels/i);
  });
});

describe("mla evidence: dispatch", () => {
  it("errors with usage on an unknown subcommand", async () => {
    const { err, deps: d } = deps();
    const code = await runEvidence(["bogus"], d);
    expect(code).toBe(2);
    expect(err.join("\n")).toMatch(/usage|unknown/i);
  });

  it("errors with usage when no subcommand is given", async () => {
    const { err, deps: d } = deps();
    const code = await runEvidence([], d);
    expect(code).toBe(2);
    expect(err.join("\n")).toMatch(/usage|ce0-export|ce0-import-labels/i);
  });
});
