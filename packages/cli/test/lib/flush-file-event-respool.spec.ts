import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Dogfood-audit 2026-06-10 (Bug 2): flush.sh Pass 2 has TWO whitelists.
//   - The forward path (event-batch-filter.jq) lists tool_used_file, so a
//     SUCCESSFUL flush PATCHes file events to control.
//   - The re-spool failure path (flush.sh case statement) did NOT, so a flush
//     that hits control-unreachable / 4xx silently DROPPED tool_used_file while
//     keeping tool_used_bash. A code-only session that fails one flush loses its
//     entire governed file trace with no error: the exact silent-drop trap the
//     agent_decision_captured whitelist comment already warns about.
//
// This spec drives the REAL src/hooks-template/flush.sh end-to-end (mirrors
// flush-decision-transport.spec.ts), stubbing only the curl boundary. It locks:
//   1. On a 200, a tool_used_file event survives the forward whitelist and lands
//      in the PATCHed events[] with its {tool, filePath} payload intact.
//   2. On a Pass 2 PATCH failure, the tool_used_file line is RE-SPOOLED, not
//      dropped (the failure-path whitelist must include the file event type).

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

// curl shim emulating `curl -fsS -w '%{http_code}'`: prints the chosen status
// (body went to -o /dev/null), exits 0 for 2xx / 22 for >= 400, and captures the
// events PATCH body to $MLA_CAPTURE_FILE so we can assert the transport payload.
function writeCapturingCurlShim(tmp: string, httpCode: string, captureFile: string): string {
  const binDir = path.join(tmp, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const exitCode = /^2\d\d$/.test(httpCode) ? 0 : 22;
  const shim = `#!/usr/bin/env bash
data=""
url=""
prev=""
for arg in "$@"; do
  if [[ "$prev" == "--data" || "$prev" == "--data-binary" ]]; then
    if [[ "$arg" == @* ]]; then data="$(cat "\${arg#@}")"; else data="$arg"; fi
  fi
  case "$arg" in
    http*) url="$arg" ;;
  esac
  prev="$arg"
done
case "$url" in
  */events) printf '%s' "$data" > "${captureFile}" ;;
esac
printf '%s' '${httpCode}'
exit ${exitCode}
`;
  fs.writeFileSync(path.join(binDir, "curl"), shim, { mode: 0o755 });
  return binDir;
}

// A tool_used_file line exactly as post-tool-use.sh spools it for an Edit:
//   {ts, event, eventKey, sessionId, payload:{tool, filePath}}
const FILE_EVENT_KEY = "tool_used_file:claude_code:toolu_file#0";
const FILE_LINE = JSON.stringify({
  ts: "2026-06-10T12:00:00-05:00",
  event: "tool_used_file",
  eventKey: FILE_EVENT_KEY,
  sessionId: "sess-file",
  payload: { tool: "Edit", filePath: "/repo/src/commands/kb_add.ts" },
});

function seedQueueWithFileEvent(queueDir: string, sessionId: string): string {
  fs.mkdirSync(queueDir, { recursive: true });
  const queueFile = path.join(queueDir, `${sessionId}.jsonl`);
  const started = JSON.stringify({
    ts: "2026-06-10T11:59:00-05:00",
    event: "session_started",
    eventKey: "ek-start",
    sessionId,
    payload: { adapter: "claude_code", repoPath: "/tmp/x" },
  });
  fs.writeFileSync(queueFile, started + "\n" + FILE_LINE + "\n");
  fs.writeFileSync(path.join(queueDir, `${sessionId}.workspaceId`), "ws_test");
  return queueFile;
}

function runFlush(stage: string, home: string, binDir: string, sessionId: string, captureFile: string) {
  return spawnSync("bash", [path.join(stage, "flush.sh"), sessionId], {
    encoding: "utf8",
    env: {
      ...process.env,
      MEETLESS_HOME: home,
      MLA_CAPTURE_FILE: captureFile,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    },
  });
}

describe("flush.sh tool_used_file transport (Bug 2: file-event whitelists)", () => {
  beforeAll(() => {
    const jq = spawnSync("jq", ["--version"], { encoding: "utf8" });
    if (jq.status !== 0) {
      throw new Error("jq must be installed to run flush-file-event-respool specs");
    }
    const flock = spawnSync("bash", ["-c", "command -v flock"], { encoding: "utf8" });
    if (flock.status !== 0) {
      throw new Error(
        "flock must be installed (brew install util-linux) to run flush-file-event-respool specs",
      );
    }
  });

  it("PATCHes a tool_used_file event with {tool, filePath} payload intact on success", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mla-file-transport-"));
    try {
      const stage = stageHooksDir(tmp);
      const home = makeMeetlessHome(tmp);
      const sessionId = "sess-file";
      const queueFile = seedQueueWithFileEvent(path.join(home, "queue"), sessionId);
      const captureFile = path.join(tmp, "patch-body.json");
      const binDir = writeCapturingCurlShim(tmp, "200", captureFile);

      const r = runFlush(stage, home, binDir, sessionId, captureFile);
      expect(r.status).toBe(0);

      expect(fs.existsSync(captureFile)).toBe(true);
      const body = JSON.parse(fs.readFileSync(captureFile, "utf8"));
      const fileEvents = body.events.filter(
        (e: { eventType: string }) => e.eventType === "tool_used_file",
      );
      expect(fileEvents).toHaveLength(1);
      const ev = fileEvents[0];
      expect(ev.eventKey).toBe(FILE_EVENT_KEY);
      expect(ev.source).toBe("claude_hook");
      expect(ev.payload.tool).toBe("Edit");
      expect(ev.payload.filePath).toBe("/repo/src/commands/kb_add.ts");

      // Clean drain self-cleans the spool.
      expect(fs.existsSync(queueFile)).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("re-spools the tool_used_file line on a Pass 2 PATCH failure (never silently dropped)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mla-file-respool-"));
    try {
      const stage = stageHooksDir(tmp);
      const home = makeMeetlessHome(tmp);
      const sessionId = "sess-file";
      const queueFile = seedQueueWithFileEvent(path.join(home, "queue"), sessionId);
      const captureFile = path.join(tmp, "patch-body.json");
      // 500: Pass 1 POST and Pass 2 PATCH both fail; the file event must survive.
      const binDir = writeCapturingCurlShim(tmp, "500", captureFile);

      const r = runFlush(stage, home, binDir, sessionId, captureFile);
      // Fail soft: never blocks the session.
      expect(r.status).toBe(0);

      // The tool_used_file line is kept in the spool for the next flush.
      expect(fs.existsSync(queueFile)).toBe(true);
      const lines = fs
        .readFileSync(queueFile, "utf8")
        .split("\n")
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l) as { event: string; eventKey: string });
      const fileEvent = lines.find((l) => l.event === "tool_used_file");
      expect(fileEvent).toBeDefined();
      expect(fileEvent?.eventKey).toBe(FILE_EVENT_KEY);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
