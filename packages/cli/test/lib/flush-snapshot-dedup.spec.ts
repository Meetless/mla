import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Dogfood incident 2026-06-22 (self-inflicted DDoS): flush.sh Pass 1 fires one
// `POST /internal/v1/agent-runs` per session_started line in the detached
// snapshot. During a control outage the spool can accumulate the SAME
// session_started line hundreds of thousands of times: Pass 1/2 re-spool the
// failed line, and a flush interrupted before its end-of-flush `rm -f "$TMP"`
// leaves a *.draining.$$ orphan that the next flush's orphan recovery cats back
// into the queue. Those two paths compound geometrically, so one session reached
// a 367MB spool with 859,723 identical session_started lines and Pass 1 hammered
// control with ~860k idempotent createRun POSTs.
//
// The fix collapses the detached snapshot by per-event eventKey BEFORE draining
// (loss-free: control already dedupes on (runId, eventKey)). These specs drive
// the REAL src/hooks-template/flush.sh end-to-end (mirrors
// flush-narration-respool.spec.ts), stubbing only the curl boundary, and lock:
//   1. N byte-identical session_started lines collapse to exactly ONE createRun
//      POST (the literal incident shape).
//   2. Lines sharing an eventKey but differing elsewhere (e.g. ts) still collapse
//      to ONE POST -- proving the key is eventKey, not the whole line.
//   3. Two DISTINCT eventKeys still produce TWO POSTs -- the dedup bounds the
//      flood without ever dropping a genuinely distinct event.

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

function makeMeetlessHome(tmp: string): string {
  const home = path.join(tmp, "home");
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(
    path.join(home, "cli-config.json"),
    JSON.stringify({
      controlUrl: "http://127.0.0.1:1",
      controlToken: "test-token",
      workspaceId: "ws_test",
      actorUserId: "user_a",
      // /bin/true: finalize-session is a no-op so Pass 3 never networks.
      mlaPath: "/bin/true",
    }),
  );
  return home;
}

// curl shim emulating `curl -fsS -w '%{http_code}'`: always 200/exit 0 so every
// POST/PATCH is treated as a clean success (nothing re-spools). It appends one
// line to $createRunCountFile for each `POST .../internal/v1/agent-runs` (Pass 1
// createRun) so we can count exactly how many createRun calls the snapshot
// produced after dedup. The events PATCH URL ends in `/events`, so it never
// matches the `*/agent-runs` arm.
function writeCountingCurlShim(tmp: string, createRunCountFile: string): string {
  const binDir = path.join(tmp, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const shim = `#!/usr/bin/env bash
url=""
for arg in "$@"; do
  case "$arg" in
    http*) url="$arg" ;;
  esac
done
case "$url" in
  */internal/v1/agent-runs) printf 'x\\n' >> "${createRunCountFile}" ;;
esac
printf '%s' '200'
exit 0
`;
  fs.writeFileSync(path.join(binDir, "curl"), shim, { mode: 0o755 });
  return binDir;
}

function startedLine(sessionId: string, eventKey: string, ts: string): string {
  return JSON.stringify({
    ts,
    event: "session_started",
    eventKey,
    sessionId,
    payload: { adapter: "claude_code", repoPath: "/tmp/x" },
  });
}

function seedQueue(queueDir: string, sessionId: string, lines: string[]): string {
  fs.mkdirSync(queueDir, { recursive: true });
  const queueFile = path.join(queueDir, `${sessionId}.jsonl`);
  fs.writeFileSync(queueFile, lines.join("\n") + "\n");
  fs.writeFileSync(path.join(queueDir, `${sessionId}.workspaceId`), "ws_test");
  return queueFile;
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

function countCreateRuns(file: string): number {
  if (!fs.existsSync(file)) return 0;
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.length > 0).length;
}

describe("flush.sh snapshot dedup (self-inflicted DDoS guard)", () => {
  beforeAll(() => {
    const jq = spawnSync("jq", ["--version"], { encoding: "utf8" });
    if (jq.status !== 0) {
      throw new Error("jq must be installed to run flush-snapshot-dedup specs");
    }
    const flock = spawnSync("bash", ["-c", "command -v flock"], { encoding: "utf8" });
    if (flock.status !== 0) {
      throw new Error(
        "flock must be installed (brew install util-linux) to run flush-snapshot-dedup specs",
      );
    }
  });

  it("collapses N byte-identical session_started lines to exactly ONE createRun POST", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mla-dedup-identical-"));
    try {
      const stage = stageHooksDir(tmp);
      const home = makeMeetlessHome(tmp);
      const sessionId = "sess-flood";
      // The literal incident shape: the same session_started line spooled 50x.
      const dup = startedLine(sessionId, "ek-start", "2026-06-22T11:59:00-05:00");
      const queueFile = seedQueue(path.join(home, "queue"), sessionId, Array(50).fill(dup));
      const countFile = path.join(tmp, "createruns.log");
      const binDir = writeCountingCurlShim(tmp, countFile);

      const r = runFlush(stage, home, binDir, sessionId);
      expect(r.status).toBe(0);

      // 50 identical copies -> 1 createRun POST. Without the dedup this is 50.
      expect(countCreateRuns(countFile)).toBe(1);
      // Clean drain self-cleans the spool.
      expect(fs.existsSync(queueFile)).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("collapses lines that share an eventKey but differ elsewhere (keyed by eventKey, not whole line)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mla-dedup-samekey-"));
    try {
      const stage = stageHooksDir(tmp);
      const home = makeMeetlessHome(tmp);
      const sessionId = "sess-flood";
      // Same eventKey, different ts on each line -> NOT byte-identical, but the
      // server dedupes on (runId, eventKey), so these must still collapse to 1.
      const lines = Array.from({ length: 20 }, (_, i) =>
        startedLine(sessionId, "ek-start", `2026-06-22T11:59:${String(i).padStart(2, "0")}-05:00`),
      );
      seedQueue(path.join(home, "queue"), sessionId, lines);
      const countFile = path.join(tmp, "createruns.log");
      const binDir = writeCountingCurlShim(tmp, countFile);

      const r = runFlush(stage, home, binDir, sessionId);
      expect(r.status).toBe(0);

      expect(countCreateRuns(countFile)).toBe(1);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("keeps DISTINCT eventKeys: two real session_started events still produce two createRun POSTs", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mla-dedup-distinct-"));
    try {
      const stage = stageHooksDir(tmp);
      const home = makeMeetlessHome(tmp);
      const sessionId = "sess-flood";
      // Two distinct events (different eventKey) interleaved with duplicates of
      // each. Dedup must collapse the duplicates but preserve both distinct keys.
      const a = startedLine(sessionId, "ek-a", "2026-06-22T11:59:00-05:00");
      const b = startedLine(sessionId, "ek-b", "2026-06-22T12:00:00-05:00");
      seedQueue(path.join(home, "queue"), sessionId, [a, a, a, b, b, a, b]);
      const countFile = path.join(tmp, "createruns.log");
      const binDir = writeCountingCurlShim(tmp, countFile);

      const r = runFlush(stage, home, binDir, sessionId);
      expect(r.status).toBe(0);

      expect(countCreateRuns(countFile)).toBe(2);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
