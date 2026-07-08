import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// P1 (notes/20260603-mla-kb-agent-proxy §7.1 P1, §7.2 backlog "P1*"; blocks A1):
// the PostToolUse hook must capture the agent's OWN `meetless__*` MCP calls per
// turn, keyed by (session_id, turn_index), so A1 can join "we injected" (the
// enrichment trace) against "the agent pulled" (these records). Before this the
// hook was Bash-only (`[[ "$TOOL" != "Bash" ]] && exit 0`) so the pull side was
// invisible.
//
// The pull side lands in a LOCAL sibling of ask-traces.jsonl
// (~/.meetless/logs/mcp-calls.jsonl), one flat snake_case line per recognized
// meetless tool call. The join key is the CURRENT turn (read, never advanced):
// next_turn_index is bumped once per UserPromptSubmit, so during turn N the
// counter holds N and every tool call the agent makes belongs to turn N.
//
// A1a contract baked in here: relationship_verdict is an ACTION, never an
// evidence Pull (evidence_tool=false); retrieve_knowledge / kb_doc_detail /
// query are evidence-bearing (evidence_tool=true).

const HOOKS_DIR = path.resolve(__dirname, "../../src/hooks-template");
const COMMON = path.join(HOOKS_DIR, "common.sh");
const HOOK = "post-tool-use.sh";

interface Harness {
  home: string;
  queueDir: string;
  logsDir: string;
  fire: (input: object) => number;
  mcpCalls: () => any[];
  queueFiles: () => string[];
  seedTurn: (sessionId: string, n: number) => void;
  readTurn: (sessionId: string) => string | null;
}

function mkHarness(activate = true): { h: Harness; cleanup: () => void } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mla-mcpcap-"));
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
    mcpCalls: () => {
      const p = path.join(logsDir, "mcp-calls.jsonl");
      if (!fs.existsSync(p)) return [];
      return fs
        .readFileSync(p, "utf8")
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l));
    },
    queueFiles: () =>
      fs.existsSync(queueDir)
        ? fs.readdirSync(queueDir).filter((f) => f.endsWith(".jsonl"))
        : [],
    seedTurn: (sessionId: string, n: number) => {
      fs.mkdirSync(queueDir, { recursive: true });
      fs.writeFileSync(path.join(queueDir, `${sessionId}.turn`), String(n));
    },
    readTurn: (sessionId: string) => {
      const p = path.join(queueDir, `${sessionId}.turn`);
      return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
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

describe("post-tool-use.sh: per-turn meetless MCP-call capture (P1)", () => {
  beforeAll(() => {
    if (spawnSync("jq", ["--version"]).status !== 0) throw new Error("jq required");
  });

  it("records a retrieve_knowledge Pull keyed to the current turn with extracted source_ids", () => {
    const { h, cleanup } = mkHarness();
    try {
      h.seedTurn("sess-1", 3);
      const status = h.fire(
        mcpInput({
          sessionId: "sess-1",
          tool: "mcp__meetless__meetless__retrieve_knowledge",
          toolInput: { query: "how does the agentic ask loop work" },
          toolResponse:
            "Evidence:\n- [NT:20260526-solo-founder-vs-agents] control boundary\n- [DD:abc123] decision diff state machine",
        }),
      );
      expect(status).toBe(0);
      const calls = h.mcpCalls();
      expect(calls.length).toBe(1);
      const c = calls[0];
      expect(c.event).toBe("tool_used_mcp");
      expect(c.session_id).toBe("sess-1");
      expect(c.turn_index).toBe(3);
      expect(c.tool).toBe("retrieve_knowledge");
      expect(c.evidence_tool).toBe(true);
      expect(c.query).toBe("how does the agentic ask loop work");
      expect(c.source_ids).toEqual(
        expect.arrayContaining(["NT:20260526-solo-founder-vs-agents", "DD:abc123"]),
      );
    } finally {
      cleanup();
    }
  });

  it("reads the turn counter WITHOUT advancing it (a tool call is not a new turn)", () => {
    const { h, cleanup } = mkHarness();
    try {
      h.seedTurn("sess-2", 5);
      h.fire(
        mcpInput({
          sessionId: "sess-2",
          tool: "mcp__meetless__meetless__retrieve_knowledge",
          toolInput: { query: "x" },
          toolResponse: "no citations here",
        }),
      );
      // Counter must be untouched: next_turn_index (UserPromptSubmit) owns it.
      expect(h.readTurn("sess-2")).toBe("5");
      expect(h.mcpCalls()[0].turn_index).toBe(5);
      // No citations -> empty array, never missing.
      expect(h.mcpCalls()[0].source_ids).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it("marks relationship_verdict as an ACTION, not an evidence Pull (A1a)", () => {
    const { h, cleanup } = mkHarness();
    try {
      h.seedTurn("sess-3", 1);
      h.fire(
        mcpInput({
          sessionId: "sess-3",
          tool: "mcp__meetless__meetless__relationship_verdict",
          toolInput: { candidate_id: "rc_1", verdict: "reject" },
          toolResponse: "ok",
        }),
      );
      const c = h.mcpCalls()[0];
      expect(c.tool).toBe("relationship_verdict");
      expect(c.evidence_tool).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("captures the cited doc on kb_doc_detail from the input citation", () => {
    const { h, cleanup } = mkHarness();
    try {
      h.seedTurn("sess-4", 2);
      h.fire(
        mcpInput({
          sessionId: "sess-4",
          tool: "mcp__meetless__meetless__kb_doc_detail",
          toolInput: { citation: "NT:20260531-kb-command-living-guide" },
          toolResponse: { content: "full doc body without an inline citation token" },
        }),
      );
      const c = h.mcpCalls()[0];
      expect(c.tool).toBe("kb_doc_detail");
      expect(c.evidence_tool).toBe(true);
      expect(c.source_ids).toContain("NT:20260531-kb-command-living-guide");
    } finally {
      cleanup();
    }
  });

  it("classifies meetless__query as evidence-bearing", () => {
    const { h, cleanup } = mkHarness();
    try {
      h.seedTurn("sess-5", 1);
      h.fire(
        mcpInput({
          sessionId: "sess-5",
          tool: "mcp__meetless__meetless__query",
          toolInput: { question: "what is the canonical X" },
          toolResponse: "Answer with [DD:xyz] citation",
        }),
      );
      const c = h.mcpCalls()[0];
      expect(c.tool).toBe("query");
      expect(c.evidence_tool).toBe(true);
      expect(c.query).toBe("what is the canonical X");
      expect(c.source_ids).toContain("DD:xyz");
    } finally {
      cleanup();
    }
  });

  it("does NOT capture a Bash tool into mcp-calls.jsonl, and still spools it (no regression)", () => {
    const { h, cleanup } = mkHarness();
    try {
      h.seedTurn("sess-6", 1);
      const status = h.fire({
        session_id: "sess-6",
        tool_name: "Bash",
        tool_input: { command: "echo hi" },
        tool_response: { exit_code: 0, stdout: "hi", stderr: "" },
      });
      expect(status).toBe(0);
      expect(h.mcpCalls()).toEqual([]);
      expect(h.queueFiles()).toEqual(["sess-6.jsonl"]);
    } finally {
      cleanup();
    }
  });

  it("ignores a non-meetless MCP tool (self-filters even if the matcher fires it)", () => {
    const { h, cleanup } = mkHarness();
    try {
      h.seedTurn("sess-7", 1);
      const status = h.fire(
        mcpInput({
          sessionId: "sess-7",
          tool: "mcp__other__something",
          toolInput: { foo: "bar" },
          toolResponse: "whatever",
        }),
      );
      expect(status).toBe(0);
      expect(h.mcpCalls()).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it("stays DORMANT (no capture) when the folder is not activated", () => {
    const { h, cleanup } = mkHarness(false);
    try {
      h.seedTurn("sess-8", 1);
      const status = h.fire(
        mcpInput({
          sessionId: "sess-8",
          tool: "mcp__meetless__meetless__retrieve_knowledge",
          toolInput: { query: "x" },
          toolResponse: "[NT:foo]",
        }),
      );
      expect(status).toBe(0);
      expect(h.mcpCalls()).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it("drift guard: post-tool-use.sh keeps the meetless MCP routing", () => {
    const src = fs.readFileSync(path.join(HOOKS_DIR, HOOK), "utf8");
    expect(src).toContain("mcp-calls.jsonl");
    // Routes the meetless MCP namespace and classifies the evidence tools;
    // relationship_verdict is named so the action/Pull split cannot silently drift.
    expect(src).toMatch(/mcp__meetless__meetless__/);
    expect(src).toContain("retrieve_knowledge|kb_doc_detail|query");
    expect(src).toMatch(/relationship_verdict/);
  });

  it("drift guard: common.sh keeps the read-only current_turn_index helper", () => {
    const src = fs.readFileSync(COMMON, "utf8");
    expect(src).toMatch(/current_turn_index\(\) \{/);
  });
});
