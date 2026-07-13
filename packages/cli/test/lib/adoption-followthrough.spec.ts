import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { COMMANDS } from "../../src/cli";
import {
  computeFollowthrough,
  buildAdoption,
  parseAdoptionArgs,
  runAdoption,
  type InjectTurn,
  type McpCall,
  type ReportCitation,
} from "../../src/commands/adoption";
import { renderUsage, resolveCommand } from "../../src/lib/command-registry";

// A1 evidence-followthrough reader (notes/20260603-mla-kb-agent-proxy §3 A1,
// §7.2 backlog "A1", §7.4 acceptance). A1 joins three LOCAL trace files by
// (session_id, turn_index):
//   - ask-traces.jsonl       (inject side: what we injected, P0)
//   - mcp-calls.jsonl        (pull side: what the agent pulled, P1)
//   - report-citations.jsonl (push-reference side: what the report cited, P3)
// and scores each high-value inject turn:
//   A1a pull_followthrough          -- agent PULLED an overlapping source_id via
//                                      an EVIDENCE tool, same / immediate-child turn
//   A1b push_reference_followthrough -- the final report CITED an injected source_id
//   A1c evidence_followthrough_any   -- A1a OR A1b (the headline "are we useless" number)
// relationship_verdict is an ACTION (evidence_tool=false) and is never a Pull.

describe("computeFollowthrough: A1 join (the four §7.4 acceptance cases)", () => {
  const inj = (
    session_id: string,
    turn_index: number,
    ids: string[],
  ): InjectTurn => ({ session_id, turn_index, injected_source_ids: ids });
  const call = (
    session_id: string,
    turn_index: number,
    evidence_tool: boolean,
    source_ids: string[],
    query = "",
  ): McpCall => ({ session_id, turn_index, evidence_tool, source_ids, query });
  const cite = (
    session_id: string,
    turn_index: number,
    source_ids: string[],
  ): ReportCitation => ({ session_id, turn_index, source_ids });

  it("(1) inject + Pull of an overlapping source_id same session/turn -> A1a true, A1c true", () => {
    const rows = computeFollowthrough(
      [inj("s1", 1, ["NT:doc-a.md"])],
      [call("s1", 1, true, ["NT:doc-a.md"])],
      [],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].a1a_pull).toBe(true);
    expect(rows[0].a1b_push_reference).toBe(false);
    expect(rows[0].a1c_any).toBe(true);
    expect(rows[0].pulled_overlap).toContain("NT:doc-a.md");
  });

  it("(2) inject + a Pull in an UNRELATED domain -> A1a false (no false positive)", () => {
    const rows = computeFollowthrough(
      [inj("s1", 1, ["NT:doc-a.md"])],
      [call("s1", 1, true, ["NT:something-else.md"], "how does billing work")],
      [],
    );
    expect(rows[0].a1a_pull).toBe(false);
    expect(rows[0].a1c_any).toBe(false);
  });

  it("(3) inject + report cites the injected source_id with NO Pull -> A1b true, A1c true (no false negative)", () => {
    const rows = computeFollowthrough(
      [inj("s1", 1, ["NT:doc-a.md"])],
      [],
      // The report writes the bare id (no .md); normalization must still match.
      [cite("s1", 1, ["NT:doc-a"])],
    );
    expect(rows[0].a1a_pull).toBe(false);
    expect(rows[0].a1b_push_reference).toBe(true);
    expect(rows[0].a1c_any).toBe(true);
    expect(rows[0].cited_overlap).toContain("NT:doc-a.md");
  });

  it("(4) inject + relationship_verdict only -> A1a false (an action is not an evidence Pull)", () => {
    // The verdict call may even carry the injected id as its citation arg, but
    // because evidence_tool=false it must NOT count as a Pull.
    const rows = computeFollowthrough(
      [inj("s1", 1, ["NT:doc-a.md"])],
      [call("s1", 1, false, ["NT:doc-a.md"], "")],
      [],
    );
    expect(rows[0].a1a_pull).toBe(false);
    expect(rows[0].a1c_any).toBe(false);
  });

  it("counts a Pull on the IMMEDIATE CHILD turn (N+1) within the default window", () => {
    const rows = computeFollowthrough(
      [inj("s1", 1, ["NT:doc-a.md"])],
      [call("s1", 2, true, ["NT:doc-a.md"])],
      [],
    );
    expect(rows[0].a1a_pull).toBe(true);
  });

  it("does NOT count a Pull two turns later (outside the default window)", () => {
    const rows = computeFollowthrough(
      [inj("s1", 1, ["NT:doc-a.md"])],
      [call("s1", 3, true, ["NT:doc-a.md"])],
      [],
    );
    expect(rows[0].a1a_pull).toBe(false);
  });

  it("does NOT join across sessions (same turn, different session)", () => {
    const rows = computeFollowthrough(
      [inj("s1", 1, ["NT:doc-a.md"])],
      [call("s2", 1, true, ["NT:doc-a.md"])],
      [cite("s2", 1, ["NT:doc-a.md"])],
    );
    expect(rows[0].a1a_pull).toBe(false);
    expect(rows[0].a1b_push_reference).toBe(false);
    expect(rows[0].a1c_any).toBe(false);
  });

  it("normalizes ids (trailing .md, case) on both sides of the overlap", () => {
    const rows = computeFollowthrough(
      [inj("s1", 1, ["NT:Doc-A.MD"])],
      [call("s1", 1, true, ["nt:doc-a"])],
      [],
    );
    expect(rows[0].a1a_pull).toBe(true);
  });

  it("scores push-reference on the child turn too (report lands on N+1)", () => {
    const rows = computeFollowthrough(
      [inj("s1", 1, ["NT:doc-a.md"])],
      [],
      [cite("s1", 2, ["NT:doc-a.md"])],
    );
    expect(rows[0].a1b_push_reference).toBe(true);
  });
});

describe("buildAdoption: aggregate rates", () => {
  it("counts inject turns and A1a/A1b/A1c with rates", () => {
    const rows = computeFollowthrough(
      [
        { session_id: "s1", turn_index: 1, injected_source_ids: ["NT:a.md"] }, // a1a
        { session_id: "s1", turn_index: 3, injected_source_ids: ["NT:b.md"] }, // a1b
        { session_id: "s1", turn_index: 5, injected_source_ids: ["NT:c.md"] }, // neither
        { session_id: "s1", turn_index: 7, injected_source_ids: ["NT:d.md"] }, // both
      ],
      [
        { session_id: "s1", turn_index: 1, evidence_tool: true, source_ids: ["NT:a.md"], query: "" },
        { session_id: "s1", turn_index: 7, evidence_tool: true, source_ids: ["NT:d.md"], query: "" },
      ],
      [
        { session_id: "s1", turn_index: 3, source_ids: ["NT:b.md"] },
        { session_id: "s1", turn_index: 7, source_ids: ["NT:d.md"] },
      ],
    );
    const agg = buildAdoption(rows);
    expect(agg.inject_turns).toBe(4);
    expect(agg.a1a_pull).toBe(2); // turns 1 and 7
    expect(agg.a1b_push_reference).toBe(2); // turns 3 and 7
    expect(agg.a1c_any).toBe(3); // turns 1, 3, 7 (turn 5 = neither)
    expect(agg.no_followthrough).toBe(1);
    expect(agg.a1c_rate).toBeCloseTo(0.75, 5);
  });

  it("zero inject turns -> zero rates, no divide-by-zero", () => {
    const agg = buildAdoption([]);
    expect(agg.inject_turns).toBe(0);
    expect(agg.a1c_rate).toBe(0);
  });
});

describe("parseAdoptionArgs", () => {
  it("defaults to --last 50, no json, not --all, window 1", () => {
    expect(parseAdoptionArgs([])).toEqual({ last: 50, json: false, all: false, window: 1 });
  });
  it("parses --last, --json, --all, --window", () => {
    expect(parseAdoptionArgs(["--last", "10", "--json", "--all", "--window", "2"])).toEqual({
      last: 10,
      json: true,
      all: true,
      window: 2,
    });
  });
  it.each(["0", "-1", "x", "1.5"])("rejects bad --last %s", (v) => {
    expect(() => parseAdoptionArgs(["--last", v])).toThrow(/positive integer/);
  });
  it("rejects a negative --window", () => {
    expect(() => parseAdoptionArgs(["--window", "-1"])).toThrow(/non-negative integer/);
  });
  it("rejects unknown flags", () => {
    expect(() => parseAdoptionArgs(["--nope"])).toThrow(/Unknown flag/);
  });
});

// --- integration: runAdoption reading the three local files ----------------

interface Captured {
  code: number;
  stdout: string;
  stderr: string;
}

function injectTrace(session_id: string, turn_index: number, sourceIds: string[]): string {
  return JSON.stringify({
    trace_id: "a".repeat(32),
    ts: "2026-06-04T00:00:00Z",
    session_id,
    turn_index,
    surface: "cli_intercept",
    mode: "enrich",
    arbitration: { decision: "injected", reason: "enrichment_driven" },
    enrichment: {
      status: "ok",
      context_items: sourceIds.map((sid, i) => ({
        id: `ctx_${i + 1}`,
        kind: "architecture_constraint",
        source_id: sid,
        provenance: "derived_from_accepted_kb",
        status: "accepted",
        text: "...",
        injected: true,
      })),
    },
    hook: { injected: true, layer2_injected: true },
  });
}

function mcpCall(
  session_id: string,
  turn_index: number,
  tool: string,
  evidence_tool: boolean,
  source_ids: string[],
): string {
  return JSON.stringify({
    ts: "2026-06-04T00:00:01Z",
    event: "tool_used_mcp",
    session_id,
    turn_index,
    tool,
    evidence_tool,
    query: "",
    source_ids,
  });
}

function reportCite(session_id: string, turn_index: number, source_ids: string[]): string {
  return JSON.stringify({
    ts: "2026-06-04T00:00:02Z",
    event: "report_citations",
    session_id,
    turn_index,
    source_ids,
  });
}

async function withHome(
  files: { traces?: string[]; mcp?: string[]; reports?: string[] },
  run: () => Promise<number> | number,
  session?: string,
): Promise<Captured> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mla-adoption-"));
  const logs = path.join(home, "logs");
  fs.mkdirSync(logs, { recursive: true });
  const w = (name: string, lines?: string[]) => {
    if (lines && lines.length) fs.writeFileSync(path.join(logs, name), lines.join("\n") + "\n");
  };
  w("ask-traces.jsonl", files.traces);
  w("mcp-calls.jsonl", files.mcp);
  w("report-citations.jsonl", files.reports);

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
    const code = await run();
    return { code, stdout: out.join("\n"), stderr: err.join("\n") };
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

describe("runAdoption: end-to-end over the three local files", () => {
  it("joins inject/pull/report and reports A1a/A1b/A1c (--json)", async () => {
    const res = await withHome(
      {
        traces: [
          injectTrace("s1", 1, ["NT:doc-a.md"]), // pull -> a1a
          injectTrace("s1", 3, ["NT:doc-b.md"]), // report cite -> a1b
          injectTrace("s1", 5, ["NT:doc-c.md"]), // neither
        ],
        mcp: [mcpCall("s1", 1, "retrieve_knowledge", true, ["NT:doc-a.md"])],
        reports: [reportCite("s1", 3, ["NT:doc-b"])],
      },
      () => runAdoption(["--json"]),
    );
    expect(res.code).toBe(0);
    const agg = JSON.parse(res.stdout);
    expect(agg.inject_turns).toBe(3);
    expect(agg.a1a_pull).toBe(1);
    expect(agg.a1b_push_reference).toBe(1);
    expect(agg.a1c_any).toBe(2);
    expect(agg.no_followthrough).toBe(1);
  });

  it("excludes relationship_verdict from Pull (evidence_tool=false in the log)", async () => {
    const res = await withHome(
      {
        traces: [injectTrace("s1", 1, ["NT:doc-a.md"])],
        mcp: [mcpCall("s1", 1, "relationship_verdict", false, ["NT:doc-a.md"])],
      },
      () => runAdoption(["--json"]),
    );
    const agg = JSON.parse(res.stdout);
    expect(agg.a1a_pull).toBe(0);
    expect(agg.a1c_any).toBe(0);
  });

  it("auto-scopes to CLAUDE_CODE_SESSION_ID; --all opts out", async () => {
    const files = {
      traces: [injectTrace("sA", 1, ["NT:x.md"]), injectTrace("sB", 1, ["NT:y.md"])],
      mcp: [mcpCall("sA", 1, "retrieve_knowledge", true, ["NT:x.md"])],
    };
    const scoped = await withHome(files, () => runAdoption(["--json"]), "sA");
    expect(JSON.parse(scoped.stdout).inject_turns).toBe(1);
    const all = await withHome(files, () => runAdoption(["--all", "--json"]), "sA");
    expect(JSON.parse(all.stdout).inject_turns).toBe(2);
  });

  it("renders the plain headline shape", async () => {
    const res = await withHome(
      {
        traces: [injectTrace("s1", 1, ["NT:doc-a.md"])],
        mcp: [mcpCall("s1", 1, "retrieve_knowledge", true, ["NT:doc-a.md"])],
      },
      () => runAdoption([]),
    );
    expect(res.code).toBe(0);
    expect(res.stdout).toMatch(/Evidence-followthrough/);
    expect(res.stdout).toMatch(/A1c/);
    expect(res.stdout).toMatch(/A1a/);
    expect(res.stdout).toMatch(/A1b/);
  });

  it("returns 1 when there are no inject turns to score", async () => {
    const res = await withHome({}, () => runAdoption([]));
    expect(res.code).toBe(1);
    expect(res.stderr).toMatch(/inject/i);
  });

  it("ignores a trace whose context_items were not injected", async () => {
    const notInjected = JSON.stringify({
      session_id: "s1",
      turn_index: 1,
      arbitration: { decision: "layer1_only" },
      enrichment: {
        context_items: [{ id: "ctx_1", source_id: "NT:doc-a.md", injected: false }],
      },
      hook: { injected: true, layer2_injected: false },
    });
    const res = await withHome({ traces: [notInjected] }, () => runAdoption(["--json"]));
    expect(res.code).toBe(1); // no high-value inject turns
  });

  it("skips unparseable lines in any of the three files", async () => {
    const res = await withHome(
      {
        traces: ["{bad", injectTrace("s1", 1, ["NT:doc-a.md"])],
        mcp: ["not json", mcpCall("s1", 1, "retrieve_knowledge", true, ["NT:doc-a.md"])],
        reports: ["{also bad"],
      },
      () => runAdoption(["--json"]),
    );
    expect(res.code).toBe(0);
    expect(JSON.parse(res.stdout).a1a_pull).toBe(1);
  });
});

describe("drift guard: adoption command is wired", () => {
  // The registry is BOTH the dispatch table and the help screen, so this guard
  // asserts the live objects rather than scraping cli.ts for a `case "adoption"`
  // arm (which no longer exists). If `adoption` were dropped from COMMANDS it
  // would become simultaneously undispatchable and undocumented, and both halves
  // below would fail.
  it("the registry dispatches 'adoption' and documents it on the help screen", () => {
    expect(resolveCommand(COMMANDS, "adoption")).toBeDefined();
    expect(renderUsage(COMMANDS)).toContain("mla adoption");
  });

  it("'adoption' routes through the same runStats -> runAdoption path as `stats evidence`", () => {
    const spec = resolveCommand(COMMANDS, "adoption");
    // INV-ADOPTION-SOURCE-1: one implementation, two entry points.
    expect(String(spec?.handler)).toContain("evidence");
  });
});
