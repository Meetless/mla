import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  openCe0Store,
  closeCe0Store,
  allocateTurnIdentity,
  openTurnAtomically,
  resolveLatestTurnIdentity,
  getTurnMemoryAssessment,
  getTurnRuleObligation,
  insertTurnMemoryAssessment,
  type Ce0Store,
  type LocalTurnIdentity,
  type TurnMemoryAssessmentRecord,
  type TurnRuleObligationRecord,
} from "../../../src/lib/rules/ce0-store";
import { samplingBucketFor } from "../../../src/lib/rules/ce0-sampling-bucket";

// Commit 5: the LocalTurnIdentity coordinate
// (notes/20260617-evidence-consultation-forcing-function-proposal.md req 1, lines
// 1109-1125). UserPromptSubmit allocates (workspaceId, sessionId, localTurnSequence)
// in one `BEGIN IMMEDIATE; nextSequence = MAX(localTurnSequence)+1; insert
// TurnMemoryAssessment; COMMIT` transaction; every later parent hook reuses it by
// reading the latest assessment back. There is deliberately NO separate turn-registry
// (cursor) table: the TurnMemoryAssessment row IS the registry, and the BEGIN
// IMMEDIATE allocation is the single serialization point.

let dir: string;
let dbPath: string;
let store: Ce0Store;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ce0-turn-"));
  dbPath = path.join(dir, "ce0.db");
  store = openCe0Store(dbPath);
});

afterEach(() => {
  closeCe0Store(store);
  fs.rmSync(dir, { recursive: true, force: true });
});

const draft = (over: Partial<Omit<TurnMemoryAssessmentRecord, "localTurnSequence">> = {}) => ({
  assessmentId: "asm_x",
  workspaceId: "ws_abc",
  sessionId: "sess_1",
  requirement: "REQUIRED" as const,
  markersMatched: ["what did we decide"],
  exclusionsMatched: [],
  classifierVersion: "raw-prompt-substring-v1",
  markerSetVersion: "seed-v1",
  exclusionSetVersion: "seed-v1",
  createdAt: 1718700000000,
  promptHash: "ph_x",
  ...over,
});

function tableNames(s: Ce0Store): string[] {
  return (
    s.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as { name: string }[]
  ).map((r) => r.name);
}

describe("allocateTurnIdentity: BEGIN IMMEDIATE MAX+1 minting", () => {
  it("mints localTurnSequence 1 for the first turn in a (workspace, session)", () => {
    const rec = allocateTurnIdentity(store, draft({ assessmentId: "asm_1" }));
    expect(rec.localTurnSequence).toBe(1);
  });

  it("increments monotonically within the same (workspace, session)", () => {
    const a = allocateTurnIdentity(store, draft({ assessmentId: "asm_1" }));
    const b = allocateTurnIdentity(store, draft({ assessmentId: "asm_2" }));
    const c = allocateTurnIdentity(store, draft({ assessmentId: "asm_3" }));
    expect([a.localTurnSequence, b.localTurnSequence, c.localTurnSequence]).toEqual([1, 2, 3]);
  });

  it("keeps the sequence independent per (workspace, session)", () => {
    allocateTurnIdentity(store, draft({ assessmentId: "asm_1", sessionId: "sess_1" }));
    allocateTurnIdentity(store, draft({ assessmentId: "asm_2", sessionId: "sess_1" }));
    const otherSession = allocateTurnIdentity(store, draft({ assessmentId: "asm_3", sessionId: "sess_2" }));
    const otherWorkspace = allocateTurnIdentity(store, draft({ assessmentId: "asm_4", workspaceId: "ws_zzz" }));
    expect(otherSession.localTurnSequence).toBe(1);
    expect(otherWorkspace.localTurnSequence).toBe(1);
  });

  it("persists the minted assessment as the registry row (round-trips with the minted sequence)", () => {
    const rec = allocateTurnIdentity(store, draft({ assessmentId: "asm_1" }));
    expect(rec.localTurnSequence).toBe(1);
    expect(getTurnMemoryAssessment(store, "asm_1")).toEqual(rec);
  });

  it("reads committed state across separate connections to the same file (the registry is the table)", () => {
    const first = allocateTurnIdentity(store, draft({ assessmentId: "asm_1" }));
    expect(first.localTurnSequence).toBe(1);
    const other = openCe0Store(dbPath);
    try {
      const second = allocateTurnIdentity(other, draft({ assessmentId: "asm_2" }));
      expect(second.localTurnSequence).toBe(2);
    } finally {
      closeCe0Store(other);
    }
  });

  it("adds no turn-registry table: turn_memory_assessment is the registry", () => {
    allocateTurnIdentity(store, draft({ assessmentId: "asm_1" }));
    const names = tableNames(store);
    // The turn-identity slice reuses turn_memory_assessment as the registry (MAX+1 minting);
    // it must NOT introduce a separate turn-identity / turn-registry table. The shared CE0
    // store also carries the rules interception tables (one opener, one database), so this
    // asserts the CE0 record tables are present and the absence of a turn-registry table,
    // rather than pinning the whole schema.
    expect(names).toEqual(
      expect.arrayContaining(["consultation_attempt", "turn_memory_assessment", "turn_rule_obligation"]),
    );
    expect(names.filter((n) => /turn_identity|turn_registry|local_turn/i.test(n))).toEqual([]);
  });

  it("mints the sampling bucket from the natural key (workspace, session, minted sequence)", () => {
    // The bucket is derived from the natural key, which includes the localTurnSequence minted INSIDE
    // this transaction, so allocate is the only place it can be computed (the draft cannot carry it).
    const rec = allocateTurnIdentity(store, draft({ assessmentId: "asm_1" }));
    expect(rec.samplingBucket).toBe(
      samplingBucketFor({
        workspaceId: rec.workspaceId,
        sessionId: rec.sessionId,
        localTurnSequence: rec.localTurnSequence,
      }),
    );
    // Persisted, not merely returned.
    expect(getTurnMemoryAssessment(store, "asm_1")?.samplingBucket).toBe(rec.samplingBucket);
  });

  it("rejects a hand-built assessment that collides on the minted (workspace, session, sequence)", () => {
    allocateTurnIdentity(store, draft({ assessmentId: "asm_1" }));
    expect(() =>
      insertTurnMemoryAssessment(store, {
        ...draft({ assessmentId: "asm_dup" }),
        localTurnSequence: 1,
        samplingBucket: "bucket_dup",
      }),
    ).toThrow();
  });
});

describe("openTurnAtomically: the assessment and its REQUIRED obligation in one BEGIN IMMEDIATE (R4 P0.4)", () => {
  // A minimal obligation built from the freshly minted assessment, mirroring what the UserPromptSubmit
  // adapter constructs for a REQUIRED turn. The builder runs INSIDE the opening transaction, so it can
  // carry the localTurnSequence just minted.
  const obligationFor = (
    a: TurnMemoryAssessmentRecord,
    over: Partial<TurnRuleObligationRecord> = {},
  ): TurnRuleObligationRecord => ({
    obligationId: "obl_1",
    workspaceId: a.workspaceId,
    sessionId: a.sessionId,
    localTurnSequence: a.localTurnSequence,
    ruleId: "consult-evidence",
    ruleVersionId: "consult-evidence@ce0-v1",
    requiredSubjects: [],
    subjectSatisfaction: [],
    status: "OPEN",
    stateVersion: 0,
    deadlineClaimedAt: null,
    deadlineClaimedVersion: null,
    responseHash: null,
    outcome: null,
    canonicalPayloadHash: "cph_test",
    ...over,
  });

  const obligationCount = (s: Ce0Store): number =>
    (s.db.prepare("SELECT COUNT(*) AS n FROM turn_rule_obligation").get() as { n: number }).n;

  it("persists both the assessment and the obligation, sharing the minted sequence", () => {
    const { assessment, obligation } = openTurnAtomically(store, draft({ assessmentId: "asm_1" }), (a) =>
      obligationFor(a),
    );
    expect(assessment.localTurnSequence).toBe(1);
    expect(obligation?.localTurnSequence).toBe(1);
    expect(getTurnMemoryAssessment(store, "asm_1")).toEqual(assessment);
    expect(getTurnRuleObligation(store, "obl_1")).toEqual(obligation);
  });

  it("persists only the assessment when buildObligation returns null (a NOT_REQUIRED turn)", () => {
    const { assessment, obligation } = openTurnAtomically(
      store,
      draft({ assessmentId: "asm_1", requirement: "NOT_REQUIRED" }),
      () => null,
    );
    expect(obligation).toBeNull();
    expect(getTurnMemoryAssessment(store, "asm_1")).toEqual(assessment);
    expect(obligationCount(store)).toBe(0);
  });

  it("rolls back the assessment AND the sequence when the obligation insert fails (no half-open turn)", () => {
    openTurnAtomically(store, draft({ assessmentId: "asm_1" }), (a) =>
      obligationFor(a, { obligationId: "obl_dup" }),
    );
    // A second REQUIRED turn whose obligation collides on the primary key: the insert throws INSIDE the
    // opening transaction, so the just-inserted assessment and the sequence allocation must roll back too.
    expect(() =>
      openTurnAtomically(store, draft({ assessmentId: "asm_2" }), (a) =>
        obligationFor(a, { obligationId: "obl_dup" }),
      ),
    ).toThrow();
    expect(getTurnMemoryAssessment(store, "asm_2")).toBeNull();
    expect(obligationCount(store)).toBe(1);
    // The sequence was not consumed: the next clean open is 2, not 3.
    const next = openTurnAtomically(store, draft({ assessmentId: "asm_3" }), (a) =>
      obligationFor(a, { obligationId: "obl_ok" }),
    );
    expect(next.assessment.localTurnSequence).toBe(2);
  });
});

describe("resolveLatestTurnIdentity: later hooks reuse the coordinate", () => {
  it("returns the highest-sequence identity for the (workspace, session)", () => {
    allocateTurnIdentity(store, draft({ assessmentId: "asm_1" }));
    allocateTurnIdentity(store, draft({ assessmentId: "asm_2" }));
    const latest = resolveLatestTurnIdentity(store, { workspaceId: "ws_abc", sessionId: "sess_1" });
    expect(latest).toEqual<LocalTurnIdentity>({
      workspaceId: "ws_abc",
      sessionId: "sess_1",
      localTurnSequence: 2,
    });
  });

  it("scopes resolution to the (workspace, session) and ignores other turns", () => {
    allocateTurnIdentity(store, draft({ assessmentId: "asm_1", sessionId: "sess_1" }));
    allocateTurnIdentity(store, draft({ assessmentId: "asm_2", sessionId: "sess_1" }));
    allocateTurnIdentity(store, draft({ assessmentId: "asm_3", sessionId: "sess_2" }));
    const latest = resolveLatestTurnIdentity(store, { workspaceId: "ws_abc", sessionId: "sess_2" });
    expect(latest).toEqual<LocalTurnIdentity>({
      workspaceId: "ws_abc",
      sessionId: "sess_2",
      localTurnSequence: 1,
    });
  });

  it("returns null when the (workspace, session) has no turn yet", () => {
    expect(resolveLatestTurnIdentity(store, { workspaceId: "ws_abc", sessionId: "none" })).toBeNull();
  });
});
