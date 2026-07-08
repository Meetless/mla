import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Forwarded tool_used_mcp AgentRunEvent (governed-story §3.1 / §3.3, T8).
//
// The agent's governed-memory calls (meetless MCP) must show up on the
// session-detail "what did mla do" lane. post-tool-use.sh ALREADY writes a LOCAL
// mcp-calls.jsonl for the A1 evidence-followthrough join; THIS path ADDS a
// forwarded AgentRunEvent that rides the EXISTING spool -> flush -> control
// pipeline (same generic claude_hook envelope as tool_used_bash). This spec
// pins the forwarded line: deterministic eventKey, the composite turnId join
// key, the prefix-stripped operation, the HONEST three-valued outcome, and the
// fail-closed query redaction. It is independent of mcp-call-capture.spec.ts,
// which covers ONLY the local mcp-calls.jsonl.

const HOOKS_DIR = path.resolve(__dirname, "../../src/hooks-template");
const HOOK = "post-tool-use.sh";
const SID = "231a83a5-b2d4-4cae-94c6-5be4638890c0";

interface Harness {
  home: string;
  queueDir: string;
  fire: (input: object) => { status: number; stdout: string; stderr: string };
  queueLines: (sessionId: string) => Record<string, unknown>[];
  seedTurn: (sessionId: string, n: number) => void;
}

// A redactor stub standing in for `mla _internal redact-capture`: it consumes
// the {query} JSON on stdin and emits a CONSTANT redacted query, so a passing
// assertion proves the hook piped the query through the redactor and forwarded
// the redactor's OUTPUT (never the raw query). The real redactor's scrubbing is
// covered by internal-redact-capture.spec.ts.
const MLA_REDACT_STUB = `#!/usr/bin/env bash
cat >/dev/null
printf '%s\\n' '{"query":"REDACTED_BY_STUB"}'
`;

// A no-op `mla` that exists, is executable, reads its stdin, and emits NOTHING.
// This stands in for "the redactor produced no usable output" (unavailable /
// crashed / empty) WITHOUT relying on a system path like /bin/true, which is
// absent on some macOS installs. When it is absent, common.sh MLA_PATH
// resolution silently falls back to the REAL installed mla, defeating the
// fail-closed premise. A created stub is hermetic on every machine.
const MLA_NOOP_STUB = `#!/usr/bin/env bash
cat >/dev/null 2>&1 || true
exit 0
`;

function mkHarness(opts?: { mlaPath?: string }): {
  h: Harness;
  cleanup: () => void;
} {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mla-mcpfwd-"));
  fs.copyFileSync(path.join(HOOKS_DIR, "common.sh"), path.join(tmp, "common.sh"));
  fs.copyFileSync(path.join(HOOKS_DIR, HOOK), path.join(tmp, HOOK));
  fs.chmodSync(path.join(tmp, HOOK), 0o755);

  // Default mla = the hermetic no-op stub (see MLA_NOOP_STUB). Tests that need a
  // working redactor pass their own mlaPath.
  const noop = path.join(tmp, "mla-noop");
  fs.writeFileSync(noop, MLA_NOOP_STUB);
  fs.chmodSync(noop, 0o755);

  const home = path.join(tmp, "home");
  fs.mkdirSync(home);
  fs.writeFileSync(
    path.join(home, "cli-config.json"),
    JSON.stringify({
      controlUrl: "http://127.0.0.1:1",
      controlToken: "x",
      workspaceId: "ws_test",
      actorUserId: "user_a",
      mlaPath: opts?.mlaPath ?? noop,
    }),
  );
  const workdir = path.join(tmp, "workdir");
  fs.mkdirSync(workdir);
  fs.writeFileSync(
    path.join(workdir, ".meetless.json"),
    JSON.stringify({ workspaceId: "ws_test" }),
  );
  const queueDir = path.join(home, "queue");
  fs.mkdirSync(queueDir, { recursive: true });

  const h: Harness = {
    home,
    queueDir,
    fire: (input: object) => {
      const r = spawnSync("bash", [path.join(tmp, HOOK)], {
        input: JSON.stringify(input),
        encoding: "utf8",
        cwd: workdir,
        env: { ...process.env, MEETLESS_HOME: home, MEETLESS_DEBUG: "0" },
        timeout: 5000,
      });
      return {
        status: r.status ?? -1,
        stdout: r.stdout ?? "",
        stderr: r.stderr ?? "",
      };
    },
    queueLines: (sessionId: string) => {
      const q = path.join(queueDir, `${sessionId}.jsonl`);
      if (!fs.existsSync(q)) return [];
      return fs
        .readFileSync(q, "utf8")
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l) as Record<string, unknown>);
    },
    // The turn counter is owned by next_turn_index (UserPromptSubmit); the MCP
    // route only PEEKS it. Seeding the file simulates "a prompt already ran this
    // turn" so we can exercise the non-null turnId branch.
    seedTurn: (sessionId: string, n: number) => {
      fs.writeFileSync(path.join(queueDir, `${sessionId}.turn`), String(n));
    },
  };
  return { h, cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}

function mcpInput(overrides: Record<string, unknown> = {}): object {
  return {
    session_id: SID,
    tool_name: "mcp__meetless__meetless__retrieve_knowledge",
    tool_use_id: "toolu_abc123",
    tool_input: { query: "where is the auth flow defined" },
    tool_response: {
      content: [{ type: "text", text: "see DD:cm123abc and NT:cm456def" }],
    },
    ...overrides,
  };
}

function mcpEvents(h: Harness): Record<string, unknown>[] {
  return h
    .queueLines(SID)
    .filter((e) => e.event === "tool_used_mcp");
}

describe("post-tool-use.sh forwarded tool_used_mcp", () => {
  beforeAll(() => {
    const jq = spawnSync("jq", ["--version"], { encoding: "utf8" });
    if (jq.status !== 0) {
      throw new Error("jq must be installed to run post-tool-use-mcp specs");
    }
  });

  it("forwards exactly one tool_used_mcp to the queue spool (not mcp-calls.jsonl)", () => {
    const { h, cleanup } = mkHarness();
    try {
      h.seedTurn(SID, 7);
      const r = h.fire(mcpInput());
      expect(r.status).toBe(0);
      const events = mcpEvents(h);
      expect(events).toHaveLength(1);
      // The LOCAL mcp-calls.jsonl is a separate file, never the queue spool.
      const local = path.join(h.home, "logs", "mcp-calls.jsonl");
      expect(fs.existsSync(local)).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("stamps the composite turnId + turnIndex from the peeked counter", () => {
    const { h, cleanup } = mkHarness();
    try {
      h.seedTurn(SID, 7);
      h.fire(mcpInput());
      const payload = mcpEvents(h)[0].payload as Record<string, unknown>;
      expect(payload.turnId).toBe(`${SID}:7`);
      expect(payload.turnIndex).toBe(7);
    } finally {
      cleanup();
    }
  });

  it("sets turnId null when no prompt has advanced the counter (turn 0)", () => {
    const { h, cleanup } = mkHarness();
    try {
      // No seedTurn: the counter is absent -> peeks 0 -> turnId must be null,
      // never borrowing another turn's id.
      h.fire(mcpInput());
      const payload = mcpEvents(h)[0].payload as Record<string, unknown>;
      expect(payload.turnId).toBeNull();
      expect(payload.turnIndex).toBe(0);
    } finally {
      cleanup();
    }
  });

  it("renders operation from the prefix-stripped name and keeps the raw toolName", () => {
    const { h, cleanup } = mkHarness();
    try {
      h.fire(mcpInput());
      const payload = mcpEvents(h)[0].payload as Record<string, unknown>;
      expect(payload.operation).toBe("retrieve_knowledge");
      expect(payload.toolName).toBe("mcp__meetless__meetless__retrieve_knowledge");
    } finally {
      cleanup();
    }
  });

  it("mints a DETERMINISTIC eventKey from the tool_use_id", () => {
    const { h, cleanup } = mkHarness();
    try {
      h.fire(mcpInput());
      expect(mcpEvents(h)[0].eventKey).toBe(`mcp:${SID}:toolu_abc123`);
    } finally {
      cleanup();
    }
  });

  it("falls back to a random eventKey when the call carries no tool_use_id", () => {
    const { h, cleanup } = mkHarness();
    try {
      h.fire(mcpInput({ tool_use_id: undefined }));
      const key = mcpEvents(h)[0].eventKey as string;
      expect(key).toMatch(/^mcp:/);
      expect(key).not.toBe(`mcp:${SID}:`);
      expect(key).not.toContain("toolu_abc123");
    } finally {
      cleanup();
    }
  });

  it("extracts governed sourceIds from the call args + response, sorted unique", () => {
    const { h, cleanup } = mkHarness();
    try {
      h.fire(mcpInput());
      const payload = mcpEvents(h)[0].payload as Record<string, unknown>;
      expect(payload.sourceIds).toEqual(["DD:cm123abc", "NT:cm456def"]);
    } finally {
      cleanup();
    }
  });

  describe("outcome (honest, three-valued)", () => {
    it("classifies a content-bearing response as success", () => {
      const { h, cleanup } = mkHarness();
      try {
        h.fire(mcpInput());
        expect((mcpEvents(h)[0].payload as Record<string, unknown>).outcome).toBe(
          "success",
        );
      } finally {
        cleanup();
      }
    });

    it("classifies an isError response as error", () => {
      const { h, cleanup } = mkHarness();
      try {
        h.fire(
          mcpInput({
            tool_response: { isError: true, content: [{ type: "text", text: "boom" }] },
          }),
        );
        expect((mcpEvents(h)[0].payload as Record<string, unknown>).outcome).toBe(
          "error",
        );
      } finally {
        cleanup();
      }
    });

    it("classifies an unrecognized response shape as unknown (never inferred success)", () => {
      const { h, cleanup } = mkHarness();
      try {
        // A bare-object response with neither isError nor content cannot be
        // positively classified, so the hook must NOT claim success.
        h.fire(mcpInput({ tool_response: {} }));
        expect((mcpEvents(h)[0].payload as Record<string, unknown>).outcome).toBe(
          "unknown",
        );
      } finally {
        cleanup();
      }
    });
  });

  describe("query redaction (§4.4, fail-closed)", () => {
    it("forwards query null when the redactor is unavailable (raw NEVER substituted)", () => {
      const { h, cleanup } = mkHarness(); // default mla = no-op stub, emits nothing
      try {
        h.fire(mcpInput());
        const payload = mcpEvents(h)[0].payload as Record<string, unknown>;
        expect(payload.query).toBeNull();
        // The raw query text must not appear anywhere on the forwarded line.
        expect(JSON.stringify(payload)).not.toContain("auth flow");
      } finally {
        cleanup();
      }
    });

    it("forwards the redactor's OUTPUT when a redactor is available", () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mla-stub-"));
      const stub = path.join(tmp, "mla");
      fs.writeFileSync(stub, MLA_REDACT_STUB);
      fs.chmodSync(stub, 0o755);
      const { h, cleanup } = mkHarness({ mlaPath: stub });
      try {
        h.fire(mcpInput());
        const payload = mcpEvents(h)[0].payload as Record<string, unknown>;
        expect(payload.query).toBe("REDACTED_BY_STUB");
        expect(JSON.stringify(payload)).not.toContain("auth flow");
      } finally {
        cleanup();
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("forwards query null for a no-query action (relationship_verdict)", () => {
      const { h, cleanup } = mkHarness();
      try {
        h.fire(
          mcpInput({
            tool_name: "mcp__meetless__meetless__relationship_verdict",
            tool_input: { verdict: "confirm" },
            tool_use_id: "toolu_v1",
          }),
        );
        const payload = mcpEvents(h)[0].payload as Record<string, unknown>;
        expect(payload.query).toBeNull();
        expect(payload.operation).toBe("relationship_verdict");
      } finally {
        cleanup();
      }
    });
  });
});
