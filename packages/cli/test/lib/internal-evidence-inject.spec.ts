// `mla _internal evidence-inject` -- the detached inject emitter (spec T4.1).
// Exercises the full record path with a real recorder + tmp MEETLESS_HOME; only
// the external transport (http.post) is mocked. Verifies the inject lands as a
// pending window (no outcome line yet), event_id == inject_id, source "hook", and
// the consent-gated forward.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

jest.mock("../../src/lib/http", () => ({
  post: jest.fn().mockResolvedValue({}),
}));

type InjectModule = typeof import("../../src/commands/internal-evidence-inject");
type StoreModule = typeof import("../../src/lib/analytics/store");
type RecorderModule = typeof import("../../src/lib/analytics/recorder");
import type { CliConfig } from "../../src/lib/config";

const CFG: CliConfig = {
  controlUrl: "http://127.0.0.1:9",
  controlToken: "t",
  mlaPath: "/tmp/mla",
  auth: { mode: "shared-key", accessToken: "t" },
};
const TRACE = "0123456789abcdef0123456789abcdef";
const NOW = Date.parse("2026-06-07T12:00:00.000Z");

describe("runInternalEvidenceInject", () => {
  let tmp: string;
  let mod: InjectModule;
  let store: StoreModule;
  let recorder: RecorderModule;
  let httpPost: jest.Mock;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mla-inject-"));
    process.env.MEETLESS_HOME = tmp;
    delete process.env.MEETLESS_LOCAL_STATS;
    delete process.env.MEETLESS_TELEMETRY;
    delete process.env.MEETLESS_NO_TELEMETRY;
    delete process.env.CLAUDE_CODE_SESSION_ID;
    jest.resetModules();
    store = require("../../src/lib/analytics/store");
    recorder = require("../../src/lib/analytics/recorder");
    mod = require("../../src/commands/internal-evidence-inject");
    httpPost = require("../../src/lib/http").post as jest.Mock;
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

  const baseArgv = (over: string[] = []): string[] => [
    "--turn-index",
    "3",
    "--offered-ids",
    "NT:20260529-foo.md,PR:bar.md",
    "--tokens",
    "1200",
    "--confidence",
    "high",
    "--latency-ms",
    "450",
    "--trace-id",
    TRACE,
    "--session-id",
    "sess_1",
    "--workspace-id",
    "ws_1",
    ...over,
  ];

  it("rejects an unknown flag with exit 2", async () => {
    expect(await mod.runInternalEvidenceInject(["--bogus"], {})).toBe(2);
  });

  it("records an mla_evidence_inject event with event_id == inject_id and pending semantics", async () => {
    const code = await mod.runInternalEvidenceInject(baseArgv(), {
      readCfg: () => null,
      machineId: () => "m_test",
      mintRunId: () => "run_test",
      nowMs: NOW,
    });
    expect(code).toBe(0);
    const events = store.readEvents();
    expect(events).toHaveLength(1);
    const ev = events[0] as unknown as Record<string, unknown>;
    expect(ev.event_type).toBe("mla_evidence_inject");
    // One inject -> one event: the business key IS the idempotency key.
    expect(ev.event_id).toBe(ev.inject_id);
    expect(ev.source).toBe("hook");
    expect(ev.turn_index).toBe(3);
    expect(ev.evidence_offered).toBe(2);
    expect(ev.offered_source_ids).toEqual(["NT:20260529-foo.md", "PR:bar.md"]);
    expect(ev.retrieval_confidence).toBe("high");
    expect(ev.retrieval_latency_ms).toBe(450);
    expect(ev.zero_results).toBe(false);
    expect(ev.trace_id).toBe(TRACE);
    expect(ev.run_id).toBe("run_test");
    expect(ev.distinct_id).toBe("m_test");
    expect(typeof ev.window_deadline).toBe("string");
    // Pending is the ABSENCE of an outcome line, not a field on the inject.
    expect(ev.outcome).toBeUndefined();
  });

  it("uses the configured actor as distinct_id when present", async () => {
    await mod.runInternalEvidenceInject(baseArgv(), {
      readCfg: () => ({ ...CFG, actorUserId: "usr_cuid" }) as CliConfig,
      machineId: () => "m_test",
      mintRunId: () => "run_test",
      nowMs: NOW,
      flush: async () => ({
        attempted: 0,
        forwarded: 0,
        skippedConsent: true,
        skippedNotEmittable: 0,
        failed: 0,
      }),
    });
    const ev = store.readEvents()[0] as unknown as Record<string, unknown>;
    expect(ev.distinct_id).toBe("usr_cuid");
  });

  it("no-ops (records nothing) when no trace_id is available", async () => {
    const code = await mod.runInternalEvidenceInject(
      ["--turn-index", "3", "--offered-ids", "NT:foo.md", "--session-id", "sess_1"],
      { readCfg: () => null },
    );
    expect(code).toBe(0);
    expect(store.readEvents()).toHaveLength(0);
  });

  it("forwards to control only when telemetry is opted in", async () => {
    process.env.MEETLESS_TELEMETRY = "on";
    await mod.runInternalEvidenceInject(baseArgv(), {
      readCfg: () => CFG,
      machineId: () => "m_test",
      mintRunId: () => "run_test",
      nowMs: NOW,
    });
    expect(httpPost).toHaveBeenCalledTimes(1);
    const [, route, body] = httpPost.mock.calls[0];
    expect(route).toBe("/internal/v1/analytics/events");
    expect((body as { events: unknown[] }).events).toHaveLength(1);
  });

  it("records locally but does NOT forward when telemetry is opted out (MEETLESS_TELEMETRY=off)", async () => {
    process.env.MEETLESS_TELEMETRY = "off";
    await mod.runInternalEvidenceInject(baseArgv(), {
      readCfg: () => CFG,
      machineId: () => "m_test",
      mintRunId: () => "run_test",
      nowMs: NOW,
    });
    expect(store.readEvents()).toHaveLength(1);
    expect(httpPost).not.toHaveBeenCalled();
  });

  it("forwards by default when telemetry is unset (opt-out posture, default ON)", async () => {
    delete process.env.MEETLESS_TELEMETRY;
    await mod.runInternalEvidenceInject(baseArgv(), {
      readCfg: () => CFG,
      machineId: () => "m_test",
      mintRunId: () => "run_test",
      nowMs: NOW,
    });
    expect(store.readEvents()).toHaveLength(1);
    expect(httpPost).toHaveBeenCalledTimes(1);
  });

  it("is fail-soft: a record dep that throws never escapes (returns 0)", async () => {
    const code = await mod.runInternalEvidenceInject(baseArgv(), {
      readCfg: () => null,
      record: () => {
        throw new Error("disk full");
      },
      nowMs: NOW,
    });
    expect(code).toBe(0);
  });

  it("flags a zero-result inject (no offered ids) as zero_results", async () => {
    await mod.runInternalEvidenceInject(
      ["--turn-index", "2", "--offered", "0", "--trace-id", TRACE, "--session-id", "s"],
      { readCfg: () => null, machineId: () => "m", mintRunId: () => "r", nowMs: NOW },
    );
    const inject = store
      .readEvents()
      .find((e) => (e as unknown as Record<string, unknown>).event_type === "mla_evidence_inject") as unknown as Record<string, unknown>;
    expect(inject.zero_results).toBe(true);
    expect(inject.evidence_offered).toBe(0);
  });

  // --- Typed coverage gaps (spec §7.5, INV-COVERAGE-GAP-1; T7.1) -------------

  const gapOf = (): Record<string, unknown> | undefined =>
    store
      .readEvents()
      .find(
        (e) => (e as unknown as Record<string, unknown>).event_type === "mla_coverage_gap",
      ) as unknown as Record<string, unknown> | undefined;

  it("emits NO coverage gap on a healthy high-confidence, non-empty inject", async () => {
    await mod.runInternalEvidenceInject(baseArgv(), {
      readCfg: () => null,
      machineId: () => "m",
      mintRunId: () => "r",
      nowMs: NOW,
    });
    expect(store.readEvents()).toHaveLength(1); // inject only
    expect(gapOf()).toBeUndefined();
  });

  it("emits a paired no_candidate_found gap on a zero-result inject, keyed to the inject", async () => {
    await mod.runInternalEvidenceInject(
      ["--turn-index", "2", "--offered", "0", "--trace-id", TRACE, "--session-id", "s", "--topic-category", "api_contract"],
      { readCfg: () => null, machineId: () => "m", mintRunId: () => "r", nowMs: NOW },
    );
    const events = store.readEvents();
    expect(events).toHaveLength(2); // inject + gap
    const inject = events.find(
      (e) => (e as unknown as Record<string, unknown>).event_type === "mla_evidence_inject",
    ) as unknown as Record<string, unknown>;
    const gap = gapOf()!;
    expect(gap.event_type).toBe("mla_coverage_gap");
    expect(gap.coverage_gap_type).toBe("no_candidate_found");
    expect(gap.inject_id).toBe(inject.inject_id);
    expect(gap.query_topic_category).toBe("api_contract");
    expect(gap.zero_results).toBe(true);
    expect(gap.source).toBe("hook");
    // The gap event_id is distinct from the inject's (no dedupe collision).
    expect(gap.event_id).not.toBe(inject.event_id);
  });

  it("classifies retrieval_error above every other signal", async () => {
    await mod.runInternalEvidenceInject(
      baseArgv(["--retrieval-error", "--permission-filtered", "--stale"]),
      { readCfg: () => null, machineId: () => "m", mintRunId: () => "r", nowMs: NOW },
    );
    expect(gapOf()!.coverage_gap_type).toBe("retrieval_error");
  });

  it("classifies permission_filtered when the flag is set", async () => {
    await mod.runInternalEvidenceInject(baseArgv(["--permission-filtered"]), {
      readCfg: () => null,
      machineId: () => "m",
      mintRunId: () => "r",
      nowMs: NOW,
    });
    expect(gapOf()!.coverage_gap_type).toBe("permission_filtered");
  });

  it("classifies low_confidence_candidates on a low-confidence, non-empty inject", async () => {
    await mod.runInternalEvidenceInject(
      ["--turn-index", "1", "--offered-ids", "NT:a.md", "--confidence", "low", "--trace-id", TRACE, "--session-id", "s"],
      { readCfg: () => null, machineId: () => "m", mintRunId: () => "r", nowMs: NOW },
    );
    expect(gapOf()!.coverage_gap_type).toBe("low_confidence_candidates");
  });

  it("coerces an unknown topic category to unknown (no raw string leaks)", async () => {
    await mod.runInternalEvidenceInject(
      ["--turn-index", "2", "--offered", "0", "--trace-id", TRACE, "--session-id", "s", "--topic-category", "stripe webhook bug"],
      { readCfg: () => null, machineId: () => "m", mintRunId: () => "r", nowMs: NOW },
    );
    expect(gapOf()!.query_topic_category).toBe("unknown");
  });

  it("forwards both the inject and the gap when telemetry is opted in", async () => {
    process.env.MEETLESS_TELEMETRY = "on";
    await mod.runInternalEvidenceInject(
      ["--turn-index", "2", "--offered", "0", "--trace-id", TRACE, "--session-id", "s", "--workspace-id", "ws_1"],
      { readCfg: () => CFG, machineId: () => "m", mintRunId: () => "r", nowMs: NOW },
    );
    expect(httpPost).toHaveBeenCalledTimes(1);
    const [, , body] = httpPost.mock.calls[0];
    expect((body as { events: unknown[] }).events).toHaveLength(2); // inject + gap
  });
});
