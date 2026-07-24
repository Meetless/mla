import {
  latestTurnIndex,
  parseTurnArgs,
  runTurn,
  type TurnCmdDeps,
} from "../../src/commands/turn";
import type { TurnRecap } from "../../src/lib/analytics/turn-recap";

// `mla turn [N]` (Layer B operator surface): the cheap, always-available "how did
// mla do?" read. No arg -> latest completed turn for the current session; N -> that
// turn; --session targets another; --json for tooling.

type Line = Record<string, unknown>;

function ask(session: string, turn: number): Line {
  return { session_id: session, turn_index: turn, hook: { injected: true } };
}
function mcp(session: string, turn: number): Line {
  return { session_id: session, turn_index: turn, tool: "retrieve_knowledge", evidence_tool: true, source_ids: [] };
}
function cite(session: string, turn: number): Line {
  return { session_id: session, turn_index: turn, source_ids: [] };
}

function readLogFrom(files: Record<string, Line[]>) {
  return (file: string): Line[] => files[file] ?? [];
}

function recap(over: Partial<TurnRecap> = {}): TurnRecap {
  return {
    session_id: "s1",
    turn_index: 4,
    trace_id: "a".repeat(32),
    ran: true,
    injected_floor: true,
    injected_evidence: true,
    not_run_reason: null,
    enrich_latency_ms: 300,
    evidence_offered: true,
    offered_source_ids: ["NT:a.md"],
    zero_results: false,
    coverage_gap_type: null,
    evidence_layer_down: false,
    retrieved_count: null,
    selected_count: null,
    abstain_class: null,
    evidence_tools_pulled: ["retrieve_knowledge"],
    pull_count: 1,
    referenced_source_ids: ["NT:a.md"],
    cited_source_ids: [],
    verdict: "USED",
    ...over,
  };
}

function run(argv: string[], deps: TurnCmdDeps = {}) {
  const out: string[] = [];
  const errs: string[] = [];
  const merged: TurnCmdDeps = {
    log: (l) => out.push(l),
    err: (l) => errs.push(l),
    env: {},
    ...deps,
  };
  return runTurn(argv, merged).then((code) => ({ code, out: out.join("\n"), err: errs.join("\n") }));
}

describe("parseTurnArgs", () => {
  it("defaults: latest turn for the current session, human output", () => {
    expect(parseTurnArgs([])).toEqual({ session: null, turn: null, json: false });
  });

  it("a positional is the turn index", () => {
    expect(parseTurnArgs(["5"])).toEqual({ session: null, turn: 5, json: false });
  });

  it("honors --session and --json in any order around the positional", () => {
    expect(parseTurnArgs(["--session", "sX", "7", "--json"])).toEqual({ session: "sX", turn: 7, json: true });
    expect(parseTurnArgs(["--json", "--session", "sX", "7"])).toEqual({ session: "sX", turn: 7, json: true });
  });

  it.each(["0", "-1", "abc", "1.5"])("rejects a non-positive-integer turn %s", (v) => {
    expect(() => parseTurnArgs([v])).toThrow(/positive integer/);
  });

  it("rejects a second positional", () => {
    expect(() => parseTurnArgs(["3", "4"])).toThrow(/one turn/i);
  });

  it("rejects an unknown flag", () => {
    expect(() => parseTurnArgs(["--bogus"])).toThrow(/Unknown flag/);
  });
});

describe("latestTurnIndex", () => {
  it("returns the max turn_index across all three spool files for the session", () => {
    const readLog = readLogFrom({
      "ask-traces.jsonl": [ask("s1", 1), ask("s1", 2)],
      "mcp-calls.jsonl": [mcp("s1", 3)],
      "report-citations.jsonl": [cite("s1", 2)],
    });
    expect(latestTurnIndex("s1", readLog)).toBe(3);
  });

  it("is scoped to the session (ignores other sessions)", () => {
    const readLog = readLogFrom({
      "ask-traces.jsonl": [ask("s1", 2), ask("s2", 9)],
    });
    expect(latestTurnIndex("s1", readLog)).toBe(2);
  });

  it("returns null when the session has no turns on disk", () => {
    const readLog = readLogFrom({ "ask-traces.jsonl": [ask("other", 1)] });
    expect(latestTurnIndex("s1", readLog)).toBeNull();
  });
});

describe("runTurn", () => {
  it("with no arg, recaps the latest completed turn for the current session", async () => {
    const seen: number[] = [];
    const r = await run([], {
      env: { CLAUDE_CODE_SESSION_ID: "s1" },
      readLog: readLogFrom({ "ask-traces.jsonl": [ask("s1", 1), ask("s1", 6)] }),
      compute: (s, t) => {
        seen.push(t);
        return recap({ session_id: s, turn_index: t });
      },
    });
    expect(r.code).toBe(0);
    expect(seen).toEqual([6]);
    expect(r.out).toMatch(/turn 6 recap/);
  });

  it("with N, recaps that turn", async () => {
    const seen: number[] = [];
    const r = await run(["3"], {
      env: { CLAUDE_CODE_SESSION_ID: "s1" },
      compute: (s, t) => {
        seen.push(t);
        return recap({ session_id: s, turn_index: t });
      },
    });
    expect(r.code).toBe(0);
    expect(seen).toEqual([3]);
  });

  it("--session targets another session", async () => {
    const seen: string[] = [];
    await run(["2", "--session", "sOther"], {
      env: { CLAUDE_CODE_SESSION_ID: "s1" },
      compute: (s) => {
        seen.push(s);
        return recap({ session_id: s });
      },
    });
    expect(seen).toEqual(["sOther"]);
  });

  it("--json prints the full TurnRecap", async () => {
    const r = await run(["4", "--json"], {
      env: { CLAUDE_CODE_SESSION_ID: "s1" },
      compute: () => recap(),
    });
    const obj = JSON.parse(r.out);
    expect(obj.verdict).toBe("USED");
    expect(obj.turn_index).toBe(4);
  });

  it("no session at all -> exit 1 with a clear pointer, no recap", async () => {
    const computed: number[] = [];
    const r = await run([], { env: {}, compute: (_s, t) => (computed.push(t), recap()) });
    expect(r.code).toBe(1);
    expect(computed).toEqual([]);
    expect(r.err).toMatch(/session/i);
  });

  it("session with no turns yet -> exit 0 with a friendly note, no throw", async () => {
    const r = await run([], {
      env: { CLAUDE_CODE_SESSION_ID: "s1" },
      readLog: readLogFrom({}),
      compute: () => recap(),
    });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/no turns/i);
  });

  it("a bad argv exits 2", async () => {
    const r = await run(["--bogus"], { env: { CLAUDE_CODE_SESSION_ID: "s1" } });
    expect(r.code).toBe(2);
  });
});
