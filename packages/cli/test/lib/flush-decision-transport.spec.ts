import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// T16 (notes/20260608-agent-decision-capture-design.md sections 5/6): the
// HARD GATE for agent-decision capture transport. These drive the REAL
// src/hooks-template/flush.sh end-to-end (mirrors flush-fail-soft.spec.ts),
// stubbing only the external boundary (`curl` -> control) with a shim that
// CAPTURES the PATCH body so we can assert exactly what control would receive.
//
// What this locks:
//   1. A spooled `agent_decision_captured` event survives the Pass 2 jq
//      whitelist and lands in the PATCHed events[] (the silent-drop trap the
//      spec calls out: an unlisted event type vanishes with no error).
//   2. It carries the stronger transport envelope
//      { source: "agent_adapter", provider, adapter } with provider/adapter
//      mirroring the canonical payload (INV-ENVELOPE-PAYLOAD-CONSISTENCY).
//   3. The canonical payload reaches control intact (it is the row source).
//   4. On a Pass 2 PATCH failure the decision line is RE-SPOOLED, not dropped
//      (the flush.sh failure-path whitelist must include the decision type).

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

// A curl shim that faithfully emulates `curl -fsS -w '%{http_code}'`: it prints
// the chosen status code (the body went to -o /dev/null) and exits 0 for 2xx /
// 22 for >= 400. It ALSO captures the `--data` body of the events PATCH to
// $MLA_CAPTURE_FILE so the test can assert the exact transport payload.
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

const DECISION_LINE = JSON.stringify({
  ts: "2026-06-08T12:00:00-05:00",
  event: "agent_decision_captured",
  eventKey: "agent_decision_captured:claude_code:toolu_abc#0",
  sessionId: "sess-dec",
  payload: {
    provider: "claude_code",
    providerSource: "claude_hook",
    providerToolName: "AskUserQuestion",
    providerEventId: "toolu_abc#0",
    providerSessionId: "sess-dec",
    decisionKind: "choice",
    prompt: { title: "MCP scope", body: "what does write the mcp mean here?" },
    choices: [
      { id: "choice_0", label: "Verify existing MCP works", description: "..." },
      { id: "choice_1", label: "Extend existing MCP", description: "..." },
    ],
    answer: {
      type: "choice_label",
      value: "Verify existing MCP works",
      choiceId: "choice_0",
      choiceMatchStatus: "exact_unique",
      raw: "Verify existing MCP works",
    },
    multiSelect: false,
    turnIndex: 7,
    capturedBy: "post_tool_use",
    rawProviderPayload: { question: { title: "MCP scope" }, answer: "Verify existing MCP works" },
  },
});

function seedQueueWithDecision(queueDir: string, sessionId: string): string {
  fs.mkdirSync(queueDir, { recursive: true });
  const queueFile = path.join(queueDir, `${sessionId}.jsonl`);
  const started = JSON.stringify({
    ts: "2026-06-08T11:59:00-05:00",
    event: "session_started",
    eventKey: "ek-start",
    sessionId,
    payload: { adapter: "claude_code", repoPath: "/tmp/x" },
  });
  fs.writeFileSync(queueFile, started + "\n" + DECISION_LINE + "\n");
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

describe("flush.sh agent-decision transport (T16 hard gate)", () => {
  beforeAll(() => {
    const jq = spawnSync("jq", ["--version"], { encoding: "utf8" });
    if (jq.status !== 0) {
      throw new Error("jq must be installed to run flush-decision-transport specs");
    }
    const flock = spawnSync("bash", ["-c", "command -v flock"], { encoding: "utf8" });
    if (flock.status !== 0) {
      throw new Error(
        "flock must be installed (brew install util-linux) to run flush-decision-transport specs",
      );
    }
  });

  it("PATCHes a captured decision with the agent_adapter transport envelope and intact payload", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mla-dec-transport-"));
    try {
      const stage = stageHooksDir(tmp);
      const home = makeMeetlessHome(tmp);
      const sessionId = "sess-dec";
      const queueFile = seedQueueWithDecision(path.join(home, "queue"), sessionId);
      const captureFile = path.join(tmp, "patch-body.json");
      const binDir = writeCapturingCurlShim(tmp, "200", captureFile);

      const r = runFlush(stage, home, binDir, sessionId, captureFile);
      expect(r.status).toBe(0);

      // The events PATCH fired and we captured its body.
      expect(fs.existsSync(captureFile)).toBe(true);
      const body = JSON.parse(fs.readFileSync(captureFile, "utf8"));
      expect(body.workspaceId).toBe("ws_test");
      expect(Array.isArray(body.events)).toBe(true);

      // session_started is Pass 1 (line-by-line POST), never in the events[] batch.
      const decisions = body.events.filter(
        (e: { eventType: string }) => e.eventType === "agent_decision_captured",
      );
      expect(decisions).toHaveLength(1);
      const ev = decisions[0];

      // (2) transport envelope: stronger source model + provider/adapter mirror.
      expect(ev.source).toBe("agent_adapter");
      expect(ev.provider).toBe("claude_code");
      expect(ev.adapter).toBe("claude_hook");
      expect(ev.eventKey).toBe("agent_decision_captured:claude_code:toolu_abc#0");
      expect(ev.occurredAt).toBe("2026-06-08T12:00:00-05:00");

      // (3) canonical payload survives intact (it is the row materialization source).
      expect(ev.payload.providerEventId).toBe("toolu_abc#0");
      expect(ev.payload.decisionKind).toBe("choice");
      expect(ev.payload.answer.choiceId).toBe("choice_0");
      expect(ev.payload.answer.choiceMatchStatus).toBe("exact_unique");
      expect(ev.payload.capturedBy).toBe("post_tool_use");
      // envelope agrees with payload (INV-ENVELOPE-PAYLOAD-CONSISTENCY input).
      expect(ev.provider).toBe(ev.payload.provider);
      expect(ev.adapter).toBe(ev.payload.providerSource);

      // Clean drain self-cleans the spool.
      expect(fs.existsSync(queueFile)).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("re-spools the decision line on a Pass 2 PATCH failure (never silently dropped)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mla-dec-respool-"));
    try {
      const stage = stageHooksDir(tmp);
      const home = makeMeetlessHome(tmp);
      const sessionId = "sess-dec";
      const queueFile = seedQueueWithDecision(path.join(home, "queue"), sessionId);
      const captureFile = path.join(tmp, "patch-body.json");
      // 500: Pass 1 POST and Pass 2 PATCH both fail; events must be re-spooled.
      const binDir = writeCapturingCurlShim(tmp, "500", captureFile);

      const r = runFlush(stage, home, binDir, sessionId, captureFile);
      // Fail soft: never blocks the session.
      expect(r.status).toBe(0);

      // The decision line is kept in the spool for the next flush.
      expect(fs.existsSync(queueFile)).toBe(true);
      const lines = fs
        .readFileSync(queueFile, "utf8")
        .split("\n")
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l) as { event: string; eventKey: string });
      const decision = lines.find((l) => l.event === "agent_decision_captured");
      expect(decision).toBeDefined();
      expect(decision?.eventKey).toBe("agent_decision_captured:claude_code:toolu_abc#0");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
