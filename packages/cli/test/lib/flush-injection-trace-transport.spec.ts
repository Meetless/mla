import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// InjectionTrace keystone (notes/20260610-session-detail-as-governed-story-design-review.md
// §7.2 / §7.5 slice 2a, TEST 2). The hook spools an `injection_trace` line on
// every turn that injected Layer 2 relationship evidence; control diverts it to
// the InjectionTrace projection. Like every event-bearing line, it must pass
// flush.sh's TWO whitelists in lockstep (flush.sh:135 warns they must match):
//   - the forward path (event-batch-filter.jq) so a SUCCESSFUL flush PATCHes it,
//   - the re-spool failure path (flush.sh case) so a failed flush does not
//     silently DROP it (the exact silent-drop trap the agent_decision_captured
//     and tool_used_file comments already warn about).
//
// This spec drives the REAL src/hooks-template/flush.sh end-to-end (mirrors
// flush-file-event-respool.spec.ts), stubbing only the curl boundary. It locks:
//   1. On a 200, the injection_trace line survives the forward whitelist and
//      lands in the PATCHed events[] as eventType "injection_trace" with its
//      full trace payload (sourceSurface/deliveryStatus/turnIndex/contextItems)
//      intact under the generic claude_hook envelope.
//   2. On a Pass 2 PATCH failure, the injection_trace line is RE-SPOOLED, not
//      dropped (the failure-path whitelist must include injection_trace).

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

// An injection_trace line exactly as user-prompt-submit.sh spools it after a
// turn that injected Layer 2 evidence: {ts, event, eventKey, sessionId, payload}.
const TRACE_EVENT_KEY = "11111111-2222-3333-4444-555555555555";
const TRACE_LINE = JSON.stringify({
  ts: "2026-06-10T12:00:00-05:00",
  event: "injection_trace",
  eventKey: TRACE_EVENT_KEY,
  sessionId: "sess-trace",
  payload: {
    sourceSurface: "HOOK",
    turnIndex: 3,
    injectId: TRACE_EVENT_KEY,
    traceId: "0123456789abcdef0123456789abcdef",
    deliveryStatus: "INJECTED",
    schemaVersion: 1,
    status: "ok",
    confidence: 0.82,
    contextItems: [
      { citation: "DD:1", field: "relatedDecisions", injected: true, source_id: "dd_1" },
    ],
    markdown: "## Related decisions\n- DD:1",
    capturedAt: "2026-06-10T12:00:00-05:00",
  },
});

function seedQueueWithTraceEvent(queueDir: string, sessionId: string): string {
  fs.mkdirSync(queueDir, { recursive: true });
  const queueFile = path.join(queueDir, `${sessionId}.jsonl`);
  const started = JSON.stringify({
    ts: "2026-06-10T11:59:00-05:00",
    event: "session_started",
    eventKey: "ek-start",
    sessionId,
    payload: { adapter: "claude_code", repoPath: "/tmp/x" },
  });
  fs.writeFileSync(queueFile, started + "\n" + TRACE_LINE + "\n");
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

describe("flush.sh injection_trace transport (keystone TEST 2: dual whitelist)", () => {
  beforeAll(() => {
    const jq = spawnSync("jq", ["--version"], { encoding: "utf8" });
    if (jq.status !== 0) {
      throw new Error("jq must be installed to run flush-injection-trace-transport specs");
    }
    const flock = spawnSync("bash", ["-c", "command -v flock"], { encoding: "utf8" });
    if (flock.status !== 0) {
      throw new Error(
        "flock must be installed (brew install util-linux) to run flush-injection-trace-transport specs",
      );
    }
  });

  it("PATCHes an injection_trace event with its full trace payload intact on success", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mla-trace-transport-"));
    try {
      const stage = stageHooksDir(tmp);
      const home = makeMeetlessHome(tmp);
      const sessionId = "sess-trace";
      const queueFile = seedQueueWithTraceEvent(path.join(home, "queue"), sessionId);
      const captureFile = path.join(tmp, "patch-body.json");
      const binDir = writeCapturingCurlShim(tmp, "200", captureFile);

      const r = runFlush(stage, home, binDir, sessionId, captureFile);
      expect(r.status).toBe(0);

      expect(fs.existsSync(captureFile)).toBe(true);
      const body = JSON.parse(fs.readFileSync(captureFile, "utf8"));
      const traceEvents = body.events.filter(
        (e: { eventType: string }) => e.eventType === "injection_trace",
      );
      expect(traceEvents).toHaveLength(1);
      const ev = traceEvents[0];
      expect(ev.eventKey).toBe(TRACE_EVENT_KEY);
      // Generic claude_hook envelope (no agent_adapter provider/adapter fields).
      expect(ev.source).toBe("claude_hook");
      expect(ev.provider).toBeUndefined();
      expect(ev.adapter).toBeUndefined();
      // The trace payload survives intact: it is the InjectionTrace projection
      // source. deliveryStatus is the hook's own stamp, never derived downstream.
      expect(ev.payload.sourceSurface).toBe("HOOK");
      expect(ev.payload.deliveryStatus).toBe("INJECTED");
      expect(ev.payload.turnIndex).toBe(3);
      expect(ev.payload.injectId).toBe(TRACE_EVENT_KEY);
      expect(ev.payload.traceId).toBe("0123456789abcdef0123456789abcdef");
      expect(ev.payload.contextItems).toHaveLength(1);
      expect(ev.payload.contextItems[0].citation).toBe("DD:1");

      // Clean drain self-cleans the spool.
      expect(fs.existsSync(queueFile)).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("re-spools the injection_trace line on a Pass 2 PATCH failure (never silently dropped)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mla-trace-respool-"));
    try {
      const stage = stageHooksDir(tmp);
      const home = makeMeetlessHome(tmp);
      const sessionId = "sess-trace";
      const queueFile = seedQueueWithTraceEvent(path.join(home, "queue"), sessionId);
      const captureFile = path.join(tmp, "patch-body.json");
      // 500: Pass 1 POST and Pass 2 PATCH both fail; the trace must survive.
      const binDir = writeCapturingCurlShim(tmp, "500", captureFile);

      const r = runFlush(stage, home, binDir, sessionId, captureFile);
      // Fail soft: never blocks the session.
      expect(r.status).toBe(0);

      // The injection_trace line is kept in the spool for the next flush.
      expect(fs.existsSync(queueFile)).toBe(true);
      const lines = fs
        .readFileSync(queueFile, "utf8")
        .split("\n")
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l) as { event: string; eventKey: string });
      const traceEvent = lines.find((l) => l.event === "injection_trace");
      expect(traceEvent).toBeDefined();
      expect(traceEvent?.eventKey).toBe(TRACE_EVENT_KEY);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
