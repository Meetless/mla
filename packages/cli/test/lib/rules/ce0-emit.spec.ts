// CE0 live telemetry sink (notes/20260617-evidence-consultation-forcing-function-proposal.md §6.4
// P0.2): the fail-soft local-append seam between the CE0 hooks and the existing generic analytics
// spool. The pure ce0-telemetry builders produce a RecordInput; emitCe0Event attaches the run-context
// envelope and appends it to the local jsonl via the shared recorder. Delivery is local-append-only
// (no synchronous network call from the hook) and fail-soft (a missing run context or a spool fault
// never throws into the turn the hook observed). Exercised with a real recorder + tmp MEETLESS_HOME,
// mirroring internal-evidence-inject.spec; only the external http transport is mocked.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

jest.mock("../../../src/lib/http", () => ({
  post: jest.fn().mockResolvedValue({}),
}));

type EmitModule = typeof import("../../../src/lib/rules/ce0-emit");
type StoreModule = typeof import("../../../src/lib/analytics/store");
type RecorderModule = typeof import("../../../src/lib/analytics/recorder");
type TelemetryModule = typeof import("../../../src/lib/rules/ce0-telemetry");
type ObservabilityModule = typeof import("../../../src/lib/observability");

const NOW = Date.parse("2026-06-19T12:00:00.000Z");

describe("emitCe0Event", () => {
  let tmp: string;
  let emit: EmitModule;
  let store: StoreModule;
  let recorder: RecorderModule;
  let telemetry: TelemetryModule;
  let observability: ObservabilityModule;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mla-ce0-emit-"));
    process.env.MEETLESS_HOME = tmp;
    delete process.env.MEETLESS_LOCAL_STATS;
    delete process.env.MEETLESS_TELEMETRY;
    delete process.env.MEETLESS_NO_TELEMETRY;
    jest.resetModules();
    store = require("../../../src/lib/analytics/store");
    recorder = require("../../../src/lib/analytics/recorder");
    telemetry = require("../../../src/lib/rules/ce0-telemetry");
    observability = require("../../../src/lib/observability");
    emit = require("../../../src/lib/rules/ce0-emit");
    recorder.resetRecorderForTesting();
  });

  afterEach(() => {
    delete process.env.MEETLESS_HOME;
    delete process.env.MEETLESS_LOCAL_STATS;
    delete process.env.MEETLESS_TELEMETRY;
    delete process.env.MEETLESS_NO_TELEMETRY;
    observability.resetRunIdForTesting();
    observability.resetRunTracerForTesting();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("appends a CE0 RecordInput to the local spool under a hook envelope (real recorder)", () => {
    const input = telemetry.buildEvidenceHookHealthEvent({
      hook: "STOP",
      operationIdentity: "ws_1:sess_1:7",
      durationMs: 3,
      failed: false,
      reason: null,
    });

    emit.emitCe0Event(
      input,
      { workspaceId: "ws_1", sessionId: "sess_1", nowMs: NOW },
      { runId: "run_test", traceId: "0123456789abcdef0123456789abcdef", machineId: () => "m_test", readCfg: () => null },
    );

    const events = store.readEvents();
    expect(events).toHaveLength(1);
    const ev = events[0] as unknown as Record<string, unknown>;
    expect(ev.event_type).toBe("evidence_hook_health");
    expect(ev.event_id).toBe(input.eventId);
    expect(ev.workspace_id).toBe("ws_1");
    expect(ev.session_id).toBe("sess_1");
    expect(ev.run_id).toBe("run_test");
    expect(ev.trace_id).toBe("0123456789abcdef0123456789abcdef");
    expect(ev.source).toBe("hook");
    expect(ev.operation_identity).toBe("ws_1:sess_1:7");
  });

  it("is fail-soft: a record dep that throws never escapes (§6.4 P0.2)", () => {
    const input = telemetry.buildEvidenceHookHealthEvent({
      hook: "USER_PROMPT_SUBMIT",
      operationIdentity: "asmt_1",
      durationMs: 1,
      failed: false,
      reason: null,
    });

    expect(() =>
      emit.emitCe0Event(
        input,
        { workspaceId: "ws_1", sessionId: "sess_1", nowMs: NOW },
        {
          runId: "run_test",
          traceId: "0123456789abcdef0123456789abcdef",
          record: () => {
            throw new Error("spool down");
          },
        },
      ),
    ).not.toThrow();
  });

  it("skips recording entirely when no joinable run/trace context is resolvable (best-effort, no attempt)", () => {
    // No run id / trace id set on the process and none injected: the durable store already recorded the
    // fact, so the seam does not even attempt to record a context-less local line that could never join
    // the enrichment. This pins the skip BEFORE recording, distinct from the throw-and-swallow path.
    const input = telemetry.buildEvidenceHookHealthEvent({
      hook: "STOP",
      operationIdentity: "ws_1:sess_1:7",
      durationMs: 2,
      failed: false,
      reason: null,
    });

    let attempted = false;
    emit.emitCe0Event(
      input,
      { workspaceId: "ws_1", sessionId: "sess_1", nowMs: NOW },
      {
        record: (() => {
          attempted = true;
          return undefined;
        }) as unknown as RecorderModule["recordAnalyticsEvent"],
      },
    );

    expect(attempted).toBe(false);
    expect(store.readEvents()).toHaveLength(0);
  });
});
