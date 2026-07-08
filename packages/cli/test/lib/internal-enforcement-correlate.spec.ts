// `mla _internal enforcement-correlate` -- the detached Stop-hook correlator that closes a
// deny window with an mla_enforcement_outcome (STAR's R). Pure DI tests: read / readTranscript
// / record / flush / readCfg / env are all pinned, so the filter + dedup + emit + fail-soft
// logic is asserted without touching fs, network, or the real transcript. The classifier
// itself is covered in enforcement-outcome.spec.ts; here we assert the command's wiring:
// which incidents it selects, that it emits only terminal + not-already-outcomed rows, that
// the outcome reuses the incident's identity, and that nothing ever escapes as a throw.

import {
  runInternalEnforcementCorrelate,
  parseArgs,
} from "../../src/commands/internal-enforcement-correlate";
import { enforcementOutcomeEventId } from "../../src/lib/analytics/event-id";

// A stored enforcement-incident row as it lands flat in events.jsonl (envelope + payload
// merged at one level). Only the keys the command reads matter.
function incidentRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event_type: "mla_enforcement_incident",
    session_id: "sess_1",
    incident_id: "INC1",
    decision: "deny",
    enforced_tool: "Write",
    blocked_path: "notes/x.md",
    workspace_id: "ws_1",
    distinct_id: "dist_1",
    run_id: "run_1",
    trace_id: "trace_1",
    created_at: "2026-07-04T00:00:00.000Z",
    ...over,
  };
}

function outcomeRow(incidentId: string): Record<string, unknown> {
  return {
    event_type: "mla_enforcement_outcome",
    session_id: "sess_1",
    incident_id: incidentId,
  };
}

function asstWrite(filePath: string): string {
  return JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", name: "Write", input: { file_path: filePath } }] },
  });
}

function asstText(text: string): string {
  return JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } });
}

const CFG = { backendUrl: "https://control.example" } as never;

// A transcript where the single deny (notes/x.md) is followed by a plain assistant turn ->
// complied_stopped (terminal, so it emits).
const STOPPED_TRANSCRIPT = [asstWrite("/repo/notes/x.md"), asstText("done")].join("\n");

function baseDeps(over: Record<string, unknown> = {}) {
  return {
    read: jest.fn().mockReturnValue([incidentRow()]),
    readTranscript: jest.fn().mockReturnValue(STOPPED_TRANSCRIPT),
    record: jest.fn(),
    flush: jest.fn().mockResolvedValue(undefined),
    readCfg: jest.fn().mockReturnValue(CFG),
    nowMs: 1_720_000_000_000,
    env: {},
    ...over,
  };
}

describe("parseArgs", () => {
  it("parses --session / --transcript in both space and = forms", () => {
    expect(parseArgs(["--session", "s", "--transcript", "/t"])).toEqual({
      session: "s",
      transcript: "/t",
    });
    expect(parseArgs(["--session=s", "--transcript=/t"])).toEqual({
      session: "s",
      transcript: "/t",
    });
  });

  it("throws on an unknown flag (strict, becomes exit 2)", () => {
    expect(() => parseArgs(["--bogus"])).toThrow(/Unknown flag/);
  });
});

describe("runInternalEnforcementCorrelate", () => {
  it("emits one terminal outcome that reuses the incident's identity", async () => {
    const deps = baseDeps();
    const code = await runInternalEnforcementCorrelate(
      ["--session", "sess_1", "--transcript", "/t.jsonl"],
      deps,
    );
    expect(code).toBe(0);
    expect(deps.record).toHaveBeenCalledTimes(1);

    const [ctx, event, env] = deps.record.mock.calls[0];
    expect(ctx).toMatchObject({
      workspaceId: "ws_1",
      sessionId: "sess_1",
      distinctId: "dist_1",
      runId: "run_1",
      traceId: "trace_1",
      source: "hook",
    });
    expect(env).toBe(deps.env);
    expect(event.eventType).toBe("mla_enforcement_outcome");
    expect(event.eventId).toBe(enforcementOutcomeEventId("INC1", 0));
    expect(event.payload).toEqual({
      incident_id: "INC1",
      outcome_version: 0,
      outcome: "complied_stopped",
      followup_attempts: 0,
      retried_blocked_count: 0,
    });
    // cfg present -> forwarded synchronously in the Stop pass.
    expect(deps.flush).toHaveBeenCalledTimes(1);
  });

  it("skips an incident that already carries an outcome line (idempotent)", async () => {
    const deps = baseDeps({
      read: jest.fn().mockReturnValue([incidentRow(), outcomeRow("INC1")]),
    });
    const code = await runInternalEnforcementCorrelate(
      ["--session", "sess_1", "--transcript", "/t.jsonl"],
      deps,
    );
    expect(code).toBe(0);
    expect(deps.record).not.toHaveBeenCalled();
  });

  it("is scoped to the requested session (other-session denies are invisible)", async () => {
    const deps = baseDeps({
      read: jest.fn().mockReturnValue([incidentRow({ session_id: "sess_other" })]),
    });
    const code = await runInternalEnforcementCorrelate(
      ["--session", "sess_1", "--transcript", "/t.jsonl"],
      deps,
    );
    expect(code).toBe(0);
    expect(deps.readTranscript).not.toHaveBeenCalled(); // no incidents -> never reads the transcript
    expect(deps.record).not.toHaveBeenCalled();
  });

  it("ignores warn incidents (a warn does not block, so it has no follow-through)", async () => {
    const deps = baseDeps({
      read: jest.fn().mockReturnValue([incidentRow({ decision: "warn" })]),
    });
    const code = await runInternalEnforcementCorrelate(
      ["--session", "sess_1", "--transcript", "/t.jsonl"],
      deps,
    );
    expect(code).toBe(0);
    expect(deps.record).not.toHaveBeenCalled();
  });

  it("does not emit for a pending deny (reaction not yet in the transcript)", async () => {
    const deps = baseDeps({
      readTranscript: jest.fn().mockReturnValue(asstWrite("/repo/notes/x.md")),
    });
    const code = await runInternalEnforcementCorrelate(
      ["--session", "sess_1", "--transcript", "/t.jsonl"],
      deps,
    );
    expect(code).toBe(0);
    expect(deps.record).not.toHaveBeenCalled();
  });

  it("records locally but does not flush when there is no control config", async () => {
    const deps = baseDeps({ readCfg: jest.fn().mockReturnValue(null) });
    const code = await runInternalEnforcementCorrelate(
      ["--session", "sess_1", "--transcript", "/t.jsonl"],
      deps,
    );
    expect(code).toBe(0);
    expect(deps.record).toHaveBeenCalledTimes(1); // the local durable record still happens
    expect(deps.flush).not.toHaveBeenCalled();
  });

  it("mints a run/trace id when the incident is missing one (join key is incident_id)", async () => {
    const deps = baseDeps({
      read: jest.fn().mockReturnValue([incidentRow({ run_id: null, trace_id: null })]),
    });
    await runInternalEnforcementCorrelate(
      ["--session", "sess_1", "--transcript", "/t.jsonl"],
      deps,
    );
    const [ctx] = deps.record.mock.calls[0];
    expect(typeof ctx.runId).toBe("string");
    expect(ctx.runId.length).toBeGreaterThan(0);
    expect(typeof ctx.traceId).toBe("string");
    expect(ctx.traceId.length).toBeGreaterThan(0);
  });

  it("is fail-soft when the transcript is unreadable (exit 0, no emit)", async () => {
    const deps = baseDeps({
      readTranscript: jest.fn(() => {
        throw new Error("ENOENT");
      }),
    });
    const code = await runInternalEnforcementCorrelate(
      ["--session", "sess_1", "--transcript", "/gone.jsonl"],
      deps,
    );
    expect(code).toBe(0);
    expect(deps.record).not.toHaveBeenCalled();
  });

  it("is a soft no-op when required args are missing (exit 0, no emit)", async () => {
    const deps = baseDeps();
    const code = await runInternalEnforcementCorrelate(["--session", "sess_1"], deps);
    expect(code).toBe(0);
    expect(deps.read).not.toHaveBeenCalled();
    expect(deps.record).not.toHaveBeenCalled();
  });

  it("rejects an unknown flag with a strict parse error (exit 2)", async () => {
    const deps = baseDeps();
    const code = await runInternalEnforcementCorrelate(["--bogus"], deps);
    expect(code).toBe(2);
    expect(deps.read).not.toHaveBeenCalled();
  });
});
