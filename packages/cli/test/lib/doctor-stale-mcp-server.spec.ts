import {
  staleMcpServerCheck,
  type RunningMcpServer,
} from "../../src/commands/doctor";

// M1 fallback lane. The reload announcement (mcp-reload-announce.spec.ts) moves
// the model-visible schema on hosts that honour
// `notifications/tools/list_changed`. Measured 2026-08-09, Claude Code 2.1.211
// does; Codex 0.144.6 does NOT (no second tools/list, ever) and treats a clean
// server exit as a fatal "Transport closed", so there is no in-band way to
// refresh it. For those hosts the operator has to know, so doctor says so.
//
// Deliberately built from information that already exists: the build identity
// already stamped in dist/build-info.json (lib/staleness.ts reads the same file)
// and the process start time already reported by `ps`. No registry, no manifest
// hash, no new coordination subsystem.

function srv(over: Partial<RunningMcpServer> = {}): RunningMcpServer {
  return {
    pid: 4242,
    startedAtMs: Date.parse("2026-08-07T14:00:00Z"),
    ...over,
  };
}

const BUILT_AT = "2026-08-07T15:04:00Z";

describe("staleMcpServerCheck", () => {
  it("is silent (info, ok) when there is no build identity to compare against", () => {
    // A dev build with no dist/build-info.json cannot tell "rebuilt" from "first
    // ever stamp". Same fail-open rule the inline staleness probe uses.
    const c = staleMcpServerCheck(null, [srv()]);
    expect(c.ok).toBe(true);
    expect(c.level).toBe("info");
  });

  it("is silent when no MCP server is running at all", () => {
    const c = staleMcpServerCheck(BUILT_AT, []);
    expect(c.ok).toBe(true);
    expect(c.level).toBe("info");
  });

  it("passes when every running server started AFTER the current build", () => {
    const c = staleMcpServerCheck(BUILT_AT, [
      srv({ pid: 1, startedAtMs: Date.parse("2026-08-07T15:10:00Z") }),
      srv({ pid: 2, startedAtMs: Date.parse("2026-08-08T09:00:00Z") }),
    ]);
    expect(c.ok).toBe(true);
    expect(c.level).toBeUndefined();
    expect(c.detail).toMatch(/2 running/);
  });

  it("FAILS when a running server predates the current build (it serves an older contract)", () => {
    const c = staleMcpServerCheck(BUILT_AT, [
      srv({ pid: 11, startedAtMs: Date.parse("2026-08-07T13:00:00Z") }),
      srv({ pid: 12, startedAtMs: Date.parse("2026-08-07T16:00:00Z") }),
    ]);
    expect(c.ok).toBe(false);
    expect(c.id).toBe("mcp.server.fresh");
    // Must name the count and the worst offender's age so the operator can act
    // without running ps themselves.
    expect(c.detail).toMatch(/1 of 2/);
  });

  it("reports the OLDEST stale server, not just any one of them", () => {
    const c = staleMcpServerCheck(BUILT_AT, [
      srv({ pid: 21, startedAtMs: Date.parse("2026-08-07T13:00:00Z") }),
      srv({ pid: 22, startedAtMs: Date.parse("2026-08-04T02:00:00Z") }),
    ]);
    expect(c.ok).toBe(false);
    expect(c.detail).toContain("22");
  });

  it("tells the operator the remedy, and that Claude Code self-heals but Codex does not", () => {
    const c = staleMcpServerCheck(BUILT_AT, [
      srv({ startedAtMs: Date.parse("2026-08-01T00:00:00Z") }),
    ]);
    expect(c.detail).toMatch(/codex/i);
    expect(c.detail).toMatch(/restart/i);
  });

  it("treats an unparseable build stamp as no stamp (never crashes doctor)", () => {
    const c = staleMcpServerCheck("not-a-date", [srv()]);
    expect(c.ok).toBe(true);
    expect(c.level).toBe("info");
  });
});
