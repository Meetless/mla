import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Part 3 (notes/20260614-queue-prune-and-leak-fix-plan.md), corrected for the
// missing-tail-turns bug (prod session 11436b5c, 2026-07-04). This drives the
// REAL flush.sh end-to-end (mirrors flush-decision-transport.spec.ts), stubbing
// only the external boundary (`curl` -> control) with a 200 shim and a no-op
// finalize (mlaPath -> exit-code stub). What it locks:
//
//   A successful finalize of a fully-drained spool KEEPS every session-lifetime
//   sidecar. The original design reaped .repoPath, .gitBaseline and .workspaceId
//   on a clean finalize on the premise that finalize == session teardown. That
//   premise was false: Claude Code has NO session-end hook, so stop.sh spools
//   finalize_requested at the end of EVERY turn. Reaping .workspaceId there (the
//   only workspace source for the nohup-detached flush) stranded every later
//   turn (earlier turn kept, later turn missing). So the corrected invariant is:
//   a clean finalize removes ONLY the now-drained 0-byte spool (RC1) and leaves
//   all sidecars for the next turn; teardown of the sidecars is the 24h age-gated
//   idle reaper's job alone.

const HOOKS_DIR = path.resolve(__dirname, "../../src/hooks-template");
const FLUSH = path.join(HOOKS_DIR, "flush.sh");
const COMMON = path.join(HOOKS_DIR, "common.sh");
const FILTER = path.join(HOOKS_DIR, "event-batch-filter.jq");

// Every per-session sidecar flush.sh / the hooks may leave behind. All of them
// are session-lifetime: a clean finalize must KEEP the lot (only the 24h idle
// reaper clears them once the session is truly dead).
const ALL_SIDECARS = [
  ".repoPath",
  ".gitBaseline",
  ".workspaceId",
  ".turn",
  ".lock",
  ".hb",
  ".hb.lock",
  ".narration-cursor",
  ".narration-cursor.lock",
] as const;

function stageHooksDir(tmp: string): string {
  const stage = path.join(tmp, "hooks");
  fs.mkdirSync(stage, { recursive: true });
  fs.copyFileSync(COMMON, path.join(stage, "common.sh"));
  fs.copyFileSync(FLUSH, path.join(stage, "flush.sh"));
  fs.copyFileSync(FILTER, path.join(stage, "event-batch-filter.jq"));
  fs.chmodSync(path.join(stage, "flush.sh"), 0o755);
  return stage;
}

// An executable `mla` stub that exits with a fixed code. flush.sh runs
// `"$MLA_PATH" _internal finalize-session <sid>`; exit 0 drives the finalize-OK
// branch, non-zero drives the finalize-FAILED branch. (We can't lean on
// /bin/true: it is not present at that path on macOS, so config mlaPath would
// silently fall back to the real `mla` in PATH and hit a live control.)
function writeMlaStub(tmp: string, exitCode: number): string {
  const p = path.join(tmp, `mla-stub-${exitCode}`);
  fs.writeFileSync(p, `#!/usr/bin/env bash\nexit ${exitCode}\n`, { mode: 0o755 });
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

// A curl shim that emulates `curl -fsS -w '%{http_code}'`: prints 200 and exits
// 0 for every call (Pass 1 POST + Pass 2 PATCH both succeed -> EVENTS_OK stays 1).
function write200CurlShim(tmp: string): string {
  const binDir = path.join(tmp, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const shim = `#!/usr/bin/env bash
printf '%s' '200'
exit 0
`;
  fs.writeFileSync(path.join(binDir, "curl"), shim, { mode: 0o755 });
  return binDir;
}

function seedFinalizeQueue(queueDir: string, sessionId: string): void {
  fs.mkdirSync(queueDir, { recursive: true });
  const started = JSON.stringify({
    ts: "2026-06-14T11:59:00-05:00",
    event: "session_started",
    eventKey: "ek-start",
    sessionId,
    payload: { adapter: "claude_code", repoPath: "/tmp/x" },
  });
  const stopped = JSON.stringify({
    ts: "2026-06-14T12:00:00-05:00",
    event: "session_stopped",
    eventKey: "ek-stop",
    sessionId,
    payload: { finalMessage: "all done" },
  });
  const finalize = JSON.stringify({
    event: "finalize_requested",
    eventKey: "ek-fin",
    sessionId,
    payload: {},
  });
  fs.writeFileSync(
    path.join(queueDir, `${sessionId}.jsonl`),
    started + "\n" + stopped + "\n" + finalize + "\n",
  );
  for (const suffix of ALL_SIDECARS) {
    const body = suffix === ".workspaceId" ? "ws_test" : suffix === ".turn" ? "7" : "x";
    fs.writeFileSync(path.join(queueDir, `${sessionId}${suffix}`), body);
  }
}

function runFlush(stage: string, home: string, binDir: string, sessionId: string) {
  return spawnSync("bash", [path.join(stage, "flush.sh"), sessionId], {
    encoding: "utf8",
    env: {
      ...process.env,
      MEETLESS_HOME: home,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    },
  });
}

describe("flush.sh finalize-time sidecar reap (Part 3 hard gate)", () => {
  beforeAll(() => {
    const jq = spawnSync("jq", ["--version"], { encoding: "utf8" });
    if (jq.status !== 0) {
      throw new Error("jq must be installed to run flush-finalize-reap specs");
    }
    const flock = spawnSync("bash", ["-c", "command -v flock"], { encoding: "utf8" });
    if (flock.status !== 0) {
      throw new Error(
        "flock must be installed (brew install util-linux) to run flush-finalize-reap specs",
      );
    }
  });

  it("keeps every session-lifetime sidecar on a successful finalize; only the drained spool self-cleans", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mla-finalize-reap-"));
    try {
      const stage = stageHooksDir(tmp);
      const home = makeMeetlessHome(tmp, writeMlaStub(tmp, 0));
      const queueDir = path.join(home, "queue");
      const sessionId = "sess-fin";
      seedFinalizeQueue(queueDir, sessionId);
      const binDir = write200CurlShim(tmp);

      const r = runFlush(stage, home, binDir, sessionId);
      expect(r.status).toBe(0);

      const leftovers = fs
        .readdirSync(queueDir)
        .filter((f) => f.startsWith(sessionId))
        .sort();

      // Claude Code has no session-end hook: stop.sh spools finalize_requested at
      // the end of EVERY turn, so a successful finalize is NOT session teardown.
      // It must therefore leave the session-lifetime sidecars intact for the next
      // turn; reaping .workspaceId here is exactly what stranded every later
      // turn of prod session 11436b5c. Teardown of the sidecars is the 24h idle
      // reaper's job. The one thing that self-cleans is the now-drained 0-byte
      // spool (RC1), and no .draining temp may survive.
      expect(leftovers).not.toContain(`${sessionId}.jsonl`);
      expect(leftovers.some((f) => f.includes(".draining."))).toBe(false);
      const survivors = ALL_SIDECARS.filter((s) =>
        fs.existsSync(path.join(queueDir, `${sessionId}${s}`)),
      );
      expect(survivors).toEqual([...ALL_SIDECARS]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("preserves sidecars when finalize FAILS (retry must keep its baseline)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mla-finalize-keep-"));
    try {
      const stage = stageHooksDir(tmp);
      // mlaPath -> a stub that exits non-zero: finalize-session FAILS, the
      // finalize-OK branch is NOT taken, FINALIZE_OK stays 0, reap must NOT fire.
      const home = makeMeetlessHome(tmp, writeMlaStub(tmp, 1));
      const queueDir = path.join(home, "queue");
      const sessionId = "sess-fail";
      seedFinalizeQueue(queueDir, sessionId);
      const binDir = write200CurlShim(tmp);

      const r = runFlush(stage, home, binDir, sessionId);
      expect(r.status).toBe(0);

      // The retry baseline survives: .repoPath/.gitBaseline/.workspaceId AND the
      // re-spooled finalize_requested in the spool.
      expect(fs.existsSync(path.join(queueDir, `${sessionId}.gitBaseline`))).toBe(true);
      expect(fs.existsSync(path.join(queueDir, `${sessionId}.repoPath`))).toBe(true);
      expect(fs.existsSync(path.join(queueDir, `${sessionId}.jsonl`))).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
