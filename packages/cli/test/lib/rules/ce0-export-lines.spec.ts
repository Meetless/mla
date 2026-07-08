import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  openCe0Store,
  closeCe0Store,
  insertTurnRuleObligation,
  insertTurnMemoryAssessment,
  type Ce0Store,
  type TurnRuleObligationRecord,
  type TurnMemoryAssessmentRecord,
  type RequirementSubject,
} from "../../../src/lib/rules/ce0-store";
import {
  assembleCe0ExportLines,
  serializeCe0ExportLines,
  parseCe0ExportLines,
  runCe0Export,
  type Ce0ExportLine,
} from "../../../src/lib/rules/ce0-evidence";
import { DEFAULT_RECALL_SAMPLE_RATE } from "../../../src/lib/rules/ce0-recall-sample";

// B3 (proposal lines 1010-1019): ce0-export writes TWO populations in one JSONL. Precision is the
// REQUIRED turns with their obligation section (assembleCe0ExportRows); recall is the sampled
// unflagged NOT_REQUIRED / UNKNOWN turns (assembleCe0RecallSampleRows). assembleCe0ExportLines stitches
// them into one discriminated stream: each line is a {population} envelope so a human (and any parser)
// can split the two without structural guessing. runCe0Export serializes that stream, defaulting the
// recall sample rate to the pinned DEFAULT_RECALL_SAMPLE_RATE.

let dir: string;
let store: Ce0Store;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ce0-export-lines-"));
  store = openCe0Store(path.join(dir, "ce0.db"));
});

afterEach(() => {
  closeCe0Store(store);
  fs.rmSync(dir, { recursive: true, force: true });
});

const IN_BUCKET = "00000000".padEnd(64, "0"); // fraction 0.0
const OUT_BUCKET = "ffffffff".padEnd(64, "f"); // fraction ~0.99999

const subject = (): RequirementSubject => ({
  subjectId: "subj_1",
  normalizedTerms: ["x"],
  entityIds: [],
  decisionIds: [],
  conceptIds: [],
  fingerprint: "fp_1",
});

function seedObligation(over: Partial<TurnRuleObligationRecord> = {}): void {
  insertTurnRuleObligation(store, {
    obligationId: "obl_1",
    workspaceId: "ws_abc",
    sessionId: "sess_1",
    localTurnSequence: 1,
    ruleId: "consult-evidence",
    ruleVersionId: "consult-evidence@ce0-v1",
    requiredSubjects: [subject()],
    subjectSatisfaction: [],
    status: "OPEN",
    stateVersion: 1,
    deadlineClaimedAt: 2,
    deadlineClaimedVersion: 0,
    responseHash: "rh_1",
    outcome: null,
    canonicalPayloadHash: "cph_1",
    ...over,
  });
}

let seq = 10;
function seedAssessment(over: Partial<TurnMemoryAssessmentRecord> = {}): void {
  seq += 1;
  insertTurnMemoryAssessment(store, {
    assessmentId: `asmt_${seq}`,
    workspaceId: "ws_abc",
    sessionId: "sess_1",
    localTurnSequence: seq,
    requirement: "NOT_REQUIRED",
    markersMatched: [],
    exclusionsMatched: [],
    classifierVersion: "clf-v1",
    markerSetVersion: "mk-v1",
    exclusionSetVersion: "ex-v1",
    createdAt: 1718700000000 + seq,
    samplingBucket: IN_BUCKET,
    promptHash: `ph_${seq}`,
    ...over,
  });
}

describe("assembleCe0ExportLines: two populations in one discriminated stream", () => {
  it("wraps each deadline-claimed obligation as a PRECISION line", () => {
    seedObligation({ obligationId: "obl_p" });
    const lines = assembleCe0ExportLines(store, "ws_abc", DEFAULT_RECALL_SAMPLE_RATE);
    const precision = lines.filter((l): l is Extract<Ce0ExportLine, { population: "PRECISION" }> => l.population === "PRECISION");
    expect(precision).toHaveLength(1);
    expect(precision[0].obligation.obligationId).toBe("obl_p");
  });

  it("wraps each sampled unflagged assessment as a RECALL line", () => {
    seedAssessment({ assessmentId: "asmt_r", requirement: "UNKNOWN" });
    const lines = assembleCe0ExportLines(store, "ws_abc", DEFAULT_RECALL_SAMPLE_RATE);
    const recall = lines.filter((l): l is Extract<Ce0ExportLine, { population: "RECALL" }> => l.population === "RECALL");
    expect(recall).toHaveLength(1);
    expect(recall[0].recall.assessmentId).toBe("asmt_r");
    expect(recall[0].recall.requirement).toBe("UNKNOWN");
  });

  it("emits all PRECISION lines before any RECALL line", () => {
    seedObligation({ obligationId: "obl_p" });
    seedAssessment({ assessmentId: "asmt_r" });
    const populations = assembleCe0ExportLines(store, "ws_abc", DEFAULT_RECALL_SAMPLE_RATE).map((l) => l.population);
    expect(populations).toEqual(["PRECISION", "RECALL"]);
  });

  it("honors the recall sample rate without affecting the precision population", () => {
    seedObligation({ obligationId: "obl_p" });
    seedAssessment({ assessmentId: "asmt_out", samplingBucket: OUT_BUCKET });
    // rate 0.5 drops the OUT_BUCKET assessment but keeps the obligation.
    const lines = assembleCe0ExportLines(store, "ws_abc", 0.5);
    expect(lines.map((l) => l.population)).toEqual(["PRECISION"]);
  });
});

describe("serializeCe0ExportLines / parseCe0ExportLines: JSONL round-trip", () => {
  it("serializes one newline-terminated JSON object per line and round-trips", () => {
    seedObligation();
    seedAssessment({ assessmentId: "asmt_r" });
    const lines = assembleCe0ExportLines(store, "ws_abc", DEFAULT_RECALL_SAMPLE_RATE);
    const jsonl = serializeCe0ExportLines(lines);
    expect(jsonl.endsWith("\n")).toBe(true);
    expect(jsonl.trimEnd().split("\n")).toHaveLength(2);
    expect(parseCe0ExportLines(jsonl)).toEqual(lines);
  });

  it("serializes an empty stream to an empty string and tolerates blank lines on parse", () => {
    expect(serializeCe0ExportLines([])).toBe("");
    expect(parseCe0ExportLines("")).toEqual([]);
    expect(parseCe0ExportLines("\n  \n")).toEqual([]);
  });
});

describe("runCe0Export: serialize the two-population stream", () => {
  it("defaults the recall sample rate to DEFAULT_RECALL_SAMPLE_RATE (samples every unflagged turn)", () => {
    seedObligation();
    seedAssessment({ assessmentId: "asmt_in", samplingBucket: IN_BUCKET });
    seedAssessment({ assessmentId: "asmt_out", samplingBucket: OUT_BUCKET });
    const parsed = parseCe0ExportLines(runCe0Export(store, "ws_abc"));
    expect(parsed).toEqual(assembleCe0ExportLines(store, "ws_abc", DEFAULT_RECALL_SAMPLE_RATE));
    // Default rate 1.0: both unflagged turns are sampled regardless of bucket.
    const recallIds = parsed
      .filter((l): l is Extract<Ce0ExportLine, { population: "RECALL" }> => l.population === "RECALL")
      .map((l) => l.recall.assessmentId)
      .sort();
    expect(recallIds).toEqual(["asmt_in", "asmt_out"]);
  });

  it("passes an explicit recall sample rate through to the recall population", () => {
    seedObligation();
    seedAssessment({ assessmentId: "asmt_in", samplingBucket: IN_BUCKET });
    seedAssessment({ assessmentId: "asmt_out", samplingBucket: OUT_BUCKET });
    const recallIds = parseCe0ExportLines(runCe0Export(store, "ws_abc", 0.5))
      .filter((l): l is Extract<Ce0ExportLine, { population: "RECALL" }> => l.population === "RECALL")
      .map((l) => l.recall.assessmentId);
    expect(recallIds).toEqual(["asmt_in"]);
  });
});
