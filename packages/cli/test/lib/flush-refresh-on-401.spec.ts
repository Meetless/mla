import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Part 3 T7 (notes/20260611-mla-hook-token-autorefresh-proposal.md §B "Reactive
// refresh-on-401"): when a capture POST/PATCH to control returns HTTP 401 AND the
// session is `auth.mode == "user-token"`, flush.sh triggers ONE synchronous token
// refresh via `mla _internal refresh` and, only if it rotates a token (rc 0),
// re-reads the access token and retries the SAME request exactly once. Any other
// refresh outcome (busy 75 / expired 77 / not-attempted) leaves the existing
// fail-soft path untouched: warn once, re-spool, exit 0. This is the background
// counterpart to the enrich-path retry tested in intercept-hook.spec.ts; it covers
// sessions that never submit a prompt (pure background flushers).
//
// These drive the REAL src/hooks-template/flush.sh end-to-end (mirrors
// flush-fail-soft.spec.ts), stubbing only the external boundaries: `curl` (-> a
// PATH shim whose printed body is the HTTP status code, sequenced per call) and
// `mla` (-> the path in cli-config `.mlaPath`, a stub that records `_internal
// refresh` invocations and returns a chosen exit code).

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

// A stub `mla` that handles the three _internal subcommands flush.sh invokes:
//   - `_internal refresh`: records the call (so the test can count it) and exits
//     with the chosen code. On rc 0 it also rewrites the config's
//     auth.accessToken to "at_refreshed" so a retry can be observed to carry the
//     rotated token (faithful to the real refresh, which atomically writeConfig's
//     the new token before returning).
//   - `_internal steer-sync` / `_internal finalize-session`: no-op exit 0 (flush
//     calls these unconditionally; they must not interfere).
// refreshLog gets one line per refresh invocation; refreshCalls() reads it.
function writeMlaStub(tmp: string, refreshRc: number): { mlaPath: string; refreshCalls: () => number } {
  const binDir = path.join(tmp, "mlabin");
  fs.mkdirSync(binDir, { recursive: true });
  const mlaPath = path.join(binDir, "mla");
  const refreshLog = path.join(tmp, "refresh-calls.log");
  fs.writeFileSync(
    mlaPath,
    `#!/usr/bin/env bash
if [[ "$1 $2" == "_internal refresh" ]]; then
  printf '%s\\n' "$*" >> ${JSON.stringify(refreshLog)}
  if [[ "${refreshRc}" -eq 0 ]]; then
    CFG="\${MEETLESS_HOME}/cli-config.json"
    tmpf="$(mktemp)"
    jq '.auth.accessToken="at_refreshed"' "$CFG" > "$tmpf" 2>/dev/null && mv "$tmpf" "$CFG"
  fi
  exit ${refreshRc}
fi
exit 0
`,
    { mode: 0o755 },
  );
  const refreshCalls = () =>
    fs.existsSync(refreshLog)
      ? fs.readFileSync(refreshLog, "utf8").split("\n").filter((l) => l.trim().length > 0).length
      : 0;
  return { mlaPath, refreshCalls };
}

// A user-token cli-config: the retry gate keys on `.auth.mode == "user-token"`.
function makeUserTokenHome(tmp: string, mlaPath: string): string {
  const home = path.join(tmp, "home");
  fs.mkdirSync(home, { recursive: true });
  const cfg = {
    controlUrl: "http://127.0.0.1:1",
    workspaceId: "ws_test",
    actorUserId: "user_a",
    mlaPath,
    auth: {
      mode: "user-token",
      accessToken: "at_initial",
      refreshToken: "rt_initial",
      accessExpiresAt: "2999-01-01T00:00:00Z",
    },
  };
  fs.writeFileSync(path.join(home, "cli-config.json"), JSON.stringify(cfg));
  return home;
}

// A legacy shared-key config (no auth.mode): the retry gate must NOT fire.
function makeLegacyHome(tmp: string, mlaPath: string): string {
  const home = path.join(tmp, "home");
  fs.mkdirSync(home, { recursive: true });
  const cfg = {
    controlUrl: "http://127.0.0.1:1",
    controlToken: "shared-key-token",
    workspaceId: "ws_test",
    actorUserId: "user_a",
    mlaPath,
  };
  fs.writeFileSync(path.join(home, "cli-config.json"), JSON.stringify(cfg));
  return home;
}

// A curl shim that sequences responses: call N returns codes[min(N-1, len-1)].
// Prints the status code (body went to -o /dev/null) and exits 0 for 2xx / 22 for
// >= 400, exactly like `curl -fsS -w '%{http_code}'`. Records every invocation's
// args so a test can assert the retry carried the rotated token.
function writeSeqCurlShim(tmp: string, codes: string[]): { binDir: string; curlArgs: () => string[] } {
  const binDir = path.join(tmp, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const countFile = path.join(tmp, "curl-count");
  const argsLog = path.join(tmp, "curl-args.log");
  const codesBash = codes.map((c) => `'${c}'`).join(" ");
  fs.writeFileSync(
    path.join(binDir, "curl"),
    `#!/usr/bin/env bash
CODES=(${codesBash})
n=0
[[ -f ${JSON.stringify(countFile)} ]] && n="$(cat ${JSON.stringify(countFile)})"
printf '%s\\n' "$*" >> ${JSON.stringify(argsLog)}
idx="$n"
last=$(( \${#CODES[@]} - 1 ))
[[ "$idx" -gt "$last" ]] && idx="$last"
code="\${CODES[$idx]}"
n=$(( n + 1 ))
printf '%s' "$n" > ${JSON.stringify(countFile)}
printf '%s' "$code"
if [[ "$code" =~ ^2 ]]; then exit 0; else exit 22; fi
`,
    { mode: 0o755 },
  );
  const curlArgs = () =>
    fs.existsSync(argsLog)
      ? fs.readFileSync(argsLog, "utf8").split("\n").filter((l) => l.trim().length > 0)
      : [];
  return { binDir, curlArgs };
}

function seedQueue(queueDir: string, sessionId: string): string {
  fs.mkdirSync(queueDir, { recursive: true });
  const queueFile = path.join(queueDir, `${sessionId}.jsonl`);
  const started = {
    ts: "2026-06-11T00:00:00Z",
    event: "session_started",
    eventKey: "ek-start",
    sessionId,
    payload: { adapter: "claude_code", repoPath: "/tmp/x" },
  };
  const prompt = {
    ts: "2026-06-11T00:00:01Z",
    event: "prompt_submitted",
    eventKey: "ek-prompt",
    sessionId,
    payload: { text: "hello" },
  };
  fs.writeFileSync(queueFile, JSON.stringify(started) + "\n" + JSON.stringify(prompt) + "\n");
  fs.writeFileSync(path.join(queueDir, `${sessionId}.workspaceId`), "ws_test");
  return queueFile;
}

function readWarnings(home: string): string[] {
  const logPath = path.join(home, "logs", "capture-auth-warnings.log");
  if (!fs.existsSync(logPath)) return [];
  return fs.readFileSync(logPath, "utf8").split("\n").filter((l) => l.trim().length > 0);
}

function runFlush(
  stage: string,
  home: string,
  binDir: string,
  sessionId: string,
  extraEnv: Record<string, string> = {},
) {
  return spawnSync("bash", [path.join(stage, "flush.sh"), sessionId], {
    encoding: "utf8",
    env: {
      ...process.env,
      MEETLESS_HOME: home,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      ...extraEnv,
    },
  });
}

describe("flush.sh reactive refresh-on-401 (Part 3 T7)", () => {
  beforeAll(() => {
    const jq = spawnSync("jq", ["--version"], { encoding: "utf8" });
    if (jq.status !== 0) throw new Error("jq must be installed to run flush-refresh-on-401 specs");
    const flock = spawnSync("bash", ["-c", "command -v flock"], { encoding: "utf8" });
    if (flock.status !== 0) {
      throw new Error("flock must be installed (brew install util-linux) to run these specs");
    }
  });

  it("401 + refresh rotates (rc 0): retries with the rotated token, drains clean, no warning", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mla-flushrefresh-ok-"));
    try {
      const stage = stageHooksDir(tmp);
      const { mlaPath, refreshCalls } = writeMlaStub(tmp, 0);
      const home = makeUserTokenHome(tmp, mlaPath);
      const sessionId = "sess-refresh-ok";
      const queueFile = seedQueue(path.join(home, "queue"), sessionId);
      // Pass 1 first curl 401, then everything 200 (retry + Pass 2 PATCH).
      const { binDir, curlArgs } = writeSeqCurlShim(tmp, ["401", "200"]);

      const r = runFlush(stage, home, binDir, sessionId);
      expect(r.status).toBe(0);

      // Refresh fired exactly once (Pass 1's 401 only; Pass 2 saw 200, no refresh).
      expect(refreshCalls()).toBe(1);

      // The retry carried the ROTATED token, proving the re-read from config.
      const calls = curlArgs();
      expect(calls.length).toBeGreaterThanOrEqual(2);
      expect(calls[0]).toContain("Bearer at_initial");
      expect(calls[1]).toContain("Bearer at_refreshed");

      // Clean drain: no auth warning, no zombie spool.
      expect(readWarnings(home)).toEqual([]);
      expect(fs.existsSync(queueFile)).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("401 persists after refresh: retries at most once per pass, warns, re-spools, exits 0", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mla-flushrefresh-still401-"));
    try {
      const stage = stageHooksDir(tmp);
      const { mlaPath, refreshCalls } = writeMlaStub(tmp, 0);
      const home = makeUserTokenHome(tmp, mlaPath);
      const sessionId = "sess-still-401";
      const queueFile = seedQueue(path.join(home, "queue"), sessionId);
      // Every curl 401: refresh rotates but the token is still rejected.
      const { binDir, curlArgs } = writeSeqCurlShim(tmp, ["401"]);

      const r = runFlush(stage, home, binDir, sessionId);
      expect(r.status).toBe(0);

      // Refresh fired (once per failing pass: Pass 1 + Pass 2 = 2). No infinite
      // loop: each pass retried exactly once, so curl is bounded at 2 per pass.
      expect(refreshCalls()).toBeGreaterThanOrEqual(1);
      // Pass 1: 401 + one retry = 2 curls. Pass 2: 401 + one retry = 2 curls.
      expect(curlArgs().length).toBe(4);

      // Fail soft: warned once (401 in user-token mode -> mla login remedy),
      // events kept for retry, never blocked.
      const warnings = readWarnings(home);
      expect(warnings).toHaveLength(1);
      expect(fs.existsSync(queueFile)).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("401 + refresh busy (rc 75): does NOT retry, warns, re-spools, exits 0", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mla-flushrefresh-busy-"));
    try {
      const stage = stageHooksDir(tmp);
      const { mlaPath, refreshCalls } = writeMlaStub(tmp, 75);
      const home = makeUserTokenHome(tmp, mlaPath);
      const sessionId = "sess-busy";
      const queueFile = seedQueue(path.join(home, "queue"), sessionId);
      const { binDir, curlArgs } = writeSeqCurlShim(tmp, ["401"]);

      const r = runFlush(stage, home, binDir, sessionId);
      expect(r.status).toBe(0);

      expect(refreshCalls()).toBeGreaterThanOrEqual(1);
      // No retry on rc 75: exactly one curl per pass (Pass 1 + Pass 2 = 2).
      expect(curlArgs().length).toBe(2);
      expect(readWarnings(home)).toHaveLength(1);
      expect(fs.existsSync(queueFile)).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("401 + refresh expired (rc 77): does NOT retry, warns, re-spools, exits 0", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mla-flushrefresh-expired-"));
    try {
      const stage = stageHooksDir(tmp);
      const { mlaPath } = writeMlaStub(tmp, 77);
      const home = makeUserTokenHome(tmp, mlaPath);
      const sessionId = "sess-expired";
      const queueFile = seedQueue(path.join(home, "queue"), sessionId);
      const { binDir, curlArgs } = writeSeqCurlShim(tmp, ["401"]);

      const r = runFlush(stage, home, binDir, sessionId);
      expect(r.status).toBe(0);

      expect(curlArgs().length).toBe(2); // no retry
      expect(readWarnings(home)).toHaveLength(1);
      expect(fs.existsSync(queueFile)).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("legacy/shared-key config (no auth.mode): a 401 never triggers refresh (regression guard)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mla-flushrefresh-legacy-"));
    try {
      const stage = stageHooksDir(tmp);
      const { mlaPath, refreshCalls } = writeMlaStub(tmp, 0);
      const home = makeLegacyHome(tmp, mlaPath);
      const sessionId = "sess-legacy";
      const queueFile = seedQueue(path.join(home, "queue"), sessionId);
      const { binDir, curlArgs } = writeSeqCurlShim(tmp, ["401"]);

      const r = runFlush(stage, home, binDir, sessionId);
      expect(r.status).toBe(0);

      // No user-token mode => the gate never fires => no refresh, no retry.
      expect(refreshCalls()).toBe(0);
      expect(curlArgs().length).toBe(2); // one curl per pass, no retry
      expect(readWarnings(home)).toHaveLength(1);
      expect(fs.existsSync(queueFile)).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("ignores the removed MEETLESS_HOOK_AUTOREFRESH=0 flag: a 401 still triggers refresh", () => {
    // Auto-refresh is unconditional now; the old kill switch is inert. Setting it
    // to "0" must behave exactly like the normal still-401 path (refresh fires, the
    // request is retried once per pass). Regression guard against re-adding a gate.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mla-flushrefresh-flagignored-"));
    try {
      const stage = stageHooksDir(tmp);
      const { mlaPath, refreshCalls } = writeMlaStub(tmp, 0);
      const home = makeUserTokenHome(tmp, mlaPath);
      const sessionId = "sess-flag-ignored";
      const queueFile = seedQueue(path.join(home, "queue"), sessionId);
      const { binDir, curlArgs } = writeSeqCurlShim(tmp, ["401"]);

      const r = runFlush(stage, home, binDir, sessionId, {
        MEETLESS_HOOK_AUTOREFRESH: "0",
      });
      expect(r.status).toBe(0);

      // The flag is dead: refresh fired despite it, and the request retried once
      // per failing pass (Pass 1 + Pass 2 = 4 curls), still bounded (no loop).
      expect(refreshCalls()).toBeGreaterThanOrEqual(1);
      expect(curlArgs().length).toBe(4);
      expect(readWarnings(home)).toHaveLength(1);
      expect(fs.existsSync(queueFile)).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
