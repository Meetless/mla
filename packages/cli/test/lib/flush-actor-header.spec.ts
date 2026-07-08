import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// T1.4 transport gap (folder = workspace, notes/20260604-folder-equals-workspace-
// binding-design.md):
//
//   The T0.2 AgentReviewWorkspaceGuard rejects any capture write whose actor
//   cannot be resolved. resolveActorIdentity reads the actor ONLY from the
//   `X-Meetless-Actor` header (or a body `actorUserId`). T1.4 stamps that header
//   on every control request the TS http client makes (src/lib/http.ts), but the
//   actual capture transport is flush.sh, which does NOT use that client. If
//   flush.sh omits the header, EVERY capture write 403s ("Actor identity
//   required") and the T1.5 fail-soft silently re-spools forever -- capture is
//   100% down while looking healthy.
//
// These drive the REAL src/hooks-template/flush.sh end-to-end (mirrors
// flush-fail-soft.spec.ts), stubbing only the external boundary (`curl` ->
// control) via a PATH shim that records the argv it was called with. The
// assertion is that flush.sh stamps `X-Meetless-Actor: <actorUserId>` on BOTH
// capture passes (POST /agent-runs and PATCH .../events).

const HOOKS_DIR = path.resolve(__dirname, "../../src/hooks-template");
const FLUSH = path.join(HOOKS_DIR, "flush.sh");
const COMMON = path.join(HOOKS_DIR, "common.sh");

const ACTOR = "wu_test_owner";

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

function makeMeetlessHome(tmp: string, actorUserId = ACTOR): string {
  const home = path.join(tmp, "home");
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(
    path.join(home, "cli-config.json"),
    JSON.stringify({
      controlUrl: "http://127.0.0.1:1",
      controlToken: "test-token",
      actorUserId,
      mlaPath: "/bin/true",
    }),
  );
  return home;
}

// A curl shim that records its argv (newline-delimited, one invocation block per
// call separated by a sentinel) and then emulates `curl -w '%{http_code}'` with a
// clean 201. The recorded argv lets us assert which headers flush.sh sent.
function writeCurlRecordingShim(tmp: string, argsLog: string): string {
  const binDir = path.join(tmp, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    path.join(binDir, "curl"),
    `#!/usr/bin/env bash\n` +
      `printf -- '---CURL---\\n' >> '${argsLog}'\n` +
      `for a in "$@"; do printf '%s\\n' "$a" >> '${argsLog}'; done\n` +
      `printf '%s' '201'\n` +
      `exit 0\n`,
    { mode: 0o755 },
  );
  return binDir;
}

function seedQueue(queueDir: string, sessionId: string): void {
  fs.mkdirSync(queueDir, { recursive: true });
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
  fs.writeFileSync(path.join(queueDir, `${sessionId}.workspaceId`), "ws_test");
}

function runFlush(
  stage: string,
  home: string,
  binDir: string,
  sessionId: string,
) {
  return spawnSync("bash", [path.join(stage, "flush.sh"), sessionId], {
    encoding: "utf8",
    env: {
      ...process.env,
      MEETLESS_HOME: home,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    },
  });
}

describe("flush.sh stamps X-Meetless-Actor on capture writes (T1.4 transport)", () => {
  beforeAll(() => {
    const jq = spawnSync("jq", ["--version"], { encoding: "utf8" });
    if (jq.status !== 0) {
      throw new Error("jq must be installed to run flush-actor-header specs");
    }
    const flock = spawnSync("bash", ["-c", "command -v flock"], {
      encoding: "utf8",
    });
    if (flock.status !== 0) {
      throw new Error(
        "flock must be installed (brew install util-linux) to run flush-actor-header specs",
      );
    }
  });

  it("sends X-Meetless-Actor: <actorUserId> on BOTH the POST run and PATCH events writes", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mla-actor-header-"));
    try {
      const stage = stageHooksDir(tmp);
      const home = makeMeetlessHome(tmp);
      const argsLog = path.join(tmp, "curl-args.log");
      const binDir = writeCurlRecordingShim(tmp, argsLog);
      const sessionId = "sess-actor";
      seedQueue(path.join(home, "queue"), sessionId);

      const r = runFlush(stage, home, binDir, sessionId);
      expect(r.status).toBe(0);

      const recorded = fs.existsSync(argsLog)
        ? fs.readFileSync(argsLog, "utf8")
        : "";

      // Both capture passes fired against /agent-runs (POST run + PATCH events).
      const calls = recorded
        .split("---CURL---")
        .map((b) => b.trim())
        .filter((b) => b.includes("/internal/v1/agent-runs"));
      expect(calls.length).toBeGreaterThanOrEqual(2);

      // EVERY capture call to /agent-runs must carry the actor header, else the
      // T0.2 guard 403s it.
      for (const call of calls) {
        expect(call).toContain(`X-Meetless-Actor: ${ACTOR}`);
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("source guard: flush.sh reads actorUserId and stamps the X-Meetless-Actor header", () => {
    const src = fs.readFileSync(FLUSH, "utf8");
    expect(src).toContain("actorUserId");
    expect(src).toContain("X-Meetless-Actor");
  });
});
