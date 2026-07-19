// `mla _internal evidence-correlate` -- the Stop-hook local correlator (spec
// sections 7.4, 10.5, INV-CORRELATOR-1). Exercises the full close path with a real
// recorder + tmp MEETLESS_HOME; only the external transport (http.post) is mocked.
//
// The §10.5 correlator row: "Stop hook closes a window at 3 turns and at 15 minutes;
// run it twice; session ends before window closes" => "one outcome per inject_id;
// idempotent on re-run; un-closed inject persists as pending, not lost."
//
// Injects are seeded through the real `mla _internal evidence-inject` so the events
// land exactly as the live hook writes them. maxTurnBySession is driven via the
// readLog dep (synthetic ask-traces), so the close reason is deterministic.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
// Type-only (erased at compile, so they never defeat jest.resetModules): the seal
// seams are typed against the real dep signatures the correlator declares.
import type { CliConfig } from "../../src/lib/config";
import type { WorkProductCaptureBody } from "../../src/lib/analytics/work-product-seal";
import type { ForwardResult } from "../../src/lib/analytics/forwarder";

jest.mock("../../src/lib/http", () => ({
  post: jest.fn().mockResolvedValue({}),
}));

type CorrelateModule = typeof import("../../src/commands/internal-evidence-correlate");
type InjectModule = typeof import("../../src/commands/internal-evidence-inject");
type StoreModule = typeof import("../../src/lib/analytics/store");
type RecorderModule = typeof import("../../src/lib/analytics/recorder");
type EvidenceModule = typeof import("../../src/lib/analytics/evidence");
type EventIdModule = typeof import("../../src/lib/analytics/event-id");

const TRACE = "0123456789abcdef0123456789abcdef";
const NOW = Date.parse("2026-06-07T12:00:00.000Z");
// Fired after the inject, but the close logic is driven by deps.nowMs per case.
const RUN = NOW + 1000;

describe("runInternalEvidenceCorrelate", () => {
  let tmp: string;
  let correlate: CorrelateModule;
  let inject: InjectModule;
  let store: StoreModule;
  let recorder: RecorderModule;
  let evidence: EvidenceModule;
  let eventId: EventIdModule;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mla-correlate-"));
    process.env.MEETLESS_HOME = tmp;
    delete process.env.MEETLESS_LOCAL_STATS;
    delete process.env.MEETLESS_TELEMETRY;
    delete process.env.MEETLESS_NO_TELEMETRY;
    delete process.env.CLAUDE_CODE_SESSION_ID;
    jest.resetModules();
    store = require("../../src/lib/analytics/store");
    recorder = require("../../src/lib/analytics/recorder");
    evidence = require("../../src/lib/analytics/evidence");
    eventId = require("../../src/lib/analytics/event-id");
    inject = require("../../src/commands/internal-evidence-inject");
    correlate = require("../../src/commands/internal-evidence-correlate");
    const httpPost = require("../../src/lib/http").post as jest.Mock;
    httpPost.mockClear();
    httpPost.mockResolvedValue({});
    recorder.resetRecorderForTesting();
  });

  afterEach(() => {
    delete process.env.MEETLESS_HOME;
    delete process.env.MEETLESS_LOCAL_STATS;
    delete process.env.MEETLESS_TELEMETRY;
    delete process.env.MEETLESS_NO_TELEMETRY;
    delete process.env.CLAUDE_CODE_SESSION_ID;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  // Seed one mla_evidence_inject at the given turn, return its inject_id. `extra`
  // is appended last so a case can override the defaults (e.g. ["--confidence",
  // "low"] to make the inject emit an inject-time coverage gap of its own).
  async function seedInject(
    turn: number,
    sids = "NT:20260529-foo.md,PR:bar",
    extra: string[] = [],
    // Emit-time env override: a case that seeds the inject with trace upload OFF gets an
    // inject payload carrying trace_upload_consented:false (the seal path then skips it).
    envOverride?: NodeJS.ProcessEnv,
  ): Promise<string> {
    await inject.runInternalEvidenceInject(
      [
        "--turn-index",
        String(turn),
        "--offered-ids",
        sids,
        "--tokens",
        "1000",
        "--confidence",
        "high",
        "--latency-ms",
        "300",
        "--trace-id",
        TRACE,
        "--session-id",
        "s1",
        "--workspace-id",
        "ws_1",
        ...extra,
      ],
      {
        readCfg: () => null,
        machineId: () => "m_test",
        mintRunId: () => "run_inj",
        nowMs: NOW,
        ...(envOverride ? { env: envOverride } : {}),
      },
    );
    const injects = store.readEvents().filter((e) => (e as { event_type: string }).event_type === "mla_evidence_inject");
    return (injects[injects.length - 1] as unknown as { inject_id: string }).inject_id;
  }

  const outcomes = () =>
    store.readEvents().filter((e) => (e as { event_type: string }).event_type === "mla_evidence_outcome") as unknown as Record<string, unknown>[];

  const gaps = () =>
    store.readEvents().filter((e) => (e as { event_type: string }).event_type === "mla_coverage_gap") as unknown as Record<string, unknown>[];

  // synthetic ask-traces lines so the per-session max turn is whatever the case needs.
  const logsWithMaxTurn = (turn: number) => (file: string): Record<string, unknown>[] =>
    file === "ask-traces.jsonl" ? [{ session_id: "s1", turn_index: turn }] : [];

  // Seed an inject the raw way (via the recorder) so its payload OMITS
  // work_product_capture_version. The live command always stamps it (=1), so this is
  // the only way to exercise the correlator's "not capture-capable -> never seal" guard.
  // Everything the close path needs (run/trace/session/turn/offered ids/deadline) is present.
  function seedRawInjectNoCaptureVersion(turn: number): string {
    const injectId = "inj_no_capture_version";
    recorder.recordAnalyticsEvent(
      {
        workspaceId: "ws_1",
        sessionId: "s1",
        runId: "run_inj",
        traceId: TRACE,
        source: "hook",
        now: new Date(NOW).toISOString(),
      },
      {
        eventType: "mla_evidence_inject",
        eventId: injectId,
        payload: {
          inject_id: injectId,
          turn_index: turn,
          offered_source_ids: ["NT:20260529-foo.md"],
          window_deadline: new Date(NOW + evidence.WINDOW_MS).toISOString(),
          trace_upload_consented: true,
          zero_results: true, // suppress the outcome-time coverage gap (irrelevant here)
        },
      },
    );
    return injectId;
  }

  it("rejects an unknown flag with exit 2", async () => {
    expect(await correlate.runInternalEvidenceCorrelate(["--bogus"], {})).toBe(2);
  });

  it("closes a window at the 3-turn limit -> ignored, deterministic event_id, inject's trace/run", async () => {
    const injectId = await seedInject(5);
    recorder.resetRecorderForTesting();
    const code = await correlate.runInternalEvidenceCorrelate([], {
      readLog: logsWithMaxTurn(8), // maxTurn 8 >= 5 + 3 -> turn_limit
      readCfg: () => null,
      nowMs: RUN,
    });
    expect(code).toBe(0);
    const out = outcomes();
    expect(out).toHaveLength(1);
    expect(out[0].inject_id).toBe(injectId);
    expect(out[0].event_type).toBe("mla_evidence_outcome");
    expect(out[0].outcome).toBe("ignored");
    expect(out[0].window_closed_reason).toBe("turn_limit");
    expect(out[0].referenced).toBe(false);
    expect(out[0].source).toBe("hook");
    // The outcome joins back to the inject's enrichment trace + run (section 11.3).
    expect(out[0].trace_id).toBe(TRACE);
    expect(out[0].run_id).toBe("run_inj");
    expect(out[0].workspace_id).toBe("ws_1");
    // Deterministic, server-recomputable id.
    expect(out[0].event_id).toBe(eventId.outcomeEventId(injectId, evidence.OUTCOME_VERSION));
  });

  it("collapses to PENDING when the deadline passed but the session is not yet ENDED (v3: no durable unknown)", async () => {
    await seedInject(5);
    recorder.resetRecorderForTesting();
    const code = await correlate.runInternalEvidenceCorrelate([], {
      readLog: logsWithMaxTurn(6), // maxTurn 6 < 5 + 3, the deadline passed but s1 is not idle 24h
      readCfg: () => null,
      nowMs: NOW + evidence.WINDOW_MS + 1, // only 15 min on: deriveEndedSessions leaves s1 alive
    });
    expect(code).toBe(0);
    // The blind `unknown` is no longer a durable verdict: it is re-derived next sweep
    // and only finalized once the idle reaper proves the session ended.
    expect(outcomes()).toHaveLength(0);
  });

  it("leaves an inject PENDING when the session ends before either window closes (not lost)", async () => {
    await seedInject(5);
    recorder.resetRecorderForTesting();
    const code = await correlate.runInternalEvidenceCorrelate([], {
      readLog: logsWithMaxTurn(6), // maxTurn 6 < 8 AND now < deadline -> still open
      readCfg: () => null,
      nowMs: NOW + 1000,
    });
    expect(code).toBe(0);
    expect(outcomes()).toHaveLength(0); // no outcome line: pending is its absence
    // the inject itself is untouched and still present
    const stillInject = store.readEvents().filter((e) => (e as { event_type: string }).event_type === "mla_evidence_inject");
    expect(stillInject).toHaveLength(1);
  });

  it("is idempotent: running twice produces exactly one outcome per inject_id", async () => {
    await seedInject(5);
    recorder.resetRecorderForTesting();
    const deps = { readLog: logsWithMaxTurn(8), readCfg: () => null, nowMs: RUN };
    await correlate.runInternalEvidenceCorrelate([], deps);
    recorder.resetRecorderForTesting();
    await correlate.runInternalEvidenceCorrelate([], deps); // re-run: sees the outcome, skips
    expect(outcomes()).toHaveLength(1);
  });

  it("marks an inject USED when the agent pulled an offered id inside the window", async () => {
    const injectId = await seedInject(5);
    recorder.resetRecorderForTesting();
    await correlate.runInternalEvidenceCorrelate([], {
      readLog: (file: string): Record<string, unknown>[] => {
        if (file === "ask-traces.jsonl") return [{ session_id: "s1", turn_index: 8 }];
        if (file === "mcp-calls.jsonl")
          return [
            { session_id: "s1", turn_index: 6, evidence_tool: true, source_ids: ["NT:20260529-foo"], query: "q" },
          ];
        return [];
      },
      readCfg: () => null,
      nowMs: RUN,
    });
    const out = outcomes();
    expect(out).toHaveLength(1);
    expect(out[0].inject_id).toBe(injectId);
    expect(out[0].outcome).toBe("used");
    expect(out[0].pulled_within_window).toBe(true);
    expect(out[0].referenced).toBe(true);
  });

  // --- Outcome-time coverage gap (candidates_found_not_used; spec §7.5) -------

  it("emits a candidates_found_not_used gap when a confident, non-empty inject closes IGNORED", async () => {
    const injectId = await seedInject(5); // high-confidence, has offered ids -> no inject-time gap
    recorder.resetRecorderForTesting();
    await correlate.runInternalEvidenceCorrelate([], {
      readLog: logsWithMaxTurn(8), // turn_limit close, never referenced -> ignored
      readCfg: () => null,
      nowMs: RUN,
    });
    expect(outcomes()[0].outcome).toBe("ignored");
    const g = gaps();
    expect(g).toHaveLength(1);
    expect(g[0].coverage_gap_type).toBe("candidates_found_not_used");
    expect(g[0].inject_id).toBe(injectId);
    expect(g[0].zero_results).toBe(false);
    expect(g[0].query_topic_category).toBe("unknown"); // correlator cannot recover the topic
    expect(g[0].source).toBe("hook");
    // Deterministic, distinct from any inject-time gap id for the same inject.
    expect(g[0].event_id).toBe(
      require("../../src/lib/analytics/coverage-gap").coverageGapNotUsedEventId(injectId),
    );
  });

  it("emits NO outcome-time gap when the inject was USED", async () => {
    await seedInject(5);
    recorder.resetRecorderForTesting();
    await correlate.runInternalEvidenceCorrelate([], {
      readLog: (file: string): Record<string, unknown>[] => {
        if (file === "ask-traces.jsonl") return [{ session_id: "s1", turn_index: 8 }];
        if (file === "mcp-calls.jsonl")
          return [
            { session_id: "s1", turn_index: 6, evidence_tool: true, source_ids: ["NT:20260529-foo"], query: "q" },
          ];
        return [];
      },
      readCfg: () => null,
      nowMs: RUN,
    });
    expect(outcomes()[0].outcome).toBe("used");
    expect(gaps()).toHaveLength(0);
  });

  it("suppresses the outcome-time gap when an inject-time gap already classified the inject", async () => {
    // A low-confidence inject emits its OWN inject-time low_confidence_candidates
    // gap; the correlator must NOT also emit candidates_found_not_used for it
    // (spec §7.5: outcome-time gap fires "only when inject-time emitted nothing").
    await seedInject(5, "NT:20260529-foo.md,PR:bar", ["--confidence", "low"]);
    recorder.resetRecorderForTesting();
    await correlate.runInternalEvidenceCorrelate([], {
      readLog: logsWithMaxTurn(8),
      readCfg: () => null,
      nowMs: RUN,
    });
    expect(outcomes()[0].outcome).toBe("ignored");
    const g = gaps();
    expect(g).toHaveLength(1); // only the inject-time gap survives
    expect(g[0].coverage_gap_type).toBe("low_confidence_candidates");
  });

  it("emits NEITHER an outcome NOR a gap on a time_limit close that collapses to pending (v3)", async () => {
    await seedInject(5);
    recorder.resetRecorderForTesting();
    await correlate.runInternalEvidenceCorrelate([], {
      readLog: logsWithMaxTurn(6), // under the turn limit, deadline passed, session not ended
      readCfg: () => null,
      nowMs: NOW + evidence.WINDOW_MS + 1,
    });
    // The window collapsed to pending: no durable unknown outcome, and therefore no
    // coverage gap either (the full window was never observed).
    expect(outcomes()).toHaveLength(0);
    expect(gaps()).toHaveLength(0);
  });

  // --- session-ended idle reaper (v2: drains `unknown` for dead sessions) ------
  // The inject's only timestamp source here is its own created_at == NOW (the
  // synthetic ask-traces carry no `ts`), so running the correlator 25h later makes
  // session s1 idle past ABANDONED_AFTER_MS (24h) -> ENDED.

  const DAY_MS = 24 * 60 * 60 * 1000;

  it("finalizes a dead session's inject on the FINAL turn as no_opportunity / session_ended (was unknown)", async () => {
    await seedInject(5);
    recorder.resetRecorderForTesting();
    await correlate.runInternalEvidenceCorrelate([], {
      readLog: logsWithMaxTurn(5), // maxTurn == inject turn: no later turn was ever taken
      readCfg: () => null,
      nowMs: NOW + DAY_MS + 1000, // > 24h after the inject -> s1 is ended
    });
    const out = outcomes();
    expect(out).toHaveLength(1);
    expect(out[0].outcome).toBe("no_opportunity");
    expect(out[0].window_closed_reason).toBe("session_ended");
    // no_opportunity is not a coverage gap (the agent never got a turn).
    expect(gaps()).toHaveLength(0);
  });

  it("finalizes a dead session's inject with a later turn as ignored / session_ended, and emits NO coverage gap (partial window)", async () => {
    await seedInject(5);
    recorder.resetRecorderForTesting();
    await correlate.runInternalEvidenceCorrelate([], {
      readLog: logsWithMaxTurn(6), // one turn after the inject, but < the 3-turn window
      readCfg: () => null,
      nowMs: NOW + DAY_MS + 1000,
    });
    const out = outcomes();
    expect(out).toHaveLength(1);
    expect(out[0].outcome).toBe("ignored");
    expect(out[0].window_closed_reason).toBe("session_ended");
    // A session_ended ignored saw only a PARTIAL window, so the coverage-gap guard
    // (turn_limit only) must suppress candidates_found_not_used.
    expect(gaps()).toHaveLength(0);
  });

  // --- re-open guard (v3: a legacy `unknown` is NOT terminal -> drains the backlog) ---
  // The skip-set holds only injects whose LATEST outcome is terminal. A window that once
  // closed blind as `unknown` (legacy v1/v2 landing) must be re-derived every sweep so
  // the idle reaper can finalize it. Append a synthetic legacy `unknown` outcome, then
  // prove the next sweep re-derives a terminal at OUTCOME_VERSION (fresh, superseding id).

  // Append a stored mla_evidence_outcome the way a legacy correlator run would have, at
  // an OLD outcome_version with the matching deterministic event_id for that version.
  function seedLegacyOutcome(injectId: string, outcome: string, version: number): void {
    recorder.recordAnalyticsEvent(
      {
        workspaceId: "ws_1",
        sessionId: "s1",
        runId: "run_inj",
        traceId: TRACE,
        source: "hook",
        now: new Date(NOW + evidence.WINDOW_MS + 1).toISOString(),
      },
      {
        eventType: "mla_evidence_outcome",
        eventId: eventId.outcomeEventId(injectId, version),
        payload: {
          inject_id: injectId,
          outcome,
          outcome_version: version,
          window_closed_reason: "time_limit",
          referenced: false,
        },
      },
    );
  }

  it("re-derives an inject whose latest outcome is the legacy `unknown` and finalizes it at the current version", async () => {
    const injectId = await seedInject(5);
    seedLegacyOutcome(injectId, "unknown", 1); // a stale v1 blind close sits in the log
    recorder.resetRecorderForTesting();
    await correlate.runInternalEvidenceCorrelate([], {
      readLog: logsWithMaxTurn(5), // no later turn taken
      readCfg: () => null,
      // Past 24h of silence after the LATEST activity (the seeded v1 outcome at +15min),
      // so the idle reaper marks s1 ended.
      nowMs: NOW + 2 * DAY_MS,
    });
    const out = outcomes();
    // Two outcome lines now exist: the legacy v1 unknown + the freshly finalized terminal.
    expect(out).toHaveLength(2);
    const finalized = out.find((o) => o.outcome === "no_opportunity");
    expect(finalized).toBeDefined();
    expect(finalized!.window_closed_reason).toBe("session_ended");
    expect(finalized!.outcome_version).toBe(evidence.OUTCOME_VERSION);
    // The new terminal carries a distinct, version-bumped event_id that SUPERSEDES the
    // legacy v1 landing in both read reducers (highest outcome_version wins).
    expect(finalized!.event_id).toBe(eventId.outcomeEventId(injectId, evidence.OUTCOME_VERSION));
    expect(finalized!.event_id).not.toBe(eventId.outcomeEventId(injectId, 1));
  });

  it("does NOT re-derive an inject whose latest outcome is already terminal (idempotent skip holds)", async () => {
    const injectId = await seedInject(5);
    seedLegacyOutcome(injectId, "ignored", 2); // a terminal verdict already recorded
    recorder.resetRecorderForTesting();
    await correlate.runInternalEvidenceCorrelate([], {
      readLog: logsWithMaxTurn(5),
      readCfg: () => null,
      nowMs: NOW + DAY_MS + 1000,
    });
    // The terminal skip-set holds: no new outcome line is appended for this inject.
    expect(outcomes()).toHaveLength(1);
    expect(outcomes()[0].outcome).toBe("ignored");
  });

  it("forwards closed outcomes to control only when telemetry is opted in", async () => {
    await seedInject(5);
    recorder.resetRecorderForTesting();
    process.env.MEETLESS_TELEMETRY = "on";
    const httpPost = require("../../src/lib/http").post as jest.Mock;
    await correlate.runInternalEvidenceCorrelate([], {
      readLog: logsWithMaxTurn(8),
      readCfg: () => ({
        controlUrl: "http://127.0.0.1:9",
        controlToken: "t",
        mlaPath: "/tmp/mla",
        auth: { mode: "shared-key" as const, accessToken: "t" },
      }),
      nowMs: RUN,
    });
    // The decided (ignored), consented, capture-capable inject now ALSO seals its
    // window: with nothing staged that seal is a `failed` POST to the capture route
    // (asserted in the seal-on-window-close block). Isolate the analytics forward by
    // route so this test stays about outcome forwarding, not the seal.
    const analyticsCalls = httpPost.mock.calls.filter(
      (c) => c[1] === "/internal/v1/analytics/events",
    );
    expect(analyticsCalls).toHaveLength(1);
    const body = analyticsCalls[0][2];
    // A confident, non-empty inject that closes ignored forwards BOTH the outcome
    // and the paired outcome-time candidates_found_not_used coverage gap.
    const forwarded = (body as { events: { event_type: string }[] }).events;
    expect(forwarded).toHaveLength(2);
    expect(forwarded.map((e) => e.event_type).sort()).toEqual([
      "mla_coverage_gap",
      "mla_evidence_outcome",
    ]);
  });

  it("buildLastActivityBySession takes the max timestamp across all sources and keys, and skips records with no parseable ts", () => {
    const m = correlate.buildLastActivityBySession([
      {
        records: [
          { session_id: "s1", created_at: new Date(NOW).toISOString(), emitted_at: new Date(NOW + 5000).toISOString() },
          { session_id: "s2", created_at: "not-a-date" }, // unparseable -> s2 absent
        ],
        keys: ["created_at", "emitted_at"],
      },
      {
        records: [
          { session_id: "s1", ts: NOW + 9000 }, // numeric epoch ms, newer than the event keys
          { session_id: "s3" }, // no ts key at all -> s3 absent
        ],
        keys: ["ts"],
      },
    ]);
    expect(m.get("s1")).toBe(NOW + 9000); // max across emitted_at (NOW+5000) and ts (NOW+9000)
    expect(m.has("s2")).toBe(false);
    expect(m.has("s3")).toBe(false);
  });

  it("is fail-soft: a record dep that throws never escapes (returns 0)", async () => {
    await seedInject(5);
    recorder.resetRecorderForTesting();
    const code = await correlate.runInternalEvidenceCorrelate([], {
      readLog: logsWithMaxTurn(8),
      readCfg: () => null,
      record: () => {
        throw new Error("disk full");
      },
      nowMs: RUN,
    });
    expect(code).toBe(0);
  });

  // --- local capture reaper wiring (§11 backstop, WORK_PRODUCT_CAPTURE_LOCAL_TTL_HOURS) ---
  // Every sweep drops locally staged work-product captures past the 48h TTL. The store is
  // per-session (shared by sibling injects), so there is no safe per-inject eager delete;
  // this age-based sweep is the guaranteed local cleanup. It runs regardless of control
  // config and never disturbs the sweep.
  describe("local capture reaper wiring (§11)", () => {
    it("invokes the reaper once per sweep with the sweep's env + clock", async () => {
      await seedInject(5);
      recorder.resetRecorderForTesting();
      const reap = jest.fn((_env?: NodeJS.ProcessEnv, _nowMs?: number) => 0);
      await correlate.runInternalEvidenceCorrelate([], {
        readLog: logsWithMaxTurn(8),
        readCfg: () => null, // no forward: proves the reaper runs even with no control cfg
        reap,
        nowMs: RUN,
      });
      expect(reap).toHaveBeenCalledTimes(1);
      const [envArg, nowArg] = reap.mock.calls[0];
      expect(envArg).toBe(process.env); // deps.env defaulted to process.env
      expect(nowArg).toBe(RUN); // the same clock the close path used
    });

    it("a reaper that throws never disturbs the sweep (fail-soft, exit 0, outcome still landed)", async () => {
      const injectId = await seedInject(5);
      recorder.resetRecorderForTesting();
      const code = await correlate.runInternalEvidenceCorrelate([], {
        readLog: logsWithMaxTurn(8),
        readCfg: () => null,
        reap: () => {
          throw new Error("unlink EPERM");
        },
        nowMs: RUN,
      });
      expect(code).toBe(0);
      expect(outcomes()[0].inject_id).toBe(injectId);
      expect(outcomes()[0].outcome).toBe("ignored");
    });

    it("end to end: a full sweep reaps a stale capture file and keeps a fresh one", async () => {
      const wpc = require("../../src/lib/analytics/work-product-capture");
      // Stage two real capture files under the tmp MEETLESS_HOME store.
      wpc.appendHunkCapture(
        { sessionId: "stale", turnIndex: 5, file: "/repo/a.ts", tool: "Edit", hunk: "code" },
        process.env,
      );
      wpc.appendHunkCapture(
        { sessionId: "fresh", turnIndex: 5, file: "/repo/b.ts", tool: "Edit", hunk: "code" },
        process.env,
      );
      const stalePath = wpc.captureSessionPath("stale", process.env);
      const freshPath = wpc.captureSessionPath("fresh", process.env);
      expect(fs.existsSync(stalePath)).toBe(true);
      expect(fs.existsSync(freshPath)).toBe(true);

      // Backdate the stale file past the 48h TTL; leave the fresh one recent.
      const hourMs = 60 * 60 * 1000;
      const oldSecs = (RUN - (wpc.WORK_PRODUCT_CAPTURE_LOCAL_TTL_HOURS + 1) * hourMs) / 1000;
      fs.utimesSync(stalePath, oldSecs, oldSecs);
      const freshSecs = (RUN - hourMs) / 1000;
      fs.utimesSync(freshPath, freshSecs, freshSecs);

      await seedInject(5);
      recorder.resetRecorderForTesting();
      // A full sweep with the REAL reaper (no seam) at the sweep clock.
      await correlate.runInternalEvidenceCorrelate([], {
        readLog: logsWithMaxTurn(8),
        readCfg: () => null,
        nowMs: RUN,
      });
      expect(fs.existsSync(stalePath)).toBe(false); // reaped
      expect(fs.existsSync(freshPath)).toBe(true); // kept
    });
  });

  // --- seal-on-window-close: the atomic capture-intake POST (§8, §12.1) --------
  // A DECIDED inject (referenced -> outcome "used", or "ignored") that is capture-capable
  // (positive emit-time work_product_capture_version) AND consented (emit-time
  // trace_upload_consented AND live consent at correlate time) has its work-product window
  // sealed via ONE best-effort POST, DEFERRED until after the flush so control has the
  // inject row first (§10.6 step 1). These stage REAL captures onto disk under the tmp
  // MEETLESS_HOME and assert the exact POST body through a postCapture seam; readCaptures
  // reads the real bytes (no store mock), and a flush seam records call order.
  describe("seal-on-window-close (§8, §12.1)", () => {
    const NOW_ISO = new Date(NOW).toISOString();
    const RUN_ISO = new Date(RUN).toISOString();
    const DAY_MS = 24 * 60 * 60 * 1000;
    const CFG: CliConfig = {
      controlUrl: "http://127.0.0.1:9",
      controlToken: "t",
      mlaPath: "/tmp/mla",
      auth: { mode: "shared-key" as const, accessToken: "t" },
    };

    // The seal path is content-upload consent gated; make emit + correlate default to ON
    // unless a case flips it, and never leak the flag to a sibling test.
    beforeEach(() => {
      delete process.env.MEETLESS_TRACE_UPLOAD;
    });
    afterEach(() => {
      delete process.env.MEETLESS_TRACE_UPLOAD;
    });

    // A postCapture + flush seam pair that records call ORDER and every POST body, so a
    // case can assert both WHAT was sealed and that the flush ran first.
    const emptyForward: ForwardResult = {
      attempted: 0,
      forwarded: 0,
      skippedConsent: false,
      skippedNotEmittable: 0,
      failed: 0,
    };

    function seams(): {
      bodies: WorkProductCaptureBody[];
      order: string[];
      postCapture: (cfg: CliConfig, body: WorkProductCaptureBody) => Promise<void>;
      flush: () => Promise<ForwardResult>;
    } {
      const bodies: WorkProductCaptureBody[] = [];
      const order: string[] = [];
      const postCapture = jest.fn(
        async (_cfg: CliConfig, body: WorkProductCaptureBody): Promise<void> => {
          order.push("post");
          bodies.push(body);
        },
      );
      const flush = jest.fn(async (): Promise<ForwardResult> => {
        order.push("flush");
        return emptyForward;
      });
      return { bodies, order, postCapture, flush };
    }

    function stageHunk(turn: number): void {
      require("../../src/lib/analytics/work-product-capture").appendHunkCapture(
        {
          sessionId: "s1",
          turnIndex: turn,
          file: "/repo/a.ts",
          tool: "Edit",
          hunk: "- const x = 1;\n+ const x = 2;",
          nowIso: NOW_ISO,
        },
        process.env,
      );
    }

    function stageAssistant(turn: number, text: string): void {
      require("../../src/lib/analytics/work-product-capture").appendAssistantOutputCapture(
        { sessionId: "s1", turnIndex: turn, text, nowIso: NOW_ISO },
        process.env,
      );
    }

    // ask-traces to turn 8 (closes the turn-5 window at turn_limit) + one evidence pull at
    // turn 6 referencing an offered id -> outcome "used".
    const usedLog = (file: string): Record<string, unknown>[] => {
      if (file === "ask-traces.jsonl") return [{ session_id: "s1", turn_index: 8 }];
      if (file === "mcp-calls.jsonl")
        return [
          { session_id: "s1", turn_index: 6, evidence_tool: true, source_ids: ["NT:20260529-foo"], query: "q" },
        ];
      return [];
    };

    it("a referenced (used) inject seals with the §5 digest for its exact window", async () => {
      const injectId = await seedInject(5);
      stageHunk(6); // a real changed-code hunk inside the window [5, 8]
      recorder.resetRecorderForTesting();
      const s = seams();
      const code = await correlate.runInternalEvidenceCorrelate([], {
        readLog: usedLog,
        readCfg: () => CFG,
        flush: s.flush,
        postCapture: s.postCapture,
        nowMs: RUN,
      });
      expect(code).toBe(0);
      expect(outcomes()[0].outcome).toBe("used");
      expect(s.bodies).toHaveLength(1);
      const body = s.bodies[0];
      expect(body.status).toBe("sealed");
      expect(body.injectId).toBe(injectId);
      expect(body.captureContractVersion).toBe(evidence.CURRENT_CAPTURE_CONTRACT_VERSION);
      expect(body.capturedTurnStart).toBe(5);
      expect(body.capturedTurnEnd).toBe(8);
      const digest = JSON.parse(String(body.workProductDigest)) as Record<string, unknown>;
      expect(digest.window_start_turn).toBe(5);
      expect(digest.window_end_turn).toBe(8);
      expect(digest.capture_contract_version).toBe(1);
      expect(digest.sealed_at).toBe(RUN_ISO);
      const turns = digest.turns as Array<{ changed_hunks: unknown[] }>;
      expect(turns.some((t) => t.changed_hunks.length > 0)).toBe(true);
    });

    it("an ignored inject with staged output seals (referenced=false is still capture_expected)", async () => {
      await seedInject(5);
      stageAssistant(6, "Here is the closing summary for the turn.");
      recorder.resetRecorderForTesting();
      const s = seams();
      await correlate.runInternalEvidenceCorrelate([], {
        readLog: logsWithMaxTurn(8), // turn_limit -> ignored
        readCfg: () => CFG,
        flush: s.flush,
        postCapture: s.postCapture,
        nowMs: RUN,
      });
      expect(outcomes()[0].outcome).toBe("ignored");
      expect(s.bodies).toHaveLength(1);
      expect(s.bodies[0].status).toBe("sealed");
      expect(typeof s.bodies[0].workProductDigest).toBe("string");
    });

    it("a decided-but-empty window seals as `failed` with NO digest body", async () => {
      await seedInject(5); // consented + capable, but nothing is staged for the window
      recorder.resetRecorderForTesting();
      const s = seams();
      await correlate.runInternalEvidenceCorrelate([], {
        readLog: logsWithMaxTurn(8),
        readCfg: () => CFG,
        flush: s.flush,
        postCapture: s.postCapture,
        nowMs: RUN,
      });
      expect(outcomes()[0].outcome).toBe("ignored");
      expect(s.bodies).toHaveLength(1);
      expect(s.bodies[0].status).toBe("failed");
      expect(s.bodies[0].workProductDigest).toBeUndefined();
    });

    it("a no_opportunity close is never sealed (terminal but not decided)", async () => {
      await seedInject(5);
      stageAssistant(5, "some output"); // present, but the outcome is not decided
      recorder.resetRecorderForTesting();
      const s = seams();
      await correlate.runInternalEvidenceCorrelate([], {
        readLog: logsWithMaxTurn(5), // no later turn -> session_ended / no_opportunity
        readCfg: () => CFG,
        flush: s.flush,
        postCapture: s.postCapture,
        nowMs: NOW + DAY_MS + 1000, // > 24h -> s1 ended
      });
      expect(outcomes()[0].outcome).toBe("no_opportunity");
      expect(s.bodies).toHaveLength(0);
    });

    it("does NOT seal when live consent was withdrawn since inject time", async () => {
      await seedInject(5);
      stageAssistant(6, "output");
      recorder.resetRecorderForTesting();
      const s = seams();
      await correlate.runInternalEvidenceCorrelate([], {
        readLog: logsWithMaxTurn(8),
        readCfg: () => CFG,
        flush: s.flush,
        postCapture: s.postCapture,
        nowMs: RUN,
        env: { ...process.env, MEETLESS_TRACE_UPLOAD: "off" }, // live consent off
      });
      expect(outcomes()[0].outcome).toBe("ignored"); // outcome still closes
      expect(s.bodies).toHaveLength(0); // but nothing is sealed
    });

    it("does NOT seal an inject whose emit-time consent was false", async () => {
      // Recorded under trace-upload OFF -> the inject carries trace_upload_consented:false.
      await seedInject(5, "NT:20260529-foo.md,PR:bar", [], {
        ...process.env,
        MEETLESS_TRACE_UPLOAD: "off",
      });
      recorder.resetRecorderForTesting();
      const s = seams();
      await correlate.runInternalEvidenceCorrelate([], {
        readLog: logsWithMaxTurn(8),
        readCfg: () => CFG,
        flush: s.flush,
        postCapture: s.postCapture,
        nowMs: RUN, // live consent ON here, but the emit-time flag gates it out
      });
      expect(outcomes()[0].outcome).toBe("ignored");
      expect(s.bodies).toHaveLength(0);
    });

    it("does NOT seal an inject with no work_product_capture_version (not capture-capable)", async () => {
      const injectId = seedRawInjectNoCaptureVersion(5);
      recorder.resetRecorderForTesting();
      const s = seams();
      await correlate.runInternalEvidenceCorrelate([], {
        readLog: logsWithMaxTurn(8),
        readCfg: () => CFG,
        flush: s.flush,
        postCapture: s.postCapture,
        nowMs: RUN,
      });
      // The inject still closes (proves it was processed, not skipped for another reason).
      expect(outcomes().find((o) => o.inject_id === injectId)?.outcome).toBe("ignored");
      expect(s.bodies).toHaveLength(0);
    });

    it("does NOT seal when the run has no control config (nothing to authenticate against)", async () => {
      await seedInject(5);
      stageAssistant(6, "output");
      recorder.resetRecorderForTesting();
      const s = seams();
      await correlate.runInternalEvidenceCorrelate([], {
        readLog: logsWithMaxTurn(8),
        readCfg: () => null, // no cfg -> the whole flush+seal block is skipped
        flush: s.flush,
        postCapture: s.postCapture,
        nowMs: RUN,
      });
      expect(outcomes()[0].outcome).toBe("ignored"); // outcome still recorded locally
      expect(s.bodies).toHaveLength(0);
      expect(s.order).toEqual([]); // neither flush nor seal ran
    });

    it("flushes the inject BEFORE it POSTs the capture intake (§10.6 step 1)", async () => {
      await seedInject(5);
      stageAssistant(6, "output for ordering test");
      recorder.resetRecorderForTesting();
      const s = seams();
      await correlate.runInternalEvidenceCorrelate([], {
        readLog: logsWithMaxTurn(8),
        readCfg: () => CFG,
        flush: s.flush,
        postCapture: s.postCapture,
        nowMs: RUN,
      });
      expect(s.bodies).toHaveLength(1);
      expect(s.order).toEqual(["flush", "post"]);
    });

    it("a seal POST that throws never disturbs the sweep (best-effort, exit 0)", async () => {
      await seedInject(5);
      stageAssistant(6, "output");
      recorder.resetRecorderForTesting();
      const s = seams();
      const throwingPost = jest.fn(async () => {
        throw new Error("control 500");
      });
      const code = await correlate.runInternalEvidenceCorrelate([], {
        readLog: logsWithMaxTurn(8),
        readCfg: () => CFG,
        flush: s.flush,
        postCapture: throwingPost,
        nowMs: RUN,
      });
      expect(code).toBe(0);
      expect(throwingPost).toHaveBeenCalledTimes(1);
      expect(outcomes()[0].outcome).toBe("ignored"); // the outcome still landed
    });
  });
});
