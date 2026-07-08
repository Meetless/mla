import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// The SessionStart hook's detached session-reconcile glue. SessionStart fires
// spawn_reconcile, which (when enabled) detaches `mla session reconcile` so any
// Meetless AgentRun whose Claude Code transcript was deleted on disk is archived
// out of the Sessions list. Claude Code has no "session deleted" event, so this
// disk-reconciliation sweep is the only way to detect deletion; running it on
// SessionStart is the natural throttling tick (an archived row drops out of the
// default list, so steady state is one cheap GET). The sweep itself is covered by
// reconcile-sessions.spec.ts + session.spec.ts; here we lock (1) the default-on
// kill switch (MEETLESS_SESSION_RECONCILE), (2) the detached argv, and (3) that
// session-start.sh actually calls it (drift guard).

const HOOKS_DIR = path.resolve(__dirname, "../../src/hooks-template");
const COMMON = path.join(HOOKS_DIR, "common.sh");
const SESSION_START = path.join(HOOKS_DIR, "session-start.sh");

// Source common.sh in a clean MEETLESS_HOME whose cli-config.json points mlaPath
// at a recording shim, then run one command. Returns the shim's recorded argv
// lines (the detached child writes them; we poll until they appear).
function withRecordingMla(
  body: string,
  env: Record<string, string> = {},
): { recorded: string[]; tmp: string } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mla-reconspawn-"));
  const home = path.join(tmp, "home");
  fs.mkdirSync(path.join(home, "logs"), { recursive: true });

  const recFile = path.join(tmp, "invoked.args");
  const shim = path.join(tmp, "mla-shim.sh");
  fs.writeFileSync(shim, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${recFile}"\n`);
  fs.chmodSync(shim, 0o755);

  fs.writeFileSync(
    path.join(home, "cli-config.json"),
    JSON.stringify({
      controlUrl: "http://127.0.0.1:1",
      controlToken: "x",
      workspaceId: "ws_test",
      mlaPath: shim,
    }),
  );

  spawnSync("bash", ["-c", `source "${COMMON}"; ${body}`], {
    encoding: "utf8",
    env: { ...process.env, MEETLESS_HOME: home, MEETLESS_DEBUG: "0", ...env },
  });

  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (fs.existsSync(recFile)) break;
    spawnSync("sleep", ["0.05"]);
  }
  const recorded = fs.existsSync(recFile)
    ? fs.readFileSync(recFile, "utf8").split("\n").filter((l) => l.trim().length > 0)
    : [];
  return { recorded, tmp };
}

// Deterministic gate check: source common.sh, call the predicate, read exit code.
function gate(env: Record<string, string>): number {
  const r = spawnSync(
    "bash",
    ["-c", `source "${COMMON}"; session_reconcile_enabled; echo "rc=$?"`],
    { encoding: "utf8", env: { ...process.env, MEETLESS_HOME: os.tmpdir(), ...env } },
  );
  const m = /rc=(\d+)/.exec(r.stdout);
  return m ? Number(m[1]) : -1;
}

describe("common.sh session_reconcile_enabled (kill switch)", () => {
  beforeAll(() => {
    if (spawnSync("jq", ["--version"]).status !== 0) throw new Error("jq required");
  });

  it("is enabled by default (unset)", () => {
    expect(gate({})).toBe(0);
  });

  it("is enabled when MEETLESS_SESSION_RECONCILE=1", () => {
    expect(gate({ MEETLESS_SESSION_RECONCILE: "1" })).toBe(0);
  });

  it("is disabled (non-zero) when MEETLESS_SESSION_RECONCILE=0", () => {
    expect(gate({ MEETLESS_SESSION_RECONCILE: "0" })).not.toBe(0);
  });
});

describe("common.sh spawn_reconcile (detached deleted-session sweep)", () => {
  beforeAll(() => {
    if (spawnSync("jq", ["--version"]).status !== 0) throw new Error("jq required");
  });

  it("detaches `mla session reconcile` when enabled", () => {
    const { recorded, tmp } = withRecordingMla("spawn_reconcile");
    try {
      expect(recorded).toContain("session reconcile");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("is a no-op when the kill switch is off (MEETLESS_SESSION_RECONCILE=0)", () => {
    const { recorded, tmp } = withRecordingMla("spawn_reconcile", {
      MEETLESS_SESSION_RECONCILE: "0",
    });
    try {
      expect(recorded).toEqual([]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("session-start.sh wiring (drift guard)", () => {
  it("calls spawn_reconcile", () => {
    const src = fs.readFileSync(SESSION_START, "utf8");
    expect(src).toMatch(/spawn_reconcile/);
  });
});
