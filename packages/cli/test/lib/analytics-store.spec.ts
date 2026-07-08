import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// store.ts derives eventsPath() from HOME, which config.ts captures at module
// load from MEETLESS_HOME. So we point MEETLESS_HOME at a tmp dir and require the
// store fresh per test (jest.resetModules), mirroring flush-gc.spec.ts.

type StoreModule = typeof import("../../src/lib/analytics/store");

function makeEvent(over: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    event_id: "ev-1",
    event_type: "mla_command",
    created_at: "2026-06-07T00:00:00.000Z",
    emitted_at: "2026-06-07T00:00:00.000Z",
    workspace_id: "ws_1",
    distinct_id: "u_1",
    session_id: "sess_1",
    run_id: "run-1",
    trace_id: "0123456789abcdef0123456789abcdef",
    source: "cli",
    command: "ask",
    ...over,
  } as never;
}

describe("analytics store (INV-LOCAL-STATS-1/2)", () => {
  let tmp: string;
  let store: StoreModule;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mla-analytics-store-"));
    process.env.MEETLESS_HOME = tmp;
    delete process.env.MEETLESS_LOCAL_STATS;
    jest.resetModules();
    store = require("../../src/lib/analytics/store");
  });

  afterEach(() => {
    delete process.env.MEETLESS_HOME;
    delete process.env.MEETLESS_LOCAL_STATS;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("eventsPath lives under MEETLESS_HOME", () => {
    expect(store.eventsPath()).toBe(path.join(tmp, "events.jsonl"));
  });

  it("appends events as jsonl and reads them back", () => {
    store.appendEvent(makeEvent({ event_id: "a" }));
    store.appendEvent(makeEvent({ event_id: "b" }));
    const events = store.readEvents();
    expect(events.map((e: { event_id: string }) => e.event_id)).toEqual(["a", "b"]);
  });

  it("creates HOME if it does not exist", () => {
    fs.rmSync(tmp, { recursive: true, force: true });
    store.appendEvent(makeEvent());
    expect(fs.existsSync(store.eventsPath())).toBe(true);
  });

  it("skips malformed and blank lines on read (never throws)", () => {
    store.appendEvent(makeEvent({ event_id: "good" }));
    fs.appendFileSync(store.eventsPath(), "\n{ not json }\n\n");
    store.appendEvent(makeEvent({ event_id: "good2" }));
    const events = store.readEvents();
    expect(events.map((e: { event_id: string }) => e.event_id)).toEqual(["good", "good2"]);
  });

  it("writes nothing when MEETLESS_LOCAL_STATS=off", () => {
    process.env.MEETLESS_LOCAL_STATS = "off";
    store.appendEvent(makeEvent());
    expect(fs.existsSync(store.eventsPath())).toBe(false);
    expect(store.readEvents()).toEqual([]);
  });

  it("machineId is stable and opaque (m_ prefix, no raw hostname)", () => {
    const id = store.machineId();
    expect(id).toMatch(/^m_[0-9a-f]{24}$/);
    expect(id).toEqual(store.machineId());
    expect(id).not.toContain(os.hostname());
  });

  it("appendEventLine tolerates a line with or without a trailing newline", () => {
    store.appendEventLine(JSON.stringify(makeEvent({ event_id: "x" })));
    store.appendEventLine(JSON.stringify(makeEvent({ event_id: "y" })) + "\n");
    expect(store.readEvents().map((e: { event_id: string }) => e.event_id)).toEqual(["x", "y"]);
  });

  describe("rolling-tail cap (bounds file + correlator re-read)", () => {
    // A line is written directly (bypassing the cap) so we can pre-seed an
    // over-cap file, then a single append triggers exactly one trim -- fully
    // deterministic, no oscillation to reason about.
    function seedLine(id: string, padTo = 200): void {
      const ev = makeEvent({ event_id: id }) as Record<string, unknown>;
      let line = JSON.stringify(ev);
      if (line.length < padTo) {
        ev.pad = "x".repeat(padTo - line.length);
        line = JSON.stringify(ev);
      }
      fs.appendFileSync(store.eventsPath(), line + "\n", "utf8");
    }

    it("drops the oldest lines and keeps the newest tail once over the high-water mark", () => {
      process.env.MEETLESS_EVENTS_MAX_BYTES = "2000";
      process.env.MEETLESS_EVENTS_KEEP_BYTES = "1000";
      // Pre-seed ~6000 bytes (30 x ~200) so the file is well over the 2000 cap.
      for (let i = 0; i < 30; i++) seedLine(`e${String(i).padStart(2, "0")}`);
      expect(fs.statSync(store.eventsPath()).size).toBeGreaterThan(2000);

      // One real append trips the cap: trim to <=1000 tail, then append e30.
      store.appendEvent(makeEvent({ event_id: "e30" }));

      const size = fs.statSync(store.eventsPath()).size;
      expect(size).toBeLessThanOrEqual(2000); // deterministic: trimmed before append

      const ids = store.readEvents().map((e: { event_id: string }) => e.event_id);
      expect(ids[ids.length - 1]).toBe("e30"); // newest survives
      expect(ids).not.toContain("e00"); // oldest dropped
      expect(ids.length).toBeLessThan(31); // rotation happened
      // Chronological order preserved and every retained line parses cleanly.
      const sorted = [...ids].sort();
      expect(ids).toEqual(sorted);
    });

    it("never trims below the newest line, even when it alone exceeds keepBytes", () => {
      process.env.MEETLESS_EVENTS_MAX_BYTES = "2000";
      process.env.MEETLESS_EVENTS_KEEP_BYTES = "1000";
      seedLine("old-small", 200);
      seedLine("huge-newest", 3000); // single line > keepBytes and > maxBytes

      store.appendEvent(makeEvent({ event_id: "after" }));

      const ids = store.readEvents().map((e: { event_id: string }) => e.event_id);
      expect(ids).toContain("huge-newest"); // retained despite exceeding keepBytes
      expect(ids).toContain("after");
      expect(ids).not.toContain("old-small"); // older line dropped
    });

    it("does not rotate while under the high-water mark", () => {
      process.env.MEETLESS_EVENTS_MAX_BYTES = "1000000";
      store.appendEvent(makeEvent({ event_id: "a" }));
      store.appendEvent(makeEvent({ event_id: "b" }));
      store.appendEvent(makeEvent({ event_id: "c" }));
      expect(store.readEvents().map((e: { event_id: string }) => e.event_id)).toEqual([
        "a",
        "b",
        "c",
      ]);
    });

    afterEach(() => {
      delete process.env.MEETLESS_EVENTS_MAX_BYTES;
      delete process.env.MEETLESS_EVENTS_KEEP_BYTES;
    });
  });
});
