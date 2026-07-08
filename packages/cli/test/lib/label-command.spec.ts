import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { parseLabelArgs, runLabel } from "../../src/commands/label";

// Behavioral lock for `mla label` (A3, the operator-label affordance from
// notes/20260603-mla-kb-agent-proxy-and-evidence-adoption.md §3/§7.2). It writes
// the reserved `operator_label` block back into a trace line in
// ~/.meetless/logs/ask-traces.jsonl so An can mark a handful of enrichments
// useful / noisy / harmful / prevented-a-mistake. That hand-labeled block is the
// ground-truth anchor the composite needs before any weight tuning, AND the
// `harmful` field is exactly what the A5 carry-forward hook reads to suppress a
// re-surface, so this write side closes the loop with carry-forward.spec.ts.
//
// All I/O is hermetic under a tmp MEETLESS_HOME (the command resolves paths
// lazily from that env var, same as `mla summary`).

interface LabelOver {
  trace_id?: string;
  session_id?: string;
  operator_label?: Record<string, unknown> | null;
}

function makeTrace(over: LabelOver): string {
  const base = {
    trace_id: "a".repeat(32),
    ts: "2026-06-04T00:00:00Z",
    session_id: "sess-A",
    surface: "cli_intercept",
    enrichment: { strategy: "agentic_mission_structured", status: "ok", latency_ms: 18000 },
    arbitration: { decision: "injected" },
    hook: { injected: true },
    operator_label: { useful: null, noisy: null, harmful: null, prevented_mistake: null, notes: null },
  };
  return JSON.stringify({ ...base, ...over });
}

interface Captured {
  code: number;
  stdout: string;
  stderr: string;
  home: string;
  lines: () => string[];
}

async function withHome(
  lines: string[],
  run: (home: string) => Promise<number> | number,
  session?: string,
): Promise<Captured> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mla-label-"));
  const logs = path.join(home, "logs");
  fs.mkdirSync(logs, { recursive: true });
  const file = path.join(logs, "ask-traces.jsonl");
  if (lines.length) fs.writeFileSync(file, lines.join("\n") + "\n");

  const prevHome = process.env.MEETLESS_HOME;
  process.env.MEETLESS_HOME = home;
  const prevSession = process.env.CLAUDE_CODE_SESSION_ID;
  if (session === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
  else process.env.CLAUDE_CODE_SESSION_ID = session;

  const out: string[] = [];
  const err: string[] = [];
  const logSpy = jest.spyOn(console, "log").mockImplementation((...a) => void out.push(a.join(" ")));
  const errSpy = jest.spyOn(console, "error").mockImplementation((...a) => void err.push(a.join(" ")));
  try {
    const code = await run(home);
    // Capture the file EAGERLY, before the finally block deletes the temp dir,
    // so the read-back is not racing cleanup.
    const after = fs.existsSync(file)
      ? fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim().length > 0)
      : [];
    return {
      code,
      stdout: out.join("\n"),
      stderr: err.join("\n"),
      home,
      lines: () => after,
    };
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
    if (prevHome === undefined) delete process.env.MEETLESS_HOME;
    else process.env.MEETLESS_HOME = prevHome;
    if (prevSession === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = prevSession;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

describe("mla label: arg parsing", () => {
  it("parses a single verdict with no trace_id (default-to-session selector)", () => {
    expect(parseLabelArgs(["--useful"])).toEqual({ traceId: null, patch: { useful: true } });
  });

  it("parses an explicit trace_id plus multiple verdicts and a note", () => {
    expect(parseLabelArgs(["abc123", "--noisy", "--note", "too much"])).toEqual({
      traceId: "abc123",
      patch: { noisy: true, notes: "too much" },
    });
  });

  it("parses --prevented-mistake and --harmful", () => {
    expect(parseLabelArgs(["--harmful", "--prevented-mistake"])).toEqual({
      traceId: null,
      patch: { harmful: true, prevented_mistake: true },
    });
  });

  it("requires at least one verdict (bare trace_id is not enough)", () => {
    expect(() => parseLabelArgs(["abc123"])).toThrow(/at least one/i);
  });

  it("requires at least one verdict (empty argv)", () => {
    expect(() => parseLabelArgs([])).toThrow(/at least one/i);
  });

  it("rejects --note without a value", () => {
    expect(() => parseLabelArgs(["--note"])).toThrow(/--note requires a value/);
  });

  it("rejects unknown flags", () => {
    expect(() => parseLabelArgs(["--bogus"])).toThrow(/Unknown flag/);
  });

  it("rejects a second positional argument", () => {
    expect(() => parseLabelArgs(["id1", "id2", "--useful"])).toThrow(/extra argument/i);
  });
});

describe("mla label: explicit trace_id", () => {
  it("sets the patched fields and preserves the unspecified ones", async () => {
    const tid = "b".repeat(32);
    const lines = [
      makeTrace({ trace_id: tid, operator_label: { useful: null, noisy: null, harmful: null, prevented_mistake: null, notes: "pre-existing" } }),
    ];
    const res = await withHome(lines, () => runLabel([tid, "--useful"]));
    expect(res.code).toBe(0);
    const after = JSON.parse(res.lines()[0]);
    expect(after.operator_label.useful).toBe(true);
    // Unspecified fields are preserved, not clobbered.
    expect(after.operator_label.notes).toBe("pre-existing");
    expect(after.operator_label.harmful).toBeNull();
    // Non-label fields survive the rewrite.
    expect(after.trace_id).toBe(tid);
    expect(after.enrichment.strategy).toBe("agentic_mission_structured");
  });

  it("returns 1 when the trace_id is not found", async () => {
    const res = await withHome([makeTrace({ trace_id: "a".repeat(32) })], () => runLabel(["does-not-exist", "--noisy"]));
    expect(res.code).toBe(1);
    expect(res.stderr).toMatch(/not found/i);
  });

  it("leaves every other line byte-intact and valid JSON (atomic rewrite)", async () => {
    const t1 = makeTrace({ trace_id: "1".repeat(32), session_id: "sess-A" });
    const t2 = makeTrace({ trace_id: "2".repeat(32), session_id: "sess-B" });
    const t3 = makeTrace({ trace_id: "3".repeat(32), session_id: "sess-A" });
    const res = await withHome([t1, t2, t3], () => runLabel(["2".repeat(32), "--harmful"]));
    expect(res.code).toBe(0);
    const after = res.lines();
    expect(after).toHaveLength(3);
    // Untouched lines are returned verbatim (same string).
    expect(after[0]).toBe(t1);
    expect(after[2]).toBe(t3);
    // The targeted line is now harmful and still valid JSON.
    expect(JSON.parse(after[1]).operator_label.harmful).toBe(true);
    // The whole file remains parseable line-by-line.
    for (const l of after) expect(() => JSON.parse(l)).not.toThrow();
  });
});

describe("mla label: default-to-latest-in-session selector", () => {
  it("labels the most recent trace in CLAUDE_CODE_SESSION_ID when no trace_id is given", async () => {
    const a1 = makeTrace({ trace_id: "1".repeat(32), session_id: "sess-A" });
    const b1 = makeTrace({ trace_id: "2".repeat(32), session_id: "sess-B" });
    const a2 = makeTrace({ trace_id: "3".repeat(32), session_id: "sess-A" });
    const res = await withHome([a1, b1, a2], () => runLabel(["--noisy"]), "sess-A");
    expect(res.code).toBe(0);
    const after = res.lines();
    // The LATEST sess-A line (a2) is labeled; the earlier sess-A line (a1) is not.
    expect(JSON.parse(after[0]).operator_label.noisy).toBeNull();
    expect(JSON.parse(after[2]).operator_label.noisy).toBe(true);
    // The other session is untouched.
    expect(after[1]).toBe(b1);
  });

  it("returns 2 when no trace_id is given and there is no current session", async () => {
    const res = await withHome([makeTrace({})], () => runLabel(["--useful"])); // no session env
    expect(res.code).toBe(2);
    expect(res.stderr).toMatch(/session/i);
    expect(res.stderr).toMatch(/trace_id/i);
  });

  it("returns 1 when the current session has no traces", async () => {
    const res = await withHome([makeTrace({ session_id: "sess-B" })], () => runLabel(["--useful"]), "sess-A");
    expect(res.code).toBe(1);
    expect(res.stderr).toMatch(/session/i);
  });
});

describe("mla label: edge + A5 tie-in", () => {
  it("returns 1 when there are no traces at all", async () => {
    const res = await withHome([], () => runLabel(["--useful"]), "sess-A");
    expect(res.code).toBe(1);
    expect(res.stderr).toMatch(/No traces/i);
  });

  it("returns 2 on a parse failure (no verdict)", async () => {
    const res = await withHome([makeTrace({})], () => runLabel(["abc"]), "sess-A");
    expect(res.code).toBe(2);
    expect(res.stderr).toMatch(/at least one/i);
  });

  it("a --harmful label writes operator_label.harmful=true, the exact field A5 reads to suppress carry", async () => {
    const tid = "c".repeat(32);
    const res = await withHome([makeTrace({ trace_id: tid })], () => runLabel([tid, "--harmful"]));
    expect(res.code).toBe(0);
    expect(JSON.parse(res.lines()[0]).operator_label.harmful).toBe(true);
  });

  it("merges across repeated labelings (additive, last write wins per field)", async () => {
    const tid = "d".repeat(32);
    const first = await withHome([makeTrace({ trace_id: tid })], (home) => {
      // First labeling sets useful.
      const code = runLabel([tid, "--useful"]);
      // Second labeling, against the rewritten file, adds a note.
      void home;
      return code === 0 ? runLabel([tid, "--note", "good catch"]) : code;
    });
    expect(first.code).toBe(0);
    const ol = JSON.parse(first.lines()[0]).operator_label;
    expect(ol.useful).toBe(true);
    expect(ol.notes).toBe("good catch");
  });

  it("prints a confirmation naming the merged label state", async () => {
    const tid = "e".repeat(32);
    const res = await withHome([makeTrace({ trace_id: tid })], () => runLabel([tid, "--useful", "--note", "nice"]));
    expect(res.code).toBe(0);
    expect(res.stdout).toMatch(/useful/);
    expect(res.stdout).toMatch(/nice/);
  });
});
