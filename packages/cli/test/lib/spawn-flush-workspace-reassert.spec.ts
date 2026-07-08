import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Regression lock for the missing-tail-turns bug, Bug A path (prod session
// 11436b5c, 2026-07-04): a folder activated MID-session.
//
// flush.sh is nohup-detached with cwd=$HOME and cannot walk up to the
// .meetless.json marker, so $QUEUE_DIR/<sid>.workspaceId is its ONLY workspace
// source. That sidecar is written by session-start.sh, which fires only on
// startup/resume/clear/compact, NEVER when `mla activate` opts a folder in
// after the Claude Code session already began. So the sidecar was never written,
// the detached flush resolved an empty workspace and exited before POSTing, and
// every post-activation turn was silently dropped.
//
// The fix: spawn_flush re-asserts the sidecar from the WORKSPACE_ID that every
// capture hook has already resolved via meetless_activated. This drives the REAL
// common.sh spawn_flush and asserts the sidecar is (re)created, without ever
// clobbering an existing good one.

const HOOKS_DIR = path.resolve(__dirname, "../../src/hooks-template");
const COMMON = path.join(HOOKS_DIR, "common.sh");

// A MEETLESS_HOME with a queue dir and a no-op hooks/flush.sh so spawn_flush's
// nohup detach succeeds cleanly. spawn_flush writes the sidecar SYNCHRONOUSLY
// before detaching, so we can assert it the instant spawn_flush returns.
function makeHome(tmp: string): string {
  const home = path.join(tmp, "home");
  fs.mkdirSync(path.join(home, "queue"), { recursive: true });
  fs.mkdirSync(path.join(home, "hooks"), { recursive: true });
  fs.writeFileSync(path.join(home, "hooks", "flush.sh"), "#!/usr/bin/env bash\nexit 0\n", {
    mode: 0o755,
  });
  // spawn_flush resolves flush.sh next to the sourced common.sh, so co-locate a
  // common.sh copy beside the fake flush; the self-relative resolve then targets
  // THIS fake flush, keeping the test hermetic rather than spawning the real one.
  fs.copyFileSync(COMMON, path.join(home, "hooks", "common.sh"));
  return home;
}

// Source the REAL common.sh, set WORKSPACE_ID (as meetless_activated would have),
// then call spawn_flush for sessionId. Returns after the synchronous sidecar
// write. MEETLESS_DEBUG=0 keeps the detached flush's stdio on /dev/null.
function runSpawnFlush(home: string, workspaceId: string, sessionId: string) {
  const script = `
set -euo pipefail
source "$1"
WORKSPACE_ID="$2"
spawn_flush "$3"
`;
  return spawnSync(
    "bash",
    ["-c", script, "runner", path.join(home, "hooks", "common.sh"), workspaceId, sessionId],
    {
      encoding: "utf8",
      env: { ...process.env, MEETLESS_HOME: home, MEETLESS_DEBUG: "0" },
    },
  );
}

describe("common.sh spawn_flush re-asserts the workspace sidecar", () => {
  it("creates .workspaceId when it is missing (mid-session activation)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mla-reassert-"));
    try {
      const home = makeHome(tmp);
      const sessionId = "sess-midactivate";
      const sidecar = path.join(home, "queue", `${sessionId}.workspaceId`);
      // Bug A precondition: session-start.sh never ran, so no sidecar exists.
      expect(fs.existsSync(sidecar)).toBe(false);

      const r = runSpawnFlush(home, "ws_reassert", sessionId);
      expect(r.status).toBe(0);

      // The fix: the next capture hook's spawn_flush minted the sidecar, so the
      // detached flush now has a workspace and can ship this and later turns.
      expect(fs.existsSync(sidecar)).toBe(true);
      expect(fs.readFileSync(sidecar, "utf8")).toBe("ws_reassert");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("does NOT overwrite an existing good sidecar", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mla-reassert-keep-"));
    try {
      const home = makeHome(tmp);
      const sessionId = "sess-hasit";
      const sidecar = path.join(home, "queue", `${sessionId}.workspaceId`);
      // session-start.sh already wrote the authoritative id. WORKSPACE_ID happens
      // to match in practice; assert the file is left byte-for-byte untouched by
      // seeding a DISTINCT value and proving spawn_flush never rewrites it.
      fs.writeFileSync(sidecar, "ws_from_session_start");

      const r = runSpawnFlush(home, "ws_different_would_be_wrong", sessionId);
      expect(r.status).toBe(0);

      expect(fs.readFileSync(sidecar, "utf8")).toBe("ws_from_session_start");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("writes nothing when no workspace is resolved (never a stray empty sidecar)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mla-reassert-empty-"));
    try {
      const home = makeHome(tmp);
      const sessionId = "sess-nows";
      const sidecar = path.join(home, "queue", `${sessionId}.workspaceId`);

      // WORKSPACE_ID empty (would not happen past the meetless_activated gate,
      // but the guard must never mint an empty sidecar that masks the real miss).
      const r = runSpawnFlush(home, "", sessionId);
      expect(r.status).toBe(0);

      expect(fs.existsSync(sidecar)).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
