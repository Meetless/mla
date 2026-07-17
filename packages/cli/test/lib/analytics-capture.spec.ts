// captureCommandEvent integration (spec section 6.2, section 11.4). Exercises the
// full finalize path: build the normalized payload -> record locally (tmp
// MEETLESS_HOME) -> conditionally forward to control. We mock ONLY the external
// transport (http.post); store, envelope, sequence, and consent all run for real.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

jest.mock("../../src/lib/http", () => ({
  post: jest.fn().mockResolvedValue({}),
}));

type CaptureModule = typeof import("../../src/lib/analytics/capture");
type ObsModule = typeof import("../../src/lib/observability");
type StoreModule = typeof import("../../src/lib/analytics/store");
type RecorderModule = typeof import("../../src/lib/analytics/recorder");
import type { CliConfig } from "../../src/lib/config";

const CFG: CliConfig = {
  controlUrl: "http://127.0.0.1:9",
  controlToken: "t",
  mlaPath: "/tmp/mla",
  auth: { mode: "shared-key", accessToken: "t" },
};

const STARTED = Date.parse("2026-06-07T12:00:00.000Z");
const NOW = STARTED + 1234;

function baseParams(over: Record<string, unknown> = {}) {
  return {
    argv: ["ask", "what is our pricing"],
    exitCode: 0,
    threw: false,
    thrown: null,
    workspaceId: "ws_1",
    sessionId: "sess_1",
    actorUserId: "usr_cuid_1",
    mlaVersion: "0.1.0",
    gitSha: "abc1234",
    invoker: "human_tty",
    startedAtMs: STARTED,
    nowMs: NOW,
    cfg: CFG,
    ...over,
  } as Parameters<CaptureModule["captureCommandEvent"]>[0];
}

describe("captureCommandEvent", () => {
  let tmp: string;
  let capture: CaptureModule;
  let obs: ObsModule;
  let store: StoreModule;
  let recorder: RecorderModule;
  let httpPost: jest.Mock;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mla-capture-"));
    process.env.MEETLESS_HOME = tmp;
    delete process.env.MEETLESS_LOCAL_STATS;
    delete process.env.MEETLESS_TELEMETRY;
    delete process.env.MEETLESS_NO_TELEMETRY;
    jest.resetModules();
    obs = require("../../src/lib/observability");
    capture = require("../../src/lib/analytics/capture");
    store = require("../../src/lib/analytics/store");
    recorder = require("../../src/lib/analytics/recorder");
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

  it("buildCommandPayload is pure and emits the normalized shape", () => {
    const p = capture.buildCommandPayload({
      argv: ["kb", "review", "ddx_1", "--accept"],
      exitCode: 0,
      threw: false,
      thrown: null,
      mlaVersion: "0.1.0",
      gitSha: "abc1234",
      invoker: "agent",
      startedAtMs: STARTED,
      nowMs: NOW,
      sessionId: null, // null session -> null sequence fields, no I/O
    });
    expect(p.command).toBe("kb");
    expect(p.subcommand).toBe("review");
    expect(p.flags_shape).toEqual(["accept"]);
    expect(p.scope).toBe("local");
    expect(p.outcome).toBe("success");
    expect(p.duration_ms).toBe(1234);
    expect(p.exit_code).toBe(0);
    expect(p.touched_surface).toBe("unknown");
    expect(p.mla_version).toBe("0.1.0");
    expect(p.git_sha).toBe("abc1234");
    // The invoker (§4.11) is threaded straight through, never re-derived here: the
    // caller derives it at bootstrap before MEETLESS_OUTPUT is deleted.
    expect(p.invoker).toBe("agent");
  });

  it("records an mla_command event locally", async () => {
    await capture.captureCommandEvent(baseParams());
    const events = store.readEvents();
    expect(events).toHaveLength(1);
    const ev = events[0] as unknown as Record<string, unknown>;
    expect(ev.event_type).toBe("mla_command");
    expect(ev.command).toBe("ask");
    expect(ev.scope).toBe("workspace");
    expect(ev.run_id).toBe("11111111-1111-1111-1111-111111111111");
    expect(ev.trace_id).toBe("0123456789abcdef0123456789abcdef");
    expect(ev.distinct_id).toBe("usr_cuid_1");
    expect(ev.invoker).toBe("human_tty");
  });

  it("carries the agent invoker onto the on-disk event (§4.11)", async () => {
    // The bootstrap derives `agent` from resolve-mla's MEETLESS_OUTPUT=json transport
    // and threads it here. The finalize path must persist it verbatim so agent traffic
    // is separable from human traffic in the local funnel.
    await capture.captureCommandEvent(baseParams({ invoker: "agent" }));
    const ev = store.readEvents()[0] as unknown as Record<string, unknown>;
    expect(ev.invoker).toBe("agent");
  });

  it("does NOT emit an mla_command for an `_internal` subcommand (funnel hygiene)", async () => {
    // Hooks spawn `mla _internal evidence-inject|evidence-correlate|auto-index`; these
    // are machine-internal plumbing, not user journey steps. They must not pollute the
    // command-journey funnel with `command:"_internal"` rows.
    await capture.captureCommandEvent(baseParams({ argv: ["_internal", "evidence-inject"] }));
    expect(store.readEvents()).toHaveLength(0); // no mla_command on disk
  });

  it("an `_internal` run still runs the remote flush (forwards anything already buffered)", async () => {
    // The internal command flushes its own buffer before finalize, so the buffer is
    // empty here and the flush is a no-op -- but the flush is still reached (it is not
    // gated on emitting an mla_command), so genuinely-buffered value events forward.
    process.env.MEETLESS_TELEMETRY = "on";
    await capture.captureCommandEvent(baseParams({ argv: ["_internal", "auto-index"] }));
    // No mla_command recorded, and with an empty buffer the forwarder posts nothing.
    expect(store.readEvents()).toHaveLength(0);
    expect(httpPost).not.toHaveBeenCalled();
  });

  it("INV-ARGV-1: the on-disk event never contains the raw query positional", async () => {
    await capture.captureCommandEvent(
      baseParams({ argv: ["ask", "what is our super secret pricing strategy", "--json"] }),
    );
    const raw = fs.readFileSync(path.join(tmp, "events.jsonl"), "utf8");
    expect(raw).not.toContain("super secret pricing strategy");
    // The shape that IS emitted: command + approved flag name only.
    const ev = JSON.parse(raw.trim());
    expect(ev.command).toBe("ask");
    expect(ev.flags_shape).toEqual(["json"]);
  });

  it("forwards to control when telemetry is opted in", async () => {
    process.env.MEETLESS_TELEMETRY = "on";
    await capture.captureCommandEvent(baseParams());
    expect(httpPost).toHaveBeenCalledTimes(1);
    const [, route, body] = httpPost.mock.calls[0];
    expect(route).toBe("/internal/v1/analytics/events");
    expect((body as { events: unknown[] }).events).toHaveLength(1);
  });

  it("records locally but does NOT forward when telemetry is opted out (MEETLESS_TELEMETRY=off)", async () => {
    process.env.MEETLESS_TELEMETRY = "off";
    await capture.captureCommandEvent(baseParams());
    expect(store.readEvents()).toHaveLength(1);
    expect(httpPost).not.toHaveBeenCalled();
  });

  it("forwards by default when telemetry is unset (opt-out posture, default ON)", async () => {
    delete process.env.MEETLESS_TELEMETRY;
    await capture.captureCommandEvent(baseParams());
    expect(store.readEvents()).toHaveLength(1);
    expect(httpPost).toHaveBeenCalledTimes(1);
  });

  it("skips the remote forward entirely when there is no control config", async () => {
    await capture.captureCommandEvent(baseParams({ cfg: null }));
    expect(store.readEvents()).toHaveLength(1); // still recorded locally
    expect(httpPost).not.toHaveBeenCalled();
  });

  it("falls back to the hashed machine id when there is no actor", async () => {
    await capture.captureCommandEvent(baseParams({ actorUserId: null }));
    const ev = store.readEvents()[0] as unknown as Record<string, unknown>;
    expect(String(ev.distinct_id)).toMatch(/^m_[0-9a-f]{24}$/);
  });

  it("derives sequence fields from prior same-session commands", async () => {
    process.env.MEETLESS_TELEMETRY = "on";
    await capture.captureCommandEvent(
      baseParams({ argv: ["ask", "first"], startedAtMs: STARTED, nowMs: STARTED + 100 }),
    );
    recorder.resetRecorderForTesting();
    httpPost.mockClear();
    await capture.captureCommandEvent(
      baseParams({ argv: ["review"], startedAtMs: NOW, nowMs: NOW + 50 }),
    );
    const events = store.readEvents();
    expect(events).toHaveLength(2);
    const second = events[1] as unknown as Record<string, unknown>;
    expect(second.command_index_in_session).toBe(2);
    expect(second.preceded_by).toBe("ask");
    expect(typeof second.session_idle_gap_ms).toBe("number");
  });

  it("records a failed command with the classified outcome", async () => {
    await capture.captureCommandEvent(
      baseParams({ exitCode: 1, threw: true, thrown: { status: 401 } }),
    );
    const ev = store.readEvents()[0] as unknown as Record<string, unknown>;
    expect(ev.outcome).toBe("auth_error");
    expect(ev.error_class).toBe("http_401");
    expect(ev.exit_code).toBe(1);
  });

  it("never throws even if the run context is unset (best-effort)", async () => {
    obs.setRunId(null as unknown as string);
    obs.setRunTraceId(null as unknown as string);
    // buildEvent would throw without a run_id; captureCommandEvent must swallow it.
    await expect(capture.captureCommandEvent(baseParams())).resolves.toBeUndefined();
    expect(httpPost).not.toHaveBeenCalled();
  });
});
