import type { CliConfig } from "../../src/lib/config";
import {
  NotActivatedError,
  MarkerMissingWorkspaceIdError,
  type WorkspaceContext,
} from "../../src/lib/workspace";
import { runInternalSessionNudge } from "../../src/commands/internal-session-nudge";

// `mla _internal session-nudge` is the SessionStart hook's "Meetless is installed
// but inactive here" explanation. It must print a Claude Code SessionStart
// additionalContext blob ONLY for a logged-in git repo that is not activated, and
// be silent everywhere else. It reuses the SAME marker resolver as `mla mcp` so
// the two surfaces never disagree on what "activated" means.

function loggedInCfg(): CliConfig {
  return {
    controlUrl: "http://control.test",
    controlToken: "ml_at_x",
    intelUrl: "http://intel.test",
    mlaPath: "/tmp/mla",
    actorUserId: "u1",
    auth: {
      mode: "user-token",
      accessToken: "ml_at_x",
      refreshToken: "ml_rt_x",
      accessExpiresAt: "2999-01-01T00:00:00.000Z",
      refreshExpiresAt: "2999-02-01T00:00:00.000Z",
      sessionId: "s1",
      user: { id: "u1", displayName: "An", email: null, role: "OWNER" },
    },
  };
}

function noneCfg(): CliConfig {
  return {
    controlUrl: "http://control.test",
    controlToken: "",
    intelUrl: "http://intel.test",
    mlaPath: "/tmp/mla",
    auth: { mode: "none" },
  };
}

function activeCtx(): WorkspaceContext {
  return {
    workspaceId: "ws_marker_123",
    workspaceName: "An's Workspace",
    markerPath: "/repo/.meetless.json",
    markerDir: "/repo",
  };
}

interface Capture {
  out: string[];
  deps: Parameters<typeof runInternalSessionNudge>[1];
}

function capture(over: Partial<NonNullable<Capture["deps"]>> = {}): Capture {
  const out: string[] = [];
  const deps = {
    readConfig: () => loggedInCfg(),
    resolveWorkspaceContext: () => {
      throw new NotActivatedError("/repo");
    },
    isGitRepo: () => true,
    log: (m: string) => out.push(m),
    env: {},
    ...over,
  };
  return { out, deps };
}

function parseInjected(line: string): { hookEventName: string; additionalContext: string } {
  const o = JSON.parse(line);
  return o.hookSpecificOutput;
}

describe("mla _internal session-nudge", () => {
  it("emits the inactive message in a logged-in git repo with no marker (the wedge case)", () => {
    const c = capture();
    const code = runInternalSessionNudge(["--cwd", "/repo"], c.deps);
    expect(code).toBe(0);
    expect(c.out).toHaveLength(1);
    const injected = parseInjected(c.out[0]);
    expect(injected.hookEventName).toBe("SessionStart");
    expect(injected.additionalContext).toMatch(/installed but inactive/i);
    expect(injected.additionalContext).toMatch(/mla activate/);
  });

  it("emits a DISTINCT repair message when the marker has no workspaceId", () => {
    const c = capture({
      resolveWorkspaceContext: () => {
        throw new MarkerMissingWorkspaceIdError("/repo/.meetless.json");
      },
    });
    runInternalSessionNudge(["--cwd", "/repo"], c.deps);
    expect(c.out).toHaveLength(1);
    const injected = parseInjected(c.out[0]);
    expect(injected.additionalContext).toMatch(/incomplete/i);
    expect(injected.additionalContext).toMatch(/mla doctor/);
  });

  it("emits NOTHING in an activated repo (the active hook path handles it)", () => {
    const c = capture({ resolveWorkspaceContext: () => activeCtx() });
    const code = runInternalSessionNudge(["--cwd", "/repo"], c.deps);
    expect(code).toBe(0);
    expect(c.out).toHaveLength(0);
  });

  it("emits NOTHING in a non-git directory (suppresses scratch dirs / $HOME)", () => {
    const c = capture({ isGitRepo: () => false });
    runInternalSessionNudge(["--cwd", "/tmp/scratch"], c.deps);
    expect(c.out).toHaveLength(0);
  });

  it("emits NOTHING for NO marker when not logged in (never nag the un-onboarded in an unrelated repo)", () => {
    // default capture() resolver throws NotActivatedError -> no marker here.
    const c = capture({ readConfig: () => noneCfg() });
    runInternalSessionNudge(["--cwd", "/repo"], c.deps);
    expect(c.out).toHaveLength(0);
  });

  // Activated-but-logged-out is the gap the blanket "not logged in -> silent" rule
  // missed: a valid marker is durable evidence the user CHOSE to govern this repo,
  // so a logout here must be visible, not silent (the MCP layer already serves a
  // green `mla login` server for the same state; SessionStart must agree).
  it("emits the LOGIN nudge for a valid marker when logged out (activated but signed out)", () => {
    const c = capture({
      readConfig: () => noneCfg(),
      resolveWorkspaceContext: () => activeCtx(),
    });
    const code = runInternalSessionNudge(["--cwd", "/repo"], c.deps);
    expect(code).toBe(0);
    expect(c.out).toHaveLength(1);
    const injected = parseInjected(c.out[0]);
    expect(injected.additionalContext).toMatch(/mla login/);
    expect(injected.additionalContext).not.toMatch(/mla activate/);
  });

  // A present-but-broken marker is also evidence of intent, so the repair path is
  // surfaced regardless of auth (doctor reveals both the marker break and the logout).
  it("emits the DOCTOR repair message for an invalid marker even when logged out", () => {
    const c = capture({
      readConfig: () => noneCfg(),
      resolveWorkspaceContext: () => {
        throw new MarkerMissingWorkspaceIdError("/repo/.meetless.json");
      },
    });
    runInternalSessionNudge(["--cwd", "/repo"], c.deps);
    expect(c.out).toHaveLength(1);
    const injected = parseInjected(c.out[0]);
    expect(injected.additionalContext).toMatch(/mla doctor/);
    expect(injected.additionalContext).not.toMatch(/mla login/);
  });

  it("is silent and exits 0 when readConfig throws (never breaks a hook)", () => {
    const c = capture({
      readConfig: () => {
        throw new Error("cli-config.json corrupt");
      },
    });
    const code = runInternalSessionNudge(["--cwd", "/repo"], c.deps);
    expect(code).toBe(0);
    expect(c.out).toHaveLength(0);
  });

  it("checks the git status of the resolved --cwd, not process.cwd()", () => {
    const seen: string[] = [];
    const c = capture({ isGitRepo: (d: string) => (seen.push(d), false) });
    runInternalSessionNudge(["--cwd", "/some/repo"], c.deps);
    expect(seen).toEqual(["/some/repo"]);
  });
});
