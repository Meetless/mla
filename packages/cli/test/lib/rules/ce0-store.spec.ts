import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import Database from "better-sqlite3";

import {
  openCe0Store,
  closeCe0Store,
  CE0_SCHEMA_VERSION,
  Ce0StoreSchemaVersionError,
  insertTurnMemoryAssessment,
  getTurnMemoryAssessment,
  insertTurnRuleObligation,
  getTurnRuleObligation,
  insertConsultationAttempt,
  getConsultationAttempt,
  appendConsultationAttempt,
  claimFirstStop,
  recordStopResponseSnapshot,
  listDeadlineClaimedObligations,
  listTurnMemoryAssessments,
  listConsultationsForTurn,
  finalizeObligation,
  type Ce0Store,
  type TurnMemoryAssessmentRecord,
  type TurnRuleObligationRecord,
  type ConsultationAttemptRecord,
  type ConsultationAttemptDraft,
  type ResponseSourceRefV1,
} from "../../../src/lib/rules/ce0-store";

// Commit 4: the CE0 durable three-record SQLite schema
// (notes/20260617-evidence-consultation-forcing-function-proposal.md Part VII,
// P0.1-P0.6 + the CE0 build directive). The store backs exactly three records:
// TurnMemoryAssessment, TurnRuleObligation, ConsultationAttempt. The doc mandates a
// local SQLite WAL store; the offline CoverageAuditLabel is a JSONL artifact and is
// NOT a table here. There is deliberately NO coverage / recovery / correction /
// checkpoint table and NO rollout-mode column: those are held seams.
//
// The CLI intentionally does not depend on @meetless/utils (see kb-candidate.ts), so
// the record shapes are vendored locally with field names byte-identical to the utils
// CE0 value types, and the array fields round-trip as JSON columns.

let dir: string;
let store: Ce0Store;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ce0-store-"));
  store = openCe0Store(path.join(dir, "ce0.db"));
});

afterEach(() => {
  closeCe0Store(store);
  fs.rmSync(dir, { recursive: true, force: true });
});

const subject = (over: Partial<TurnRuleObligationRecord["requiredSubjects"][number]> = {}) => ({
  subjectId: "subj_softgate",
  normalizedTerms: ["enforcement", "gate", "soft"],
  entityIds: [],
  decisionIds: [],
  conceptIds: [],
  fingerprint: "fp_subject_softgate",
  ...over,
});

const assessment: TurnMemoryAssessmentRecord = {
  assessmentId: "asm_1",
  workspaceId: "ws_abc",
  sessionId: "sess_1",
  localTurnSequence: 7,
  requirement: "REQUIRED",
  markersMatched: ["what did we decide"],
  exclusionsMatched: [],
  classifierVersion: "raw-prompt-substring-v1",
  markerSetVersion: "seed-v1",
  exclusionSetVersion: "seed-v1",
  createdAt: 1718700000000,
  samplingBucket: "bucket_asm_1",
  promptHash: "ph_asm_1",
};

const obligation: TurnRuleObligationRecord = {
  obligationId: "obl_1",
  workspaceId: "ws_abc",
  sessionId: "sess_1",
  localTurnSequence: 7,
  ruleId: "consult-evidence",
  ruleVersionId: "consult-evidence@ce0-v1",
  requiredSubjects: [subject()],
  subjectSatisfaction: [{ subjectId: "subj_softgate", consultationId: "con_1" }],
  status: "SATISFIED",
  stateVersion: 3,
  deadlineClaimedAt: 9,
  deadlineClaimedVersion: 2,
  responseHash: "rh_deadbeef",
  outcome: null,
  canonicalPayloadHash: "cph_cafef00d",
};

const consultation: ConsultationAttemptRecord = {
  consultationId: "con_1",
  workspaceId: "ws_abc",
  sessionId: "sess_1",
  localTurnSequence: 7,
  source: "AGENT_PULL",
  consultationSubjects: [subject({ subjectId: "subj_softgate" })],
  execution: "COMPLETE",
  result: "RESULTS_RETURNED",
  deliveredToAnsweringContext: true,
  orderingToken: 4,
  createdAt: 1718700000500,
};

function tableNames(s: Ce0Store): string[] {
  return (
    s.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as { name: string }[]
  ).map((r) => r.name);
}

function columnNames(s: Ce0Store, table: string): string[] {
  return (s.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
    (r) => r.name,
  );
}

describe("openCe0Store: schema", () => {
  it("creates exactly the three CE0 record tables", () => {
    const names = tableNames(store);
    expect(names).toContain("turn_memory_assessment");
    expect(names).toContain("turn_rule_obligation");
    expect(names).toContain("consultation_attempt");
  });

  it("creates NONE of the held tables (no coverage / recovery / correction / checkpoint)", () => {
    const names = tableNames(store).join("|").toLowerCase();
    for (const forbidden of [
      "coverage",
      "subject_coverage",
      "obligation_consultation_coverage",
      "recovery",
      "correction",
      "checkpoint",
    ]) {
      expect(names).not.toContain(forbidden);
    }
  });

  it("opens the database in WAL mode (doc mandates the SQLite WAL store)", () => {
    expect(store.db.pragma("journal_mode", { simple: true })).toBe("wal");
  });

  it("opens with a positive busy_timeout so a writer contended by a parallel session waits, not drops a measurement", () => {
    // CE0 is a measurement harness across concurrent Claude Code sessions: two sessions can both reach a
    // BEGIN IMMEDIATE write on the shared store at once. Without a busy_timeout the loser gets SQLITE_BUSY
    // at once and the fail-soft adapter silently DROPS that turn's row, which is a lost measurement. This
    // pins the contention-durability default (better-sqlite3 sets busy_timeout from its constructor timeout
    // option, default 5000ms) so opening the store with timeout:0 can never silently regress it to a drop.
    const busyTimeout = store.db.pragma("busy_timeout", { simple: true });
    expect(typeof busyTimeout).toBe("number");
    expect(busyTimeout as number).toBeGreaterThan(0);
  });

  it("gives turn_rule_obligation exactly the directive's columns, and no rollout-mode column", () => {
    const cols = columnNames(store, "turn_rule_obligation");
    for (const expected of [
      "obligation_id",
      "workspace_id",
      "session_id",
      "local_turn_sequence",
      "rule_id",
      "rule_version_id",
      "required_subjects",
      "subject_satisfaction",
      "status",
      "state_version",
      "deadline_claimed_at",
      "deadline_claimed_version",
      "response_hash",
      "outcome",
      "canonical_payload_hash",
    ]) {
      expect(cols).toContain(expected);
    }
    for (const forbidden of ["rollout_mode", "phase_mode", "deployment_mode", "ce_phase", "mode"]) {
      expect(cols).not.toContain(forbidden);
    }
  });
});

describe("CE0 store: sampling bucket column (R3 P0.9)", () => {
  it("gives turn_memory_assessment a sampling_bucket column", () => {
    expect(columnNames(store, "turn_memory_assessment")).toContain("sampling_bucket");
  });

  it("round-trips the assessment's deterministic sampling bucket", () => {
    insertTurnMemoryAssessment(store, { ...assessment, samplingBucket: "deadbeefcafef00d" });
    expect(getTurnMemoryAssessment(store, "asm_1")?.samplingBucket).toBe("deadbeefcafef00d");
  });
});

// R4 P0.1 recall snapshot (proposal lines 287-295): EVERY classified turn carries a content-free
// pointer to its prompt so the offline ce0-export can sample NOT_REQUIRED / UNKNOWN turns for
// false-negative grading. promptHash is the prompt's identity-only hash, born at classification and
// NOT_NULL on every assessment. The asserted-answer half (stopObservedAt / responseHash /
// responseSourceRef) is the first-Stop snapshot, built in the next describe block under the §2.3
// two-stage mechanism.
describe("CE0 store: prompt hash column (R4 P0.1 recall snapshot)", () => {
  it("gives turn_memory_assessment a prompt_hash column", () => {
    expect(columnNames(store, "turn_memory_assessment")).toContain("prompt_hash");
  });

  it("round-trips the assessment's prompt hash verbatim", () => {
    insertTurnMemoryAssessment(store, { ...assessment, promptHash: "cafef00ddeadbeef" });
    expect(getTurnMemoryAssessment(store, "asm_1")?.promptHash).toBe("cafef00ddeadbeef");
  });
});

// S-1 of the Stop response snapshot (proposal §2.3, lines 1102-1149): the asserted-answer half of
// the R4 recall snapshot, the contract pin the prompt-hash block above deferred. Stage A stamps
// stopObservedAt on EVERY classified turn; best-effort Stage B writes responseHash plus
// responseSourceRef (a local-only pointer into the Claude transcript, never emitted to analytics).
// All three are nullable columns filled by a later UPDATE, so they are OPTIONAL on the record
// (absent at the UserPromptSubmit insert) and the Draft / prompt-submit adapter stay untouched.
describe("CE0 store: Stop response snapshot columns (R4 §2.3 asserted-answer half)", () => {
  const sourceRef: ResponseSourceRefV1 = {
    kind: "CLAUDE_TRANSCRIPT_JSONL",
    version: 1,
    transcriptPath: "/tmp/sess/transcript.jsonl",
    recordByteOffset: 4096,
    recordByteLength: 512,
    recordSha256: "a".repeat(64),
    selector: "PARENT_ASSISTANT_TEXT_V1",
  };

  it("gives turn_memory_assessment the three snapshot columns", () => {
    expect(columnNames(store, "turn_memory_assessment")).toEqual(
      expect.arrayContaining(["stop_observed_at", "response_hash", "response_source_ref"]),
    );
  });

  it("leaves the snapshot fields absent on an assessment inserted without them (the UserPromptSubmit shape)", () => {
    insertTurnMemoryAssessment(store, assessment);
    const got = getTurnMemoryAssessment(store, "asm_1");
    expect(got).toEqual(assessment);
    expect(got).not.toHaveProperty("stopObservedAt");
    expect(got).not.toHaveProperty("responseHash");
    expect(got).not.toHaveProperty("responseSourceRef");
  });

  it("round-trips a fully snapshotted assessment, parsing the source ref back from JSON", () => {
    const snapshotted: TurnMemoryAssessmentRecord = {
      ...assessment,
      stopObservedAt: 1718700009000,
      responseHash: "b".repeat(64),
      responseSourceRef: sourceRef,
    };
    insertTurnMemoryAssessment(store, snapshotted);
    expect(getTurnMemoryAssessment(store, "asm_1")).toEqual(snapshotted);
  });
});

describe("recordStopResponseSnapshot: §2.3 Stage B idempotent response writer", () => {
  // Stage B is best-effort and runs OUTSIDE the Stage A deadline transaction: it fills the
  // response pair (responseHash + responseSourceRef) on a turn the Stage A stamp already touched.
  // It is idempotent under repeated Stop continuations (P0.6): a later Stop may fill a still-missing
  // snapshot, but it may NEVER overwrite one that already completed.
  const coord = { workspaceId: "ws_abc", sessionId: "sess_1", localTurnSequence: 7 };
  const sourceRef: ResponseSourceRefV1 = {
    kind: "CLAUDE_TRANSCRIPT_JSONL",
    version: 1,
    transcriptPath: "/tmp/sess/transcript.jsonl",
    recordByteOffset: 4096,
    recordByteLength: 512,
    recordSha256: "a".repeat(64),
    selector: "PARENT_ASSISTANT_TEXT_V1",
  };

  it("fills the response pair on a stamped assessment, leaving the Stage A stamp untouched", () => {
    insertTurnMemoryAssessment(store, { ...assessment, stopObservedAt: 1718700009000 });
    const res = recordStopResponseSnapshot(store, coord, {
      responseHash: "b".repeat(64),
      responseSourceRef: sourceRef,
    });
    expect(res).toEqual({ status: "RECORDED" });
    const got = getTurnMemoryAssessment(store, "asm_1");
    expect(got?.responseHash).toBe("b".repeat(64));
    expect(got?.responseSourceRef).toEqual(sourceRef);
    expect(got?.stopObservedAt).toBe(1718700009000);
  });

  it("is idempotent: a later Stop with a different snapshot never overwrites a completed one", () => {
    insertTurnMemoryAssessment(store, { ...assessment, stopObservedAt: 1718700009000 });
    recordStopResponseSnapshot(store, coord, { responseHash: "b".repeat(64), responseSourceRef: sourceRef });

    const second = recordStopResponseSnapshot(store, coord, {
      responseHash: "c".repeat(64),
      responseSourceRef: { ...sourceRef, recordByteOffset: 9999 },
    });
    expect(second).toEqual({ status: "ALREADY_RECORDED" });

    const got = getTurnMemoryAssessment(store, "asm_1");
    expect(got?.responseHash).toBe("b".repeat(64));
    expect(got?.responseSourceRef).toEqual(sourceRef);
  });

  it("returns NO_ASSESSMENT when no assessment row exists for the coord", () => {
    const res = recordStopResponseSnapshot(store, coord, {
      responseHash: "b".repeat(64),
      responseSourceRef: sourceRef,
    });
    expect(res).toEqual({ status: "NO_ASSESSMENT" });
    expect(getTurnMemoryAssessment(store, "asm_1")).toBeNull();
  });
});

describe("CE0 store: insert + read round-trips", () => {
  it("round-trips a TurnMemoryAssessment", () => {
    insertTurnMemoryAssessment(store, assessment);
    expect(getTurnMemoryAssessment(store, "asm_1")).toEqual(assessment);
  });

  it("round-trips a TurnRuleObligation, preserving JSON arrays, nulls, and numbers", () => {
    insertTurnRuleObligation(store, obligation);
    expect(getTurnRuleObligation(store, "obl_1")).toEqual(obligation);
  });

  it("round-trips a ConsultationAttempt, preserving the optional result and the boolean", () => {
    insertConsultationAttempt(store, consultation);
    expect(getConsultationAttempt(store, "con_1")).toEqual(consultation);
  });

  it("preserves a COMPLETE + NO_MATCH consultation with an absent result as null", () => {
    const noMatch: ConsultationAttemptRecord = {
      ...consultation,
      consultationId: "con_2",
      result: null,
    };
    insertConsultationAttempt(store, noMatch);
    expect(getConsultationAttempt(store, "con_2")).toEqual(noMatch);
  });

  it("returns null for an unknown id", () => {
    expect(getTurnRuleObligation(store, "nope")).toBeNull();
    expect(getTurnMemoryAssessment(store, "nope")).toBeNull();
    expect(getConsultationAttempt(store, "nope")).toBeNull();
  });
});

describe("appendConsultationAttempt: mints a per-turn monotonic orderingToken", () => {
  // The capture adapter (Commit 7b) records the FACT of one governed-memory pull; the
  // orderingToken is its position on the turn's number line. It must be monotonic and
  // wall-clock-free: the deadline claim (Commit 8) reads the high-water orderingToken as
  // the boundary, and the reducer breaks ties on it. So the store mints it transactionally
  // (BEGIN IMMEDIATE MAX+1, exactly like allocateTurnIdentity), never from a clock; the
  // caller supplies a draft WITHOUT orderingToken.
  const draft = (over: Partial<ConsultationAttemptDraft> = {}): ConsultationAttemptDraft => ({
    consultationId: "con_x",
    workspaceId: "ws_abc",
    sessionId: "sess_1",
    localTurnSequence: 7,
    source: "AGENT_PULL",
    consultationSubjects: [subject({ subjectId: "subj_softgate" })],
    execution: "COMPLETE",
    result: "RESULTS_RETURNED",
    deliveredToAnsweringContext: true,
    createdAt: 1718700000500,
    ...over,
  });

  it("mints orderingToken 1 for the first consultation in a turn and returns the persisted row", () => {
    const rec = appendConsultationAttempt(store, draft({ consultationId: "con_1" }));
    expect(rec.orderingToken).toBe(1);
    expect(getConsultationAttempt(store, "con_1")).toEqual(rec);
  });

  it("advances the token monotonically within the same turn (1, 2, 3)", () => {
    const a = appendConsultationAttempt(store, draft({ consultationId: "con_1" }));
    const b = appendConsultationAttempt(store, draft({ consultationId: "con_2" }));
    const c = appendConsultationAttempt(store, draft({ consultationId: "con_3" }));
    expect([a.orderingToken, b.orderingToken, c.orderingToken]).toEqual([1, 2, 3]);
  });

  it("restarts the token per turn: a different localTurnSequence begins again at 1", () => {
    appendConsultationAttempt(store, draft({ consultationId: "con_1", localTurnSequence: 7 }));
    const other = appendConsultationAttempt(
      store,
      draft({ consultationId: "con_2", localTurnSequence: 8 }),
    );
    expect(other.orderingToken).toBe(1);
  });

  it("keeps a separate number line per (workspace, session) for the same sequence", () => {
    appendConsultationAttempt(store, draft({ consultationId: "con_1", sessionId: "sess_1" }));
    const other = appendConsultationAttempt(
      store,
      draft({ consultationId: "con_2", sessionId: "sess_2" }),
    );
    expect(other.orderingToken).toBe(1);
  });
});

describe("claimFirstStop: §2.3 Stage A stamps the turn and freezes the eligibility boundary", () => {
  // Commit 8 + S-2: the §2.3 Stage A deadline transaction. In one BEGIN IMMEDIATE the first Stop
  // (a) stamps stopObservedAt on the turn's assessment for EVERY classified turn (REQUIRED or not),
  // and (b) when an obligation is present, freezes the eligibility boundary by recording the turn's
  // high-water orderingToken: any consultation that arrives after the claim (a higher token) is
  // post-deadline and excluded from satisfaction. The deadline claim is a CAS on stateVersion that
  // advances stateVersion WITHOUT moving status, and is idempotent: a later Stop must not move the
  // frozen boundary nor overwrite the first stopObservedAt. Stage A performs NO filesystem I/O;
  // the response snapshot is the best-effort Stage B, outside this transaction. Satisfaction itself
  // is recomputed offline (Commit 9) over the frozen eligible set; the claim only fixes the boundary.
  const RV = "consult-evidence@ce0-v1";
  const coord = { workspaceId: "ws_abc", sessionId: "sess_1", localTurnSequence: 7 };
  const STOP_AT = 1718700050000;
  const now = () => STOP_AT;

  const openObligation: TurnRuleObligationRecord = {
    obligationId: "obl_open",
    workspaceId: "ws_abc",
    sessionId: "sess_1",
    localTurnSequence: 7,
    ruleId: "consult-evidence",
    ruleVersionId: RV,
    requiredSubjects: [subject()],
    subjectSatisfaction: [],
    status: "OPEN",
    stateVersion: 0,
    deadlineClaimedAt: null,
    deadlineClaimedVersion: null,
    responseHash: null,
    outcome: null,
    canonicalPayloadHash: "cph_cafef00d",
  };

  function consult(consultationId: string): void {
    appendConsultationAttempt(store, {
      consultationId,
      workspaceId: "ws_abc",
      sessionId: "sess_1",
      localTurnSequence: 7,
      source: "AGENT_PULL",
      consultationSubjects: [subject()],
      execution: "COMPLETE",
      result: "RESULTS_RETURNED",
      deliveredToAnsweringContext: true,
      createdAt: 1718700000500,
    });
  }

  it("returns NO_OBLIGATION when the turn has no CE0 obligation", () => {
    expect(claimFirstStop(store, coord, RV, now)).toEqual({ status: "NO_OBLIGATION" });
  });

  it("is scoped by rule version: a foreign rule version finds no obligation", () => {
    insertTurnRuleObligation(store, openObligation);
    expect(claimFirstStop(store, coord, "other-rule@v9", now)).toEqual({
      status: "NO_OBLIGATION",
    });
  });

  it("stamps stopObservedAt on the turn's assessment alongside the deadline claim (a REQUIRED turn)", () => {
    insertTurnMemoryAssessment(store, assessment); // coord (ws_abc, sess_1, 7); stop_observed_at NULL
    insertTurnRuleObligation(store, openObligation);
    expect(claimFirstStop(store, coord, RV, now)).toMatchObject({ status: "CLAIMED" });
    expect(getTurnMemoryAssessment(store, "asm_1")?.stopObservedAt).toBe(STOP_AT);
  });

  it("stamps stopObservedAt for a NOT_REQUIRED turn that has no obligation (Stage A runs for every classified turn)", () => {
    // A NOT_REQUIRED / UNKNOWN turn has an assessment but no obligation; the deadline half is a
    // NO_OBLIGATION no-op, yet the assessment is still stamped so the false-negative recall sample
    // carries the same answer evidence as a flagged turn.
    insertTurnMemoryAssessment(store, { ...assessment, requirement: "NOT_REQUIRED" });
    expect(claimFirstStop(store, coord, RV, now)).toEqual({ status: "NO_OBLIGATION" });
    expect(getTurnMemoryAssessment(store, "asm_1")?.stopObservedAt).toBe(STOP_AT);
  });

  it("stamps stopObservedAt if-null: a later Stop never overwrites the first observation", () => {
    insertTurnMemoryAssessment(store, assessment);
    insertTurnRuleObligation(store, openObligation);
    claimFirstStop(store, coord, RV, () => STOP_AT);
    claimFirstStop(store, coord, RV, () => STOP_AT + 999); // a later Stop, a later clock
    expect(getTurnMemoryAssessment(store, "asm_1")?.stopObservedAt).toBe(STOP_AT);
  });

  it("freezes the boundary at the high-water orderingToken, advancing stateVersion not status", () => {
    insertTurnRuleObligation(store, openObligation);
    consult("con_1");
    consult("con_2");
    consult("con_3"); // tokens 1, 2, 3
    expect(claimFirstStop(store, coord, RV, now)).toEqual({
      status: "CLAIMED",
      claim: {
        obligationId: "obl_open",
        deadlineClaimedAt: 3,
        deadlineClaimedVersion: 0,
        stateVersion: 1,
      },
    });
    const after = getTurnRuleObligation(store, "obl_open");
    expect(after?.deadlineClaimedAt).toBe(3);
    expect(after?.deadlineClaimedVersion).toBe(0);
    expect(after?.stateVersion).toBe(1);
    expect(after?.status).toBe("OPEN"); // status NOT moved
    expect(after?.subjectSatisfaction).toEqual([]); // satisfaction NOT recomputed here
  });

  it("freezes a boundary of 0 when the agent never consulted", () => {
    insertTurnRuleObligation(store, openObligation);
    expect(claimFirstStop(store, coord, RV, now)).toMatchObject({
      status: "CLAIMED",
      claim: { deadlineClaimedAt: 0, stateVersion: 1 },
    });
  });

  it("is idempotent: a later Stop never moves the boundary or re-advances stateVersion", () => {
    insertTurnRuleObligation(store, openObligation);
    consult("con_1");
    consult("con_2"); // boundary 2
    expect(claimFirstStop(store, coord, RV, now)).toMatchObject({
      status: "CLAIMED",
      claim: { deadlineClaimedAt: 2, stateVersion: 1 },
    });
    // A late consultation arrives after the first Stop (token 3) ...
    consult("con_3");
    // ... and a second Stop fires: it must NOT move the boundary to 3 or bump stateVersion.
    expect(claimFirstStop(store, coord, RV, now)).toEqual({
      status: "ALREADY_CLAIMED",
      claim: {
        obligationId: "obl_open",
        deadlineClaimedAt: 2,
        deadlineClaimedVersion: 0,
        stateVersion: 1,
      },
    });
    const after = getTurnRuleObligation(store, "obl_open");
    expect(after?.deadlineClaimedAt).toBe(2);
    expect(after?.stateVersion).toBe(1);
  });
});

describe("CE0 store: the obligation identity is one per (turn, rule version)", () => {
  it("rejects a second obligation for the same (workspace, session, sequence, rule version)", () => {
    insertTurnRuleObligation(store, obligation);
    const collision: TurnRuleObligationRecord = { ...obligation, obligationId: "obl_dup" };
    expect(() => insertTurnRuleObligation(store, collision)).toThrow();
  });

  it("admits the same rule version on a different turn sequence", () => {
    insertTurnRuleObligation(store, obligation);
    const nextTurn: TurnRuleObligationRecord = {
      ...obligation,
      obligationId: "obl_2",
      localTurnSequence: 8,
    };
    expect(() => insertTurnRuleObligation(store, nextTurn)).not.toThrow();
    expect(getTurnRuleObligation(store, "obl_2")).toEqual(nextTurn);
  });
});

describe("CE0 store: listing the deadline-claimed obligation set (the export frozen set)", () => {
  /** An obligation whose deadline has NOT been claimed (still live, not exportable). */
  const liveObligation: TurnRuleObligationRecord = {
    ...obligation,
    obligationId: "obl_live",
    localTurnSequence: 5,
    status: "OPEN",
    deadlineClaimedAt: null,
    deadlineClaimedVersion: null,
  };

  it("returns only obligations whose deadline has been claimed, excluding live ones", () => {
    insertTurnRuleObligation(store, obligation); // deadlineClaimedAt 9
    insertTurnRuleObligation(store, liveObligation); // deadlineClaimedAt null
    const rows = listDeadlineClaimedObligations(store, "ws_abc");
    expect(rows.map((r) => r.obligationId)).toEqual(["obl_1"]);
  });

  it("includes FINALIZED obligations (the workflow layer, not the store, skips them)", () => {
    insertTurnRuleObligation(store, obligation);
    insertTurnRuleObligation(store, {
      ...obligation,
      obligationId: "obl_final",
      localTurnSequence: 8,
      status: "FINALIZED",
      outcome: "COMPLIANT_ON_TIME",
    });
    expect(listDeadlineClaimedObligations(store, "ws_abc").map((r) => r.obligationId)).toEqual([
      "obl_1",
      "obl_final",
    ]);
  });

  it("scopes to the given workspace", () => {
    insertTurnRuleObligation(store, obligation);
    insertTurnRuleObligation(store, {
      ...obligation,
      obligationId: "obl_other_ws",
      workspaceId: "ws_other",
    });
    expect(listDeadlineClaimedObligations(store, "ws_abc").map((r) => r.obligationId)).toEqual([
      "obl_1",
    ]);
  });

  it("orders deterministically session-major then sequence-minor", () => {
    // (session, sequence) is unique per rule version, so two rows can never share both; the
    // obligationId column in the ORDER BY is an unreachable backstop in CE0. This exercises the
    // reachable ordering: session first, then sequence within a session.
    insertTurnRuleObligation(store, { ...obligation, obligationId: "obl_b", sessionId: "sess_2", localTurnSequence: 1 });
    insertTurnRuleObligation(store, { ...obligation, obligationId: "obl_a", sessionId: "sess_1", localTurnSequence: 9 });
    insertTurnRuleObligation(store, { ...obligation, obligationId: "obl_x", sessionId: "sess_1", localTurnSequence: 3 });
    expect(listDeadlineClaimedObligations(store, "ws_abc").map((r) => r.obligationId)).toEqual([
      "obl_x",
      "obl_a",
      "obl_b",
    ]);
  });

  it("round-trips the full record shape (so the export carries every frozen field)", () => {
    insertTurnRuleObligation(store, obligation);
    expect(listDeadlineClaimedObligations(store, "ws_abc")).toEqual([obligation]);
  });
});

describe("CE0 store: listing a workspace's memory assessments (the offline telemetry source)", () => {
  // The offline `mla evidence ce0-emit-telemetry` sweep projects one
  // memory_requirement_assessed event per assessment row (proposal §6.4: the
  // precision/recall denominator). Unlike the obligation export, EVERY assessment is a
  // telemetry fact regardless of requirement or any deadline claim, so this reader has
  // no deadline filter. Deterministically ordered (session, sequence, assessmentId) so a
  // re-run projects the same events in the same order.
  it("returns every assessment in the workspace, with no deadline/requirement filter", () => {
    insertTurnMemoryAssessment(store, assessment); // REQUIRED
    insertTurnMemoryAssessment(store, {
      ...assessment,
      assessmentId: "asm_notreq",
      localTurnSequence: 8,
      requirement: "NOT_REQUIRED",
    });
    expect(listTurnMemoryAssessments(store, "ws_abc").map((a) => a.assessmentId)).toEqual([
      "asm_1",
      "asm_notreq",
    ]);
  });

  it("scopes to the given workspace", () => {
    insertTurnMemoryAssessment(store, assessment);
    insertTurnMemoryAssessment(store, {
      ...assessment,
      assessmentId: "asm_other_ws",
      workspaceId: "ws_other",
    });
    expect(listTurnMemoryAssessments(store, "ws_abc").map((a) => a.assessmentId)).toEqual([
      "asm_1",
    ]);
  });

  it("orders deterministically session-major then sequence-minor", () => {
    insertTurnMemoryAssessment(store, { ...assessment, assessmentId: "asm_b", sessionId: "sess_2", localTurnSequence: 1 });
    insertTurnMemoryAssessment(store, { ...assessment, assessmentId: "asm_a", sessionId: "sess_1", localTurnSequence: 9 });
    insertTurnMemoryAssessment(store, { ...assessment, assessmentId: "asm_x", sessionId: "sess_1", localTurnSequence: 3 });
    expect(listTurnMemoryAssessments(store, "ws_abc").map((a) => a.assessmentId)).toEqual([
      "asm_x",
      "asm_a",
      "asm_b",
    ]);
  });

  it("returns an empty list for a workspace with no assessments", () => {
    expect(listTurnMemoryAssessments(store, "ws_empty")).toEqual([]);
  });

  it("round-trips the full assessment record shape", () => {
    insertTurnMemoryAssessment(store, assessment);
    expect(listTurnMemoryAssessments(store, "ws_abc")).toEqual([assessment]);
  });
});

describe("CE0 store: listing a turn's consultations (the export raw facts)", () => {
  const turn = { workspaceId: "ws_abc", sessionId: "sess_1", localTurnSequence: 7 };

  it("returns the turn's consultations ordered by (orderingToken, consultationId)", () => {
    insertConsultationAttempt(store, { ...consultation, consultationId: "con_b", orderingToken: 2 });
    insertConsultationAttempt(store, { ...consultation, consultationId: "con_a", orderingToken: 1 });
    insertConsultationAttempt(store, { ...consultation, consultationId: "con_c", orderingToken: 2 });
    expect(listConsultationsForTurn(store, turn).map((c) => c.consultationId)).toEqual([
      "con_a",
      "con_b",
      "con_c",
    ]);
  });

  it("scopes to the (workspace, session, sequence) turn coordinate", () => {
    insertConsultationAttempt(store, consultation); // turn 7
    insertConsultationAttempt(store, { ...consultation, consultationId: "con_other_turn", localTurnSequence: 8 });
    insertConsultationAttempt(store, { ...consultation, consultationId: "con_other_sess", sessionId: "sess_2" });
    expect(listConsultationsForTurn(store, turn).map((c) => c.consultationId)).toEqual(["con_1"]);
  });

  it("returns an empty list for a turn that never consulted", () => {
    expect(listConsultationsForTurn(store, turn)).toEqual([]);
  });

  it("round-trips the full consultation record shape", () => {
    insertConsultationAttempt(store, consultation);
    expect(listConsultationsForTurn(store, turn)).toEqual([consultation]);
  });
});

describe("CE0 store: finalizing an obligation (CAS on stateVersion)", () => {
  it("finalizes a deadline-claimed obligation: writes outcome, status FINALIZED, advances stateVersion", () => {
    insertTurnRuleObligation(store, obligation); // SATISFIED, stateVersion 3, outcome null
    const result = finalizeObligation(store, {
      obligationId: "obl_1",
      expectedStateVersion: 3,
      outcome: "COMPLIANT_ON_TIME",
    });
    expect(result).toEqual({
      status: "FINALIZED",
      obligationId: "obl_1",
      outcome: "COMPLIANT_ON_TIME",
      stateVersion: 4,
    });
    expect(getTurnRuleObligation(store, "obl_1")).toMatchObject({
      status: "FINALIZED",
      outcome: "COMPLIANT_ON_TIME",
      stateVersion: 4,
    });
  });

  it("rejects a stale stateVersion as CAS_CONFLICT and leaves the row untouched", () => {
    insertTurnRuleObligation(store, obligation); // stateVersion 3
    const result = finalizeObligation(store, {
      obligationId: "obl_1",
      expectedStateVersion: 2, // stale
      outcome: "MISSED",
    });
    expect(result).toEqual({
      status: "CAS_CONFLICT",
      obligationId: "obl_1",
      expectedStateVersion: 2,
      actualStateVersion: 3,
    });
    expect(getTurnRuleObligation(store, "obl_1")).toMatchObject({
      status: "SATISFIED",
      outcome: null,
      stateVersion: 3,
    });
  });

  it("returns NO_OBLIGATION for an unknown obligation id", () => {
    expect(
      finalizeObligation(store, { obligationId: "obl_ghost", expectedStateVersion: 1, outcome: "MISSED" }),
    ).toEqual({ status: "NO_OBLIGATION", obligationId: "obl_ghost" });
  });

  it("is idempotent under CAS: a second finalize at the now-stale version conflicts, never double-writes", () => {
    insertTurnRuleObligation(store, obligation); // v3
    finalizeObligation(store, { obligationId: "obl_1", expectedStateVersion: 3, outcome: "COMPLIANT_ON_TIME" }); // -> v4
    const second = finalizeObligation(store, { obligationId: "obl_1", expectedStateVersion: 3, outcome: "MISSED" });
    expect(second).toEqual({
      status: "CAS_CONFLICT",
      obligationId: "obl_1",
      expectedStateVersion: 3,
      actualStateVersion: 4,
    });
    expect(getTurnRuleObligation(store, "obl_1")).toMatchObject({ status: "FINALIZED", outcome: "COMPLIANT_ON_TIME" });
  });
});

describe("CE0 store: the FINALIZED-IFF-outcome DB invariant", () => {
  it("rejects inserting a FINALIZED obligation with a null outcome", () => {
    expect(() =>
      insertTurnRuleObligation(store, { ...obligation, status: "FINALIZED", outcome: null }),
    ).toThrow();
  });

  it("rejects inserting a non-finalized obligation that carries an outcome", () => {
    expect(() =>
      insertTurnRuleObligation(store, { ...obligation, status: "OPEN", outcome: "COMPLIANT_ON_TIME" }),
    ).toThrow();
  });
});

// The measurement-integrity guard. A CE0 store created by an earlier mla, before a schema column
// was added (the live dogfood store predated consultation_attempt.source), keeps its drifted tables
// forever because the opener is CREATE TABLE IF NOT EXISTS. Every capture INSERT against the missing
// column then fails INSIDE the hook's fail-soft swallow, so the harness silently records nothing and
// under-counts with no signal. For a measurement harness that is the worst failure mode, so the opener
// stamps a schema version on a fresh store and REFUSES (loudly) to hand back a populated store whose
// version does not match the current code, rather than silently returning one it cannot write to.
describe("CE0 store: schema-version drift guard", () => {
  let dvDir: string;

  beforeEach(() => {
    dvDir = fs.mkdtempSync(path.join(os.tmpdir(), "ce0-drift-"));
  });

  afterEach(() => {
    fs.rmSync(dvDir, { recursive: true, force: true });
  });

  /** Fabricate the legacy store exactly as the pre-`source` mla left it: the three tables present,
   * consultation_attempt WITHOUT the source column, and user_version never stamped (0). */
  function writeLegacyStore(dbPath: string): void {
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE consultation_attempt (
        consultation_id                TEXT PRIMARY KEY,
        workspace_id                   TEXT NOT NULL,
        session_id                     TEXT NOT NULL,
        local_turn_sequence            INTEGER NOT NULL,
        consultation_subjects          TEXT NOT NULL,
        execution                      TEXT NOT NULL,
        result                         TEXT,
        delivered_to_answering_context INTEGER NOT NULL,
        ordering_token                 INTEGER NOT NULL,
        created_at                     INTEGER NOT NULL
      );
    `);
    db.close();
  }

  it("stamps a fresh store with the current schema version", () => {
    const p = path.join(dvDir, "fresh.db");
    const s = openCe0Store(p);
    expect(s.db.pragma("user_version", { simple: true })).toBe(CE0_SCHEMA_VERSION);
    closeCe0Store(s);
  });

  it("reopens a store it created without complaint (version matches)", () => {
    const p = path.join(dvDir, "reopen.db");
    closeCe0Store(openCe0Store(p));
    const again = openCe0Store(p);
    expect(again.db.pragma("user_version", { simple: true })).toBe(CE0_SCHEMA_VERSION);
    closeCe0Store(again);
  });

  it("throws (does not silently proceed) on a populated store whose version is behind the code", () => {
    const p = path.join(dvDir, "legacy.db");
    writeLegacyStore(p);
    expect(() => openCe0Store(p)).toThrow(Ce0StoreSchemaVersionError);
  });

  it("leaves the drifted store untouched when it refuses it (no wipe, no papered-over stamp)", () => {
    const p = path.join(dvDir, "legacy2.db");
    writeLegacyStore(p);
    try {
      openCe0Store(p);
    } catch {
      // expected
    }
    // The refusal is non-destructive AND does not paper over the drift: the opener never wipes the
    // tables, and it must NOT stamp the current version onto a pre-existing populated store. Stamping a
    // drifted v0 store up to v1 is exactly what corrupted the live dogfood store in an earlier build
    // (v1 on disk, yet still missing the source column), so a refused store stays at version 0.
    const db = new Database(p);
    const cols = (db.prepare("SELECT name FROM pragma_table_info('consultation_attempt')").all() as Array<
      Record<string, unknown>
    >).map((r) => r.name as string);
    const version = db.pragma("user_version", { simple: true });
    db.close();
    expect(cols).not.toContain("source");
    expect(version).toBe(0);
  });
});
