import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Behavioral lock for the `mla activate` current-session bootstrap.
//
// Production capture is dir-wise: the `.meetless.json` marker gate decides
// which sessions are spooled, and a freshly-activated folder only captures the
// NEXT session because the current one's SessionStart hook already fired
// dormant. To get a single session working end-to-end without a restart,
// `mla activate` reuses the installed session-start.sh as the canonical writer
// when run inside a live Claude Code session (CLAUDE_CODE_SESSION_ID set): it
// writes the repoPath sidecar, spools session_started, and spawns flush for the
// current session. This spec proves that bootstrap fires when a session id is
// present and stays inert (NEXT-session message, no spool) when it is not.
//
// Determinism: the staged hooks dir intentionally OMITS flush.sh, so
// spawn_flush's nohup target is missing and no-ops (|| true). The sidecar and
// the session_started spool line are therefore never drained by a racing
// background flush.

const HOOKS_SRC = path.resolve(__dirname, "../../src/hooks-template");

function stageHome(tmp: string): string {
  const home = path.join(tmp, "home");
  const hooks = path.join(home, "hooks");
  fs.mkdirSync(hooks, { recursive: true });
  for (const f of ["common.sh", "session-start.sh"]) {
    fs.copyFileSync(path.join(HOOKS_SRC, f), path.join(hooks, f));
  }
  fs.chmodSync(path.join(hooks, "session-start.sh"), 0o755);
  fs.writeFileSync(
    path.join(home, "cli-config.json"),
    JSON.stringify({
      controlUrl: "http://127.0.0.1:1",
      controlToken: "test-token",
      workspaceId: "ws_test",
      mlaPath: "/bin/true",
    }),
  );
  return home;
}

interface ActivateRun {
  code: number;
  logs: string[];
}

// Run runActivate in-process with an isolated MEETLESS_HOME + cwd. MEETLESS_HOME
// must be set BEFORE requiring the command module because config.ts freezes
// HOOKS_DIR from the env at module load; jest.resetModules + require picks up
// the test home. CLAUDE_CODE_SESSION_ID is read at call time, so it can be set
// after require.
async function runActivateIn(opts: {
  home: string;
  cwd: string;
  sessionId?: string;
  argv?: string[];
}): Promise<ActivateRun> {
  const prevCwd = process.cwd();
  const prevHome = process.env.MEETLESS_HOME;
  const prevSid = process.env.CLAUDE_CODE_SESSION_ID;
  const prevDebug = process.env.MEETLESS_DEBUG;
  const logs: string[] = [];
  const spy = jest.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    logs.push(a.map(String).join(" "));
  });
  try {
    process.env.MEETLESS_HOME = opts.home;
    process.env.MEETLESS_DEBUG = "0";
    if (opts.sessionId) process.env.CLAUDE_CODE_SESSION_ID = opts.sessionId;
    else delete process.env.CLAUDE_CODE_SESSION_ID;
    process.chdir(opts.cwd);
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require("../../src/commands/activate");
    const code = (await mod.runActivate(opts.argv ?? [])) as number;
    return { code, logs };
  } finally {
    process.chdir(prevCwd);
    if (prevHome === undefined) delete process.env.MEETLESS_HOME;
    else process.env.MEETLESS_HOME = prevHome;
    if (prevSid === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = prevSid;
    if (prevDebug === undefined) delete process.env.MEETLESS_DEBUG;
    else process.env.MEETLESS_DEBUG = prevDebug;
    spy.mockRestore();
  }
}

describe("mla activate current-session bootstrap", () => {
  beforeAll(() => {
    const { spawnSync } = require("child_process");
    const jq = spawnSync("jq", ["--version"], { encoding: "utf8" });
    if (jq.status !== 0) {
      throw new Error("jq must be installed to run activate-bootstrap specs");
    }
  });

  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mla-boot-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("bootstraps the current session when CLAUDE_CODE_SESSION_ID is set", async () => {
    const home = stageHome(tmp);
    const workdir = path.join(tmp, "repo");
    fs.mkdirSync(workdir);
    // Pre-seed a marker so activate takes the network-free BIND path (T2.1's
    // provision path would POST to control, which the dead-port test config can
    // never reach). Bootstrap is independent of provision-vs-bind.
    fs.writeFileSync(
      path.join(workdir, ".meetless.json"),
      JSON.stringify({ workspaceId: "ws_test" }) + "\n",
    );
    const sid = "sess-boot-1";

    const r = await runActivateIn({ home, cwd: workdir, sessionId: sid });

    expect(r.code).toBe(0);
    // Marker present in the bound folder.
    expect(fs.existsSync(path.join(workdir, ".meetless.json"))).toBe(true);

    // session-start.sh ran for THIS session: repoPath sidecar points at the repo.
    const sidecar = path.join(home, "queue", `${sid}.repoPath`);
    expect(fs.existsSync(sidecar)).toBe(true);
    // session-start.sh records $PWD, which getcwd() reports as the physical
    // path (on macOS /var is a symlink to /private/var); compare via realpath.
    expect(fs.readFileSync(sidecar, "utf8")).toBe(fs.realpathSync(workdir));

    // session_started was spooled for this session.
    const spool = path.join(home, "queue", `${sid}.jsonl`);
    expect(fs.existsSync(spool)).toBe(true);
    expect(fs.readFileSync(spool, "utf8")).toContain('"event":"session_started"');

    expect(r.logs.join("\n")).toContain("active NOW for this session");
  });

  it("does NOT bootstrap (NEXT-session message, no spool) when no session id is present", async () => {
    const home = stageHome(tmp);
    const workdir = path.join(tmp, "repo");
    fs.mkdirSync(workdir);
    // Pre-seed a marker so activate takes the network-free BIND path (T2.1).
    fs.writeFileSync(
      path.join(workdir, ".meetless.json"),
      JSON.stringify({ workspaceId: "ws_test" }) + "\n",
    );

    const r = await runActivateIn({ home, cwd: workdir, sessionId: undefined });

    expect(r.code).toBe(0);
    expect(fs.existsSync(path.join(workdir, ".meetless.json"))).toBe(true);

    const queueDir = path.join(home, "queue");
    const files = fs.existsSync(queueDir) ? fs.readdirSync(queueDir) : [];
    expect(files).toEqual([]);

    expect(r.logs.join("\n")).toContain("NEXT Claude Code session");
  });

  it("bootstraps the current session even when the folder is already activated", async () => {
    const home = stageHome(tmp);
    const workdir = path.join(tmp, "repo");
    fs.mkdirSync(workdir);
    // Pre-existing marker (folder activated in a prior run).
    fs.writeFileSync(
      path.join(workdir, ".meetless.json"),
      JSON.stringify({ workspaceId: "ws_test" }) + "\n",
    );
    const sid = "sess-boot-2";

    const r = await runActivateIn({ home, cwd: workdir, sessionId: sid });

    expect(r.code).toBe(0);
    expect(r.logs.join("\n")).toContain("Already activated");
    // Bootstrap still fires for the current session.
    expect(fs.existsSync(path.join(home, "queue", `${sid}.repoPath`))).toBe(true);
    expect(r.logs.join("\n")).toContain("active NOW for this session");
  });

  // Re-activating a session that was muted with `mla mute` must clear the
  // sentinel FIRST, otherwise the bootstrap's own session-start.sh would be
  // short-circuited by meetless_session_disabled and capture would stay dead.
  it("clears a prior mute sentinel for the current session on re-activate", async () => {
    const home = stageHome(tmp);
    const workdir = path.join(tmp, "repo");
    fs.mkdirSync(workdir);
    // Pre-seed a marker so activate takes the network-free BIND path (T2.1).
    fs.writeFileSync(
      path.join(workdir, ".meetless.json"),
      JSON.stringify({ workspaceId: "ws_test" }) + "\n",
    );
    const sid = "sess-boot-3";

    // Simulate a prior `mla mute` for this session.
    const gateDir = path.join(home, "session-gate");
    fs.mkdirSync(gateDir, { recursive: true });
    const sentinel = path.join(gateDir, `${sid}.off`);
    fs.writeFileSync(sentinel, "2026-05-28T00:00:00Z\n");

    const r = await runActivateIn({ home, cwd: workdir, sessionId: sid });

    expect(r.code).toBe(0);
    expect(fs.existsSync(sentinel)).toBe(false);
    expect(r.logs.join("\n")).toContain("Cleared a prior `mla mute`");
    // Bootstrap fired (sentinel gone before session-start.sh ran).
    expect(fs.existsSync(path.join(home, "queue", `${sid}.repoPath`))).toBe(true);
  });
});

// NOTE: the old `mla deactivate` per-session OFF sentinel behavior moved to
// `mla mute` / `mla unmute` (T2.3, mute-unmute.spec.ts); `mla deactivate` is now
// workspace-binding removal (T2.2, deactivate-marker.spec.ts). The sentinel
// tests that lived here were migrated to those specs.
