import {
  MCP_RESTART_EXIT_CODE,
  isMcpChild,
  shouldSuperviseMcp,
} from "../../src/lib/mcp-restart";

// The self-heal supervisor split. `mla mcp` (no `--child`) becomes a thin,
// long-lived PARENT that holds the stdio pipe to the client and respawns a
// `mla mcp --child` WORKER whenever the worker self-exits with the restart
// sentinel (it detected a newer build on disk and reloaded). These pure helpers
// route a single `mla mcp` invocation to either role and pin the sentinel code.
// They are the seam cli.ts branches on, so they must be unambiguous and stable.

describe("MCP_RESTART_EXIT_CODE", () => {
  it("is a distinct, non-signal exit code that never collides with the worker's own codes", () => {
    expect(typeof MCP_RESTART_EXIT_CODE).toBe("number");
    // Worker returns 0 (clean disconnect), 1 (server error), 2 (guard fail).
    // The sentinel must differ so the parent can tell "reload me" from those.
    expect([0, 1, 2]).not.toContain(MCP_RESTART_EXIT_CODE);
    // Stay inside the portable 0..255 byte range and out of the 129..255
    // signal-encoding band so it is never confused with a killed child.
    expect(MCP_RESTART_EXIT_CODE).toBeGreaterThan(2);
    expect(MCP_RESTART_EXIT_CODE).toBeLessThanOrEqual(128);
  });
});

describe("isMcpChild", () => {
  it("is true when argv carries the --child flag (the spawned worker)", () => {
    expect(isMcpChild(["--child"], {})).toBe(true);
    expect(isMcpChild(["--dir", "/x", "--child"], {})).toBe(true);
  });

  it("is true when MEETLESS_MCP_CHILD is set (env-signalled worker)", () => {
    expect(isMcpChild([], { MEETLESS_MCP_CHILD: "1" })).toBe(true);
  });

  it("is false for a bare invocation with no child signal", () => {
    expect(isMcpChild([], {})).toBe(false);
    expect(isMcpChild(["--dir", "/x"], {})).toBe(false);
  });
});

describe("shouldSuperviseMcp", () => {
  it("supervises a bare `mla mcp` (the default self-heal path)", () => {
    expect(shouldSuperviseMcp([], {})).toBe(true);
    expect(shouldSuperviseMcp(["--dir", "/x"], {})).toBe(true);
  });

  it("does NOT supervise when the invocation IS the child worker", () => {
    expect(shouldSuperviseMcp(["--child"], {})).toBe(false);
    expect(shouldSuperviseMcp([], { MEETLESS_MCP_CHILD: "1" })).toBe(false);
  });

  it("does NOT supervise when the kill switch MEETLESS_MCP_SUPERVISOR=0 is set (falls back to a single in-process server)", () => {
    expect(shouldSuperviseMcp([], { MEETLESS_MCP_SUPERVISOR: "0" })).toBe(false);
  });

  it("treats any non-\"0\" supervisor value as enabled (kill switch is opt-out, exact \"0\")", () => {
    expect(shouldSuperviseMcp([], { MEETLESS_MCP_SUPERVISOR: "1" })).toBe(true);
    expect(shouldSuperviseMcp([], { MEETLESS_MCP_SUPERVISOR: "" })).toBe(true);
  });
});
