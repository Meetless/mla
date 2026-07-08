import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Contract lock for the bash side of Part 3 (T5/T8): the `refresh_user_token`
// helper in common.sh. It is the SYNCHRONOUS, fail-soft trigger the two capture
// hooks (user-prompt-submit.sh enrich, flush.sh control POST) call on a 401 to
// drive the TS CLI's concurrency-safe `mla _internal refresh`. UNLIKE the
// detached spawn_* helpers, it runs in the foreground because the caller branches
// on its exit code: a reactive retry only re-runs the request when this returns 0.
//
// What this test pins:
//   - The subcommand's sysexits codes (0 / 75 / 77 / 64) pass straight through.
//   - A local sentinel 70 means "NOT ATTEMPTED" (the CLI could not be located),
//     distinct from any code the subcommand itself emits.
//   - Auto-refresh is ALWAYS on: there is no kill switch. The former
//     MEETLESS_HOOK_AUTOREFRESH env var is now inert and MUST be ignored (setting
//     it to "0" still spawns the refresh). Regression guard against re-adding a gate.
//   - The `--quiet` flag is always passed (defense in depth: no token in output).
//   - An optional first arg is forwarded as `--if-expiring-within <secs>` for the
//     proactive gate; with no arg the flag is absent.
//   - The helper is set -e-safe: common.sh runs under `set -euo pipefail`, so a
//     non-zero return must not abort the sourcing shell before we read the rc.

const COMMON_SH = path.resolve(__dirname, "../../src/hooks-template/common.sh");

interface RefreshRun {
  /** The rc `refresh_user_token` returned, captured via `|| rc=$?`. */
  rc: number;
  /** One line per stub invocation: the full arg string the stub `mla` saw. */
  stubArgs: string[];
}

// Source common.sh in a real bash, override the resolved MLA_PATH with a stub
// that records its args and exits with a chosen code, then call
// refresh_user_token and echo its rc. Returns the rc + the stub's arg log so the
// test can assert both the exit-code passthrough and the exact CLI invocation.
function runRefresh(opts: {
  home: string;
  /** Exit code the stub `mla` returns. Ignored when noMla is set. */
  exitCode?: number;
  /** Optional seconds arg passed to refresh_user_token (the proactive gate). */
  arg?: string;
  /** Point MLA_PATH at a non-existent file to model "CLI unlocatable". */
  noMla?: boolean;
  /** Extra env, e.g. { MEETLESS_HOOK_AUTOREFRESH: "0" }. */
  env?: Record<string, string>;
}): RefreshRun {
  const stubPath = path.join(opts.home, "mla-stub.sh");
  const argsLog = path.join(opts.home, "stub-args.log");
  if (!opts.noMla) {
    fs.writeFileSync(
      stubPath,
      `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(argsLog)}\nexit ${
        opts.exitCode ?? 0
      }\n`,
    );
    fs.chmodSync(stubPath, 0o755);
  }
  const mlaPath = opts.noMla ? path.join(opts.home, "does-not-exist") : stubPath;
  const callArg = opts.arg !== undefined ? ` ${JSON.stringify(opts.arg)}` : "";
  const script =
    [
      "source " + JSON.stringify(COMMON_SH),
      // Override the MLA_PATH common.sh resolved (config mlaPath / PATH lookup).
      `MLA_PATH=${JSON.stringify(mlaPath)}`,
      "rc=0",
      `refresh_user_token${callArg} || rc=$?`,
      'echo "RC=$rc"',
    ].join("\n") + "\n";

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MEETLESS_HOME: opts.home,
    ...(opts.env ?? {}),
  };
  const out = execFileSync("bash", ["-c", script], {
    cwd: opts.home,
    env,
    encoding: "utf8",
  });
  const m = out.match(/RC=(\d+)/);
  const rc = m ? Number(m[1]) : NaN;
  const stubArgs = fs.existsSync(argsLog)
    ? fs
        .readFileSync(argsLog, "utf8")
        .split("\n")
        .filter((l) => l.trim().length > 0)
    : [];
  return { rc, stubArgs };
}

describe("refresh_user_token (Part 3 bash helper)", () => {
  let tmp: string;
  let home: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mla-refreshhelper-"));
    home = path.join(tmp, "home");
    fs.mkdirSync(home, { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("passes through rc 0 when the subcommand reports refreshed", () => {
    const { rc, stubArgs } = runRefresh({ home, exitCode: 0 });
    expect(rc).toBe(0);
    expect(stubArgs).toHaveLength(1);
    // Always invokes the internal subcommand with --quiet (no token in output).
    expect(stubArgs[0]).toContain("_internal refresh");
    expect(stubArgs[0]).toContain("--quiet");
    // No proactive arg => no --if-expiring-within.
    expect(stubArgs[0]).not.toContain("--if-expiring-within");
  });

  it("passes through rc 75 (busy) without aborting the set -e sourcing shell", () => {
    const { rc, stubArgs } = runRefresh({ home, exitCode: 75 });
    expect(rc).toBe(75);
    expect(stubArgs).toHaveLength(1);
  });

  it("passes through rc 77 (expired refresh token)", () => {
    const { rc } = runRefresh({ home, exitCode: 77 });
    expect(rc).toBe(77);
  });

  it("passes through rc 64 (wrong mode / bad args)", () => {
    const { rc } = runRefresh({ home, exitCode: 64 });
    expect(rc).toBe(64);
  });

  it("ignores the removed MEETLESS_HOOK_AUTOREFRESH=0 flag and still refreshes", () => {
    // Auto-refresh is unconditional now; the old kill switch is inert. Setting it
    // to "0" must NOT suppress the spawn. Guards against re-introducing the gate.
    const { rc, stubArgs } = runRefresh({
      home,
      exitCode: 0,
      env: { MEETLESS_HOOK_AUTOREFRESH: "0" },
    });
    expect(rc).toBe(0);
    expect(stubArgs).toHaveLength(1); // spawned despite the flag
  });

  it("returns sentinel 70 when the CLI cannot be located", () => {
    const { rc } = runRefresh({ home, noMla: true });
    expect(rc).toBe(70);
  });

  it("forwards a seconds arg as --if-expiring-within <secs> for the proactive gate", () => {
    const { rc, stubArgs } = runRefresh({ home, exitCode: 0, arg: "600" });
    expect(rc).toBe(0);
    expect(stubArgs).toHaveLength(1);
    expect(stubArgs[0]).toContain("--if-expiring-within 600");
    expect(stubArgs[0]).toContain("--quiet");
  });

  it("refreshes unconditionally (no env needed; auto-refresh is always on)", () => {
    const { rc, stubArgs } = runRefresh({ home, exitCode: 0 });
    expect(rc).toBe(0);
    expect(stubArgs).toHaveLength(1);
  });
});
