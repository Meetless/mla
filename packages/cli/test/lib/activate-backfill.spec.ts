import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// End-to-end lock for the pre-activation prompt back-fill wired into
// `mla activate` (dogfood 2026-07-03: a session activated mid-flight rendered
// its run + session_stopped but not its opening user turn). bootstrapCurrentSession
// must, BEFORE running session-start.sh, recover the genuine human prompts that
// predate activation from Claude Code's transcript and spool them as
// prompt_submitted lines. The flush that session-start.sh spawns then creates the
// run and attaches them. Here flush.sh is deliberately NOT staged, so the spool is
// not drained and we can assert its contents directly.

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

function userPromptLine(uuid: string, ts: string, text: string): string {
  return JSON.stringify({
    type: "user",
    uuid,
    timestamp: ts,
    message: { role: "user", content: text },
  });
}

async function runActivateIn(opts: {
  home: string;
  claudeConfigDir: string;
  cwd: string;
  sessionId: string;
}): Promise<number> {
  const prev = {
    cwd: process.cwd(),
    home: process.env.MEETLESS_HOME,
    claude: process.env.CLAUDE_CONFIG_DIR,
    sid: process.env.CLAUDE_CODE_SESSION_ID,
    debug: process.env.MEETLESS_DEBUG,
  };
  const spy = jest.spyOn(console, "log").mockImplementation(() => undefined);
  try {
    process.env.MEETLESS_HOME = opts.home;
    // The transcript scan roots at CLAUDE_CONFIG_DIR (Claude Code's own override);
    // unlike a runtime $HOME mutation, this is read fresh on every call.
    process.env.CLAUDE_CONFIG_DIR = opts.claudeConfigDir;
    process.env.MEETLESS_DEBUG = "0";
    process.env.CLAUDE_CODE_SESSION_ID = opts.sessionId;
    process.chdir(opts.cwd);
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require("../../src/commands/activate");
    return (await mod.runActivate([])) as number;
  } finally {
    process.chdir(prev.cwd);
    restore("MEETLESS_HOME", prev.home);
    restore("CLAUDE_CONFIG_DIR", prev.claude);
    restore("CLAUDE_CODE_SESSION_ID", prev.sid);
    restore("MEETLESS_DEBUG", prev.debug);
    spy.mockRestore();
  }
}

function restore(key: string, val: string | undefined): void {
  if (val === undefined) delete process.env[key];
  else process.env[key] = val;
}

describe("mla activate back-fills pre-activation prompts", () => {
  beforeAll(() => {
    const { spawnSync } = require("child_process");
    if (spawnSync("jq", ["--version"], { encoding: "utf8" }).status !== 0) {
      throw new Error("jq must be installed to run activate-backfill specs");
    }
  });

  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mla-bf-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("spools only the prompt that predates activatedAt, with a deterministic key", async () => {
    const home = stageHome(tmp);
    const claudeConfigDir = path.join(tmp, "dot-claude");
    const workdir = path.join(tmp, "repo");
    fs.mkdirSync(workdir);
    // Already-activated marker so activate takes the network-free BIND path and
    // does NOT rewrite activatedAt (the cutoff we control).
    fs.writeFileSync(
      path.join(workdir, ".meetless.json"),
      JSON.stringify({ workspaceId: "ws_test", activatedAt: "2026-07-03T10:05:00.000Z" }) + "\n",
    );
    const sid = "sess-bf-1";

    // Seed the live Claude Code transcript: one prompt BEFORE activation (dropped
    // by the gate) and one AFTER (captured live, must not be re-emitted).
    const projDir = path.join(claudeConfigDir, "projects", "-Users-me-repo");
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(
      path.join(projDir, `${sid}.jsonl`),
      [
        userPromptLine("pre1", "2026-07-03T10:00:00.000Z", "the dropped opening prompt"),
        userPromptLine("post1", "2026-07-03T10:30:00.000Z", "captured live later"),
      ].join("\n") + "\n",
    );

    const code = await runActivateIn({ home, claudeConfigDir, cwd: workdir, sessionId: sid });
    expect(code).toBe(0);

    // flush.sh was not staged, so the spool retains both the back-fill line and
    // the session_started line session-start.sh added.
    const spool = fs.readFileSync(path.join(home, "queue", `${sid}.jsonl`), "utf8");
    const events = spool
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));

    const backfilled = events.filter((e) => e.event === "prompt_submitted");
    expect(backfilled).toHaveLength(1);
    expect(backfilled[0].eventKey).toBe("backfill-pre1");
    expect(backfilled[0].payload.prompt).toBe("the dropped opening prompt");

    // The run anchor is present and the post-activation prompt was NOT re-emitted.
    expect(events.some((e) => e.event === "session_started")).toBe(true);
    expect(spool).not.toContain("captured live later");
    expect(spool).not.toContain("backfill-post1");
  });

  it("falls back to the marker mtime as the cutoff for a legacy no-activatedAt marker", async () => {
    const home = stageHome(tmp);
    const claudeConfigDir = path.join(tmp, "dot-claude");
    const workdir = path.join(tmp, "repo");
    fs.mkdirSync(workdir);
    // Legacy marker: workspaceId but no activatedAt. Stamp its mtime as the
    // activation instant so the cutoff comes from the file, not "now".
    const marker = path.join(workdir, ".meetless.json");
    fs.writeFileSync(marker, JSON.stringify({ workspaceId: "ws_test" }) + "\n");
    const markerMtime = new Date("2026-07-03T10:05:00.000Z");
    fs.utimesSync(marker, markerMtime, markerMtime);
    const sid = "sess-bf-legacy";

    const projDir = path.join(claudeConfigDir, "projects", "-Users-me-repo");
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(
      path.join(projDir, `${sid}.jsonl`),
      [
        userPromptLine("preL", "2026-07-03T10:00:00.000Z", "dropped before the marker"),
        userPromptLine("postL", "2026-07-03T10:30:00.000Z", "captured live after"),
      ].join("\n") + "\n",
    );

    const code = await runActivateIn({ home, claudeConfigDir, cwd: workdir, sessionId: sid });
    expect(code).toBe(0);

    const spool = fs.readFileSync(path.join(home, "queue", `${sid}.jsonl`), "utf8");
    const backfilled = spool
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
      .filter((e) => e.event === "prompt_submitted");
    expect(backfilled).toHaveLength(1);
    expect(backfilled[0].eventKey).toBe("backfill-preL");
    expect(spool).not.toContain("captured live after");
  });
});
