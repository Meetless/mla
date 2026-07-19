// The evidence-grounding lifecycle (spec sections 4.2, 7.4; T4.1 + T4.2). Pure
// functions over caller-supplied data, so the correlator and this test run the
// identical close logic with no clock or I/O baked in. The close-precedence cases
// (turn_limit vs time_limit) are what make ignored vs unknown an honest split.

import {
  ABANDONED_AFTER_MS,
  CURRENT_CAPTURE_CONTRACT_VERSION,
  DeriveOutcomeContext,
  InjectRecord,
  OUTCOME_VERSION,
  WINDOW_MS,
  buildInjectPayload,
  deriveEndedSessions,
  deriveOutcome,
} from "../../src/lib/analytics/evidence";
import { McpCall, ReportCitation } from "../../src/lib/analytics/followthrough";
import { outcomeEventId } from "../../src/lib/analytics/event-id";

const T0 = Date.parse("2026-06-07T12:00:00.000Z");

const inject = (over: Partial<InjectRecord> = {}): InjectRecord => ({
  inject_id: "inj_1",
  session_id: "s1",
  turn_index: 5,
  offered_source_ids: ["NT:20260529-foo.md", "PR:bar"],
  window_deadline: new Date(T0 + WINDOW_MS).toISOString(),
  ...over,
});

const ctx = (over: Partial<DeriveOutcomeContext> = {}): DeriveOutcomeContext => ({
  nowMs: T0,
  maxTurnBySession: new Map([["s1", 5]]),
  ...over,
});

describe("buildInjectPayload", () => {
  it("coerces an unknown confidence to low and stamps the 15-minute deadline", () => {
    const p = buildInjectPayload({
      turn_index: 2,
      evidence_offered: 1,
      offered_source_ids: ["NT:x.md"],
      evidence_tokens: 100,
      retrieval_confidence: "bogus",
      retrieval_latency_ms: 50,
      createdAtMs: T0,
      injectId: "inj_x",
    });
    expect(p.inject_id).toBe("inj_x");
    expect(p.retrieval_confidence).toBe("low");
    expect(p.zero_results).toBe(false);
    expect(p.window_deadline).toBe(new Date(T0 + WINDOW_MS).toISOString());
  });

  it("marks a zero-result inject", () => {
    const p = buildInjectPayload({
      turn_index: 2,
      evidence_offered: 0,
      offered_source_ids: [],
      evidence_tokens: 0,
      retrieval_confidence: "high",
      retrieval_latency_ms: 0,
      createdAtMs: T0,
    });
    expect(p.zero_results).toBe(true);
    expect(p.evidence_offered).toBe(0);
  });

  it("carries the two material-incorporation provenance keys (§6.4)", () => {
    // version is static per build (capability advertisement), never null for this client.
    const consented = buildInjectPayload({
      turn_index: 2,
      evidence_offered: 1,
      offered_source_ids: ["NT:x.md"],
      evidence_tokens: 10,
      retrieval_confidence: "high",
      retrieval_latency_ms: 5,
      createdAtMs: T0,
      traceUploadConsented: true,
    });
    expect(consented.trace_upload_consented).toBe(true);
    expect(consented.work_product_capture_version).toBe(CURRENT_CAPTURE_CONTRACT_VERSION);

    // Declined consent still advertises capability (version non-null) but flags no egress.
    const declined = buildInjectPayload({
      turn_index: 2,
      evidence_offered: 1,
      offered_source_ids: ["NT:x.md"],
      evidence_tokens: 10,
      retrieval_confidence: "high",
      retrieval_latency_ms: 5,
      createdAtMs: T0,
      traceUploadConsented: false,
    });
    expect(declined.trace_upload_consented).toBe(false);
    expect(declined.work_product_capture_version).toBe(CURRENT_CAPTURE_CONTRACT_VERSION);

    // Omitted consent defaults to false so an old caller never over-claims.
    const omitted = buildInjectPayload({
      turn_index: 2,
      evidence_offered: 1,
      offered_source_ids: ["NT:x.md"],
      evidence_tokens: 10,
      retrieval_confidence: "high",
      retrieval_latency_ms: 5,
      createdAtMs: T0,
    });
    expect(omitted.trace_upload_consented).toBe(false);
  });
});

describe("deriveOutcome (the correlator close logic, INV-CORRELATOR-1)", () => {
  it("stays pending (null) while neither the turn window nor the deadline has passed", () => {
    const out = deriveOutcome(
      inject(),
      [],
      [],
      ctx({ nowMs: T0, maxTurnBySession: new Map([["s1", 6]]) }),
    );
    expect(out).toBeNull(); // maxTurn 6 < 5+3=8, now < deadline
  });

  it("returns null for an inject with no turn_index (cannot correlate, stays pending)", () => {
    expect(deriveOutcome(inject({ turn_index: null }), [], [], ctx())).toBeNull();
  });

  it("turn_limit close, not referenced -> ignored (full opportunity observed)", () => {
    const out = deriveOutcome(inject(), [], [], ctx({ maxTurnBySession: new Map([["s1", 8]]) }));
    expect(out).not.toBeNull();
    expect(out!.payload.window_closed_reason).toBe("turn_limit");
    expect(out!.payload.outcome).toBe("ignored");
    expect(out!.payload.referenced).toBe(false);
    expect(out!.event_id).toBe(outcomeEventId("inj_1", OUTCOME_VERSION));
  });

  it("turn_limit close, the agent PULLED an offered id -> used", () => {
    const calls: McpCall[] = [
      {
        session_id: "s1",
        turn_index: 6,
        evidence_tool: true,
        source_ids: ["NT:20260529-foo"],
        query: "q",
      },
    ];
    const out = deriveOutcome(inject(), calls, [], ctx({ maxTurnBySession: new Map([["s1", 8]]) }));
    expect(out!.payload.outcome).toBe("used");
    expect(out!.payload.pulled_within_window).toBe(true);
    expect(out!.payload.referenced).toBe(true);
    expect(out!.payload.referenced_source_ids).toContain("NT:20260529-foo.md");
  });

  it("time_limit close (session idle before the turn window filled) -> unknown, not ignored", () => {
    const out = deriveOutcome(
      inject(),
      [],
      [],
      ctx({ nowMs: T0 + WINDOW_MS + 1, maxTurnBySession: new Map([["s1", 6]]) }),
    );
    expect(out!.payload.window_closed_reason).toBe("time_limit");
    expect(out!.payload.outcome).toBe("unknown");
  });

  it("a report citation of an offered id -> used + report_cited, with reference rate and citation precision", () => {
    const cites: ReportCitation[] = [
      { session_id: "s1", turn_index: 6, source_ids: ["NT:20260529-foo", "ZZ:not-offered"] },
    ];
    const out = deriveOutcome(inject(), [], cites, ctx({ maxTurnBySession: new Map([["s1", 8]]) }));
    expect(out!.payload.outcome).toBe("used");
    expect(out!.payload.report_cited).toBe(true);
    expect(out!.payload.referenced_source_ids).toContain("NT:20260529-foo.md");
    // 1 of 2 distinct offered ids was referenced.
    expect(out!.payload.offered_reference_rate).toBeCloseTo(0.5, 6);
    // 1 of 2 distinct cited ids resolves to an offered id (ZZ:not-offered does not).
    expect(out!.payload.citation_precision).toBeCloseTo(0.5, 6);
  });

  it("is idempotent: the deterministic event_id is stable across recomputation", () => {
    const a = deriveOutcome(inject(), [], [], ctx({ maxTurnBySession: new Map([["s1", 8]]) }));
    const b = deriveOutcome(inject(), [], [], ctx({ maxTurnBySession: new Map([["s1", 8]]) }));
    expect(a!.event_id).toBe(b!.event_id);
  });
});

describe("deriveEndedSessions (the idle reaper, INV-CORRELATOR-1 / session-death approx)", () => {
  it("returns an empty set for an empty last-activity map (fail-safe no-op)", () => {
    expect(deriveEndedSessions(new Map(), T0).size).toBe(0);
  });

  it("marks a session idle for >= the abandonment threshold as ended", () => {
    const last = new Map([["s1", T0]]);
    const ended = deriveEndedSessions(last, T0 + ABANDONED_AFTER_MS);
    expect(ended.has("s1")).toBe(true);
  });

  it("does NOT mark a session idle for less than the threshold", () => {
    const last = new Map([["s1", T0]]);
    const ended = deriveEndedSessions(last, T0 + ABANDONED_AFTER_MS - 1);
    expect(ended.has("s1")).toBe(false);
  });

  it("never marks a session whose last activity is non-finite", () => {
    const last = new Map([["s1", Number.NaN]]);
    const ended = deriveEndedSessions(last, T0 + ABANDONED_AFTER_MS * 10);
    expect(ended.has("s1")).toBe(false);
  });

  it("honors a custom abandonment threshold", () => {
    const last = new Map([["s1", T0]]);
    expect(deriveEndedSessions(last, T0 + 1000, 1000).has("s1")).toBe(true);
    expect(deriveEndedSessions(last, T0 + 999, 1000).has("s1")).toBe(false);
  });
});

describe("deriveOutcome with a known-ended session (session_ended close, v2)", () => {
  // The deadline has passed but the turn window never filled: pre-reaper this closed
  // `unknown`. With the session in ctx.endedSessions it is finalized honestly.
  const afterDeadline = (over: Partial<DeriveOutcomeContext> = {}): DeriveOutcomeContext =>
    ctx({ nowMs: T0 + WINDOW_MS + 1, maxTurnBySession: new Map([["s1", 6]]), ...over });

  it("ended session + >=1 later turn, not referenced -> ignored / session_ended", () => {
    // maxTurn 6 is one past the inject turn 5: the agent took a turn and passed.
    const out = deriveOutcome(
      inject(),
      [],
      [],
      afterDeadline({ endedSessions: new Set(["s1"]) }),
    );
    expect(out!.payload.window_closed_reason).toBe("session_ended");
    expect(out!.payload.outcome).toBe("ignored");
    expect(out!.payload.outcome_version).toBe(OUTCOME_VERSION);
  });

  it("ended session + inject on the final turn (no later turn) -> no_opportunity / session_ended", () => {
    // maxTurn == inject turn 5: the inject landed on the last turn the agent took.
    const out = deriveOutcome(
      inject(),
      [],
      [],
      afterDeadline({ maxTurnBySession: new Map([["s1", 5]]), endedSessions: new Set(["s1"]) }),
    );
    expect(out!.payload.window_closed_reason).toBe("session_ended");
    expect(out!.payload.outcome).toBe("no_opportunity");
  });

  it("ended session but the offered id WAS referenced -> still used (referenced wins)", () => {
    const calls: McpCall[] = [
      { session_id: "s1", turn_index: 6, evidence_tool: true, source_ids: ["NT:20260529-foo"], query: "q" },
    ];
    const out = deriveOutcome(
      inject(),
      calls,
      [],
      afterDeadline({ endedSessions: new Set(["s1"]) }),
    );
    expect(out!.payload.outcome).toBe("used");
  });

  it("deadline passed but the session is NOT in endedSessions -> still unknown (no reaper info)", () => {
    const out = deriveOutcome(
      inject(),
      [],
      [],
      afterDeadline({ endedSessions: new Set(["other-session"]) }),
    );
    expect(out!.payload.window_closed_reason).toBe("time_limit");
    expect(out!.payload.outcome).toBe("unknown");
  });

  it("turn_limit precedence: a full turn window wins even when the session is ended", () => {
    // maxTurn 8 == 5+3: full window observed, so this is a turn_limit ignored, not
    // a session_ended close, even though the session is in endedSessions.
    const out = deriveOutcome(
      inject(),
      [],
      [],
      afterDeadline({ maxTurnBySession: new Map([["s1", 8]]), endedSessions: new Set(["s1"]) }),
    );
    expect(out!.payload.window_closed_reason).toBe("turn_limit");
    expect(out!.payload.outcome).toBe("ignored");
  });
});
