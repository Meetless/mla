// computeSequence (spec section 6.2: command_index_in_session, preceded_by,
// session_idle_gap_ms). Derived from the strictly-prior `mla_command` rows of the
// SAME session in the local events.jsonl. We seed real rows through the store
// (tmp MEETLESS_HOME) so the read path is exercised for real; no mocks.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

type SequenceModule = typeof import("../../src/lib/analytics/sequence");
type StoreModule = typeof import("../../src/lib/analytics/store");

// A minimal prior row: only the fields computeSequence reads. Cast through unknown
// since the store's appendEvent takes a full AnalyticsEvent.
function priorCommand(over: {
  session_id: string | null;
  command: string;
  emitted_at: string;
}): unknown {
  return {
    event_type: "mla_command",
    session_id: over.session_id,
    command: over.command,
    created_at: over.emitted_at,
    emitted_at: over.emitted_at,
  };
}

describe("computeSequence", () => {
  let tmp: string;
  let sequence: SequenceModule;
  let store: StoreModule;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mla-seq-"));
    process.env.MEETLESS_HOME = tmp;
    delete process.env.MEETLESS_LOCAL_STATS;
    jest.resetModules();
    sequence = require("../../src/lib/analytics/sequence");
    store = require("../../src/lib/analytics/store");
  });

  afterEach(() => {
    delete process.env.MEETLESS_HOME;
    delete process.env.MEETLESS_LOCAL_STATS;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("returns all-null for an unbound run (no session)", () => {
    expect(sequence.computeSequence(null, 1000)).toEqual({
      command_index_in_session: null,
      preceded_by: null,
      session_idle_gap_ms: null,
    });
  });

  it("is index 1 with no predecessor for the first command of a session", () => {
    const res = sequence.computeSequence("sess_a", Date.parse("2026-06-07T12:00:00Z"));
    expect(res).toEqual({
      command_index_in_session: 1,
      preceded_by: null,
      session_idle_gap_ms: null,
    });
  });

  it("counts strictly-prior same-session commands and names the latest predecessor", () => {
    store.appendEvent(
      priorCommand({ session_id: "sess_a", command: "ask", emitted_at: "2026-06-07T12:00:00.000Z" }) as never,
    );
    store.appendEvent(
      priorCommand({ session_id: "sess_a", command: "review", emitted_at: "2026-06-07T12:00:05.000Z" }) as never,
    );
    const start = Date.parse("2026-06-07T12:00:09.000Z");
    const res = sequence.computeSequence("sess_a", start);
    expect(res.command_index_in_session).toBe(3);
    expect(res.preceded_by).toBe("review"); // latest by emitted_at
    expect(res.session_idle_gap_ms).toBe(4000); // 12:00:09 - 12:00:05
  });

  it("ignores rows from a different session", () => {
    store.appendEvent(
      priorCommand({ session_id: "sess_other", command: "ask", emitted_at: "2026-06-07T12:00:00.000Z" }) as never,
    );
    const res = sequence.computeSequence("sess_a", Date.parse("2026-06-07T12:00:09.000Z"));
    expect(res.command_index_in_session).toBe(1);
    expect(res.preceded_by).toBeNull();
  });

  it("ignores non-mla_command rows", () => {
    const inject = {
      event_type: "mla_evidence_inject",
      session_id: "sess_a",
      emitted_at: "2026-06-07T12:00:00.000Z",
      created_at: "2026-06-07T12:00:00.000Z",
    };
    store.appendEvent(inject as never);
    const res = sequence.computeSequence("sess_a", Date.parse("2026-06-07T12:00:09.000Z"));
    expect(res.command_index_in_session).toBe(1);
    expect(res.preceded_by).toBeNull();
  });

  it("clamps a negative idle gap (clock skew) to null", () => {
    store.appendEvent(
      priorCommand({ session_id: "sess_a", command: "ask", emitted_at: "2026-06-07T12:00:10.000Z" }) as never,
    );
    // Start time BEFORE the prior row's recorded time.
    const res = sequence.computeSequence("sess_a", Date.parse("2026-06-07T12:00:05.000Z"));
    expect(res.command_index_in_session).toBe(2);
    expect(res.preceded_by).toBe("ask");
    expect(res.session_idle_gap_ms).toBeNull();
  });

  it("returns index 1 when local stats are off (no working set to order against)", () => {
    process.env.MEETLESS_LOCAL_STATS = "off";
    jest.resetModules();
    const seq2: SequenceModule = require("../../src/lib/analytics/sequence");
    const res = seq2.computeSequence("sess_a", Date.parse("2026-06-07T12:00:09.000Z"));
    expect(res.command_index_in_session).toBe(1);
    expect(res.preceded_by).toBeNull();
  });
});
