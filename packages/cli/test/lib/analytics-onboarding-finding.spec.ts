// Onboarding-finding emit seam (drift-finding design §9): the fail-soft, local-append-only bridge
// between the two lifecycle points of a doc/code inconsistency and the generic analytics spool.
// Mirrors analytics-enforcement-incident.spec (real recorder + tmp MEETLESS_HOME; only the http
// transport is mocked), because these two rows have the same job: be the ONLY producer behind a
// documented metric, and never be able to break the operation they observe.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

jest.mock("../../src/lib/http", () => ({
  post: jest.fn().mockResolvedValue({}),
}));

type EmitModule = typeof import("../../src/lib/analytics/onboarding-finding");
type StoreModule = typeof import("../../src/lib/analytics/store");
type RecorderModule = typeof import("../../src/lib/analytics/recorder");
type EventIdModule = typeof import("../../src/lib/analytics/event-id");
type ObservabilityModule = typeof import("../../src/lib/observability");

const NOW = Date.parse("2026-07-31T12:00:00.000Z");
// A full sha256-shaped candidate id. The seam must truncate it; the whole value never crosses.
const CANDIDATE = "a1b2c3d4e5f6" + "0".repeat(52);
const DEPS = {
  runId: "run_test",
  traceId: "0123456789abcdef0123456789abcdef",
  machineId: () => "m_test",
  readCfg: () => null,
  repoFingerprint: "rf_test",
};
const COORDS = { workspaceId: "ws_1", sessionId: "sess_1", nowMs: NOW };

describe("emitOnboardingFinding", () => {
  let tmp: string;
  let emit: EmitModule;
  let store: StoreModule;
  let recorder: RecorderModule;
  let eventId: EventIdModule;
  let observability: ObservabilityModule;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mla-onboarding-finding-"));
    process.env.MEETLESS_HOME = tmp;
    delete process.env.MEETLESS_LOCAL_STATS;
    delete process.env.MEETLESS_TELEMETRY;
    delete process.env.MEETLESS_NO_TELEMETRY;
    jest.resetModules();
    store = require("../../src/lib/analytics/store");
    recorder = require("../../src/lib/analytics/recorder");
    eventId = require("../../src/lib/analytics/event-id");
    observability = require("../../src/lib/observability");
    emit = require("../../src/lib/analytics/onboarding-finding");
    recorder.resetRecorderForTesting();
  });

  afterEach(() => {
    delete process.env.MEETLESS_HOME;
    delete process.env.MEETLESS_LOCAL_STATS;
    delete process.env.MEETLESS_TELEMETRY;
    delete process.env.MEETLESS_NO_TELEMETRY;
    observability.resetRunIdForTesting();
    observability.resetRunTracerForTesting();
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  });

  function rows(): Record<string, unknown>[] {
    return store.readEvents() as unknown as Record<string, unknown>[];
  }

  it("appends one persisted row with the truncated finding id and a null verdict", () => {
    emit.emitOnboardingFinding({ candidateId: CANDIDATE }, COORDS, DEPS);

    const events = rows();
    expect(events).toHaveLength(1);
    const ev = events[0];
    expect(ev.event_type).toBe("mla_onboarding_finding");
    expect(ev.source).toBe("cli");
    expect(ev.workspace_id).toBe("ws_1");
    expect(ev.session_id).toBe("sess_1");
    expect(ev.run_id).toBe("run_test");
    expect(ev.trace_id).toBe("0123456789abcdef0123456789abcdef");
    // The repository dimension the kill rule's ">= 3 distinct repositories" and 40% single-repo
    // cap are computed over. If this ever stops riding, the kill rule stops being evaluable.
    expect(ev.repo_fingerprint).toBe("rf_test");
    // created_at is the clock for "time to first finding".
    expect(ev.created_at).toBe(new Date(NOW).toISOString());
    // Payload.
    expect(ev.finding_id).toBe("a1b2c3d4e5f6");
    expect(ev.finding_phase).toBe("persisted");
    expect(ev.finding_verdict).toBeNull();
    expect(ev.minted_rule).toBe(false);
  });

  it("truncates the candidate id to 12 hex; the full identity never crosses the boundary", () => {
    emit.emitOnboardingFinding({ candidateId: CANDIDATE }, COORDS, DEPS);
    const serialized = JSON.stringify(rows()[0]);
    expect(serialized).not.toContain(CANDIDATE);
    expect((rows()[0].finding_id as string).length).toBe(emit.FINDING_ID_LEN);
  });

  it("appends a resolved row carrying the verdict and whether a rule was actually minted", () => {
    emit.emitOnboardingFinding(
      { candidateId: CANDIDATE, verdict: "code_diverged", mintedRule: true },
      COORDS,
      DEPS,
    );
    const ev = rows()[0];
    expect(ev.finding_phase).toBe("resolved");
    expect(ev.finding_verdict).toBe("code_diverged");
    expect(ev.minted_rule).toBe(true);
  });

  it("counts a carve_out verdict verbatim (this row IS the kill metric's numerator)", () => {
    emit.emitOnboardingFinding({ candidateId: CANDIDATE, verdict: "carve_out" }, COORDS, DEPS);
    const ev = rows()[0];
    expect(ev.finding_phase).toBe("resolved");
    expect(ev.finding_verdict).toBe("carve_out");
    // A carve-out mints nothing by construction, so the flag must not be inferred from the verdict.
    expect(ev.minted_rule).toBe(false);
  });

  it("keys the two phases of one finding under DIFFERENT event ids (they must both survive dedup)", () => {
    emit.emitOnboardingFinding({ candidateId: CANDIDATE }, COORDS, DEPS);
    emit.emitOnboardingFinding({ candidateId: CANDIDATE, verdict: "doc_stale" }, COORDS, DEPS);
    const events = rows();
    expect(events).toHaveLength(2);
    expect(events[0].event_id).not.toBe(events[1].event_id);
    expect(events[0].event_id).toBe(
      eventId.deterministicEventId("onboarding-finding:persisted:a1b2c3d4e5f6", 0),
    );
    expect(events[1].event_id).toBe(
      eventId.deterministicEventId("onboarding-finding:resolved:a1b2c3d4e5f6", 0),
    );
  });

  it("re-emitting the SAME phase produces the SAME event_id, so a re-run cannot inflate the rate", () => {
    // `enrich ingest` is resumable and re-runnable: the same finding can reach this seam twice.
    emit.emitOnboardingFinding({ candidateId: CANDIDATE }, COORDS, DEPS);
    emit.emitOnboardingFinding({ candidateId: CANDIDATE }, { ...COORDS, nowMs: NOW + 5000 }, DEPS);
    const events = rows();
    expect(events).toHaveLength(2);
    expect(events[0].event_id).toBe(events[1].event_id);
  });

  it("MINTS a run/trace when none is ambient (the two rows self-join on finding_id)", () => {
    emit.emitOnboardingFinding({ candidateId: CANDIDATE }, COORDS, {
      machineId: () => "m_test",
      readCfg: () => null,
    });
    const ev = rows()[0];
    expect(typeof ev.run_id).toBe("string");
    expect((ev.run_id as string).length).toBeGreaterThan(0);
    expect(ev.trace_id).toMatch(/^[0-9a-f]{32}$/);
  });

  it("emits nothing for an empty candidate id rather than a row that joins to nothing", () => {
    emit.emitOnboardingFinding({ candidateId: "" }, COORDS, DEPS);
    expect(rows()).toHaveLength(0);
  });

  it("is fail-soft: a record dep that throws never escapes into the ingest or the resolution", () => {
    expect(() =>
      emit.emitOnboardingFinding({ candidateId: CANDIDATE }, COORDS, {
        ...DEPS,
        record: () => {
          throw new Error("spool down");
        },
      }),
    ).not.toThrow();
  });

  it("carries NO finding content: no statement, no quote, no path, no commit sha", () => {
    emit.emitOnboardingFinding(
      { candidateId: CANDIDATE, verdict: "code_diverged", mintedRule: true },
      COORDS,
      DEPS,
    );
    const ev = rows()[0];
    for (const k of ["finding_id", "finding_phase", "finding_verdict", "minted_rule"]) {
      expect(ev).toHaveProperty(k);
    }
    // Nothing path-shaped, quote-shaped, or statement-shaped may ride on this row.
    const serialized = JSON.stringify(ev);
    expect(serialized).not.toMatch(/\.md|\.ts|\/notes\/|file_path|statement|quote|commit/);
  });

  // The reach of these rows, pinned rather than assumed. §9's metrics are computed CENTRALLY
  // (control.analytics_events), and a row only travels when the forwarder's join gate passes.
  // That gate wants a workspace AND a session, so which invocations count is a property of the
  // analytics plane, not of this feature. Both directions are asserted because the boundary is
  // exactly what makes the kill metric a lower bound instead of a census, and a bound nobody
  // wrote down is a bound somebody later mistakes for a total.
  describe("reach of the row (what the central kill metric can and cannot see)", () => {
    function emittable(coords: { workspaceId: string | null; sessionId: string | null }): boolean {
      emit.emitOnboardingFinding(
        { candidateId: CANDIDATE, verdict: "carve_out" },
        { ...coords, nowMs: NOW },
        DEPS,
      );
      const envelope = require("../../src/lib/analytics/envelope");
      return envelope.isRemotelyEmittable(rows()[0]);
    }

    it("clears the remote join gate when the resolution happened inside an agent session", () => {
      expect(emittable({ workspaceId: "ws_1", sessionId: "sess_1" })).toBe(true);
    });

    it("stays on the machine when it did not: a bare-terminal verdict is local-only", () => {
      // Not a defect of this event, and deliberately not patched here: INV-JOIN-1 withholds
      // every session-less CLI row, `mla_command` included. The consequence is specific
      // though: `mla enrich resolve` is runnable by a human at a plain prompt, so the
      // carve-out share computed in Postgres counts in-session resolutions only, and there
      // is no complete backstop for the remainder. The row does land in the local
      // events.jsonl, but that file is a rolling 5MB-to-3MB tail (store.ts
      // `capEventsFileIfNeeded`) that drops its oldest lines, so it is recent history and
      // not an archive. §9 states the kill metric as a lower bound for exactly this reason.
      expect(emittable({ workspaceId: "ws_1", sessionId: null })).toBe(false);
    });

    it("stays on the machine for an unbound run, so no metric is attributed to no workspace", () => {
      expect(emittable({ workspaceId: null, sessionId: "sess_1" })).toBe(false);
    });
  });
});
