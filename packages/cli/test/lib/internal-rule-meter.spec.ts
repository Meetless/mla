// `mla _internal rule-meter` -- the detached rule-cost emitter (audit 6.G / 7.10).
//
// Exercises the full record path with a real recorder + tmp MEETLESS_HOME; only the external
// transport (http.post) is mocked. This process exists purely so the assembler (which runs on a
// hot path that may never make a network call) can still ship the number it measured. So the
// contract under test is: it records a numbers-only event, it joins to the turn via trace_id, and
// NOTHING it does can ever disturb the session that spawned it.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

jest.mock("../../src/lib/http", () => ({
  post: jest.fn().mockResolvedValue({}),
}));

type MeterModule = typeof import("../../src/commands/internal-rule-meter");
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
const NOW = Date.parse("2026-07-12T12:00:00.000Z");

const METER = {
  base_bytes: 100,
  always_on_bytes: 800,
  always_on_rules: 4,
  scoped_bytes: 200,
  scoped_rules: 1,
  scoped_configured: 6,
  avoided_bytes: 1200,
  omitted_rules: 0,
  head_bytes: 1100,
  safe_total: 2000,
  overflow: false,
  degraded: false,
  base_invariant: false,
};

describe("runInternalRuleMeter", () => {
  let tmp: string;
  let mod: MeterModule;
  let store: StoreModule;
  let recorder: RecorderModule;
  let httpPost: jest.Mock;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mla-meter-"));
    process.env.MEETLESS_HOME = tmp;
    delete process.env.MEETLESS_LOCAL_STATS;
    delete process.env.MEETLESS_TELEMETRY;
    delete process.env.MEETLESS_NO_TELEMETRY;
    delete process.env.CLAUDE_CODE_SESSION_ID;
    jest.resetModules();
    store = require("../../src/lib/analytics/store");
    recorder = require("../../src/lib/analytics/recorder");
    mod = require("../../src/commands/internal-rule-meter");
    httpPost = require("../../src/lib/http").post as jest.Mock;
    httpPost.mockClear();
    httpPost.mockResolvedValue({});
    recorder.resetRecorderForTesting();
  });

  afterEach(() => {
    delete process.env.MEETLESS_HOME;
    delete process.env.MEETLESS_TELEMETRY;
    delete process.env.CLAUDE_CODE_SESSION_ID;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const baseArgv = (meter: unknown = METER, over: string[] = []): string[] => [
    "--meter",
    JSON.stringify(meter),
    "--trace-id",
    TRACE,
    "--session-id",
    "sess_1",
    "--workspace-id",
    "ws_1",
    "--turn-index",
    "3",
    ...over,
  ];

  const deps = () => ({
    readCfg: () => null,
    machineId: () => "m_test",
    mintRunId: () => "run_test",
    nowMs: NOW,
  });

  it("rejects an unknown flag with exit 2", async () => {
    expect(await mod.runInternalRuleMeter(["--bogus"], {})).toBe(2);
  });

  it("records an mla_rule_injection event carrying the turn's rule cost", async () => {
    const code = await mod.runInternalRuleMeter(baseArgv(), deps());
    expect(code).toBe(0);

    const events = store.readEvents();
    expect(events).toHaveLength(1);
    const ev = events[0] as unknown as Record<string, unknown>;
    expect(ev.event_type).toBe("mla_rule_injection");
    expect(ev.source).toBe("hook");
    expect(ev.turn_index).toBe(3);
    expect(ev.always_on_bytes).toBe(800);
    expect(ev.always_on_rules).toBe(4);
    expect(ev.scoped_bytes).toBe(200);
    expect(ev.scoped_configured).toBe(6);
    // The derived pricing numbers a board actually plots.
    expect(ev.always_on_tokens).toBe(200);
    expect(ev.scoped_tokens).toBe(50);
    expect(ev.avoided_tokens).toBe(300);
    expect(ev.always_on_share_bp).toBe(8000);
    // It joins to the turn it priced: same trace as the turn's enrichment, fresh run_id.
    expect(ev.trace_id).toBe(TRACE);
    expect(ev.run_id).toBe("run_test");
    expect(ev.distinct_id).toBe("m_test");
    expect(ev.workspace_id).toBe("ws_1");
  });

  it("carries numbers and booleans ONLY, so nothing about the prompt can leak (INV-POSTHOG-PII-1)", async () => {
    await mod.runInternalRuleMeter(baseArgv(), deps());
    const ev = store.readEvents()[0] as unknown as Record<string, unknown>;
    // The envelope's own identity fields are strings by design; everything the METER contributed
    // must be a number or a boolean. Control's PostHog projector is a fail-closed allowlist, so a
    // pure-number payload crosses to the board with no backend change.
    const payloadKeys = [
      "base_bytes",
      "always_on_bytes",
      "always_on_rules",
      "scoped_bytes",
      "scoped_rules",
      "scoped_configured",
      "avoided_bytes",
      "omitted_rules",
      "head_bytes",
      "safe_total",
      "overflow",
      "degraded",
      "base_invariant",
      "turn_index",
      "always_on_tokens",
      "scoped_tokens",
      "avoided_tokens",
      "head_tokens",
      "always_on_share_bp",
    ];
    for (const k of payloadKeys) {
      expect(ev).toHaveProperty(k);
      expect(["number", "boolean"]).toContain(typeof ev[k]);
    }
    // And the event carries NO payload key beyond those: no prompt, no path, no rule text ever
    // rides this event, by construction.
    const envelopeKeys = new Set([
      "schema_version",
      "event_id",
      "event_type",
      "created_at",
      "emitted_at",
      "workspace_id",
      "distinct_id",
      "session_id",
      "run_id",
      "trace_id",
      "source",
      "repo_fingerprint",
      "attribution",
    ]);
    for (const k of Object.keys(ev)) {
      if (envelopeKeys.has(k)) continue;
      expect(payloadKeys).toContain(k);
    }
  });

  it("dedupes a re-fired hook: the event_id is deterministic per (session, turn)", async () => {
    await mod.runInternalRuleMeter(baseArgv(), deps());
    const first = store.readEvents()[0] as unknown as Record<string, unknown>;
    recorder.resetRecorderForTesting();
    await mod.runInternalRuleMeter(baseArgv(), deps());
    const both = store.readEvents();
    expect(both).toHaveLength(2);
    // Both rows land locally, but they share one event_id, so control's (workspace_id, event_id)
    // dedupe charges the turn exactly once.
    expect((both[1] as unknown as Record<string, unknown>).event_id).toBe(first.event_id);
  });

  it("uses the configured actor as distinct_id when present", async () => {
    await mod.runInternalRuleMeter(baseArgv(), {
      ...deps(),
      readCfg: () => ({ ...CFG, actorUserId: "usr_cuid" }) as CliConfig,
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

  it("records nothing when there is no meter to record", async () => {
    const code = await mod.runInternalRuleMeter(["--trace-id", TRACE, "--session-id", "s"], deps());
    expect(code).toBe(0);
    expect(store.readEvents()).toHaveLength(0);
  });

  it("records nothing when the meter is not parseable JSON (a producer bug, not a guess)", async () => {
    const code = await mod.runInternalRuleMeter(
      ["--meter", "{not json", "--trace-id", TRACE, "--session-id", "s"],
      deps(),
    );
    expect(code).toBe(0);
    expect(store.readEvents()).toHaveLength(0);
  });

  it("records nothing without a trace_id: a cost row that cannot join to its turn has no home", async () => {
    const code = await mod.runInternalRuleMeter(
      ["--meter", JSON.stringify(METER), "--session-id", "s"],
      deps(),
    );
    expect(code).toBe(0);
    expect(store.readEvents()).toHaveLength(0);
  });

  it("still meters a degraded turn (zero rules delivered is exactly the turn a board must not omit)", async () => {
    await mod.runInternalRuleMeter(
      baseArgv({ ...METER, always_on_bytes: 0, always_on_rules: 0, scoped_bytes: 0, scoped_rules: 0, degraded: true }),
      deps(),
    );
    const ev = store.readEvents()[0] as unknown as Record<string, unknown>;
    expect(ev.degraded).toBe(true);
    expect(ev.always_on_tokens).toBe(0);
    expect(ev.always_on_share_bp).toBe(0);
  });

  it("meters a base-invariant turn (the worst-tax turn: full floor, zero targeting)", async () => {
    await mod.runInternalRuleMeter(
      baseArgv({ ...METER, scoped_bytes: 0, scoped_rules: 0, avoided_bytes: 0, base_invariant: true }),
      deps(),
    );
    const ev = store.readEvents()[0] as unknown as Record<string, unknown>;
    expect(ev.base_invariant).toBe(true);
    expect(ev.degraded).toBe(false);
    expect(ev.always_on_share_bp).toBe(10000);
    // scoped_configured survives so the board can name what the overrun forfeited.
    expect(ev.scoped_configured).toBe(6);
    expect(ev.scoped_rules).toBe(0);
  });

  it("forwards to control only when telemetry is opted in", async () => {
    process.env.MEETLESS_TELEMETRY = "on";
    await mod.runInternalRuleMeter(baseArgv(), { ...deps(), readCfg: () => CFG });
    expect(httpPost).toHaveBeenCalledTimes(1);
    const [, route, body] = httpPost.mock.calls[0];
    expect(route).toBe("/internal/v1/analytics/events");
    expect((body as { events: unknown[] }).events).toHaveLength(1);
  });

  it("records locally but does NOT forward when telemetry is opted out", async () => {
    process.env.MEETLESS_TELEMETRY = "off";
    await mod.runInternalRuleMeter(baseArgv(), { ...deps(), readCfg: () => CFG });
    expect(store.readEvents()).toHaveLength(1);
    expect(httpPost).not.toHaveBeenCalled();
  });

  it("is fail-soft: a record dep that throws never escapes (returns 0)", async () => {
    const code = await mod.runInternalRuleMeter(baseArgv(), {
      ...deps(),
      record: () => {
        throw new Error("disk full");
      },
    });
    expect(code).toBe(0);
  });
});
