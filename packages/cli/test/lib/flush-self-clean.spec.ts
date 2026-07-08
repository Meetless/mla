import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// RC1 (stale-session reaper, self-clean): a cleanly-drained session must leave
// NOTHING behind in the queue that queueDepth() would count as an "active
// session".
//
// The bug it locks down: stop.sh fires a flush at EVERY turn boundary, so the
// LAST turn of an ended session triggers the LAST flush. flush.sh truncated the
// spool to a 0-byte `<sid>.jsonl` (so concurrent writers landed in the new file)
// but only ever REMOVED an empty spool at the TOP of a *subsequent* flush
// (line ~55). For an ended session no subsequent flush comes, so the 0-byte
// spool lingered forever and `mla doctor` counted it among "N active sessions"
// (the phantom "25 active sessions, oldest age 149281s"). The fix removes the
// empty spool at end-of-flush, under the same lock spool_append uses, but ONLY
// when it is still empty (a re-spool on failure, or a concurrent next-turn
// append, must be preserved).
//
// These drive the REAL src/hooks-template/flush.sh end-to-end (mirrors
// repo-path-sidecar.spec.ts), stubbing only the external boundary (`curl` ->
// control) via a PATH shim.

const HOOKS_DIR = path.resolve(__dirname, "../../src/hooks-template");
const FLUSH = path.join(HOOKS_DIR, "flush.sh");
const COMMON = path.join(HOOKS_DIR, "common.sh");

function stageHooksDir(tmp: string): string {
  const stage = path.join(tmp, "hooks");
  fs.mkdirSync(stage, { recursive: true });
  fs.copyFileSync(COMMON, path.join(stage, "common.sh"));
  fs.copyFileSync(FLUSH, path.join(stage, "flush.sh"));
  const filter = path.join(HOOKS_DIR, "event-batch-filter.jq");
  if (fs.existsSync(filter)) {
    fs.copyFileSync(filter, path.join(stage, "event-batch-filter.jq"));
  }
  fs.chmodSync(path.join(stage, "flush.sh"), 0o755);
  return stage;
}

function makeMeetlessHome(tmp: string, workspaceId = "ws_test"): string {
  const home = path.join(tmp, "home");
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(
    path.join(home, "cli-config.json"),
    JSON.stringify({
      controlUrl: "http://127.0.0.1:1",
      controlToken: "test-token",
      workspaceId,
      mlaPath: "/bin/true",
    }),
  );
  return home;
}

// A curl shim with a controllable exit code: 0 = control reachable + 2xx,
// nonzero = control down / 4xx-5xx (curl -f exits 22). Lets each test choose
// whether the flush drains cleanly or re-spools.
function writeCurlShim(tmp: string, exitCode: number): string {
  const binDir = path.join(tmp, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    path.join(binDir, "curl"),
    `#!/usr/bin/env bash\nexit ${exitCode}\n`,
    { mode: 0o755 },
  );
  return binDir;
}

describe("flush.sh self-clean (RC1 stale-session reaper)", () => {
  beforeAll(() => {
    const jq = spawnSync("jq", ["--version"], { encoding: "utf8" });
    if (jq.status !== 0) {
      throw new Error("jq must be installed to run flush-self-clean specs");
    }
    const flock = spawnSync("bash", ["-c", "command -v flock"], { encoding: "utf8" });
    if (flock.status !== 0) {
      throw new Error("flock must be installed (brew install util-linux) to run flush-self-clean specs");
    }
  });

  it("removes the empty spool after a clean drain (no zombie .jsonl left behind)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mla-selfclean-ok-"));
    try {
      const stage = stageHooksDir(tmp);
      const home = makeMeetlessHome(tmp);
      const queueDir = path.join(home, "queue");
      fs.mkdirSync(queueDir, { recursive: true });

      const sessionId = "sess-clean";
      const queueFile = path.join(queueDir, `${sessionId}.jsonl`);
      // session_started (Pass 1) + prompt_submitted (Pass 2). No
      // finalize_requested, so Pass 3 is skipped and no mla hop is needed.
      const started = {
        ts: "2026-06-04T00:00:00Z",
        event: "session_started",
        eventKey: "ek-start",
        sessionId,
        payload: { adapter: "claude_code", repoPath: "/tmp/x" },
      };
      const prompt = {
        ts: "2026-06-04T00:00:01Z",
        event: "prompt_submitted",
        eventKey: "ek-prompt",
        sessionId,
        payload: { text: "hello" },
      };
      fs.writeFileSync(
        queueFile,
        JSON.stringify(started) + "\n" + JSON.stringify(prompt) + "\n",
      );
      // T1.2 cutover: flush sources workspaceId from the .workspaceId sidecar
      // (snapshotted at session start), not cli-config. Stage it so the batch
      // clears the empty-workspace guard and drains.
      fs.writeFileSync(path.join(queueDir, `${sessionId}.workspaceId`), "ws_test");

      const binDir = writeCurlShim(tmp, 0);
      const r = spawnSync("bash", [path.join(stage, "flush.sh"), sessionId], {
        encoding: "utf8",
        env: { ...process.env, MEETLESS_HOME: home, PATH: `${binDir}:${process.env.PATH ?? ""}` },
      });
      expect(r.status).toBe(0);

      // The whole point: a cleanly-flushed session leaves no spool behind, so
      // queueDepth() does not count it as active.
      expect(fs.existsSync(queueFile)).toBe(false);
      // And no draining snapshot is stranded either.
      const leftover = fs.readdirSync(queueDir).filter((f) => f.startsWith(`${sessionId}.jsonl`));
      expect(leftover).toEqual([]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("PRESERVES the spool when the flush re-spools on failure (no event loss)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mla-selfclean-fail-"));
    try {
      const stage = stageHooksDir(tmp);
      const home = makeMeetlessHome(tmp);
      const queueDir = path.join(home, "queue");
      fs.mkdirSync(queueDir, { recursive: true });

      const sessionId = "sess-respool";
      const queueFile = path.join(queueDir, `${sessionId}.jsonl`);
      const started = {
        ts: "2026-06-04T00:00:00Z",
        event: "session_started",
        eventKey: "ek-start",
        sessionId,
        payload: { adapter: "claude_code", repoPath: "/tmp/x" },
      };
      const prompt = {
        ts: "2026-06-04T00:00:01Z",
        event: "prompt_submitted",
        eventKey: "ek-prompt",
        sessionId,
        payload: { text: "hello" },
      };
      fs.writeFileSync(
        queueFile,
        JSON.stringify(started) + "\n" + JSON.stringify(prompt) + "\n",
      );
      // T1.2 cutover: workspaceId comes from the .workspaceId sidecar.
      fs.writeFileSync(path.join(queueDir, `${sessionId}.workspaceId`), "ws_test");

      // curl fails -> Pass 1 re-spools session_started, Pass 2 PATCH fails ->
      // EVENTS_OK=0 -> prompt_submitted re-spooled. Spool is non-empty at
      // end-of-flush and MUST survive so the next flush can retry.
      const binDir = writeCurlShim(tmp, 22);
      const r = spawnSync("bash", [path.join(stage, "flush.sh"), sessionId], {
        encoding: "utf8",
        env: { ...process.env, MEETLESS_HOME: home, PATH: `${binDir}:${process.env.PATH ?? ""}` },
      });
      expect(r.status).toBe(0);

      expect(fs.existsSync(queueFile)).toBe(true);
      const lines = fs.readFileSync(queueFile, "utf8").split("\n").filter((l) => l.length > 0);
      expect(lines.length).toBeGreaterThanOrEqual(2);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("KEEPS the end-of-flush empty-spool removal under lock (drift guard)", () => {
    const src = fs.readFileSync(FLUSH, "utf8");
    // The removal must be gated on emptiness so a re-spool or concurrent
    // append is never clobbered.
    expect(src).toMatch(/\[\[ -s "\$QUEUE_FILE" \]\] \|\| rm -f "\$QUEUE_FILE"/);
  });
});
