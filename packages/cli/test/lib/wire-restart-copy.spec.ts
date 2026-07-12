import { printWireResult, WireResult, McpServerAction } from "../../src/lib/wire";

// Session-aware restart copy: Claude Code loads MCP servers + scout agents only at
// session start, so an in-session `mla rewire`/`init` (CLAUDE_CODE_SESSION_ID set)
// genuinely needs one restart, while a `curl | sh` install from a bare terminal does
// not: the tools just appear next time Claude Code opens. printWireResult must not
// scare the common install path with a restart it never needed.

function baseResult(mcpAction: McpServerAction): WireResult {
  return {
    copied: ["capture.sh"],
    hooksAdded: [],
    settingsPath: "/home/u/.claude/settings.json",
    skillDir: "/home/u/.claude/skills/mla",
    onboardSkillDir: "/home/u/.claude/skills/mla-onboard",
    scoutAgents: ["meetless-doc-scout", "meetless-history-scout"],
    flock: { ok: true, detail: "flock present" },
    projectRules: null,
    mcp: { path: "/home/u/.claude.json", action: mcpAction },
  };
}

function capture(fn: () => void): string {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    fn();
  } finally {
    console.log = orig;
  }
  return lines.join("\n");
}

describe("printWireResult restart copy is session-aware", () => {
  const saved = process.env.CLAUDE_CODE_SESSION_ID;
  afterEach(() => {
    if (saved === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = saved;
  });

  it("in-session (mid-session wire): tells the user to restart once", () => {
    process.env.CLAUDE_CODE_SESSION_ID = "sess-123";
    const out = capture(() => printWireResult(baseResult("added")));
    expect(out).toContain("Restart Claude Code once");
    expect(out).not.toContain("load automatically the next time");
  });

  it("no session (bare-terminal install): promises automatic load, no restart", () => {
    delete process.env.CLAUDE_CODE_SESSION_ID;
    const out = capture(() => printWireResult(baseResult("added")));
    expect(out).toContain("load automatically the next time you open Claude Code");
    expect(out).not.toContain("Restart Claude Code");
  });

  it("says nothing about restart when the MCP entry was already canonical", () => {
    process.env.CLAUDE_CODE_SESSION_ID = "sess-123";
    const out = capture(() => printWireResult(baseResult("unchanged")));
    expect(out).toContain("already registered");
    expect(out).not.toContain("Restart Claude Code");
    expect(out).not.toContain("load automatically");
  });

  it("writing-style guard: no em dash or double dash in either branch", () => {
    process.env.CLAUDE_CODE_SESSION_ID = "sess-123";
    const inSession = capture(() => printWireResult(baseResult("added")));
    delete process.env.CLAUDE_CODE_SESSION_ID;
    const bare = capture(() => printWireResult(baseResult("added")));
    for (const out of [inSession, bare]) {
      expect(out).not.toContain("—");
      expect(out).not.toMatch(/ -- /);
    }
  });
});
