// Enforcement-incident emit seam (the deny tile, §5.1): the fail-soft, local-append-only bridge
// between the PreToolUse deny branch and the generic analytics spool. Mirrors ce0-emit.spec
// (real recorder + tmp MEETLESS_HOME; only the http transport is mocked). The one behaviour that
// DIFFERS from CE0 is asserted explicitly: a deny self-joins via incident_id, so the seam MINTS a
// run/trace when none is ambient rather than skipping the event.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

jest.mock("../../src/lib/http", () => ({
  post: jest.fn().mockResolvedValue({}),
}));

type EmitModule = typeof import("../../src/lib/analytics/enforcement-incident");
type StoreModule = typeof import("../../src/lib/analytics/store");
type RecorderModule = typeof import("../../src/lib/analytics/recorder");
type EventIdModule = typeof import("../../src/lib/analytics/event-id");
type ObservabilityModule = typeof import("../../src/lib/observability");

const NOW = Date.parse("2026-06-19T12:00:00.000Z");
const INCIDENT = "01J0000000DENYATTEMPT0001";

describe("emitEnforcementIncident", () => {
  let tmp: string;
  let emit: EmitModule;
  let store: StoreModule;
  let recorder: RecorderModule;
  let eventId: EventIdModule;
  let observability: ObservabilityModule;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mla-enforcement-incident-"));
    process.env.MEETLESS_HOME = tmp;
    delete process.env.MEETLESS_LOCAL_STATS;
    delete process.env.MEETLESS_TELEMETRY;
    delete process.env.MEETLESS_NO_TELEMETRY;
    jest.resetModules();
    store = require("../../src/lib/analytics/store");
    recorder = require("../../src/lib/analytics/recorder");
    eventId = require("../../src/lib/analytics/event-id");
    observability = require("../../src/lib/observability");
    emit = require("../../src/lib/analytics/enforcement-incident");
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

  function input(over: Partial<EmitModule["emitEnforcementIncident"] extends (i: infer I, ...rest: never[]) => unknown ? I : never> = {}) {
    return {
      incidentId: INCIDENT,
      decision: "deny" as const,
      tool: "Write" as const,
      touchedSurface: "docs" as const,
      ruleVersionId: "ver_1",
      ...over,
    };
  }

  it("appends one mla_enforcement_incident under a hook envelope, with all PII-safe enum/id fields", () => {
    emit.emitEnforcementIncident(
      input(),
      { workspaceId: "ws_1", sessionId: "sess_1", nowMs: NOW },
      { runId: "run_test", traceId: "0123456789abcdef0123456789abcdef", machineId: () => "m_test", readCfg: () => null },
    );

    const events = store.readEvents();
    expect(events).toHaveLength(1);
    const ev = events[0] as unknown as Record<string, unknown>;
    expect(ev.event_type).toBe("mla_enforcement_incident");
    // Deterministic id keyed on the incident (re-fire dedups), version 0 (born unreviewed).
    expect(ev.event_id).toBe(eventId.deterministicEventId(INCIDENT, 0));
    expect(ev.source).toBe("hook");
    expect(ev.workspace_id).toBe("ws_1");
    expect(ev.session_id).toBe("sess_1");
    expect(ev.run_id).toBe("run_test");
    expect(ev.trace_id).toBe("0123456789abcdef0123456789abcdef");
    // Payload.
    expect(ev.incident_id).toBe(INCIDENT);
    expect(ev.decision).toBe("deny");
    expect(ev.enforced_tool).toBe("Write");
    expect(ev.touched_surface).toBe("docs");
    expect(ev.rule_version_id).toBe("ver_1");
    expect(ev.review_status).toBe("unreviewed");
  });

  it("re-firing on the same incident produces the SAME event_id (idempotent dedup)", () => {
    const deps = { runId: "run_test", traceId: "0123456789abcdef0123456789abcdef", machineId: () => "m_test", readCfg: () => null };
    emit.emitEnforcementIncident(input(), { workspaceId: "ws_1", sessionId: "sess_1", nowMs: NOW }, deps);
    emit.emitEnforcementIncident(input(), { workspaceId: "ws_1", sessionId: "sess_1", nowMs: NOW + 5 }, deps);
    const events = store.readEvents();
    expect(events).toHaveLength(2);
    expect((events[0] as unknown as Record<string, unknown>).event_id).toBe(
      (events[1] as unknown as Record<string, unknown>).event_id,
    );
  });

  it("MINTS a run/trace when none is ambient (a deny is too valuable to skip; it self-joins via incident_id)", () => {
    // No run/trace injected and none set on the process: unlike CE0 (which skips), this seam records.
    emit.emitEnforcementIncident(
      input(),
      { workspaceId: "ws_1", sessionId: "sess_1", nowMs: NOW },
      { machineId: () => "m_test", readCfg: () => null },
    );
    const events = store.readEvents();
    expect(events).toHaveLength(1);
    const ev = events[0] as unknown as Record<string, unknown>;
    expect(typeof ev.run_id).toBe("string");
    expect((ev.run_id as string).length).toBeGreaterThan(0);
    expect(ev.trace_id).toMatch(/^[0-9a-f]{32}$/);
  });

  it("is fail-soft: a record dep that throws never escapes into the blocked turn", () => {
    expect(() =>
      emit.emitEnforcementIncident(
        input(),
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

  it("carries NO key beyond the envelope + the closed payload (no path, no content leaks)", () => {
    emit.emitEnforcementIncident(
      input(),
      { workspaceId: "ws_1", sessionId: "sess_1", nowMs: NOW },
      { runId: "run_test", traceId: "0123456789abcdef0123456789abcdef", machineId: () => "m_test", readCfg: () => null },
    );
    const ev = store.readEvents()[0] as unknown as Record<string, unknown>;
    const payloadKeys = ["incident_id", "decision", "enforced_tool", "touched_surface", "rule_version_id", "review_status"];
    for (const k of payloadKeys) expect(ev).toHaveProperty(k);
    // The serialized event must not contain any free-text path-shaped value: the only ids present
    // are the ULID incident, the rule version, ws/session/run/trace, and the enums.
    const serialized = JSON.stringify(ev);
    expect(serialized).not.toMatch(/\.md|\.ts|\/notes\/|file_path/);
    // And with no snapshot supplied, the optional evidence keys stay off the row entirely.
    expect(ev).not.toHaveProperty("rule_node_id");
    expect(ev).not.toHaveProperty("rule_text");
  });

  it("snapshots the deciding rule node id + statement onto the payload when supplied (capture-time evidence)", () => {
    emit.emitEnforcementIncident(
      input({ ruleNodeId: "cmexamplerulenodeid000000", ruleText: "Notes live under notes/, never docs/." }),
      { workspaceId: "ws_1", sessionId: "sess_1", nowMs: NOW },
      { runId: "run_test", traceId: "0123456789abcdef0123456789abcdef", machineId: () => "m_test", readCfg: () => null },
    );
    const ev = store.readEvents()[0] as unknown as Record<string, unknown>;
    // The node id (cutover-stable) and the verbatim rule statement travel with the deny, so the
    // review queue never depends on a version-id join that can rot.
    expect(ev.rule_node_id).toBe("cmexamplerulenodeid000000");
    expect(ev.rule_text).toBe("Notes live under notes/, never docs/.");
  });

  it("omits the snapshot keys when the node id / text are empty strings (never an empty-value key)", () => {
    emit.emitEnforcementIncident(
      input({ ruleNodeId: "", ruleText: "" }),
      { workspaceId: "ws_1", sessionId: "sess_1", nowMs: NOW },
      { runId: "run_test", traceId: "0123456789abcdef0123456789abcdef", machineId: () => "m_test", readCfg: () => null },
    );
    const ev = store.readEvents()[0] as unknown as Record<string, unknown>;
    expect(ev).not.toHaveProperty("rule_node_id");
    expect(ev).not.toHaveProperty("rule_text");
  });
});
