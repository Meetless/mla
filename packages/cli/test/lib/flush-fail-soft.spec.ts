import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// T1.5 fail-soft (folder = workspace, notes/20260604-folder-equals-workspace-
// binding-design.md "Hook failure behavior (fail soft)"):
//
//   If a capture write returns 401 / 403 / 404, the hook records a local warning
//   and exits 0. It does not block the session. Repeated auth failures are
//   throttled (do not warn on every turn). This matters specifically because
//   "committed marker + not yet a member" is a common transient state during
//   team onboarding.
//
// These drive the REAL src/hooks-template/flush.sh end-to-end (mirrors
// flush-self-clean.spec.ts), stubbing only the external boundary (`curl` ->
// control) via a PATH shim whose printed body is the HTTP status code (flush.sh
// reads it via `curl -w '%{http_code}'`). A 403 here must: warn (once), re-spool
// (events kept), and exit 0 (never block).

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

// actorUserId defaults to a real actor so the common 403 case is the membership
// gap ("actor sent, not yet a member" -- the onboarding state these specs model).
// Pass null to omit it and exercise the OTHER 403 branch: the CLI sent no actor
// identity at all (a client-side cli-config gap). warn_capture_auth (common.sh)
// emits a different remedy per branch, so both need coverage.
function makeMeetlessHome(
  tmp: string,
  workspaceId = "ws_test",
  actorUserId: string | null = "user_a",
): string {
  const home = path.join(tmp, "home");
  fs.mkdirSync(home, { recursive: true });
  const cfg: Record<string, unknown> = {
    controlUrl: "http://127.0.0.1:1",
    controlToken: "test-token",
    workspaceId,
    mlaPath: "/bin/true",
  };
  if (actorUserId) cfg.actorUserId = actorUserId;
  fs.writeFileSync(path.join(home, "cli-config.json"), JSON.stringify(cfg));
  return home;
}

// A curl shim that faithfully emulates `curl -fsS -w '%{http_code}'`: it prints
// the chosen status code to stdout (the body went to -o /dev/null) and exits 0
// for a 2xx or 22 for any >= 400 (exactly how real `curl -f` behaves, while -w
// still emits the code). This lets the flusher branch on curl's exit code for
// success/failure and read the status code only to decide whether to warn.
function writeCurlCodeShim(tmp: string, httpCode: string): string {
  const binDir = path.join(tmp, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const exitCode = /^2\d\d$/.test(httpCode) ? 0 : 22;
  fs.writeFileSync(
    path.join(binDir, "curl"),
    `#!/usr/bin/env bash\nprintf '%s' '${httpCode}'\nexit ${exitCode}\n`,
    { mode: 0o755 },
  );
  return binDir;
}

function seedQueue(queueDir: string, sessionId: string): string {
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
  // T1.2 cutover: flush sources workspaceId from the sidecar, not cli-config.
  fs.writeFileSync(path.join(queueDir, `${sessionId}.workspaceId`), "ws_test");
  return queueFile;
}

function readWarnings(home: string): string[] {
  const logPath = path.join(home, "logs", "capture-auth-warnings.log");
  if (!fs.existsSync(logPath)) return [];
  return fs
    .readFileSync(logPath, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0);
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

describe("flush.sh fail-soft on 401/403/404 (T1.5)", () => {
  beforeAll(() => {
    const jq = spawnSync("jq", ["--version"], { encoding: "utf8" });
    if (jq.status !== 0) {
      throw new Error("jq must be installed to run flush-fail-soft specs");
    }
    const flock = spawnSync("bash", ["-c", "command -v flock"], { encoding: "utf8" });
    if (flock.status !== 0) {
      throw new Error(
        "flock must be installed (brew install util-linux) to run flush-fail-soft specs",
      );
    }
  });

  it("on a 403 membership gap: warns once (not-a-member remedy), re-spools, exits 0", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mla-failsoft-403-"));
    try {
      const stage = stageHooksDir(tmp);
      // An actor IS configured, so the 403 means "not yet a member" (the
      // onboarding state), not a missing-identity client gap.
      const home = makeMeetlessHome(tmp, "ws_test", "user_a");
      const sessionId = "sess-403";
      const queueFile = seedQueue(path.join(home, "queue"), sessionId);
      const binDir = writeCurlCodeShim(tmp, "403");

      const r = runFlush(stage, home, binDir, sessionId);

      // Fail soft: the session is never blocked.
      expect(r.status).toBe(0);

      // A single, actionable local warning was recorded (Pass 1 POST and Pass 2
      // PATCH both 403, but the throttle collapses them to one line per window).
      const warnings = readWarnings(home);
      expect(warnings).toHaveLength(1);
      // The membership branch names the actor and points at `mla activate`.
      expect(warnings[0]).toMatch(/member/i);
      expect(warnings[0]).toContain("user_a");
      expect(warnings[0]).toContain("ws_test");

      // Events are KEPT for retry (a 403 is the transient onboarding state).
      expect(fs.existsSync(queueFile)).toBe(true);
      const lines = fs
        .readFileSync(queueFile, "utf8")
        .split("\n")
        .filter((l) => l.length > 0);
      expect(lines.length).toBeGreaterThanOrEqual(2);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("on a 403 with NO actor configured: warns about missing identity, not membership", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mla-failsoft-403-noactor-"));
    try {
      const stage = stageHooksDir(tmp);
      // No actorUserId in cli-config: flush.sh sends no X-Meetless-Actor header, so
      // the 403 is a client-side identity gap, NOT a membership gap. Blaming
      // membership here would send the operator chasing a ghost (the bug 19b9ca4a
      // fixed); this locks the correct branch.
      const home = makeMeetlessHome(tmp, "ws_test", null);
      const sessionId = "sess-403-noactor";
      const queueFile = seedQueue(path.join(home, "queue"), sessionId);
      const binDir = writeCurlCodeShim(tmp, "403");

      const r = runFlush(stage, home, binDir, sessionId);
      expect(r.status).toBe(0);

      const warnings = readWarnings(home);
      expect(warnings).toHaveLength(1);
      // Missing-identity remedy: set actorUserId; NOT the membership remedy.
      expect(warnings[0]).toMatch(/no actor identity/i);
      expect(warnings[0]).toMatch(/actorUserId/);
      expect(warnings[0]).not.toMatch(/is not a member/i);
      expect(warnings[0]).toContain("ws_test");

      // Same fail-soft contract: events are kept for retry.
      expect(fs.existsSync(queueFile)).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("throttles across flushes: a second 403 flush in the same window does NOT re-warn", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mla-failsoft-throttle-"));
    try {
      const stage = stageHooksDir(tmp);
      const home = makeMeetlessHome(tmp);
      const sessionId = "sess-403-twice";
      seedQueue(path.join(home, "queue"), sessionId);
      const binDir = writeCurlCodeShim(tmp, "403");

      const r1 = runFlush(stage, home, binDir, sessionId);
      expect(r1.status).toBe(0);
      expect(readWarnings(home)).toHaveLength(1);

      // Second flush drains the re-spooled events, hits 403 again, but the
      // throttle (default 3600s) suppresses a duplicate warning.
      const r2 = runFlush(stage, home, binDir, sessionId);
      expect(r2.status).toBe(0);
      expect(readWarnings(home)).toHaveLength(1);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("on a clean 2xx: no warning is recorded and the spool drains", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mla-failsoft-200-"));
    try {
      const stage = stageHooksDir(tmp);
      const home = makeMeetlessHome(tmp);
      const sessionId = "sess-200";
      const queueFile = seedQueue(path.join(home, "queue"), sessionId);
      const binDir = writeCurlCodeShim(tmp, "200");

      const r = runFlush(stage, home, binDir, sessionId);
      expect(r.status).toBe(0);
      expect(readWarnings(home)).toEqual([]);
      // Clean drain leaves no zombie spool (RC1 self-clean still holds).
      expect(fs.existsSync(queueFile)).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("flush.sh captures the HTTP status (no bare `curl -fsS` capture write left)", () => {
    const src = fs.readFileSync(FLUSH, "utf8");
    // The capture writes must read the status code so 401/403/404 can fail soft.
    expect(src).toMatch(/-w '%\{http_code\}'/);
    // And must route those codes through the throttled warner.
    expect(src).toContain("warn_capture_auth");
  });
});
