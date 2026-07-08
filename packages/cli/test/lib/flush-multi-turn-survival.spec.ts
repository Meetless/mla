import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Regression lock for the missing-tail-turns bug (prod session 11436b5c,
// 2026-07-04): a live, single-process Claude Code session captured its FIRST
// turn but silently dropped every LATER turn.
//
// Root cause: stop.sh spools finalize_requested on EVERY turn's Stop (Claude
// Code has no "session end" hook; Stop fires when the agent finishes each
// turn). flush.sh treated a successful finalize as session teardown and reaped
// the session-lifetime sidecars, above all .workspaceId, the ONLY source of
// the workspace id for the nohup-detached flush (cwd=$HOME, cannot resolve the
// marker). session-start.sh, the sidecar's writer, fires only on
// startup/resume/clear/compact, NEVER on a plain next turn. So after turn 1's
// finalize deleted .workspaceId, turn 2's flush found no workspace and exited
// before POSTing anything: earlier turn kept, later turn missing.
//
// This drives the REAL flush.sh twice (turn 1 = a full prompt/stop/finalize,
// turn 2 = a later prompt with NO intervening session-start) and asserts the
// later prompt still reaches control. It stubs only the external boundary: a
// capturing `curl` shim (records every request body, answers 200) and a no-op
// `mla` finalize stub (exit 0).

const HOOKS_DIR = path.resolve(__dirname, "../../src/hooks-template");
const FLUSH = path.join(HOOKS_DIR, "flush.sh");
const COMMON = path.join(HOOKS_DIR, "common.sh");
const FILTER = path.join(HOOKS_DIR, "event-batch-filter.jq");

function stageHooksDir(tmp: string): string {
  const stage = path.join(tmp, "hooks");
  fs.mkdirSync(stage, { recursive: true });
  fs.copyFileSync(COMMON, path.join(stage, "common.sh"));
  fs.copyFileSync(FLUSH, path.join(stage, "flush.sh"));
  fs.copyFileSync(FILTER, path.join(stage, "event-batch-filter.jq"));
  fs.chmodSync(path.join(stage, "flush.sh"), 0o755);
  return stage;
}

// A no-op `mla` stub so `mla _internal finalize-session` exits 0 and drives the
// finalize-OK branch (the branch that used to reap .workspaceId).
function writeMlaStub(tmp: string): string {
  const p = path.join(tmp, "mla-stub");
  fs.writeFileSync(p, `#!/usr/bin/env bash\nexit 0\n`, { mode: 0o755 });
  return p;
}

function makeMeetlessHome(tmp: string, mlaPath: string): string {
  const home = path.join(tmp, "home");
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(
    path.join(home, "cli-config.json"),
    JSON.stringify({
      controlUrl: "http://127.0.0.1:1",
      controlToken: "test-token",
      workspaceId: "ws_test",
      actorUserId: "user_a",
      mlaPath,
    }),
  );
  return home;
}

// A curl shim that emulates `curl -fsS -w '%{http_code}'` (prints 200, exits 0)
// AND records every request: its argv plus the bytes of any `--data-binary
// @<file>` body. The test greps this capture for the later prompt's marker to
// prove the event actually left for control.
function writeCapturingCurlShim(tmp: string, capturePath: string): string {
  const binDir = path.join(tmp, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const shim = `#!/usr/bin/env bash
{
  printf 'CALL'
  for a in "$@"; do printf ' %s' "$a"; done
  printf '\\n'
  for a in "$@"; do
    case "$a" in
      @*) cat "\${a#@}" 2>/dev/null || true; printf '\\n' ;;
    esac
  done
} >> ${JSON.stringify(capturePath)} 2>/dev/null || true
printf '%s' '200'
exit 0
`;
  fs.writeFileSync(path.join(binDir, "curl"), shim, { mode: 0o755 });
  return binDir;
}

function promptLine(sessionId: string, key: string, ts: string, prompt: string): string {
  return JSON.stringify({
    ts,
    event: "prompt_submitted",
    eventKey: key,
    sessionId,
    payload: { prompt, sessionTitle: "", turnId: null, turnIndex: 0 },
  });
}

function runFlush(stage: string, home: string, binDir: string, capture: string, sessionId: string) {
  return spawnSync("bash", [path.join(stage, "flush.sh"), sessionId], {
    encoding: "utf8",
    env: {
      ...process.env,
      MEETLESS_HOME: home,
      MEETLESS_DEBUG: "0",
      MLA_CURL_CAPTURE: capture,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    },
  });
}

describe("flush.sh preserves capture across turns of a live session", () => {
  beforeAll(() => {
    if (spawnSync("jq", ["--version"], { encoding: "utf8" }).status !== 0) {
      throw new Error("jq must be installed to run flush-multi-turn-survival specs");
    }
    if (spawnSync("bash", ["-c", "command -v flock"], { encoding: "utf8" }).status !== 0) {
      throw new Error("flock must be installed (brew install util-linux) to run these specs");
    }
  });

  it("still POSTs a later turn's prompt after an earlier turn finalized", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mla-multiturn-"));
    try {
      const stage = stageHooksDir(tmp);
      const home = makeMeetlessHome(tmp, writeMlaStub(tmp));
      const queueDir = path.join(home, "queue");
      fs.mkdirSync(queueDir, { recursive: true });
      const capture = path.join(tmp, "curl-capture.log");
      const binDir = writeCapturingCurlShim(tmp, capture);
      const sessionId = "sess-multiturn";

      // session-start.sh writes .workspaceId once, at session start. Model that:
      // the sidecar exists for turn 1, and NO later session-start rewrites it.
      fs.writeFileSync(path.join(queueDir, `${sessionId}.workspaceId`), "ws_test");
      fs.writeFileSync(path.join(queueDir, `${sessionId}.repoPath`), "/tmp/repo");
      fs.writeFileSync(path.join(queueDir, `${sessionId}.gitBaseline`), "deadbeef");
      fs.writeFileSync(path.join(queueDir, `${sessionId}.turn`), "1");

      // Turn 1: session_started + prompt A + session_stopped + finalize_requested.
      fs.writeFileSync(
        path.join(queueDir, `${sessionId}.jsonl`),
        [
          JSON.stringify({
            ts: "2026-07-04T11:59:00-05:00",
            event: "session_started",
            eventKey: "ek-start",
            sessionId,
            payload: { adapter: "claude_code", repoPath: "/tmp/repo" },
          }),
          promptLine(sessionId, "ek-prompt-a", "2026-07-04T11:59:10-05:00", "PROMPT_A_EARLIER"),
          JSON.stringify({
            ts: "2026-07-04T12:00:00-05:00",
            event: "session_stopped",
            eventKey: "ek-stop-1",
            sessionId,
            payload: { finalMessage: "turn 1 done" },
          }),
          JSON.stringify({
            event: "finalize_requested",
            eventKey: "ek-fin-1",
            sessionId,
            payload: {},
          }),
        ].join("\n") + "\n",
      );

      const r1 = runFlush(stage, home, binDir, capture, sessionId);
      expect(r1.status).toBe(0);
      // Sanity: the earlier prompt reached control.
      expect(fs.readFileSync(capture, "utf8")).toContain("PROMPT_A_EARLIER");

      // Turn 2: a later prompt in the SAME live process. No session-start fires,
      // so nothing rewrites .workspaceId. spool_append recreates the drained
      // spool with `>>`; model that with a fresh single-line spool.
      fs.writeFileSync(
        path.join(queueDir, `${sessionId}.jsonl`),
        promptLine(sessionId, "ek-prompt-b", "2026-07-04T12:05:00-05:00", "PROMPT_B_LATER") + "\n",
      );

      const r2 = runFlush(stage, home, binDir, capture, sessionId);
      expect(r2.status).toBe(0);

      // The heart of the bug: the later prompt MUST still reach control. Pre-fix,
      // turn 1's finalize deleted .workspaceId and this flush exited without any
      // POST, so the marker never appears.
      expect(fs.readFileSync(capture, "utf8")).toContain("PROMPT_B_LATER");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
