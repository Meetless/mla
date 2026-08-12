import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { parseSummaryArgs, runSummary } from "../../src/commands/summary";

// Behavioral lock for `mla summary` (formerly `mla traces summarize`; the
// `show`/`label` subcommands were removed 2026-05-31 because the enrichment
// trace ids are already in ~/.meetless/logs/ask-traces.jsonl and printed on
// every prompt, so Langfuse is the per-trace surface). The trace JSONL is the
// dogfood dataset; this spec proves the summary tallies match the §6.9 example.
// All file I/O is hermetic under a tmp MEETLESS_HOME (the command resolves
// paths lazily from that env var).

function makeTrace(over: Record<string, unknown>): string {
  const base = {
    trace_id: "a".repeat(32),
    ts: "2026-05-28T00:00:00Z",
    surface: "cli_intercept",
    mode: "enrich",
    experiment: { experiment_id: "hotpath_enrichment_v0", variant: "agentic_mission_structured" },
    enrichment: { strategy: "agentic_mission_structured", status: "ok", latency_ms: 18000, cost_usd: 0.14, confidence: "high" },
    arbitration: { decision: "injected", reason: "classifier_inject", discarded_after_compute: false },
    hook: { intercept_latency_ms: 18200, injected: true, injected_chars: 2104, fail_open_reason: null, truncated: false },
    operator_label: { useful: null, noisy: null, harmful: null, prevented_mistake: null, notes: null },
  };
  return JSON.stringify({ ...base, ...over });
}

interface Captured {
  code: number;
  stdout: string;
  stderr: string;
}

async function withHome(
  lines: string[],
  run: (home: string) => Promise<number> | number,
  session?: string,
): Promise<Captured> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mla-summary-"));
  const logs = path.join(home, "logs");
  fs.mkdirSync(logs, { recursive: true });
  if (lines.length) fs.writeFileSync(path.join(logs, "ask-traces.jsonl"), lines.join("\n") + "\n");

  const prevHome = process.env.MEETLESS_HOME;
  process.env.MEETLESS_HOME = home;
  // Control the "current live session" env var the summary auto-scopes to.
  // undefined session => global (var cleared); a string => scoped to it.
  const prevSession = process.env.CLAUDE_CODE_SESSION_ID;
  if (session === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
  else process.env.CLAUDE_CODE_SESSION_ID = session;
  const out: string[] = [];
  const err: string[] = [];
  const logSpy = jest.spyOn(console, "log").mockImplementation((...a) => void out.push(a.join(" ")));
  const errSpy = jest.spyOn(console, "error").mockImplementation((...a) => void err.push(a.join(" ")));
  try {
    const code = await run(home);
    return { code, stdout: out.join("\n"), stderr: err.join("\n") };
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
    if (prevHome === undefined) delete process.env.MEETLESS_HOME;
    else process.env.MEETLESS_HOME = prevHome;
    if (prevSession === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = prevSession;
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
}

describe("mla summary: arg parsing", () => {
  it("defaults to --last 20, no json, not --all", () => {
    expect(parseSummaryArgs([])).toEqual({ last: 20, json: false, all: false });
  });
  it("parses --last N and --json", () => {
    expect(parseSummaryArgs(["--last", "5", "--json"])).toEqual({ last: 5, json: true, all: false });
  });
  it("parses --all", () => {
    expect(parseSummaryArgs(["--all"])).toEqual({ last: 20, json: false, all: true });
  });
  it.each(["0", "-3", "abc", "2.5"])("rejects non-positive-int --last %s", (v) => {
    expect(() => parseSummaryArgs(["--last", v])).toThrow(/positive integer/);
  });
  it("rejects unknown flags", () => {
    expect(() => parseSummaryArgs(["--nope"])).toThrow(/Unknown flag/);
  });
});

describe("mla summary: tallies", () => {
  it("counts inject / discard / fail-open and label buckets per §6.9", async () => {
    const lines = [
      makeTrace({}), // injected, useful set below
      makeTrace({
        arbitration: { decision: "discarded", reason: "classifier_skip_enrichment_lowmed", discarded_after_compute: true },
        enrichment: { strategy: "agentic_mission_structured", status: "ok", latency_ms: 20000, cost_usd: 0.1, confidence: "low" },
        hook: { injected: false, injected_chars: 0, fail_open_reason: null },
        operator_label: { useful: null, noisy: true, harmful: null, prevented_mistake: null, notes: null },
      }),
      makeTrace({
        arbitration: { decision: "fail_open", reason: "enrichment_timeout", discarded_after_compute: false },
        enrichment: { strategy: "agentic_mission_structured", status: "timeout", latency_ms: null, cost_usd: null, confidence: null },
        hook: { injected: false, injected_chars: 0, fail_open_reason: "timeout" },
        operator_label: { useful: null, noisy: null, harmful: true, prevented_mistake: null, notes: null },
      }),
      makeTrace({ operator_label: { useful: true, noisy: null, harmful: null, prevented_mistake: null, notes: null } }),
    ];
    const res = await withHome(lines, () => runSummary(["--json"]));
    expect(res.code).toBe(0);
    const s = JSON.parse(res.stdout);
    expect(s.prompt_count).toBe(4);
    // Was one `injected` counter keyed off arbitration.decision. Split into the two
    // layers it always conflated: the base fixture lands the floor and no evidence.
    expect(s.injected_floor).toBe(2);
    expect(s.injected_evidence).toBe(0);
    expect(s.discarded_after_compute).toBe(1);
    expect(s.fail_open).toBe(1);
    // timeout rate = 1 of 4
    expect(s.timeout_rate).toBeCloseTo(0.25, 5);
    // cost = 0.14 + 0.1 (+ 0.14 from the 4th injected) ; latencies from 3 numeric
    expect(s.total_cost_usd).toBeCloseTo(0.38, 5);
    expect(s.strategies).toEqual({ agentic_mission_structured: 4 });
    expect(s.operator_labels).toEqual({ useful: 1, noisy: 1, harmful: 1, unlabeled: 1 });
    // avg injected chars over the 2 injected (both 2104)
    expect(s.avg_injected_chars).toBe(2104);
  });

  it("honors --last N (only the most recent N lines)", async () => {
    const lines = [
      makeTrace({ arbitration: { decision: "fail_open", discarded_after_compute: false } }),
      makeTrace({}),
      makeTrace({}),
    ];
    const res = await withHome(lines, () => runSummary(["--last", "2", "--json"]));
    const s = JSON.parse(res.stdout);
    expect(s.prompt_count).toBe(2);
    expect(s.fail_open).toBe(0); // the fail_open is the oldest, excluded by --last 2
    expect(s.injected_floor).toBe(2);
  });

  it("skips unparseable lines without crashing", async () => {
    const res = await withHome(["{not json", makeTrace({})], () => runSummary(["--json"]));
    expect(res.code).toBe(0);
    expect(JSON.parse(res.stdout).prompt_count).toBe(1);
  });

  it("renders the plain-text shape with the five §6.9 lines", async () => {
    const res = await withHome([makeTrace({})], () => runSummary([]));
    expect(res.stdout).toMatch(/^Prompt count: 1$/m);
    expect(res.stdout).toMatch(
      /Injected {2}Layer 1 \(floor\): 1 {3}Layer 2 \(evidence\): 0\s+Discarded after compute: 0\s+Fail-open: 0/,
    );
    expect(res.stdout).toMatch(/Avg enrichment latency: 18\.0s\s+P95: 18\.0s\s+Timeout rate: 0%/);
    expect(res.stdout).toMatch(/Total cost: \$0\.14\s+Avg injected chars: 2104\s+Strategies: agentic_mission_structured=1/);
    expect(res.stdout).toMatch(/Operator labels: 0 useful \/ 0 noisy \/ 0 harmful \/ 1 unlabeled/);
  });

  it("returns 1 when there are no traces", async () => {
    const res = await withHome([], () => runSummary([]));
    expect(res.code).toBe(1);
    expect(res.stderr).toMatch(/No traces found/);
  });

  it("returns 2 on a bad flag (parse failure)", async () => {
    const res = await withHome([makeTrace({})], () => runSummary(["--bogus"]));
    expect(res.code).toBe(2);
    expect(res.stderr).toMatch(/Unknown flag/);
  });
});

describe("mla summary: session scoping (auto, no flag)", () => {
  it("auto-scopes to CLAUDE_CODE_SESSION_ID when set", async () => {
    const lines = [
      makeTrace({ session_id: "sess-A" }),
      makeTrace({ session_id: "sess-B" }),
      makeTrace({ session_id: "sess-A" }),
    ];
    const res = await withHome(lines, () => runSummary(["--json"]), "sess-A");
    expect(res.code).toBe(0);
    expect(JSON.parse(res.stdout).prompt_count).toBe(2); // only sess-A
  });

  it("--all overrides the session scope and counts every session", async () => {
    const lines = [makeTrace({ session_id: "sess-A" }), makeTrace({ session_id: "sess-B" })];
    const res = await withHome(lines, () => runSummary(["--all", "--json"]), "sess-A");
    expect(JSON.parse(res.stdout).prompt_count).toBe(2);
  });

  it("counts every session when no CLAUDE_CODE_SESSION_ID is set (global default)", async () => {
    const lines = [makeTrace({ session_id: "sess-A" }), makeTrace({ session_id: "sess-B" })];
    const res = await withHome(lines, () => runSummary(["--json"])); // no session env
    expect(JSON.parse(res.stdout).prompt_count).toBe(2);
  });

  it("scopes BEFORE --last (last N of the current session, not last N overall)", async () => {
    const lines = [
      makeTrace({ session_id: "sess-A" }),
      makeTrace({ session_id: "sess-B" }),
      makeTrace({ session_id: "sess-B" }),
      makeTrace({ session_id: "sess-A" }),
    ];
    const res = await withHome(lines, () => runSummary(["--last", "1", "--json"]), "sess-A");
    // 2 sess-A lines, --last 1 keeps the most recent sess-A line only.
    expect(JSON.parse(res.stdout).prompt_count).toBe(1);
  });

  it("returns 1 with a session-aware message when the current session has no traces", async () => {
    const res = await withHome([makeTrace({ session_id: "sess-B" })], () => runSummary([]), "sess-A");
    expect(res.code).toBe(1);
    expect(res.stderr).toMatch(/session/i);
    expect(res.stderr).toMatch(/--all/);
  });
});

// --- F6: one command said mla did nothing, the other said it injected 19KB ----
//
// Same session, same source file, both shipping:
//   mla summary : "Injected: 0", "Avg injected chars: 0"
//   mla turn    : "injected: 3,796 chars", hook.injected true, injected_chars 3796
//
// summary counted `arbitration.decision === "injected"`, which is true only when
// LAYER 2 drove the injection, and then printed it under the bare label "Injected".
// Every turn in that session was `layer1_only`: the floor landed on all five and
// delivered ~19KB, which is exactly what mla turn was reporting. Neither number was
// wrong; the label was, and an unlabelled counter that reads as "mla did nothing"
// is worse than no counter.
//
// turn-recap.ts already carries the correct field definitions (injected_floor =
// hook.injected, injected_evidence = hook.layer2_injected, injected_chars = total
// delivered). summary now reads THOSE, so the two commands cannot drift again.
describe("mla summary reports the two layers separately, and agrees with mla turn", () => {
  const floorOnly = (over: Record<string, unknown> = {}) =>
    makeTrace({
      arbitration: { decision: "layer1_only", reason: "no_relevant_context", discarded_after_compute: false },
      hook: { intercept_latency_ms: 300, injected: true, layer2_injected: false, injected_chars: 3796, fail_open_reason: null, truncated: false },
      ...over,
    });

  it("does not report zero for a session where the floor injected on every turn", async () => {
    const out = await withHome([floorOnly(), floorOnly(), floorOnly(), floorOnly(), floorOnly()], () => runSummary([]));
    expect(out.code).toBe(0);
    // The old line. It is the whole bug: five turns, ~19KB delivered, "Injected: 0".
    expect(out.stdout).not.toMatch(/(^|\s)Injected: 0(\s|$)/);
    expect(out.stdout).toMatch(/Layer 1 \(floor\): 5/);
    expect(out.stdout).toMatch(/Layer 2 \(evidence\): 0/);
  });

  it("counts layer 2 only when layer 2 actually landed", async () => {
    const withEvidence = makeTrace({
      arbitration: { decision: "injected", reason: "enrichment_driven", discarded_after_compute: false },
      hook: { intercept_latency_ms: 300, injected: true, layer2_injected: true, injected_chars: 5000, fail_open_reason: null, truncated: false },
    });
    const out = await withHome([floorOnly(), withEvidence], () => runSummary([]));
    expect(out.stdout).toMatch(/Layer 1 \(floor\): 2/);
    expect(out.stdout).toMatch(/Layer 2 \(evidence\): 1/);
  });

  it("totals the delivered characters over every turn that injected, not just layer-2 turns", async () => {
    const out = await withHome([floorOnly(), floorOnly()], () => runSummary(["--json"]));
    const parsed = JSON.parse(out.stdout);
    expect(parsed.injected_floor).toBe(2);
    expect(parsed.injected_evidence).toBe(0);
    expect(parsed.total_injected_chars).toBe(3796 * 2);
    expect(parsed.avg_injected_chars).toBe(3796);
  });
});
