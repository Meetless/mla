import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  CONSULT_EVIDENCE_CANONICAL_PAYLOAD_HASH,
  CONSULT_EVIDENCE_RULE_ID,
  CONSULT_EVIDENCE_RULE_VERSION_ID,
} from "../../../src/lib/rules/ce0-rule";
import {
  openCe0Store,
  closeCe0Store,
  insertTurnMemoryAssessment,
  insertTurnRuleObligation,
  appendConsultationAttempt,
  getTurnRuleObligation,
  getTurnMemoryAssessment,
  type Ce0Store,
} from "../../../src/lib/rules/ce0-store";
import {
  observeStop,
  parseStopInput,
  type StopAdapterConfig,
} from "../../../src/lib/rules/stop-adapter";
import { sha256Hex } from "../../../src/lib/rules/canonical-json";
import { samplingBucketFor } from "../../../src/lib/rules/ce0-sampling-bucket";

// Commit 8: the CE0 Stop adapter, the deadline-claim seam (proposal: the first Stop
// CAS-claims the deadline). When the agent finishes a turn, the first Stop hook resolves the
// turn's LocalTurnIdentity and freezes its obligation's eligibility boundary via the store's
// claimFirstStopDeadline. It mirrors the sibling adapters' discipline:
//   - It NEVER injects: the hook response is the empty object on EVERY branch (RECORD_ONLY).
//   - It NEVER turns an infra problem into a write or a throw: malformed input, a missing
//     session coordinate, and a persistence failure surface as INFRA.
//   - A turn with no obligation (NOT_REQUIRED, or a Stop for a session CE0 never assessed) is
//     NOT_APPLICABLE: there is simply nothing to freeze.
//   - It is idempotent: a later Stop reports ALREADY_CLAIMED and never moves the boundary.

let dir: string;
let store: Ce0Store;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ce0-stop-"));
  store = openCe0Store(path.join(dir, "ce0.db"));
});

afterEach(() => {
  closeCe0Store(store);
  fs.rmSync(dir, { recursive: true, force: true });
});

function config(over: Partial<StopAdapterConfig> = {}): StopAdapterConfig {
  // ruleVersionId defaults to the unarmed compile-time identity (matching seedObligation's default), so
  // the existing tests claim the obligation they seed. The GAP 3 slice-4 tests override it to an armed
  // version to prove the claim joins on whatever version the obligation was stamped with.
  return { store, workspaceId: "ws_abc", ruleVersionId: CONSULT_EVIDENCE_RULE_VERSION_ID, ...over };
}

function stop(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { session_id: "sess_1", hook_event_name: "Stop", ...over };
}

/** Seed a UserPromptSubmit assessment so the Stop's LocalTurnIdentity resolves. */
function seedTurn(seq = 1, sessionId = "sess_1"): void {
  insertTurnMemoryAssessment(store, {
    assessmentId: `asm_${sessionId}_${seq}`,
    workspaceId: "ws_abc",
    sessionId,
    localTurnSequence: seq,
    requirement: "REQUIRED",
    markersMatched: [],
    exclusionsMatched: [],
    classifierVersion: "raw-prompt-substring-v1",
    markerSetVersion: "seed-v1",
    exclusionSetVersion: "seed-v1",
    createdAt: 1718700000000,
    samplingBucket: samplingBucketFor({ workspaceId: "ws_abc", sessionId, localTurnSequence: seq }),
    promptHash: "ph_seed",
  });
}

/** Seed an OPEN CE0 obligation for the turn (the thing a Stop freezes a deadline on). The version id
 * the obligation is stamped with defaults to the unarmed compile-time identity; an armed test overrides
 * it to prove the Stop claim joins on whatever version stamped the obligation. */
function seedObligation(seq = 1, sessionId = "sess_1", ruleVersionId = CONSULT_EVIDENCE_RULE_VERSION_ID): string {
  const obligationId = `obl_${sessionId}_${seq}`;
  insertTurnRuleObligation(store, {
    obligationId,
    workspaceId: "ws_abc",
    sessionId,
    localTurnSequence: seq,
    ruleId: CONSULT_EVIDENCE_RULE_ID,
    ruleVersionId,
    requiredSubjects: [],
    subjectSatisfaction: [],
    status: "OPEN",
    stateVersion: 0,
    deadlineClaimedAt: null,
    deadlineClaimedVersion: null,
    responseHash: null,
    outcome: null,
    canonicalPayloadHash: CONSULT_EVIDENCE_CANONICAL_PAYLOAD_HASH,
  });
  return obligationId;
}

function consult(consultationId: string, seq = 1, sessionId = "sess_1"): void {
  appendConsultationAttempt(store, {
    consultationId,
    workspaceId: "ws_abc",
    sessionId,
    localTurnSequence: seq,
    source: "AGENT_PULL",
    consultationSubjects: [],
    execution: "COMPLETE",
    result: "RESULTS_RETURNED",
    deliveredToAnsweringContext: true,
    createdAt: 1718700000500,
  });
}

describe("observeStop: infrastructure problems never become writes or throws", () => {
  it("maps unparseable input to INFRA with an empty response", () => {
    seedTurn();
    seedObligation();
    const { response, outcome } = observeStop("not json at all", config());
    expect(response).toEqual({});
    expect(outcome).toEqual({ kind: "INFRA", diagnostic: "malformed hook input" });
  });

  it("maps a missing session coordinate to INFRA", () => {
    const { outcome } = observeStop(stop({ session_id: undefined }), config());
    expect(outcome).toEqual({ kind: "INFRA", diagnostic: "missing session_id coordinate" });
  });

  it("maps a persistence failure to INFRA, never a throw", () => {
    seedTurn();
    seedObligation();
    store.db.exec("DROP TABLE turn_rule_obligation");
    const { response, outcome } = observeStop(stop(), config());
    expect(response).toEqual({});
    expect(outcome.kind).toBe("INFRA");
  });
});

describe("observeStop: a turn with no obligation is NOT_APPLICABLE", () => {
  it("is NOT_APPLICABLE when the session has no turn identity yet", () => {
    const { response, outcome } = observeStop(stop(), config());
    expect(response).toEqual({});
    expect(outcome).toEqual({ kind: "NOT_APPLICABLE" });
  });

  it("is NOT_APPLICABLE when the turn was assessed but created no obligation (NOT_REQUIRED)", () => {
    seedTurn();
    expect(observeStop(stop(), config()).outcome).toEqual({ kind: "NOT_APPLICABLE" });
  });
});

describe("observeStop: the first Stop freezes the boundary", () => {
  it("never injects: the response is the empty object even when it claims", () => {
    seedTurn();
    seedObligation();
    expect(observeStop(stop(), config()).response).toEqual({});
  });

  it("freezes the high-water orderingToken and reports the claim", () => {
    seedTurn();
    const obligationId = seedObligation();
    consult("con_1");
    consult("con_2"); // boundary 2
    const { outcome } = observeStop(stop(), config());
    expect(outcome).toEqual({
      kind: "CLAIMED",
      obligationId,
      localTurnSequence: 1,
      deadlineClaimedAt: 2,
      deadlineClaimedVersion: 0,
      stateVersion: 1,
    });
    const after = getTurnRuleObligation(store, obligationId);
    expect(after?.deadlineClaimedAt).toBe(2);
    expect(after?.stateVersion).toBe(1);
    expect(after?.status).toBe("OPEN");
  });

  it("freezes a boundary of 0 when the agent never consulted", () => {
    seedTurn();
    seedObligation();
    expect(observeStop(stop(), config()).outcome).toMatchObject({
      kind: "CLAIMED",
      deadlineClaimedAt: 0,
    });
  });
});

describe("observeStop: a later Stop is idempotent", () => {
  it("reports ALREADY_CLAIMED and never moves the boundary or re-advances stateVersion", () => {
    seedTurn();
    const obligationId = seedObligation();
    consult("con_1"); // boundary 1
    expect(observeStop(stop(), config()).outcome).toMatchObject({
      kind: "CLAIMED",
      deadlineClaimedAt: 1,
      stateVersion: 1,
    });
    consult("con_2"); // a late consultation after the first Stop
    expect(observeStop(stop(), config()).outcome).toEqual({
      kind: "ALREADY_CLAIMED",
      obligationId,
      localTurnSequence: 1,
      deadlineClaimedAt: 1,
    });
    const after = getTurnRuleObligation(store, obligationId);
    expect(after?.deadlineClaimedAt).toBe(1);
    expect(after?.stateVersion).toBe(1);
  });
});

// GAP 3 slice 4: the Stop claim binds to config.ruleVersionId, not the compile-time constant. The
// prompt-submit adapter stamps the obligation with the runtime scope's resolved version (the LIVE
// attested one when armed); claimFirstStop joins the obligation on (ws, session, seq, ruleVersionId), so
// the Stop MUST claim with the SAME bound version or it orphans the armed obligation and never freezes it.
describe("observeStop: the deadline claim binds to config.ruleVersionId (the runtime scope's bound version)", () => {
  it("claims an obligation stamped with an ARMED version when config carries that same version", () => {
    seedTurn();
    const obligationId = seedObligation(1, "sess_1", "ver_armed_1");
    consult("con_1");
    const { outcome } = observeStop(stop(), config({ ruleVersionId: "ver_armed_1" }));
    expect(outcome).toMatchObject({ kind: "CLAIMED", obligationId, deadlineClaimedAt: 1 });
    expect(getTurnRuleObligation(store, obligationId)?.deadlineClaimedAt).toBe(1);
  });

  it("does NOT claim an armed obligation when config carries the unarmed constant (version id is load-bearing in the lookup)", () => {
    seedTurn();
    const obligationId = seedObligation(1, "sess_1", "ver_armed_1");
    // The default config carries the compile-time constant, which does not match the armed obligation.
    const { outcome } = observeStop(stop(), config());
    expect(outcome).toEqual({ kind: "NOT_APPLICABLE" });
    expect(getTurnRuleObligation(store, obligationId)?.deadlineClaimedAt).toBeNull();
  });
});

describe("parseStopInput: defensive shape gate", () => {
  it("returns null for unparseable strings and non-objects", () => {
    expect(parseStopInput("{not json")).toBeNull();
    expect(parseStopInput(42)).toBeNull();
    expect(parseStopInput(null)).toBeNull();
  });

  it("extracts the session coordinate from an object or a JSON string", () => {
    expect(parseStopInput(stop())).toEqual({ session_id: "sess_1" });
    expect(parseStopInput(JSON.stringify(stop()))).toEqual({ session_id: "sess_1" });
  });

  it("returns an absent session_id (not null) for an object lacking one, so the adapter can diagnose it", () => {
    expect(parseStopInput({ hook_event_name: "Stop" })).toEqual({ session_id: undefined });
  });

  it("carries transcript_path alongside the session coordinate (the §2.3 Stage B input)", () => {
    expect(parseStopInput(stop({ transcript_path: "/x/y.jsonl" }))).toEqual({
      session_id: "sess_1",
      transcript_path: "/x/y.jsonl",
    });
  });
});

// CE0 §2.3 Stage B, wired into the adapter (proposal lines 1119-1149). After the I/O-free Stage A
// deadline claim, the adapter reads transcript_path best-effort, snapshots the latest top-level
// parent assistant answer onto the turn's assessment (responseHash + responseSourceRef), and never
// fails Stop. Stage B runs for EVERY classified turn, REQUIRED or not, so the offline false-negative
// recall sample carries the same answer evidence as a flagged turn. A transcript failure leaves the
// snapshot null and marks the sample UNLABELABLE with a stable reason.

describe("observeStop: §2.3 Stage B records the response snapshot best-effort", () => {
  function writeTranscript(answer: string): string {
    const p = path.join(dir, "transcript.jsonl");
    const records = [
      { type: "user", message: { role: "user", content: [{ type: "text", text: "q" }] } },
      {
        type: "assistant",
        isSidechain: false,
        message: { role: "assistant", content: [{ type: "text", text: answer }] },
      },
    ];
    fs.writeFileSync(p, records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
    return p;
  }

  it("snapshots the canonical answer onto a REQUIRED turn and reports RECORDED, alongside the Stage A claim", () => {
    seedTurn();
    seedObligation();
    const res = observeStop(stop({ transcript_path: writeTranscript("the final answer") }), config());
    expect(res.outcome).toMatchObject({ kind: "CLAIMED" });
    expect(res.snapshot).toEqual({ kind: "RECORDED" });
    const asm = getTurnMemoryAssessment(store, "asm_sess_1_1");
    expect(asm?.responseHash).toBe(sha256Hex("the final answer"));
    expect(asm?.responseSourceRef?.selector).toBe("PARENT_ASSISTANT_TEXT_V1");
  });

  it("records the answer evidence even for a NOT_REQUIRED turn (no obligation): outcome NOT_APPLICABLE, snapshot RECORDED", () => {
    seedTurn(); // assessment but no obligation
    const res = observeStop(stop({ transcript_path: writeTranscript("answer for an unflagged turn") }), config());
    expect(res.outcome).toEqual({ kind: "NOT_APPLICABLE" });
    expect(res.snapshot).toEqual({ kind: "RECORDED" });
    expect(getTurnMemoryAssessment(store, "asm_sess_1_1")?.responseHash).toBe(
      sha256Hex("answer for an unflagged turn"),
    );
  });

  it("marks the sample UNLABELABLE with TRANSCRIPT_MISSING when no transcript_path is supplied, never failing Stop", () => {
    seedTurn();
    seedObligation();
    const res = observeStop(stop(), config()); // no transcript_path
    expect(res.response).toEqual({});
    expect(res.outcome).toMatchObject({ kind: "CLAIMED" });
    expect(res.snapshot).toEqual({ kind: "UNLABELABLE", reason: "TRANSCRIPT_MISSING" });
    expect(getTurnMemoryAssessment(store, "asm_sess_1_1")?.responseHash).toBeUndefined();
  });

  it("is idempotent: a later Stop never overwrites a completed snapshot (ALREADY_RECORDED)", () => {
    seedTurn();
    seedObligation();
    const first = observeStop(stop({ transcript_path: writeTranscript("first answer") }), config());
    expect(first.snapshot).toEqual({ kind: "RECORDED" });
    const second = observeStop(stop({ transcript_path: writeTranscript("a different later answer") }), config());
    expect(second.snapshot).toEqual({ kind: "ALREADY_RECORDED" });
    expect(getTurnMemoryAssessment(store, "asm_sess_1_1")?.responseHash).toBe(sha256Hex("first answer"));
  });

  it("stamps stopObservedAt from the injected clock", () => {
    seedTurn();
    seedObligation();
    observeStop(stop({ transcript_path: writeTranscript("a") }), config({ now: () => 1718700123456 }));
    expect(getTurnMemoryAssessment(store, "asm_sess_1_1")?.stopObservedAt).toBe(1718700123456);
  });
});
