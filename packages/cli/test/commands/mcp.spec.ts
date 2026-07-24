import * as path from "path";
import type { CliConfig } from "../../src/lib/config";
import {
  NotActivatedError,
  MarkerMissingWorkspaceIdError,
  type WorkspaceContext,
} from "../../src/lib/workspace";
import {
  runMcp,
  type RunMcpDeps,
  type McpServerDeps,
  type ActiveMcpServerDeps,
} from "../../src/commands/mcp";
import { MCP_RESTART_EXIT_CODE } from "../../src/lib/mcp-restart";

// The server boots into a discriminated runtime. The wiring tests below assert
// the ACTIVE variant; narrow here so accessing active-only fields is type-safe
// and a regression that serves inactive deps fails loudly instead of `undefined`.
function active(d: McpServerDeps): ActiveMcpServerDeps {
  if (d.mode !== "active") {
    throw new Error(`expected an active server, got mode "${d.mode}"`);
  }
  return d;
}

// Slice 3 of the `mla mcp` refactor (notes/20260530-mla-init-browser-login-
// proposal.md keystone + 20260610-dogfood-issue-collection.md). `mla mcp` boots
// the Meetless MCP server authenticated as the logged-in human (cli-config
// user-token, auto-refreshing) and scoped to the workspace resolved from the
// nearest `.meetless.json` marker. NO service key, NO MEETLESS_WORKSPACE_ID env
// pin. This pins the command's guard logic and the closure wiring; the real
// stdio transport (startServer default) is proven by a runtime smoke, not jest.

function userTokenCfg(): CliConfig {
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

function sharedKeyCfg(): CliConfig {
  return {
    controlUrl: "http://control.test",
    controlToken: "internal-key",
    intelUrl: "http://intel.test",
    mlaPath: "/tmp/mla",
    auth: { mode: "shared-key", accessToken: "internal-key" },
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

function ctx(): WorkspaceContext {
  return {
    workspaceId: "ws_marker_123",
    workspaceName: "An's Workspace",
    markerPath: "/repo/.meetless.json",
    markerDir: "/repo",
  };
}

interface Harness {
  deps: RunMcpDeps;
  errors: string[];
  logs: string[];
  started: McpServerDeps[];
}

function harness(over: Partial<RunMcpDeps> = {}): Harness {
  const errors: string[] = [];
  const logs: string[] = [];
  const started: McpServerDeps[] = [];
  const deps: RunMcpDeps = {
    readConfig: () => userTokenCfg(),
    resolveWorkspaceContext: () => ctx(),
    startServer: async (d) => {
      started.push(d);
      return undefined;
    },
    errorLog: (m) => errors.push(m),
    log: (m) => logs.push(m),
    // No-op the real guard so the suite registers no process listeners / timers.
    installOrphanGuard: () => {},
    env: {},
    ...over,
  };
  return { deps, errors, logs, started };
}

describe("mla mcp — known-inactive states serve a green status-only server", () => {
  // The customer-facing fix: a KNOWN dormant state (not logged in, not activated,
  // broken marker) must complete the MCP handshake so Claude Code shows a
  // CONNECTED server, not a misleading red "failed to connect". The server is
  // served with inactive deps (status-only) and exits 0. Only a GENUINE, unexpected
  // failure (readConfig throws) stays red (exit 2).

  // INV-INACTIVE-QUIET: the Claude Code plugin registers `mla mcp` on EVERY
  // machine, so a logged-out / unactivated repo is the COMMON case, not an
  // error. This state must serve the status-only server (green handshake) and
  // exit 0, emitting exactly ONE benign breadcrumb to the MCP log; it must
  // never regress into a noisy red failure (exit 2 / crash). This case pins the
  // `auth: none` half of that invariant.
  it("serves inactive (not-authenticated) and exits 0 when not logged in", async () => {
    const h = harness({ readConfig: () => noneCfg() });
    const code = await runMcp([], h.deps);
    expect(code).toBe(0);
    expect(h.started).toHaveLength(1);
    const d = h.started[0];
    expect(d.mode).toBe("inactive");
    if (d.mode !== "inactive") throw new Error("unreachable");
    expect(d.status.reason).toBe("not-authenticated");
    expect(d.status.action.command).toBe("mla login");
    // Quiet, not silent: a single intentional "inactive" note to Claude Code's
    // MCP log, never a red crash line. A regression that started spewing errors
    // (or went silent) would break the "reads as intentional" contract.
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]).toMatch(/inactive/i);
  });

  it("stays red (exit 2, never starts) when readConfig throws (no cli-config.json)", async () => {
    const h = harness({
      readConfig: () => {
        throw new Error("cli-config.json not found at /x. Run 'mla init' first.");
      },
    });
    const code = await runMcp([], h.deps);
    expect(code).toBe(2);
    expect(h.started).toHaveLength(0);
  });

  it("serves inactive (not-activated) and exits 0 when no workspace marker is found", async () => {
    const h = harness({
      resolveWorkspaceContext: () => {
        throw new NotActivatedError("/tmp/nowhere");
      },
    });
    const code = await runMcp([], h.deps);
    expect(code).toBe(0);
    expect(h.started).toHaveLength(1);
    const d = h.started[0];
    expect(d.mode).toBe("inactive");
    if (d.mode !== "inactive") throw new Error("unreachable");
    expect(d.status.reason).toBe("not-activated");
    expect(d.status.action.command).toBe("mla activate");
  });

  it("serves inactive (invalid-activation) and exits 0 when the marker carries no workspaceId", async () => {
    const h = harness({
      resolveWorkspaceContext: () => {
        throw new MarkerMissingWorkspaceIdError("/repo/.meetless.json");
      },
    });
    const code = await runMcp([], h.deps);
    expect(code).toBe(0);
    expect(h.started).toHaveLength(1);
    const d = h.started[0];
    expect(d.mode).toBe("inactive");
    if (d.mode !== "inactive") throw new Error("unreachable");
    // Distinct from a missing activation: a present-but-broken marker routes to
    // `mla doctor`, not `mla activate`.
    expect(d.status.reason).toBe("invalid-activation");
    expect(d.status.action.command).toBe("mla doctor");
  });

  it("installs the orphan guard before serving even in an inactive state", async () => {
    const order: string[] = [];
    const h = harness({
      readConfig: () => noneCfg(),
      installOrphanGuard: () => order.push("guard"),
      startServer: async () => {
        order.push("serve");
        return undefined;
      },
    });
    const code = await runMcp([], h.deps);
    expect(code).toBe(0);
    expect(order).toEqual(["guard", "serve"]);
  });
});

describe("mla mcp — closure wiring", () => {
  it("on a healthy user-token + marker, injects cli-config closures and serves the MARKER workspace (no env pin)", async () => {
    const cfg = userTokenCfg();
    const controlFetch = jest.fn();
    const intelFetch = jest.fn();
    const intelAsk = jest.fn();
    const makeControlFetch = jest.fn(() => controlFetch);
    const makeIntelFetch = jest.fn(() => intelFetch);
    const makeIntelAsk = jest.fn(() => intelAsk);
    const h = harness({
      readConfig: () => cfg,
      makeControlFetch,
      makeIntelFetch,
      makeIntelAsk,
    });

    const code = await runMcp([], h.deps);

    expect(code).toBe(0);
    // Closures are built from the SAME cfg object so an in-run token rotation
    // (refreshUserToken mutates cfg in place) is visible to every later call.
    expect(makeControlFetch).toHaveBeenCalledWith(cfg);
    expect(makeIntelFetch).toHaveBeenCalledWith(cfg);
    expect(makeIntelAsk).toHaveBeenCalledWith(cfg);
    expect(h.started).toHaveLength(1);
    const d = active(h.started[0]);
    expect(d.defaultWorkspaceId).toBe("ws_marker_123");
    expect(d.controlFetch).toBe(controlFetch);
    expect(d.intelFetch).toBe(intelFetch);
    expect(d.intelAsk).toBe(intelAsk);
    expect(d.operatorUserId).toBe("u1");
    // A staleness probe is always wired so a server that outlives a rebuild can
    // warn instead of silently serving old code (the stale-dist footgun).
    expect(typeof d.staleCheck).toBe("function");
    // The MCP-evidence-failure sink is wired so a masked intel failure lands as a
    // sanitized local friction event (Item 5). server.js stays fs/env-pure; the
    // command owns the sink closure.
    expect(typeof d.recordFailure).toBe("function");
  });

  it("honors an injected makeStaleCheck and wires its probe onto the server deps", async () => {
    const probe = () => "STALE: restart your editor";
    const makeStaleCheck = jest.fn(() => probe);
    const h = harness({ makeStaleCheck });
    const code = await runMcp([], h.deps);
    expect(code).toBe(0);
    // Built once at boot (the spawn snapshot lives in the returned closure).
    expect(makeStaleCheck).toHaveBeenCalledTimes(1);
    expect(active(h.started[0]).staleCheck).toBe(probe);
  });

  it("allows shared-key mode (the sanctioned CI / headless service path) and serves the marker workspace", async () => {
    const h = harness({ readConfig: () => sharedKeyCfg() });
    const code = await runMcp([], h.deps);
    expect(code).toBe(0);
    expect(h.started).toHaveLength(1);
    const d = active(h.started[0]);
    expect(d.defaultWorkspaceId).toBe("ws_marker_123");
    // No user identity in shared-key mode.
    expect(d.operatorUserId).toBeNull();
  });

  it("honors MEETLESS_NOTES_ROOT, else derives notes as a sibling of the marker repo", async () => {
    const h1 = harness({ env: { MEETLESS_NOTES_ROOT: "/custom/notes" } });
    await runMcp([], h1.deps);
    expect(active(h1.started[0]).notesRoot).toBe("/custom/notes");

    const h2 = harness({ env: {} });
    await runMcp([], h2.deps);
    // markerDir "/repo" -> sibling "/notes" (projects/<x>/notes for the dogfood).
    expect(active(h2.started[0]).notesRoot).toBe(path.resolve("/repo", "..", "notes"));
  });
});

describe("mla mcp — self-heal child wiring", () => {
  // When the supervisor spawns this process as `mla mcp --child`, the worker
  // wires an onStaleRestart hook onto the server deps. The server's idle poller
  // calls it once a newer build lands on disk; the worker exits with the restart
  // sentinel so the parent respawns a fresh worker on the new dist. A bare /
  // kill-switched (non-child) run does NOT wire it, so it keeps the old single-
  // server behaviour with only the inline staleness warning.

  it("wires onStaleRestart when launched as the --child worker", async () => {
    const h = harness();
    const code = await runMcp(["--child"], h.deps);
    expect(code).toBe(0);
    expect(typeof active(h.started[0]).onStaleRestart).toBe("function");
  });

  it("wires onStaleRestart when MEETLESS_MCP_CHILD is set", async () => {
    const h = harness({ env: { MEETLESS_MCP_CHILD: "1" } });
    await runMcp([], h.deps);
    expect(typeof active(h.started[0]).onStaleRestart).toBe("function");
  });

  it("does NOT wire onStaleRestart for a bare (non-child) run", async () => {
    const h = harness();
    await runMcp([], h.deps);
    expect(active(h.started[0]).onStaleRestart).toBeNull();
  });

  it("the wired onStaleRestart exits the worker with MCP_RESTART_EXIT_CODE", async () => {
    const exits: number[] = [];
    const h = harness({ exit: (c: number) => exits.push(c) });
    await runMcp(["--child"], h.deps);
    const restart = active(h.started[0]).onStaleRestart;
    expect(restart).not.toBeNull();
    restart?.();
    expect(exits).toEqual([MCP_RESTART_EXIT_CODE]);
  });
});

describe("mla mcp — orphan guard wiring", () => {
  // The worker's MCP server resolves ONLY on stdin EOF. If the client dies
  // without closing the pipe the process would block forever as a pid-1 orphan.
  // runMcp must install the death backstops (signal handlers + ppid watchdog)
  // before it starts serving, for BOTH the supervised child and a bare run.

  it("installs the orphan guard before serving (bare run)", async () => {
    const order: string[] = [];
    const h = harness({
      installOrphanGuard: () => order.push("guard"),
      startServer: async () => {
        order.push("serve");
        return undefined;
      },
    });
    const code = await runMcp([], h.deps);
    expect(code).toBe(0);
    // Guard must be armed BEFORE the long-lived server blocks, or a disconnect
    // during startup could still orphan the process.
    expect(order).toEqual(["guard", "serve"]);
  });

  it("installs the orphan guard for the --child worker too", async () => {
    const installs: number[] = [];
    const h = harness({ installOrphanGuard: () => installs.push(1) });
    await runMcp(["--child"], h.deps);
    expect(installs).toHaveLength(1);
  });
});

describe("mla mcp — marker start dir (deterministic for a spawned daemon)", () => {
  // A spawned MCP server cannot `cd`; its launch cwd is whatever the client
  // chose and may sit outside the repo. So `mla mcp` must resolve the marker
  // start dir from an explicit client signal, not blindly trust process.cwd().
  function captureHarness(env: NodeJS.ProcessEnv): {
    deps: RunMcpDeps;
    calls: (string | undefined)[];
  } {
    const calls: (string | undefined)[] = [];
    const deps: RunMcpDeps = {
      readConfig: () => userTokenCfg(),
      resolveWorkspaceContext: (startDir?: string) => {
        calls.push(startDir);
        return ctx();
      },
      startServer: async () => undefined,
      errorLog: () => {},
      log: () => {},
      installOrphanGuard: () => {},
      env,
    };
    return { deps, calls };
  }

  it("uses MEETLESS_PROJECT_DIR as the marker start dir (client-agnostic pin)", async () => {
    const h = captureHarness({ MEETLESS_PROJECT_DIR: "/proj/repo" });
    const code = await runMcp([], h.deps);
    expect(code).toBe(0);
    expect(h.calls).toEqual(["/proj/repo"]);
  });

  it("falls back to CLAUDE_PROJECT_DIR when MEETLESS_PROJECT_DIR is unset (Claude Code sets it to the project root)", async () => {
    const h = captureHarness({ CLAUDE_PROJECT_DIR: "/cc/root" });
    await runMcp([], h.deps);
    expect(h.calls).toEqual(["/cc/root"]);
  });

  it("prefers MEETLESS_PROJECT_DIR over CLAUDE_PROJECT_DIR", async () => {
    const h = captureHarness({
      MEETLESS_PROJECT_DIR: "/explicit",
      CLAUDE_PROJECT_DIR: "/cc/root",
    });
    await runMcp([], h.deps);
    expect(h.calls).toEqual(["/explicit"]);
  });

  it("passes undefined (resolveWorkspaceContext's cwd fallback) when no project-dir env is set", async () => {
    const h = captureHarness({});
    await runMcp([], h.deps);
    expect(h.calls).toEqual([undefined]);
  });

  it("lets an explicit deps.startDir override the env (test / future --dir seam)", async () => {
    const h = captureHarness({ MEETLESS_PROJECT_DIR: "/from/env" });
    h.deps.startDir = "/from/flag";
    await runMcp([], h.deps);
    expect(h.calls).toEqual(["/from/flag"]);
  });
});
