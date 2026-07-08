import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// ARG_MAX overflow regression (dogfood incident 2026-06-11). A real session
// accumulates hundreds-to-thousands of tool_used_* events; the Pass 2 events
// batch serializes to ~1-2 MB. Pre-fix flush.sh built that body by passing the
// whole array on the ARGV of `jq --argjson events "$EVENTS_JSON"` (flush.sh:283)
// and then `curl --data "$body"` (flush.sh:188). Multi-MB argv overflows execve
// (E2BIG, "Argument list too long"), so under `set -euo pipefail` the entire
// flush ABORTED at the jq build before any curl ran. Every captured event for a
// busy session was stranded in the local queue, invisible server-side.
//
// The fix keeps the body OFF argv end to end: the filter output is written to a
// file, the request body is assembled with `jq --slurpfile` (reads the file, no
// argv), and curl streams it with `--data-binary @<file>`. control's body limit
// is 10mb (bootstrap.ts), so a single streamed request is correct; no chunking.
//
// This spec drives the REAL src/hooks-template/flush.sh end to end (mirrors
// flush-injection-trace-transport.spec.ts), stubbing only the curl boundary. It
// seeds a deliberately large batch (well past every platform's single-arg limit:
// macOS ARG_MAX 1 MB, Linux MAX_ARG_STRLEN 128 KB) and locks:
//   1. The events PATCH body is handed to curl via `--data-binary @<file>`, NOT
//      inline on argv. This is the overflow-proof transport contract and is the
//      deterministic RED-on-pre-fix assertion (pre-fix used inline `--data`).
//   2. Every event survives transport: the PATCHed events[] has all N events.
//   3. flush exits 0 and the queue self-cleans (no abort, no re-spool).

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

// curl shim emulating `curl -fsS -w '%{http_code}'`. Records, for the events
// PATCH only: (a) the RESOLVED request body to $MLA_CAPTURE_FILE, and (b) the
// RAW `--data*` argument form to $MLA_FORM_FILE. The form file is how we prove
// the body was streamed from a file (`@<path>`) rather than passed inline on
// argv. Handles both `--data` and `--data-binary`, and both inline and `@file`
// forms, so this shim stays valid for any transport the flusher chooses.
function writeCapturingCurlShim(
  tmp: string,
  httpCode: string,
  captureFile: string,
  formFile: string,
): string {
  const binDir = path.join(tmp, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const exitCode = /^2\d\d$/.test(httpCode) ? 0 : 22;
  const shim = `#!/usr/bin/env bash
data=""
form=""
url=""
prev=""
for arg in "$@"; do
  if [[ "$prev" == "--data" || "$prev" == "--data-binary" ]]; then
    form="$arg"
    if [[ "$arg" == @* ]]; then data="$(cat "\${arg#@}")"; else data="$arg"; fi
  fi
  case "$arg" in
    http*) url="$arg" ;;
  esac
  prev="$arg"
done
case "$url" in
  */events)
    printf '%s' "$data" > "${captureFile}"
    printf '%s' "$form" > "${formFile}"
    ;;
esac
printf '%s' '${httpCode}'
exit ${exitCode}
`;
  fs.writeFileSync(path.join(binDir, "curl"), shim, { mode: 0o755 });
  return binDir;
}

const SESSION_ID = "sess-big";
// 1500 events x ~1 KB padded command -> ~1.7 MB events[] array. Comfortably past
// macOS ARG_MAX (1 MB total) and Linux MAX_ARG_STRLEN (128 KB single arg), so a
// pre-fix run genuinely overflows execve at the jq --argjson build.
const EVENT_COUNT = 1500;
const PAYLOAD_PAD = "x".repeat(1024);

function seedLargeQueue(queueDir: string, sessionId: string): string {
  fs.mkdirSync(queueDir, { recursive: true });
  const queueFile = path.join(queueDir, `${sessionId}.jsonl`);
  const lines: string[] = [
    JSON.stringify({
      ts: "2026-06-11T11:59:00-05:00",
      event: "session_started",
      eventKey: "ek-start",
      sessionId,
      payload: { adapter: "claude_code", repoPath: "/tmp/x" },
    }),
  ];
  for (let i = 0; i < EVENT_COUNT; i++) {
    lines.push(
      JSON.stringify({
        ts: "2026-06-11T12:00:00-05:00",
        event: "tool_used_bash",
        eventKey: `tool_used_bash:claude_code:cmd#${i}`,
        sessionId,
        payload: { command: `echo ${i} ${PAYLOAD_PAD}`, exitCode: 0 },
      }),
    );
  }
  fs.writeFileSync(queueFile, lines.join("\n") + "\n");
  fs.writeFileSync(path.join(queueDir, `${sessionId}.workspaceId`), "ws_test");
  return queueFile;
}

function runFlush(
  stage: string,
  home: string,
  binDir: string,
  sessionId: string,
  captureFile: string,
  formFile: string,
) {
  return spawnSync("bash", [path.join(stage, "flush.sh"), sessionId], {
    encoding: "utf8",
    env: {
      ...process.env,
      MEETLESS_HOME: home,
      MLA_CAPTURE_FILE: captureFile,
      MLA_FORM_FILE: formFile,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    },
  });
}

describe("flush.sh large-batch transport (ARG_MAX overflow regression)", () => {
  beforeAll(() => {
    const jq = spawnSync("jq", ["--version"], { encoding: "utf8" });
    if (jq.status !== 0) {
      throw new Error("jq must be installed to run flush-large-batch specs");
    }
    const flock = spawnSync("bash", ["-c", "command -v flock"], { encoding: "utf8" });
    if (flock.status !== 0) {
      throw new Error(
        "flock must be installed (brew install util-linux) to run flush-large-batch specs",
      );
    }
  });

  it("streams a multi-MB events batch via --data-binary @file and lands every event", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mla-large-batch-"));
    try {
      const home = makeMeetlessHome(tmp);
      const stage = stageHooksDir(tmp);
      const queueDir = path.join(home, "queue");
      const queueFile = seedLargeQueue(queueDir, SESSION_ID);
      const captureFile = path.join(tmp, "patched-body.json");
      const formFile = path.join(tmp, "data-arg-form.txt");
      const binDir = writeCapturingCurlShim(tmp, "200", captureFile, formFile);

      const res = runFlush(stage, home, binDir, SESSION_ID, captureFile, formFile);

      // 3. No abort: a clean drain exits 0.
      expect(res.status).toBe(0);

      // 1. Transport contract: the body was streamed from a file (@<path>), not
      // passed inline on argv. This is what makes a multi-MB body overflow-proof.
      expect(fs.existsSync(formFile)).toBe(true);
      const form = fs.readFileSync(formFile, "utf8");
      expect(form.startsWith("@")).toBe(true);

      // 2. Every event survived transport, intact, under the right workspace.
      expect(fs.existsSync(captureFile)).toBe(true);
      const body = JSON.parse(fs.readFileSync(captureFile, "utf8"));
      expect(body.workspaceId).toBe("ws_test");
      expect(Array.isArray(body.events)).toBe(true);
      expect(body.events).toHaveLength(EVENT_COUNT);
      expect(body.events[0].eventType).toBe("tool_used_bash");
      expect(body.events[0].payload.command).toContain(PAYLOAD_PAD);

      // 3. Clean drain self-cleans the emptied queue file (no re-spool, no abort).
      expect(fs.existsSync(queueFile)).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
