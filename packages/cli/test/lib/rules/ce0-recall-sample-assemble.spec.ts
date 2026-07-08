import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  openCe0Store,
  closeCe0Store,
  insertTurnMemoryAssessment,
  type Ce0Store,
  type TurnMemoryAssessmentRecord,
  type ResponseSourceRefV1,
} from "../../../src/lib/rules/ce0-store";
import {
  assembleCe0RecallSampleRows,
  DEFAULT_RECALL_SAMPLE_RATE,
  type Ce0RecallSampleRow,
} from "../../../src/lib/rules/ce0-recall-sample";

// B2 (proposal lines 1010-1019): the recall (false-negative) population of `ce0-export`. The store
// stamps EVERY classified turn with an assessment; precision needs the REQUIRED turns, recall needs the
// turns we did NOT flag. assembleCe0RecallSampleRows reads listTurnMemoryAssessments, keeps the
// NOT_REQUIRED / UNKNOWN turns whose deterministic samplingBucket falls in the sample at `rate`, and
// emits one assessment-keyed row per kept turn (NO obligation section, by construction). Each row
// carries the facts a recall grader needs (assessmentId, requirement, samplingBucket, promptHash) plus
// a store-knowable labelability: a turn with no responseSourceRef has no transcript handle to resolve
// its content, so it is exported UNLABELABLE with a stable reason, counted, never silently dropped.
//
// Store-backed with a real SQLite store (no mocking internal services): we seed assessments with
// explicit samplingBuckets so sample membership is crisp.

let dir: string;
let store: Ce0Store;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ce0-recall-"));
  store = openCe0Store(path.join(dir, "ce0.db"));
  seq = 0;
});

afterEach(() => {
  closeCe0Store(store);
  fs.rmSync(dir, { recursive: true, force: true });
});

// Crafted 64-char digests whose leading 32 bits pin a known fraction.
const IN_BUCKET = "00000000".padEnd(64, "0"); // fraction 0.0: in the sample at any positive rate
const OUT_BUCKET = "ffffffff".padEnd(64, "f"); // fraction ~0.99999: out at any rate below ~1

const sourceRef = (over: Partial<ResponseSourceRefV1> = {}): ResponseSourceRefV1 => ({
  kind: "CLAUDE_TRANSCRIPT_JSONL",
  version: 1,
  transcriptPath: "/tmp/transcript.jsonl",
  recordByteOffset: 0,
  recordByteLength: 128,
  recordSha256: "ref_sha_cafe",
  selector: "PARENT_ASSISTANT_TEXT_V1",
  ...over,
});

let seq = 0;
function seedAssessment(over: Partial<TurnMemoryAssessmentRecord> = {}): TurnMemoryAssessmentRecord {
  seq += 1;
  const rec: TurnMemoryAssessmentRecord = {
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
  };
  insertTurnMemoryAssessment(store, rec);
  return rec;
}

describe("assembleCe0RecallSampleRows: which unflagged turns become recall rows", () => {
  it("excludes REQUIRED assessments (precision population is exported separately)", () => {
    seedAssessment({ requirement: "REQUIRED", assessmentId: "asmt_required" });
    seedAssessment({ requirement: "NOT_REQUIRED", assessmentId: "asmt_nr" });
    const rows = assembleCe0RecallSampleRows(store, "ws_abc", DEFAULT_RECALL_SAMPLE_RATE);
    expect(rows.map((r) => r.assessmentId)).toEqual(["asmt_nr"]);
  });

  it("includes both NOT_REQUIRED and UNKNOWN turns (UNKNOWN is the third recall band)", () => {
    seedAssessment({ requirement: "NOT_REQUIRED", assessmentId: "asmt_nr" });
    seedAssessment({ requirement: "UNKNOWN", assessmentId: "asmt_unk" });
    const rows = assembleCe0RecallSampleRows(store, "ws_abc", DEFAULT_RECALL_SAMPLE_RATE);
    expect(rows.map((r) => r.assessmentId).sort()).toEqual(["asmt_nr", "asmt_unk"]);
  });

  it("drops an unflagged turn whose samplingBucket falls outside the sample at the given rate", () => {
    seedAssessment({ assessmentId: "asmt_in", samplingBucket: IN_BUCKET });
    seedAssessment({ assessmentId: "asmt_out", samplingBucket: OUT_BUCKET });
    const rows = assembleCe0RecallSampleRows(store, "ws_abc", 0.5);
    expect(rows.map((r) => r.assessmentId)).toEqual(["asmt_in"]);
  });

  it("at the default rate (1.0) samples every unflagged turn regardless of bucket", () => {
    seedAssessment({ assessmentId: "asmt_in", samplingBucket: IN_BUCKET });
    seedAssessment({ assessmentId: "asmt_out", samplingBucket: OUT_BUCKET });
    const rows = assembleCe0RecallSampleRows(store, "ws_abc", DEFAULT_RECALL_SAMPLE_RATE);
    expect(rows.map((r) => r.assessmentId).sort()).toEqual(["asmt_in", "asmt_out"]);
  });

  it("scopes to the workspace: another workspace's unflagged turns never appear", () => {
    seedAssessment({ assessmentId: "asmt_mine", workspaceId: "ws_abc" });
    seedAssessment({ assessmentId: "asmt_other", workspaceId: "ws_other" });
    const rows = assembleCe0RecallSampleRows(store, "ws_abc", DEFAULT_RECALL_SAMPLE_RATE);
    expect(rows.map((r) => r.assessmentId)).toEqual(["asmt_mine"]);
  });
});

describe("assembleCe0RecallSampleRows: the row a recall grader receives", () => {
  it("carries the assessment facts needed to grade the classifier's call", () => {
    seedAssessment({
      assessmentId: "asmt_facts",
      sessionId: "sess_x",
      localTurnSequence: 4,
      requirement: "UNKNOWN",
      samplingBucket: IN_BUCKET,
      promptHash: "ph_facts",
    });
    const [row] = assembleCe0RecallSampleRows(store, "ws_abc", DEFAULT_RECALL_SAMPLE_RATE);
    expect(row).toMatchObject<Partial<Ce0RecallSampleRow>>({
      assessmentId: "asmt_facts",
      workspaceId: "ws_abc",
      sessionId: "sess_x",
      localTurnSequence: 4,
      requirement: "UNKNOWN",
      samplingBucket: IN_BUCKET,
      promptHash: "ph_facts",
    });
  });

  it("marks a turn with no response snapshot UNLABELABLE with a stable reason", () => {
    seedAssessment({ assessmentId: "asmt_noref" }); // no responseSourceRef / responseHash
    const [row] = assembleCe0RecallSampleRows(store, "ws_abc", DEFAULT_RECALL_SAMPLE_RATE);
    expect(row.labelability).toBe("UNLABELABLE");
    expect(row.labelabilityReason).toBe("NO_RESPONSE_SNAPSHOT");
    expect(row.responseSourceRef).toBeNull();
    expect(row.responseHash).toBeNull();
  });

  it("marks a turn with a response snapshot LABELABLE and carries the resolution pointer", () => {
    const ref = sourceRef({ transcriptPath: "/tmp/sess_x.jsonl", recordByteOffset: 42 });
    seedAssessment({ assessmentId: "asmt_ref", responseHash: "rh_beef", responseSourceRef: ref });
    const [row] = assembleCe0RecallSampleRows(store, "ws_abc", DEFAULT_RECALL_SAMPLE_RATE);
    expect(row.labelability).toBe("LABELABLE");
    expect(row.labelabilityReason).toBeNull();
    expect(row.responseHash).toBe("rh_beef");
    expect(row.responseSourceRef).toEqual(ref);
  });

  it("never carries an obligation section (the recall population has no obligation by construction)", () => {
    seedAssessment({ assessmentId: "asmt_nr" });
    const [row] = assembleCe0RecallSampleRows(store, "ws_abc", DEFAULT_RECALL_SAMPLE_RATE);
    expect(row).not.toHaveProperty("obligationId");
    expect(row).not.toHaveProperty("obligation");
  });
});
