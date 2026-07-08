import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// P0.2 MCP trace parity (notes/20260610-session-detail-as-governed-story-design-review.md
// §7.6, §4 P0). The MCP grounding path is an INJECTION surface: an evidence-bearing
// `meetless__*` pull returns cited relationships INTO the turn's context. Without a
// trace, the session-detail "Injected" lane reads empty for an MCP-grounded run even
// though relationships WERE injected, which the page would be lying about (and the
// dogfood session is grounded through exactly this path).
//
// The stateless MCP server has no session identity, but the PostToolUse hook does
// (session_id + the read-only current_turn_index). So the hook is the one place that
// can emit an InjectionTrace-compatible record for the MCP surface, reconciled to the
// run by riding its own session's event stream (same transport as the HOOK producer).
//
// Contract baked in here (mirrors spool_injection_trace in user-prompt-submit.sh):
//   - emit ONLY for an evidence tool (retrieve_knowledge | kb_doc_detail | query)
//     that returned >=1 cited source: a pull with no citation injected nothing;
//   - relationship_verdict is an ACTION (evidence_tool=false) -> never an injection;
//   - the lean §7.6 superset: contextItems are the citation tokens (no kind/status/
//     confidence agentic enrichment), sourceSurface=MCP, deliveryStatus=INJECTED;
//   - the local mcp-calls.jsonl "pull" record is UNCHANGED (the two artifacts coexist).

const HOOKS_DIR = path.resolve(__dirname, "../../src/hooks-template");
const COMMON = path.join(HOOKS_DIR, "common.sh");
const HOOK = "post-tool-use.sh";

interface Harness {
  home: string;
  queueDir: string;
  logsDir: string;
  fire: (input: object) => number;
  mcpCalls: () => any[];
  queueEvents: (sessionId: string) => any[];
  seedTurn: (sessionId: string, n: number) => void;
}

function mkHarness(activate = true): { h: Harness; cleanup: () => void } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mla-mcpit-"));
  fs.copyFileSync(COMMON, path.join(tmp, "common.sh"));
  fs.copyFileSync(path.join(HOOKS_DIR, HOOK), path.join(tmp, HOOK));
  fs.chmodSync(path.join(tmp, HOOK), 0o755);

  const home = path.join(tmp, "home");
  fs.mkdirSync(home);
  fs.writeFileSync(
    path.join(home, "cli-config.json"),
    JSON.stringify({
      controlUrl: "http://127.0.0.1:1",
      controlToken: "x",
      workspaceId: "ws_test",
      mlaPath: "/bin/true",
    }),
  );
  const workdir = path.join(tmp, "workdir");
  fs.mkdirSync(workdir);
  if (activate) fs.writeFileSync(path.join(workdir, ".meetless.json"), "{}\n");

  const queueDir = path.join(home, "queue");
  const logsDir = path.join(home, "logs");

  const readJsonl = (p: string): any[] =>
    fs.existsSync(p)
      ? fs
          .readFileSync(p, "utf8")
          .split("\n")
          .filter((l) => l.trim().length > 0)
          .map((l) => JSON.parse(l))
      : [];

  const h: Harness = {
    home,
    queueDir,
    logsDir,
    fire: (input: object) => {
      const r = spawnSync("bash", [path.join(tmp, HOOK)], {
        input: JSON.stringify(input),
        encoding: "utf8",
        cwd: workdir,
        env: { ...process.env, MEETLESS_HOME: home, MEETLESS_DEBUG: "0" },
      });
      return r.status ?? -1;
    },
    mcpCalls: () => readJsonl(path.join(logsDir, "mcp-calls.jsonl")),
    queueEvents: (sessionId: string) =>
      readJsonl(path.join(queueDir, `${sessionId}.jsonl`)),
    seedTurn: (sessionId: string, n: number) => {
      fs.mkdirSync(queueDir, { recursive: true });
      fs.writeFileSync(path.join(queueDir, `${sessionId}.turn`), String(n));
    },
  };
  return { h, cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}

function mcpInput(opts: {
  sessionId: string;
  tool: string;
  toolInput?: object;
  toolResponse?: unknown;
}) {
  return {
    session_id: opts.sessionId,
    tool_name: opts.tool,
    tool_input: opts.toolInput ?? {},
    tool_response: opts.toolResponse ?? "",
  };
}

function injectionTraces(events: any[]): any[] {
  return events.filter((e) => e.event === "injection_trace");
}

describe("post-tool-use.sh: MCP grounding emits an InjectionTrace (P0.2)", () => {
  beforeAll(() => {
    if (spawnSync("jq", ["--version"]).status !== 0) throw new Error("jq required");
  });

  it("spools a sourceSurface=MCP injection_trace carrying the returned citations", () => {
    const { h, cleanup } = mkHarness();
    try {
      h.seedTurn("sess-1", 3);
      const status = h.fire(
        mcpInput({
          sessionId: "sess-1",
          tool: "mcp__meetless__meetless__query",
          toolInput: { question: "what is the canonical positioning doc" },
          toolResponse:
            "Answer: see [NT:20260608-positioning] and [DD:abc123] for the state machine.",
        }),
      );
      expect(status).toBe(0);

      // The local pull-side record is preserved (no regression).
      expect(h.mcpCalls().length).toBe(1);

      // ... AND a control-bound injection_trace is spooled for the MCP surface.
      const traces = injectionTraces(h.queueEvents("sess-1"));
      expect(traces.length).toBe(1);
      const t = traces[0];
      expect(t.sessionId).toBe("sess-1");
      expect(typeof t.eventKey).toBe("string");
      expect(t.eventKey.length).toBeGreaterThan(0);

      const p = t.payload;
      expect(p.sourceSurface).toBe("MCP");
      expect(p.deliveryStatus).toBe("INJECTED");
      expect(p.turnIndex).toBe(3);
      expect(p.schemaVersion).toBe(1);
      // injectId and traceId are both required, non-empty (the control parser
      // rejects a trace missing either): minted from the same per-call key.
      expect(typeof p.injectId).toBe("string");
      expect(p.injectId.length).toBeGreaterThan(0);
      expect(typeof p.traceId).toBe("string");
      expect(p.traceId.length).toBeGreaterThan(0);

      // The lean §7.6 shape: contextItems are the citation tokens the grounding
      // returned, each flagged injected so the Injected lane renders them.
      const sids = p.contextItems.map((it: any) => it.source_id);
      expect(sids).toEqual(
        expect.arrayContaining(["NT:20260608-positioning", "DD:abc123"]),
      );
      expect(p.contextItems.every((it: any) => it.injected === true)).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("does NOT spool an injection_trace when the pull returned no citations", () => {
    const { h, cleanup } = mkHarness();
    try {
      h.seedTurn("sess-2", 1);
      h.fire(
        mcpInput({
          sessionId: "sess-2",
          tool: "mcp__meetless__meetless__retrieve_knowledge",
          toolInput: { query: "something with no governed evidence" },
          toolResponse: "No relevant knowledge found.",
        }),
      );
      // The pull is still recorded locally (source_ids empty), but nothing was
      // injected, so there is no InjectionTrace to claim.
      expect(h.mcpCalls()[0].source_ids).toEqual([]);
      expect(injectionTraces(h.queueEvents("sess-2"))).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it("does NOT treat relationship_verdict (an ACTION) as an injection", () => {
    const { h, cleanup } = mkHarness();
    try {
      h.seedTurn("sess-3", 2);
      h.fire(
        mcpInput({
          sessionId: "sess-3",
          tool: "mcp__meetless__meetless__relationship_verdict",
          // a citation-shaped token in the args must NOT make a verdict an injection
          toolInput: { candidate_id: "rc_1", verdict: "reject", note: "[NT:foo]" },
          toolResponse: "ok",
        }),
      );
      expect(h.mcpCalls()[0].evidence_tool).toBe(false);
      expect(injectionTraces(h.queueEvents("sess-3"))).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it("traces a kb_doc_detail pull from the cited input doc", () => {
    const { h, cleanup } = mkHarness();
    try {
      h.seedTurn("sess-4", 4);
      h.fire(
        mcpInput({
          sessionId: "sess-4",
          tool: "mcp__meetless__meetless__kb_doc_detail",
          toolInput: { citation: "NT:20260531-kb-command-living-guide" },
          toolResponse: { content: "full doc body with no inline citation token" },
        }),
      );
      const traces = injectionTraces(h.queueEvents("sess-4"));
      expect(traces.length).toBe(1);
      expect(traces[0].payload.sourceSurface).toBe("MCP");
      expect(traces[0].payload.contextItems.map((it: any) => it.source_id)).toContain(
        "NT:20260531-kb-command-living-guide",
      );
    } finally {
      cleanup();
    }
  });

  it("stays DORMANT (no trace) when the folder is not activated", () => {
    const { h, cleanup } = mkHarness(false);
    try {
      h.seedTurn("sess-5", 1);
      h.fire(
        mcpInput({
          sessionId: "sess-5",
          tool: "mcp__meetless__meetless__query",
          toolInput: { question: "x" },
          toolResponse: "[NT:foo]",
        }),
      );
      expect(injectionTraces(h.queueEvents("sess-5"))).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it("drift guard: post-tool-use.sh keeps the MCP injection_trace emission", () => {
    const src = fs.readFileSync(path.join(HOOKS_DIR, HOOK), "utf8");
    expect(src).toContain("injection_trace");
    expect(src).toMatch(/sourceSurface:\s*"MCP"/);
  });
});
