import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// F3-B throttled mid-turn liveness heartbeat.
//
// PostToolUse spools tool events but historically never flushed them, so during
// a long, tool-heavy turn (many tool calls spanning >5min between the
// prompt-submit flush and the Stop flush) control's lastSeenAt stayed pinned at
// turn start and deriveLiveness aged the session into IDLE while it was actively
// working. F3-B fires a detached flush at the TOP of every PostToolUse, at most
// once per MEETLESS_HEARTBEAT_THROTTLE_SECS per session, so the events already
// accumulated this turn forward periodically and lastSeenAt keeps advancing.
//
// The heartbeat spools NO new event (it only drains what is already queued), so
// the v0 privacy boundary holds: a Read/Grep turn still spools nothing. The
// flush is observed here via a stub flush.sh that records each invocation.

const HOOKS_DIR = path.resolve(__dirname, "../../src/hooks-template");
const HOOK = "post-tool-use.sh";

interface Harness {
  home: string;
  queueDir: string;
  workdir: string;
  flushLog: string;
  fire: (input: object, extraEnv?: Record<string, string>) => number;
  flushCount: () => number;
  waitForFlushCount: (expected: number, timeoutMs?: number) => number;
  queueLines: (sessionId: string) => Record<string, unknown>[];
}

function mkHarness(): { h: Harness; cleanup: () => void } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mla-heartbeat-"));
  fs.copyFileSync(path.join(HOOKS_DIR, "common.sh"), path.join(tmp, "common.sh"));
  fs.copyFileSync(path.join(HOOKS_DIR, HOOK), path.join(tmp, HOOK));
  fs.chmodSync(path.join(tmp, HOOK), 0o755);

  const home = path.join(tmp, "home");
  fs.mkdirSync(home);
  fs.writeFileSync(
    path.join(home, "cli-config.json"),
    JSON.stringify({
      controlUrl: "http://127.0.0.1:1",
      controlToken: "x",
      workspaceId: "ws_test",
      mlaPath: "/bin/true",
    }),
  );

  // Stub flush.sh co-located with the tmp/common.sh copy: spawn_flush resolves
  // flush.sh relative to common.sh's OWN dir (plugin-safe), so the stub must sit
  // beside it here, not under $MEETLESS_HOME/hooks. The stub appends one line per
  // invocation so the test can count heartbeat fires; it writes via $MEETLESS_HOME
  // (inherited by the detached process) so its log path is independent of the cwd.
  const flushLog = path.join(home, "flush-invocations.log");
  fs.writeFileSync(
    path.join(tmp, "flush.sh"),
    `#!/usr/bin/env bash\nprintf '%s %s\\n' "$1" "$$" >> "$MEETLESS_HOME/flush-invocations.log"\n`,
  );
  fs.chmodSync(path.join(tmp, "flush.sh"), 0o755);

  const workdir = path.join(tmp, "workdir");
  fs.mkdirSync(workdir);
  fs.writeFileSync(
    path.join(workdir, ".meetless.json"),
    JSON.stringify({ workspaceId: "ws_test" }),
  );

  const queueDir = path.join(home, "queue");
  const flushCount = () => {
    if (!fs.existsSync(flushLog)) return 0;
    return fs
      .readFileSync(flushLog, "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0).length;
  };

  const h: Harness = {
    home,
    queueDir,
    workdir,
    flushLog,
    fire: (input: object, extraEnv: Record<string, string> = {}) => {
      const r = spawnSync("bash", [path.join(tmp, HOOK)], {
        input: JSON.stringify(input),
        encoding: "utf8",
        cwd: workdir,
        env: { ...process.env, MEETLESS_HOME: home, MEETLESS_DEBUG: "0", ...extraEnv },
        timeout: 5000,
      });
      return r.status ?? -1;
    },
    flushCount,
    // spawn_flush detaches via nohup, so the stub may not have written by the
    // time spawnSync returns. Poll until the expected count appears or timeout.
    waitForFlushCount: (expected: number, timeoutMs = 3000) => {
      const deadline = Date.now() + timeoutMs;
      let n = flushCount();
      while (n < expected && Date.now() < deadline) {
        spawnSync("sleep", ["0.05"]);
        n = flushCount();
      }
      return n;
    },
    queueLines: (sessionId: string) => {
      const q = path.join(queueDir, `${sessionId}.jsonl`);
      if (!fs.existsSync(q)) return [];
      return fs
        .readFileSync(q, "utf8")
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l) as Record<string, unknown>);
    },
  };
  return { h, cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}

function readInput(sessionId: string, workdir: string) {
  return {
    session_id: sessionId,
    tool_name: "Read",
    tool_input: { file_path: path.join(workdir, "a.ts") },
    tool_response: { success: true },
  };
}

describe("post-tool-use.sh: F3-B throttled liveness heartbeat", () => {
  beforeAll(() => {
    const jq = spawnSync("jq", ["--version"], { encoding: "utf8" });
    if (jq.status !== 0) throw new Error("jq must be installed to run heartbeat specs");
  });

  it("fires a detached flush on the first PostToolUse of a turn, spooling no new event", () => {
    const { h, cleanup } = mkHarness();
    try {
      const status = h.fire(readInput("h1", h.workdir), {
        MEETLESS_HEARTBEAT_THROTTLE_SECS: "3600",
      });
      expect(status).toBe(0);
      expect(h.waitForFlushCount(1)).toBe(1);
      // A Read still spools nothing: the heartbeat only drains the queue.
      expect(h.queueLines("h1")).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it("throttles repeated tool calls to at most one flush per window", () => {
    const { h, cleanup } = mkHarness();
    try {
      for (let i = 0; i < 3; i++) {
        expect(
          h.fire(readInput("h2", h.workdir), { MEETLESS_HEARTBEAT_THROTTLE_SECS: "3600" }),
        ).toBe(0);
      }
      // Let the first detached flush land, then confirm no further fire crept in.
      expect(h.waitForFlushCount(1)).toBe(1);
      spawnSync("sleep", ["0.3"]);
      expect(h.flushCount()).toBe(1);
    } finally {
      cleanup();
    }
  });

  it("fires again once the throttle window has elapsed", () => {
    const { h, cleanup } = mkHarness();
    try {
      expect(
        h.fire(readInput("h3", h.workdir), { MEETLESS_HEARTBEAT_THROTTLE_SECS: "3600" }),
      ).toBe(0);
      expect(h.waitForFlushCount(1)).toBe(1);

      // Age the throttle sidecar past the window: the next fire must re-flush.
      fs.writeFileSync(path.join(h.queueDir, "h3.hb"), "1");
      expect(
        h.fire(readInput("h3", h.workdir), { MEETLESS_HEARTBEAT_THROTTLE_SECS: "3600" }),
      ).toBe(0);
      expect(h.waitForFlushCount(2)).toBe(2);
    } finally {
      cleanup();
    }
  });
});
