import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  openCe0Store,
  closeCe0Store,
  insertTurnMemoryAssessment,
  insertTurnRuleObligation,
  type Ce0Store,
  type TurnMemoryAssessmentRecord,
  type TurnRuleObligationRecord,
} from "../../src/lib/rules/ce0-store";
import { deterministicEventId } from "../../src/lib/analytics/event-id";
import type { RecordContext, RecordInput } from "../../src/lib/analytics/recorder";
import type { AnalyticsEvent } from "../../src/lib/analytics/envelope";
import { runEvidence, type EvidenceDeps } from "../../src/commands/evidence";

// `mla evidence ce0-emit-telemetry`: the OFFLINE projection of the CE0 durable store into the §6.4
// analytics events. It is a sweep, not a hook: zero per-turn latency, run by the operator alongside
// the labeling workflow. It projects exactly the two events the store honestly backs
// (memory_requirement_assessed per assessment, evidence_obligation_finalized per FINALIZED
// obligation), records each to the local events.jsonl, and best-effort flushes to control.
//
// Idempotency has two layers: the deterministic event_id dedupes on the remote sink, and a local
// skip-set (the event_ids already in the local log for these two types) keeps a repeated sweep from
// re-appending the same lines. Each event carries the ORIGINAL turn's session in its envelope, not
// the emit run's session, so the analytics side joins it to the turn it describes.

let dir: string;
let dbPath: string;
let store: Ce0Store;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "evidence-emit-"));
  dbPath = path.join(dir, "ce0.db");
  store = openCe0Store(dbPath);
});

afterEach(() => {
  closeCe0Store(store);
  fs.rmSync(dir, { recursive: true, force: true });
});

const baseAssessment: TurnMemoryAssessmentRecord = {
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

const baseObligation: TurnRuleObligationRecord = {
  obligationId: "obl_1",
  workspaceId: "ws_abc",
  sessionId: "sess_1",
  localTurnSequence: 7,
  ruleId: "consult-evidence",
  ruleVersionId: "consult-evidence@ce0-v1",
  requiredSubjects: [],
  subjectSatisfaction: [],
  status: "FINALIZED",
  stateVersion: 4,
  deadlineClaimedAt: 3,
  deadlineClaimedVersion: 0,
  responseHash: "rh_deadbeef",
  outcome: "COMPLIANT_ON_TIME",
  canonicalPayloadHash: "cph_cafef00d",
};

interface Recorded {
  ctx: RecordContext;
  input: RecordInput;
}

function makeDeps(
  over: Partial<EvidenceDeps> = {},
): { deps: EvidenceDeps; recorded: Recorded[]; flushed: number[]; out: string[]; err: string[] } {
  const recorded: Recorded[] = [];
  const flushed: number[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const deps: EvidenceDeps = {
    resolveWorkspaceId: () => "ws_abc",
    storePath: dbPath,
    record: ((ctx, input) => {
      recorded.push({ ctx, input });
      return {} as AnalyticsEvent;
    }) as EvidenceDeps["record"],
    flush: (async () => {
      flushed.push(1);
    }) as unknown as EvidenceDeps["flush"],
    readCfg: () => ({ actorUserId: "user_x" }) as never,
    readEvents: () => [],
    runId: "run_fixed",
    traceId: "trace_fixed",
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    ...over,
  };
  return { deps, recorded, flushed, out, err };
}

describe("mla evidence ce0-emit-telemetry: offline projection of the CE0 store", () => {
  it("projects one assessed event per assessment and one finalized event per FINALIZED obligation", async () => {
    insertTurnMemoryAssessment(store, baseAssessment);
    insertTurnMemoryAssessment(store, { ...baseAssessment, assessmentId: "asm_2", localTurnSequence: 8, requirement: "NOT_REQUIRED" });
    insertTurnRuleObligation(store, baseObligation); // FINALIZED -> emitted
    // A deadline-claimed but NOT-finalized obligation must NOT produce a finalized event.
    insertTurnRuleObligation(store, {
      ...baseObligation,
      obligationId: "obl_live",
      localTurnSequence: 9,
      status: "SATISFIED",
      outcome: null,
    });

    const { deps, recorded, flushed, out } = makeDeps();
    const code = await runEvidence(["ce0-emit-telemetry"], deps);

    expect(code).toBe(0);
    const byType = recorded.map((r) => r.input.eventType).sort();
    expect(byType).toEqual([
      "evidence_obligation_finalized",
      "memory_requirement_assessed",
      "memory_requirement_assessed",
    ]);
    // The finalized event is the FINALIZED one only, keyed on (obligationId, stateVersion).
    const fin = recorded.find((r) => r.input.eventType === "evidence_obligation_finalized");
    expect(fin?.input.eventId).toBe(deterministicEventId("obl_1", 4));
    expect(recorded.some((r) => r.input.payload.obligation_id === "obl_live")).toBe(false);
    expect(flushed).toEqual([1]); // flushed once (cfg present)
    expect(out.join("")).toContain("\"assessed\":2");
    expect(out.join("")).toContain("\"finalized\":1");
  });

  it("stamps each event with the ORIGINAL turn's session, not the emit run's session", async () => {
    insertTurnMemoryAssessment(store, { ...baseAssessment, assessmentId: "asm_a", sessionId: "sess_other" });
    const { deps, recorded } = makeDeps();
    await runEvidence(["ce0-emit-telemetry"], deps);
    const asm = recorded.find((r) => r.input.eventType === "memory_requirement_assessed");
    expect(asm?.ctx.sessionId).toBe("sess_other");
    expect(asm?.ctx.workspaceId).toBe("ws_abc");
    expect(asm?.ctx.runId).toBe("run_fixed");
    expect(asm?.ctx.traceId).toBe("trace_fixed");
    expect(asm?.ctx.distinctId).toBe("user_x");
  });

  it("skips events already present in the local log (a repeated sweep is idempotent)", async () => {
    insertTurnMemoryAssessment(store, baseAssessment); // -> asm_1 event id
    insertTurnRuleObligation(store, baseObligation); // -> obl_1@v4 event id
    const prior: AnalyticsEvent[] = [
      { event_id: deterministicEventId("asm_1", 0), event_type: "memory_requirement_assessed" } as AnalyticsEvent,
    ];
    const { deps, recorded, out } = makeDeps({ readEvents: () => prior });
    await runEvidence(["ce0-emit-telemetry"], deps);

    // The assessed event was already logged -> skipped; only the finalized event is recorded.
    expect(recorded.map((r) => r.input.eventType)).toEqual(["evidence_obligation_finalized"]);
    expect(out.join("")).toContain("\"skipped\":1");
  });

  it("scopes to the resolved workspace (a FINALIZED obligation in another workspace is ignored)", async () => {
    insertTurnRuleObligation(store, baseObligation); // ws_abc
    insertTurnRuleObligation(store, { ...baseObligation, obligationId: "obl_other_ws", workspaceId: "ws_other" });
    const { deps, recorded } = makeDeps();
    await runEvidence(["ce0-emit-telemetry"], deps);
    const finIds = recorded
      .filter((r) => r.input.eventType === "evidence_obligation_finalized")
      .map((r) => r.input.payload.obligation_id);
    expect(finIds).toEqual(["obl_1"]);
  });

  it("does not flush when there is no control config, but still records locally", async () => {
    insertTurnMemoryAssessment(store, baseAssessment);
    const { deps, recorded, flushed } = makeDeps({ readCfg: () => null });
    const code = await runEvidence(["ce0-emit-telemetry"], deps);
    expect(code).toBe(0);
    expect(recorded.length).toBe(1);
    expect(flushed).toEqual([]); // no cfg -> no remote forward
  });

  it("exits 1 and records nothing when no workspace resolves", async () => {
    insertTurnMemoryAssessment(store, baseAssessment);
    const { deps, recorded, err } = makeDeps({ resolveWorkspaceId: () => undefined });
    const code = await runEvidence(["ce0-emit-telemetry"], deps);
    expect(code).toBe(1);
    expect(recorded.length).toBe(0);
    expect(err.join("")).toContain("no workspace resolved");
  });
});
