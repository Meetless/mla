import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  parseCaptureMcpFailuresArgs,
  parseTranscript,
  runInternalCaptureMcpFailures,
} from "../../src/commands/internal-capture-mcp-failures";

// D3's writer, end to end over a real on-disk transcript file. The unit half (which
// rows the scan produces) is in test/lib/analytics/mcp-failure-scan.spec.ts; this
// covers the parts only the command owns: argv, JSONL parsing of a file being
// appended to under us, the ledger dedup read, and the append itself.

function tmpTranscript(entries: object[]): { file: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mla-mcpfail-"));
  const file = path.join(dir, "transcript.jsonl");
  fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return {
    file,
    // maxRetries: a spawned hook can still be writing into this tree when the remove
    // runs. Repo invariant, enforced by test/lib/teardown-rmsync-is-retried.spec.ts.
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }),
  };
}

const REFUSAL = JSON.stringify({
  tool: "meetless__retrieve_knowledge",
  error: "retrieval temporarily unavailable: intel is unreachable (the connection failed)",
  category: "unavailable",
});

const PROMPT = {
  type: "user",
  message: { role: "user", content: [{ type: "text", text: "audit MLA" }] },
};
const CALL = {
  type: "assistant",
  message: {
    role: "assistant",
    content: [
      {
        type: "tool_use",
        id: "toolu_ZZ",
        name: "mcp__meetless__meetless__retrieve_knowledge",
        input: { query: "MLA durable product doctrine" },
      },
    ],
  },
};
const REFUSED = {
  type: "user",
  message: {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "toolu_ZZ", is_error: true, content: REFUSAL }],
  },
};

describe("mla _internal capture-mcp-failures", () => {
  it("rejects a malformed argv with exit 2 rather than silently doing nothing", () => {
    const err = jest.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(runInternalCaptureMcpFailures(["--turn", "0"])).toBe(2);
      expect(runInternalCaptureMcpFailures(["--nonsense"])).toBe(2);
    } finally {
      err.mockRestore();
    }
  });

  it("parses the three flags the Stop hook passes", () => {
    expect(
      parseCaptureMcpFailuresArgs(["--session", "s1", "--turn", "4", "--transcript", "/t.jsonl"]),
    ).toEqual({ session: "s1", turn: 4, transcript: "/t.jsonl" });
  });

  it("drops a torn final line instead of losing the whole transcript", () => {
    // The transcript is appended to by another process while we read it, so the last
    // line is routinely half-written. Throwing there would make the scan fail exactly
    // on the busiest turns.
    const parsed = parseTranscript('{"a":1}\n{"b":2}\n{"c":');
    expect(parsed).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("appends one ledger row for a refused pull", () => {
    const { file, cleanup } = tmpTranscript([PROMPT, CALL, REFUSED]);
    const appended: string[] = [];
    try {
      const rc = runInternalCaptureMcpFailures(
        ["--session", "sess-x", "--turn", "3", "--transcript", file],
        {
          readLedger: () => [],
          appendLines: (lines) => appended.push(...lines),
          now: () => "2026-08-09T00:00:00Z",
        },
      );
      expect(rc).toBe(0);
      expect(appended).toHaveLength(1);
      expect(JSON.parse(appended[0])).toEqual({
        ts: "2026-08-09T00:00:00Z",
        event: "tool_used_mcp",
        session_id: "sess-x",
        turn_index: 3,
        tool: "retrieve_knowledge",
        evidence_tool: true,
        query: "MLA durable product doctrine",
        source_ids: [],
        outcome: "error",
        tool_use_id: "toolu_ZZ",
      });
    } finally {
      cleanup();
    }
  });

  it("is a no-op on a second Stop for the same turn (the ledger already holds the row)", () => {
    const { file, cleanup } = tmpTranscript([PROMPT, CALL, REFUSED]);
    const appended: string[] = [];
    try {
      runInternalCaptureMcpFailures(
        ["--session", "sess-x", "--turn", "3", "--transcript", file],
        {
          readLedger: () => [{ tool_use_id: "toolu_ZZ" }],
          appendLines: (lines) => appended.push(...lines),
        },
      );
      expect(appended).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it("exits 0 and writes nothing when the transcript is unreadable", () => {
    const appended: string[] = [];
    const rc = runInternalCaptureMcpFailures(
      ["--session", "s", "--turn", "1", "--transcript", "/no/such/transcript.jsonl"],
      { readLedger: () => [], appendLines: (lines) => appended.push(...lines) },
    );
    expect(rc).toBe(0);
    expect(appended).toEqual([]);
  });

  it("writes the row into the real mcp-calls.jsonl when no append seam is injected", () => {
    const { file, cleanup } = tmpTranscript([PROMPT, CALL, REFUSED]);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "mla-home-"));
    const prev = process.env.MEETLESS_HOME;
    process.env.MEETLESS_HOME = home;
    try {
      runInternalCaptureMcpFailures(
        ["--session", "sess-real", "--turn", "2", "--transcript", file],
        { readLedger: () => [] },
      );
      const ledger = path.join(home, "logs", "mcp-calls.jsonl");
      expect(fs.existsSync(ledger)).toBe(true);
      const rows = fs
        .readFileSync(ledger, "utf8")
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l));
      expect(rows).toHaveLength(1);
      expect(rows[0].outcome).toBe("error");
      expect(rows[0].session_id).toBe("sess-real");
    } finally {
      if (prev === undefined) delete process.env.MEETLESS_HOME;
      else process.env.MEETLESS_HOME = prev;
      fs.rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
      cleanup();
    }
  });
});
