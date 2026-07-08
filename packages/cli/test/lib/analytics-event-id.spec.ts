import {
  mintEventId,
  deterministicEventId,
  outcomeEventId,
  reviewDecisionEventId,
} from "../../src/lib/analytics/event-id";
import { mintRunId } from "../../src/lib/observability";

// INV-IDEMPOTENCY-1 / INV-REMOTE-DEDUPE-1: CLI-origin ids are mint-once UUIDs;
// server-recomputable ids are deterministic over (businessKey, version) and never
// collide across workspaces (the collision is prevented downstream by control
// keying on the PAIR (workspace_id, event_id), but the id itself is stable here).

describe("event-id (INV-IDEMPOTENCY-1)", () => {
  it("mintEventId returns distinct UUIDs", () => {
    const a = mintEventId();
    const b = mintEventId();
    expect(a).not.toEqual(b);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("deterministicEventId is stable for the same (key, version)", () => {
    expect(deterministicEventId("inj_1", 1)).toEqual(deterministicEventId("inj_1", 1));
  });

  it("deterministicEventId changes when the version bumps", () => {
    expect(deterministicEventId("inj_1", 1)).not.toEqual(deterministicEventId("inj_1", 2));
  });

  it("deterministicEventId changes when the business key changes", () => {
    expect(deterministicEventId("inj_1", 1)).not.toEqual(deterministicEventId("inj_2", 1));
  });

  it("rejects an empty business key or bad version", () => {
    expect(() => deterministicEventId("", 1)).toThrow();
    expect(() => deterministicEventId("inj_1", -1)).toThrow();
    expect(() => deterministicEventId("inj_1", 1.5)).toThrow();
  });

  it("outcomeEventId / reviewDecisionEventId are deterministicEventId in disguise", () => {
    expect(outcomeEventId("inj_9", 3)).toEqual(deterministicEventId("inj_9", 3));
    expect(reviewDecisionEventId("dec_9", 2)).toEqual(deterministicEventId("dec_9", 2));
  });

  it("run_id is a UUID distinct from a 32-hex trace_id shape (INV-RUN-1)", () => {
    const runId = mintRunId();
    expect(runId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    // Not the trace-id shape (32 hex, no dashes), so the two identities can never
    // be confused at a glance or by a regex gate.
    expect(runId).not.toMatch(/^[0-9a-f]{32}$/);
  });
});
