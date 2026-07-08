import {
  SCHEMA_VERSION,
  makeEnvelope,
  envelopeMissingKeys,
  assertEnvelopeComplete,
  isRemotelyEmittable,
  AnalyticsEnvelope,
} from "../../src/lib/analytics/envelope";

function fullEnvelope(over: Partial<AnalyticsEnvelope> = {}): AnalyticsEnvelope {
  return makeEnvelope({
    event_id: "ev-1",
    event_type: "mla_command",
    created_at: "2026-06-07T00:00:00.000Z",
    workspace_id: "ws_1",
    distinct_id: "u_1",
    session_id: "sess_1",
    run_id: "run-1",
    trace_id: "0123456789abcdef0123456789abcdef",
    ...over,
  });
}

describe("analytics envelope (INV-JOIN-1, INV-SCHEMA-1)", () => {
  it("makeEnvelope stamps schema_version and mirrors emitted_at from created_at", () => {
    const ev = fullEnvelope();
    expect(ev.schema_version).toBe(SCHEMA_VERSION);
    expect(ev.emitted_at).toBe(ev.created_at);
    expect(ev.source).toBe("cli");
  });

  it("a complete envelope has no missing keys and asserts clean", () => {
    const ev = fullEnvelope();
    expect(envelopeMissingKeys(ev)).toEqual([]);
    expect(() => assertEnvelopeComplete(ev)).not.toThrow();
  });

  it.each(["event_id", "event_type", "run_id", "trace_id", "created_at"])(
    "flags a missing required key %p",
    (key) => {
      const ev = fullEnvelope();
      delete (ev as unknown as Record<string, unknown>)[key];
      expect(envelopeMissingKeys(ev)).toContain(key);
      expect(() => assertEnvelopeComplete(ev)).toThrow(/missing required envelope/);
    },
  );

  it("allows null workspace_id and session_id (unbound run) without flagging", () => {
    const ev = fullEnvelope({ workspace_id: null, session_id: null });
    // The KEYS are present, so envelope completeness passes...
    expect(envelopeMissingKeys(ev)).toEqual([]);
    expect(() => assertEnvelopeComplete(ev)).not.toThrow();
    // ...but it is NOT remotely emittable (no workspace/session to join on).
    expect(isRemotelyEmittable(ev)).toBe(false);
  });

  it("treats undefined run_id/trace_id as missing", () => {
    const ev = fullEnvelope();
    (ev as unknown as Record<string, unknown>).run_id = undefined;
    expect(envelopeMissingKeys(ev)).toContain("run_id");
  });

  it("a bound run is remotely emittable", () => {
    expect(isRemotelyEmittable(fullEnvelope())).toBe(true);
  });

  it("an empty-string workspace_id is not emittable", () => {
    expect(isRemotelyEmittable(fullEnvelope({ workspace_id: "" }))).toBe(false);
  });
});
