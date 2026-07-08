// `mla _internal forward-enforcement` -- the delivery bridge that ships hook-emitted
// enforcement incidents from the local spool to control (INV-ENFORCEMENT-DELIVERY-1).
// The deny hot path records the incident locally then exits before it can flush, so
// this detached command is the only thing that actually delivers it to the review
// queue. These are pure dependency-injection tests: read/forward/readCfg/env are all
// pinned, so the filter + dedup + gate logic is asserted without touching the fs or
// the network.

import { runInternalForwardEnforcement } from "../../src/commands/internal-forward-enforcement";
import { AnalyticsEvent } from "../../src/lib/analytics/envelope";
import { CliConfig } from "../../src/lib/config";
import { ForwardResult } from "../../src/lib/analytics/forwarder";

// A minimal enforcement-incident row as it lands in events.jsonl (envelope + payload
// flat-merged). Only the keys the command reads matter here.
function incident(over: Partial<Record<string, unknown>> = {}): AnalyticsEvent {
  return {
    event_type: "mla_enforcement_incident",
    event_id: "evt_1",
    workspace_id: "ws_1",
    session_id: "sess_1",
    incident_id: "01J0DENY0001",
    ...over,
  } as unknown as AnalyticsEvent;
}

const CFG = { backendUrl: "https://control.example" } as unknown as CliConfig;

const OK: ForwardResult = {
  attempted: 0,
  forwarded: 0,
  skippedConsent: false,
  skippedNotEmittable: 0,
  failed: 0,
};

describe("runInternalForwardEnforcement", () => {
  it("forwards only enforcement incidents for the requested session", async () => {
    const forward = jest.fn().mockResolvedValue({ ...OK, forwarded: 1 });
    const events: AnalyticsEvent[] = [
      incident({ event_id: "evt_a", session_id: "sess_target" }),
      // wrong session -> excluded
      incident({ event_id: "evt_b", session_id: "sess_other" }),
      // wrong type -> excluded even in the target session
      incident({ event_id: "evt_c", session_id: "sess_target", event_type: "mla_evidence_inject" }),
    ];
    const code = await runInternalForwardEnforcement(["--session", "sess_target"], {
      read: () => events,
      readCfg: () => CFG,
      forward,
      env: {},
    });
    expect(code).toBe(0);
    expect(forward).toHaveBeenCalledTimes(1);
    const shipped = forward.mock.calls[0][1] as AnalyticsEvent[];
    expect(shipped.map((e) => (e as unknown as Record<string, unknown>).event_id)).toEqual(["evt_a"]);
  });

  it("dedupes re-fired incidents by event_id (N re-fires -> ONE forwarded row)", async () => {
    const forward = jest.fn().mockResolvedValue({ ...OK, forwarded: 1 });
    const events: AnalyticsEvent[] = [
      incident({ event_id: "evt_dup", incident_id: "01J0DENY0007" }),
      incident({ event_id: "evt_dup", incident_id: "01J0DENY0007" }),
      incident({ event_id: "evt_dup", incident_id: "01J0DENY0007" }),
    ];
    const code = await runInternalForwardEnforcement(["--session", "sess_1"], {
      read: () => events,
      readCfg: () => CFG,
      forward,
      env: {},
    });
    expect(code).toBe(0);
    const shipped = forward.mock.calls[0][1] as AnalyticsEvent[];
    expect(shipped).toHaveLength(1);
  });

  it("with no --session forwards every local incident (manual re-sync)", async () => {
    const forward = jest.fn().mockResolvedValue({ ...OK, forwarded: 2 });
    const events: AnalyticsEvent[] = [
      incident({ event_id: "evt_a", session_id: "sess_1" }),
      incident({ event_id: "evt_b", session_id: "sess_2" }),
    ];
    const code = await runInternalForwardEnforcement([], {
      read: () => events,
      readCfg: () => CFG,
      forward,
      env: {},
    });
    expect(code).toBe(0);
    const shipped = forward.mock.calls[0][1] as AnalyticsEvent[];
    expect(shipped).toHaveLength(2);
  });

  it("does not call forward when there are no matching incidents", async () => {
    const forward = jest.fn().mockResolvedValue(OK);
    const code = await runInternalForwardEnforcement(["--session", "sess_1"], {
      read: () => [incident({ session_id: "sess_other" })],
      readCfg: () => CFG,
      forward,
      env: {},
    });
    expect(code).toBe(0);
    expect(forward).not.toHaveBeenCalled();
  });

  it("does not call forward when there is no control config (leaves the spool durable)", async () => {
    const forward = jest.fn().mockResolvedValue(OK);
    const code = await runInternalForwardEnforcement(["--session", "sess_1"], {
      read: () => [incident()],
      readCfg: () => null,
      forward,
      env: {},
    });
    expect(code).toBe(0);
    expect(forward).not.toHaveBeenCalled();
  });

  it("is fail-soft: a forward that throws never escapes (exit 0)", async () => {
    const forward = jest.fn().mockRejectedValue(new Error("control down"));
    const code = await runInternalForwardEnforcement(["--session", "sess_1"], {
      read: () => [incident()],
      readCfg: () => CFG,
      forward,
      env: {},
    });
    expect(code).toBe(0);
  });

  it("rejects an unknown flag with a strict parse error (exit 2)", async () => {
    const forward = jest.fn();
    const code = await runInternalForwardEnforcement(["--bogus"], {
      read: () => [incident()],
      readCfg: () => CFG,
      forward,
      env: {},
    });
    expect(code).toBe(2);
    expect(forward).not.toHaveBeenCalled();
  });
});
