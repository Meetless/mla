import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Recorder + forwarder integration. We mock ONLY the external transport
// (http.post = the control round-trip); the store, envelope, and consent logic
// run for real against a tmp MEETLESS_HOME. Internal services are never mocked
// (project testing rule); http.post is the external-service wrapper boundary.

jest.mock("../../src/lib/http", () => ({
  post: jest.fn().mockResolvedValue({}),
}));

type RecorderModule = typeof import("../../src/lib/analytics/recorder");
type ObsModule = typeof import("../../src/lib/observability");
type StoreModule = typeof import("../../src/lib/analytics/store");
import type { CliConfig } from "../../src/lib/config";

const CFG: CliConfig = {
  controlUrl: "http://127.0.0.1:9",
  controlToken: "t",
  mlaPath: "/tmp/mla",
  auth: { mode: "shared-key", accessToken: "t" },
};

const CTX_NOW = "2026-06-07T12:00:00.000Z";

function ctx(over: Record<string, unknown> = {}) {
  return {
    workspaceId: "ws_1",
    sessionId: "sess_1",
    now: CTX_NOW,
    ...over,
  } as never;
}

describe("analytics recorder + forwarder", () => {
  let tmp: string;
  let recorder: RecorderModule;
  let obs: ObsModule;
  let store: StoreModule;
  let httpPost: jest.Mock;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mla-analytics-rec-"));
    process.env.MEETLESS_HOME = tmp;
    delete process.env.MEETLESS_LOCAL_STATS;
    delete process.env.MEETLESS_TELEMETRY;
    delete process.env.MEETLESS_NO_TELEMETRY;
    jest.resetModules();
    obs = require("../../src/lib/observability");
    recorder = require("../../src/lib/analytics/recorder");
    store = require("../../src/lib/analytics/store");
    httpPost = require("../../src/lib/http").post as jest.Mock;
    httpPost.mockClear();
    httpPost.mockResolvedValue({});
    obs.setRunTraceId("0123456789abcdef0123456789abcdef");
    obs.setRunId("11111111-1111-1111-1111-111111111111");
    recorder.resetRecorderForTesting();
  });

  afterEach(() => {
    delete process.env.MEETLESS_HOME;
    delete process.env.MEETLESS_LOCAL_STATS;
    delete process.env.MEETLESS_TELEMETRY;
    delete process.env.MEETLESS_NO_TELEMETRY;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("buildEvent produces a flat, complete event from the run context", () => {
    const ev = recorder.buildEvent(ctx(), {
      eventType: "mla_command",
      payload: { command: "ask", outcome: "success" },
    }) as unknown as Record<string, unknown>;
    expect(ev.run_id).toBe("11111111-1111-1111-1111-111111111111");
    expect(ev.trace_id).toBe("0123456789abcdef0123456789abcdef");
    expect(ev.workspace_id).toBe("ws_1");
    expect(ev.session_id).toBe("sess_1");
    expect(ev.command).toBe("ask"); // payload flattened to top level
    expect(ev.event_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("carries a source-attribution block (T1.10) derived from the run context", () => {
    const ev = recorder.buildEvent(
      ctx({ actorWorkspaceUserId: "usr_abc", repoFingerprint: "r_deadbeef" }),
      { eventType: "mla_command", payload: { command: "ask", outcome: "success" } },
    ) as unknown as Record<string, unknown>;
    const attribution = ev.attribution as Record<string, unknown>;
    expect(attribution).toBeDefined();
    // Product-origin axis (distinct from the emission-channel envelope `source`).
    expect(attribution.source).toBe("mla");
    expect(attribution.sourceProduct).toBe("MLA");
    // Surface derives from the typed envelope source enum (cli -> CLI).
    expect(attribution.sourceSurface).toBe("CLI");
    // Un-collapsed actor cuid + workspace, plus session + repo fingerprint.
    expect(attribution.actorWorkspaceUserId).toBe("usr_abc");
    expect(attribution.workspaceId).toBe("ws_1");
    expect(attribution.agentSessionId).toBe("sess_1");
    expect(attribution.repoFingerprint).toBe("r_deadbeef");
  });

  it("attribution reports honest nulls on an actorless, repo-less run", () => {
    obs.resetRepoFingerprintForTesting(); // no bootstrap fingerprint set
    const ev = recorder.buildEvent(ctx({ sessionId: null }), {
      eventType: "mla_command",
      payload: { command: "init" },
    }) as unknown as Record<string, unknown>;
    const attribution = ev.attribution as Record<string, unknown>;
    expect(attribution.source).toBe("mla"); // origin is constant
    expect(attribution.actorWorkspaceUserId).toBeNull();
    expect(attribution.agentSessionId).toBeNull();
    expect(attribution.repoFingerprint).toBeNull();
  });

  it("records locally and buffers for forward, then forwards on flush (opt-in ON)", async () => {
    process.env.MEETLESS_TELEMETRY = "on";
    recorder.recordAnalyticsEvent(ctx(), {
      eventType: "mla_command",
      payload: { command: "ask" },
    });
    // Local sink wrote immediately.
    expect(store.readEvents()).toHaveLength(1);

    const res = await recorder.flushAnalyticsEvents(CFG);
    expect(res.forwarded).toBe(1);
    expect(httpPost).toHaveBeenCalledTimes(1);
    const [, route, body] = httpPost.mock.calls[0];
    expect(route).toBe("/internal/v1/analytics/events");
    expect((body as { events: unknown[] }).events).toHaveLength(1);
  });

  it("records locally but does NOT forward when remote analytics is opted out (MEETLESS_TELEMETRY=off)", async () => {
    process.env.MEETLESS_TELEMETRY = "off";
    recorder.recordAnalyticsEvent(ctx(), { eventType: "mla_command", payload: { command: "ask" } });
    expect(store.readEvents()).toHaveLength(1); // local still works
    const res = await recorder.flushAnalyticsEvents(CFG);
    expect(res.skippedConsent).toBe(true);
    expect(httpPost).not.toHaveBeenCalled();
  });

  it("forwards by default when remote analytics is unset (opt-out posture, default ON)", async () => {
    delete process.env.MEETLESS_TELEMETRY;
    recorder.recordAnalyticsEvent(ctx(), { eventType: "mla_command", payload: { command: "ask" } });
    expect(store.readEvents()).toHaveLength(1);
    const res = await recorder.flushAnalyticsEvents(CFG);
    expect(res.forwarded).toBe(1);
    expect(res.skippedConsent).toBe(false);
    expect(httpPost).toHaveBeenCalledTimes(1);
  });

  it("withholds an unbound-run event from forward but still records it locally", async () => {
    process.env.MEETLESS_TELEMETRY = "on";
    recorder.recordAnalyticsEvent(ctx({ workspaceId: null }), {
      eventType: "mla_command",
      payload: { command: "init" },
    });
    expect(store.readEvents()).toHaveLength(1);
    const res = await recorder.flushAnalyticsEvents(CFG);
    expect(res.skippedNotEmittable).toBe(1);
    expect(res.forwarded).toBe(0);
    expect(httpPost).not.toHaveBeenCalled();
  });

  it("a transport failure is swallowed and counted, never thrown", async () => {
    process.env.MEETLESS_TELEMETRY = "on";
    httpPost.mockRejectedValueOnce(new Error("control down"));
    recorder.recordAnalyticsEvent(ctx(), { eventType: "mla_command", payload: { command: "ask" } });
    const res = await recorder.flushAnalyticsEvents(CFG);
    expect(res.failed).toBe(1);
    expect(res.forwarded).toBe(0);
    // Local record survives for a later re-forward.
    expect(store.readEvents()).toHaveLength(1);
  });

  it("flush clears the buffer (a second flush is a no-op)", async () => {
    process.env.MEETLESS_TELEMETRY = "on";
    recorder.recordAnalyticsEvent(ctx(), { eventType: "mla_command", payload: { command: "ask" } });
    await recorder.flushAnalyticsEvents(CFG);
    httpPost.mockClear();
    const res = await recorder.flushAnalyticsEvents(CFG);
    expect(res.attempted).toBe(0);
    expect(httpPost).not.toHaveBeenCalled();
  });

  it("a deterministic event_id is preserved when supplied (server-recomputable)", () => {
    const ev = recorder.buildEvent(ctx(), {
      eventType: "mla_evidence_outcome",
      payload: { inject_id: "inj_1", outcome: "used" },
      eventId: "deadbeef",
    }) as unknown as Record<string, unknown>;
    expect(ev.event_id).toBe("deadbeef");
  });
});
