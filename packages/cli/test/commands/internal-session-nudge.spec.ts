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
    // Default to UNKNOWN so no test reaches the real network and every legacy
    // expectation (silence in an activated repo) still holds.
    workspaceEverOnboarded: async () => null,
    ...over,
  };
  return { out, deps };
}

function parseInjected(line: string): { hookEventName: string; additionalContext: string } {
  const o = JSON.parse(line);
  return o.hookSpecificOutput;
}

describe("mla _internal session-nudge", () => {
  it("emits the inactive message in a logged-in git repo with no marker (the wedge case)", async () => {
    const c = capture();
    const code = await runInternalSessionNudge(["--cwd", "/repo"], c.deps);
    expect(code).toBe(0);
    expect(c.out).toHaveLength(1);
    const injected = parseInjected(c.out[0]);
    expect(injected.hookEventName).toBe("SessionStart");
    expect(injected.additionalContext).toMatch(/installed but inactive/i);
    expect(injected.additionalContext).toMatch(/mla activate/);
  });

  it("emits a DISTINCT repair message when the marker has no workspaceId", async () => {
    const c = capture({
      resolveWorkspaceContext: () => {
        throw new MarkerMissingWorkspaceIdError("/repo/.meetless.json");
      },
    });
    await runInternalSessionNudge(["--cwd", "/repo"], c.deps);
    expect(c.out).toHaveLength(1);
    const injected = parseInjected(c.out[0]);
    expect(injected.additionalContext).toMatch(/incomplete/i);
    expect(injected.additionalContext).toMatch(/mla doctor/);
  });

  it("emits NOTHING in an activated, ONBOARDED repo (the active hook path handles it)", async () => {
    const c = capture({
      resolveWorkspaceContext: () => activeCtx(),
      workspaceEverOnboarded: async () => true,
    });
    const code = await runInternalSessionNudge(["--cwd", "/repo"], c.deps);
    expect(code).toBe(0);
    expect(c.out).toHaveLength(0);
  });

  // The activated-but-never-onboarded hole. Measured in prod on 2026-08-02: 72 of the
  // 80 live REPO workspaces (90%) were activated with zero rules, and 8 of them served
  // 283 empty retrieve_knowledge pulls in 6 days. `mla activate` hands off to the
  // onboard skill, but that is an EDGE at activation time: these workspaces are already
  // past it and can never recover through it. SessionStart is the only LEVEL trigger
  // that reaches them, and the message is aimed at the agent, which is what actually
  // calls retrieve_knowledge and then reports "not recorded" on an empty corpus.
  it("emits the ONBOARD nudge for an activated repo that was NEVER onboarded", async () => {
    const c = capture({
      resolveWorkspaceContext: () => activeCtx(),
      workspaceEverOnboarded: async () => false,
    });
    const code = await runInternalSessionNudge(["--cwd", "/repo"], c.deps);
    expect(code).toBe(0);
    expect(c.out).toHaveLength(1);
    const injected = parseInjected(c.out[0]);
    expect(injected.hookEventName).toBe("SessionStart");
    expect(injected.additionalContext).toMatch(/\/mla onboard/);
    // The consequence, not just the command: an empty corpus answers EVERY query
    // with nothing, which an agent must not read as "the fact is not recorded".
    expect(injected.additionalContext).toMatch(/every/i);
    expect(injected.additionalContext).toMatch(/retrieve_knowledge/);
    // Never mixed with the states it is not: this repo is activated and signed in.
    expect(injected.additionalContext).not.toMatch(/mla activate/);
    expect(injected.additionalContext).not.toMatch(/mla login/);
  });

  // Fail QUIET, like `activate`: a nudge is not a gate, and an intel hiccup must not
  // turn a one-time hand-off into a nag at the start of every session.
  it("emits NOTHING when the onboarding answer is UNKNOWN (null)", async () => {
    const c = capture({
      resolveWorkspaceContext: () => activeCtx(),
      workspaceEverOnboarded: async () => null,
    });
    const code = await runInternalSessionNudge(["--cwd", "/repo"], c.deps);
    expect(code).toBe(0);
    expect(c.out).toHaveLength(0);
  });

  it("emits NOTHING when the onboarding probe THROWS (never breaks a hook)", async () => {
    const c = capture({
      resolveWorkspaceContext: () => activeCtx(),
      workspaceEverOnboarded: async () => {
        throw new Error("intel unreachable");
      },
    });
    const code = await runInternalSessionNudge(["--cwd", "/repo"], c.deps);
    expect(code).toBe(0);
    expect(c.out).toHaveLength(0);
  });

  // The probe is marker-scoped: it must ask about the workspace THIS repo is bound to,
  // never whatever workspace the on-disk config happens to name.
  it("probes onboarding with the MARKER-resolved workspaceId", async () => {
    const asked: string[] = [];
    const c = capture({
      resolveWorkspaceContext: () => activeCtx(),
      workspaceEverOnboarded: async (ws: string) => {
        asked.push(ws);
        return false;
      },
    });
    await runInternalSessionNudge(["--cwd", "/repo"], c.deps);
    expect(asked).toEqual(["ws_marker_123"]);
  });

  // No marker means no workspace to ask about, and logged out means no credential to
  // ask with. Both must skip the network entirely: SessionStart runs on every session,
  // including offline ones, and must not pay for an answer it cannot use.
  it("does NOT probe onboarding when there is no marker", async () => {
    let calls = 0;
    const c = capture({
      workspaceEverOnboarded: async () => (calls++, false),
    });
    await runInternalSessionNudge(["--cwd", "/repo"], c.deps);
    expect(calls).toBe(0);
  });

  it("does NOT probe onboarding when logged out", async () => {
    let calls = 0;
    const c = capture({
      readConfig: () => noneCfg(),
      resolveWorkspaceContext: () => activeCtx(),
      workspaceEverOnboarded: async () => (calls++, false),
    });
    await runInternalSessionNudge(["--cwd", "/repo"], c.deps);
    expect(calls).toBe(0);
    expect(c.out).toHaveLength(1);
    expect(parseInjected(c.out[0]).additionalContext).toMatch(/mla login/);
  });

  it("emits NOTHING in a non-git directory (suppresses scratch dirs / $HOME)", async () => {
    const c = capture({ isGitRepo: () => false });
    await runInternalSessionNudge(["--cwd", "/tmp/scratch"], c.deps);
    expect(c.out).toHaveLength(0);
  });

  it("emits NOTHING for NO marker when not logged in (never nag the un-onboarded in an unrelated repo)", async () => {
    // default capture() resolver throws NotActivatedError -> no marker here.
    const c = capture({ readConfig: () => noneCfg() });
    await runInternalSessionNudge(["--cwd", "/repo"], c.deps);
    expect(c.out).toHaveLength(0);
  });

  // Activated-but-logged-out is the gap the blanket "not logged in -> silent" rule
  // missed: a valid marker is durable evidence the user CHOSE to govern this repo,
  // so a logout here must be visible, not silent (the MCP layer already serves a
  // green `mla login` server for the same state; SessionStart must agree).
  it("emits the LOGIN nudge for a valid marker when logged out (activated but signed out)", async () => {
    const c = capture({
      readConfig: () => noneCfg(),
      resolveWorkspaceContext: () => activeCtx(),
    });
    const code = await runInternalSessionNudge(["--cwd", "/repo"], c.deps);
    expect(code).toBe(0);
    expect(c.out).toHaveLength(1);
    const injected = parseInjected(c.out[0]);
    expect(injected.additionalContext).toMatch(/mla login/);
    expect(injected.additionalContext).not.toMatch(/mla activate/);
  });

  // A present-but-broken marker is also evidence of intent, so the repair path is
  // surfaced regardless of auth (doctor reveals both the marker break and the logout).
  it("emits the DOCTOR repair message for an invalid marker even when logged out", async () => {
    const c = capture({
      readConfig: () => noneCfg(),
      resolveWorkspaceContext: () => {
        throw new MarkerMissingWorkspaceIdError("/repo/.meetless.json");
      },
    });
    await runInternalSessionNudge(["--cwd", "/repo"], c.deps);
    expect(c.out).toHaveLength(1);
    const injected = parseInjected(c.out[0]);
    expect(injected.additionalContext).toMatch(/mla doctor/);
    expect(injected.additionalContext).not.toMatch(/mla login/);
  });

  it("is silent and exits 0 when readConfig throws (never breaks a hook)", async () => {
    const c = capture({
      readConfig: () => {
        throw new Error("cli-config.json corrupt");
      },
    });
    const code = await runInternalSessionNudge(["--cwd", "/repo"], c.deps);
    expect(code).toBe(0);
    expect(c.out).toHaveLength(0);
  });

  it("checks the git status of the resolved --cwd, not process.cwd()", async () => {
    const seen: string[] = [];
    const c = capture({ isGitRepo: (d: string) => (seen.push(d), false) });
    await runInternalSessionNudge(["--cwd", "/some/repo"], c.deps);
    expect(seen).toEqual(["/some/repo"]);
  });
});
