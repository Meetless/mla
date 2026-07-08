import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Behavioral lock for `mla mute` / `mla unmute` (folder = workspace, T2.3,
// notes/20260604-folder-equals-workspace-binding-design.md).
//
// `mute` / `unmute` are the per-SESSION capture toggle, split out of the old
// `mla deactivate` (which T2.2 repurposes into whole-folder marker removal).
// Mechanically unchanged from the old sentinel behavior:
//   - `mute`   drops a `<sid>.off` sentinel into SESSION_GATE_DIR for the
//              CURRENT live session, silencing capture AND Push. It does NOT
//              touch `.meetless.json`.
//   - `unmute` removes that sentinel for the current session. It does NOT touch
//              `.meetless.json`.
// Both refuse to run outside a live Claude Code session (no session id to key
// the sentinel on) and reject stray arguments.

function stageHome(tmp: string): string {
  const home = path.join(tmp, "home");
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(
    path.join(home, "cli-config.json"),
    JSON.stringify({
      controlUrl: "http://127.0.0.1:1",
      controlToken: "test-token",
      mlaPath: "/bin/true",
    }),
  );
  return home;
}

// Run a command export (runMute / runUnmute) in-process with an isolated
// MEETLESS_HOME. MEETLESS_HOME must be set BEFORE requiring the module because
// config.ts freezes SESSION_GATE_DIR from the env at module load. Captures both
// console.log and console.error so the error paths are assertable.
async function runCmd(opts: {
  fn: "runMute" | "runUnmute";
  home: string;
  sessionId?: string;
  argv?: string[];
}): Promise<{ code: number; logs: string[] }> {
  const prevHome = process.env.MEETLESS_HOME;
  const prevSid = process.env.CLAUDE_CODE_SESSION_ID;
  const logs: string[] = [];
  const push = (...a: unknown[]) => {
    logs.push(a.map(String).join(" "));
  };
  const outSpy = jest.spyOn(console, "log").mockImplementation(push);
  const errSpy = jest.spyOn(console, "error").mockImplementation(push);
  try {
    process.env.MEETLESS_HOME = opts.home;
    if (opts.sessionId) process.env.CLAUDE_CODE_SESSION_ID = opts.sessionId;
    else delete process.env.CLAUDE_CODE_SESSION_ID;
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require("../../src/commands/activate");
    const code = (await mod[opts.fn](opts.argv ?? [])) as number;
    return { code, logs };
  } finally {
    if (prevHome === undefined) delete process.env.MEETLESS_HOME;
    else process.env.MEETLESS_HOME = prevHome;
    if (prevSid === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = prevSid;
    errSpy.mockRestore();
    outSpy.mockRestore();
  }
}

describe("mla mute (per-session capture OFF)", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mla-mute-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("writes a <sid>.off sentinel for the current session", async () => {
    const home = stageHome(tmp);
    const sid = "sess-mute-1";

    const r = await runCmd({ fn: "runMute", home, sessionId: sid });

    expect(r.code).toBe(0);
    expect(fs.existsSync(path.join(home, "session-gate", `${sid}.off`))).toBe(true);
    expect(r.logs.join("\n")).toContain("capture AND Push are now OFF");
    // Points at the dedicated re-enable verb.
    expect(r.logs.join("\n")).toContain("mla unmute");
  });

  it("does NOT touch .meetless.json (session-scope only)", async () => {
    const home = stageHome(tmp);
    const sid = "sess-mute-mk";
    // A marker in cwd must survive a mute (mute is session-scope, not folder).
    const prevCwd = process.cwd();
    const workdir = path.join(tmp, "repo");
    fs.mkdirSync(workdir);
    fs.writeFileSync(path.join(workdir, ".meetless.json"), JSON.stringify({ workspaceId: "ws_x" }) + "\n");
    try {
      process.chdir(workdir);
      const r = await runCmd({ fn: "runMute", home, sessionId: sid });
      expect(r.code).toBe(0);
      expect(fs.existsSync(path.join(workdir, ".meetless.json"))).toBe(true);
    } finally {
      process.chdir(prevCwd);
    }
  });

  it("errors (exit 2, no sentinel) when not inside a session", async () => {
    const home = stageHome(tmp);

    const r = await runCmd({ fn: "runMute", home, sessionId: undefined });

    expect(r.code).toBe(2);
    const gateDir = path.join(home, "session-gate");
    const files = fs.existsSync(gateDir) ? fs.readdirSync(gateDir) : [];
    expect(files).toEqual([]);
    expect(r.logs.join("\n")).toContain("must run INSIDE a live Claude Code session");
  });

  it("rejects unexpected arguments (exit 2)", async () => {
    const home = stageHome(tmp);

    const r = await runCmd({ fn: "runMute", home, sessionId: "sess-mute-2", argv: ["--force"] });

    expect(r.code).toBe(2);
    expect(r.logs.join("\n")).toContain("takes no arguments");
  });
});

describe("mla unmute (per-session capture back ON)", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mla-unmute-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("removes the <sid>.off sentinel for the current session", async () => {
    const home = stageHome(tmp);
    const sid = "sess-unmute-1";
    const gateDir = path.join(home, "session-gate");
    fs.mkdirSync(gateDir, { recursive: true });
    const sentinel = path.join(gateDir, `${sid}.off`);
    fs.writeFileSync(sentinel, "2026-06-04T00:00:00Z\n");

    const r = await runCmd({ fn: "runUnmute", home, sessionId: sid });

    expect(r.code).toBe(0);
    expect(fs.existsSync(sentinel)).toBe(false);
    expect(r.logs.join("\n")).toContain("capture is back ON");
  });

  it("is a no-op (exit 0) when the session was not muted", async () => {
    const home = stageHome(tmp);
    const sid = "sess-unmute-2";

    const r = await runCmd({ fn: "runUnmute", home, sessionId: sid });

    expect(r.code).toBe(0);
    expect(r.logs.join("\n")).toContain("was not muted");
  });

  it("errors (exit 2) when not inside a session", async () => {
    const home = stageHome(tmp);

    const r = await runCmd({ fn: "runUnmute", home, sessionId: undefined });

    expect(r.code).toBe(2);
    expect(r.logs.join("\n")).toContain("must run INSIDE a live Claude Code session");
  });

  it("rejects unexpected arguments (exit 2)", async () => {
    const home = stageHome(tmp);

    const r = await runCmd({ fn: "runUnmute", home, sessionId: "sess-unmute-3", argv: ["x"] });

    expect(r.code).toBe(2);
    expect(r.logs.join("\n")).toContain("takes no arguments");
  });
});
