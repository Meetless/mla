import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// T1.5 fail-soft (folder = workspace, notes/20260604-folder-equals-workspace-
// binding-design.md "Hook failure behavior (fail soft)"):
//
//   - If a capture write returns 401 / 403 / 404, the hook records a local
//     warning and exits 0. It does not block the session.
//   - Repeated auth failures are throttled (do not warn on every turn).
//
// The detached flusher (flush.sh) is the only thing that performs capture HTTP
// writes; on 401/403/404 it calls `warn_capture_auth` (common.sh), which records
// a throttled, human-readable local warning and keeps the queued events for a
// later retry (a 403 here is usually the transient "committed marker, token not
// yet a workspace member" onboarding state). This drives the real bash helper.

const COMMON_SH = path.resolve(__dirname, "../../src/hooks-template/common.sh");
const WARN_LOG = "capture-auth-warnings.log";

interface WarnRun {
  /** Lines appended to the human-readable warnings log. */
  warnings: string[];
}

// Source common.sh in a real bash and invoke warn_capture_auth N times with the
// given (code, endpoint). Returns the resulting warnings-log lines so the test can
// assert throttle behavior and message content.
function runWarn(opts: {
  home: string;
  calls: Array<{ code: string; endpoint?: string }>;
  throttleSecs?: number;
  workspaceId?: string;
  /**
   * The CLI actor key flush.sh resolved from cli-config (ACTOR_USER_ID). An empty
   * string models "the CLI sent no actor identity" (no X-Meetless-Actor header);
   * a non-empty value models "actor sent but server rejected it". Defaults to a
   * present actor so the membership-cause assertions stay exercised.
   */
  actorUserId?: string;
  /** Optional shell run between sourcing and the calls (e.g. backdate the throttle file). */
  preamble?: string;
}): WarnRun {
  const lines: string[] = [
    "source " + JSON.stringify(COMMON_SH),
    `WORKSPACE_ID=${JSON.stringify(opts.workspaceId ?? "ws_test")}`,
    `ACTOR_USER_ID=${JSON.stringify(opts.actorUserId ?? "wu_test")}`,
  ];
  if (opts.preamble) lines.push(opts.preamble);
  for (const c of opts.calls) {
    lines.push(
      `warn_capture_auth "sess-123" ${JSON.stringify(c.code)} ${JSON.stringify(
        c.endpoint ?? "POST /internal/v1/agent-runs",
      )}`,
    );
  }
  const script = lines.join("\n") + "\n";

  const env: NodeJS.ProcessEnv = { ...process.env, MEETLESS_HOME: opts.home };
  if (opts.throttleSecs !== undefined) {
    env.MEETLESS_AUTH_WARN_THROTTLE_SECS = String(opts.throttleSecs);
  }

  execFileSync("bash", ["-c", script], { cwd: opts.home, env, encoding: "utf8" });

  const logPath = path.join(opts.home, "logs", WARN_LOG);
  const warnings = fs.existsSync(logPath)
    ? fs
        .readFileSync(logPath, "utf8")
        .split("\n")
        .filter((l) => l.trim().length > 0)
    : [];
  return { warnings };
}

describe("warn_capture_auth (T1.5 fail-soft capture warning)", () => {
  let tmp: string;
  let home: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mla-authwarn-"));
    home = path.join(tmp, "home");
    fs.mkdirSync(home, { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("records one local warning on a 403 capture rejection", () => {
    const { warnings } = runWarn({
      home,
      throttleSecs: 3600,
      workspaceId: "ws_abc",
      calls: [{ code: "403" }],
    });
    expect(warnings).toHaveLength(1);
    // The 403 message names the membership cause and the affected workspace.
    expect(warnings[0]).toMatch(/member/i);
    expect(warnings[0]).toContain("ws_abc");
    // It also reassures that queued events are kept (capture is fail-soft).
    expect(warnings[0].toLowerCase()).toMatch(/kept|retry/);
  });

  it("403 distinguishes a missing actor identity from a real non-membership", () => {
    // Bug 3 (notes/20260604-mla-bug-report.md): the guard 403s for TWO different
    // reasons on a capture write. When the CLI sent no actor (ACTOR_USER_ID empty),
    // flush.sh omits the X-Meetless-Actor header and control rejects with "Actor
    // identity required" -- a CLIENT-side misconfig, not a membership gap. The old
    // message always blamed membership ("ask a workspace owner to add you"), which
    // sent the operator chasing a membership ghost. The two causes must read
    // differently.
    const { warnings: noActor } = runWarn({
      home,
      throttleSecs: 3600,
      workspaceId: "ws_abc",
      actorUserId: "",
      calls: [{ code: "403" }],
    });
    expect(noActor).toHaveLength(1);
    expect(noActor[0].toLowerCase()).toMatch(/actor identity|actoruserid/);
    expect(noActor[0]).not.toMatch(/not yet a member|not a member/i);
    expect(noActor[0]).toContain("ws_abc");

    // Actor WAS sent but is not a provisioned member: the membership message is the
    // correct one, and it names the rejected actor key so the cause is unambiguous.
    const home2 = path.join(tmp, "home-member");
    fs.mkdirSync(home2, { recursive: true });
    const { warnings: notMember } = runWarn({
      home: home2,
      throttleSecs: 3600,
      workspaceId: "ws_abc",
      actorUserId: "wu_ghost",
      calls: [{ code: "403" }],
    });
    expect(notMember).toHaveLength(1);
    expect(notMember[0]).toMatch(/not a member/i);
    expect(notMember[0]).toContain("wu_ghost");
  });

  it("throttles repeated auth failures: a second immediate 403 does NOT re-warn", () => {
    const { warnings } = runWarn({
      home,
      throttleSecs: 3600,
      calls: [{ code: "403" }, { code: "403" }, { code: "403" }],
    });
    // Three failures in the same throttle window => exactly one warning line.
    expect(warnings).toHaveLength(1);
  });

  it("re-warns once the stored throttle timestamp ages past the window", () => {
    // First call warns and stamps the throttle file. Backdate it to epoch 0, then
    // a second call sees age >> window and warns again: proves the gate reads the
    // persisted timestamp, not just in-process state.
    const { warnings } = runWarn({
      home,
      throttleSecs: 3600,
      calls: [{ code: "403" }],
    });
    expect(warnings).toHaveLength(1);

    const { warnings: after } = runWarn({
      home,
      throttleSecs: 3600,
      preamble: `printf '0\\n' > "$(capture_auth_warn_file sess-123)"`,
      calls: [{ code: "403" }],
    });
    expect(after).toHaveLength(2);
  });

  it("uses a distinct, actionable message per auth status (401 token, 404 not-found)", () => {
    const { warnings: w401 } = runWarn({
      home,
      throttleSecs: 3600,
      calls: [{ code: "401" }],
    });
    expect(w401).toHaveLength(1);
    expect(w401[0].toLowerCase()).toMatch(/token/);

    // Fresh home so the throttle file does not suppress the 404 case.
    const home2 = path.join(tmp, "home2");
    fs.mkdirSync(home2, { recursive: true });
    const { warnings: w404 } = runWarn({
      home: home2,
      throttleSecs: 3600,
      workspaceId: "ws_gone",
      calls: [{ code: "404" }],
    });
    expect(w404).toHaveLength(1);
    expect(w404[0].toLowerCase()).toMatch(/not found|deleted|repair/);
    expect(w404[0]).toContain("ws_gone");
  });

  it("401 advises `mla login` in user-token mode, not `mla init --control-token`", () => {
    // Bug (this session): the operator authenticated with `mla login` (user-token
    // mode: browser OAuth + a refresh token). When that session's access token
    // expired, the 401 capture warning told them to run `mla init --control-token
    // <token>`, which is the SHARED-KEY recovery path and would downgrade an audited
    // human identity to the anonymous workspace key (and readConfig() now HARD-ERRORS
    // if MEETLESS_CONTROL_TOKEN is set over a user-token session). A user-token
    // session must instead be told to re-authenticate with `mla login`.
    fs.writeFileSync(
      path.join(home, "cli-config.json"),
      JSON.stringify({ auth: { mode: "user-token" } }),
    );
    const { warnings } = runWarn({
      home,
      throttleSecs: 3600,
      calls: [{ code: "401" }],
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/mla login/);
    expect(warnings[0]).not.toMatch(/control-token/);
  });

  it("401 keeps the `mla init --control-token` advice in shared-key mode", () => {
    // The CI / headless path authenticates with a shared workspace key
    // (`mla init --control-token`). There, re-running that command IS the correct
    // recovery, so the shared-key message must not be rewritten to `mla login`
    // (there is no interactive browser in a headless session).
    fs.writeFileSync(
      path.join(home, "cli-config.json"),
      JSON.stringify({ auth: { mode: "shared-key" } }),
    );
    const { warnings } = runWarn({
      home,
      throttleSecs: 3600,
      calls: [{ code: "401" }],
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/control-token/);
    expect(warnings[0]).not.toMatch(/mla login/);
  });

  it("always returns 0 so it is safe under `set -e` in the flusher", () => {
    // If warn_capture_auth ever returned non-zero, `bash -e` would abort here and
    // execFileSync would throw. Reaching the assertion means it stayed fail-soft.
    expect(() =>
      execFileSync(
        "bash",
        [
          "-c",
          [
            "set -euo pipefail",
            "source " + JSON.stringify(COMMON_SH),
            'WORKSPACE_ID="ws_x"',
            'warn_capture_auth "sess-z" "403" "POST /x"',
            'echo OK',
          ].join("\n"),
        ],
        { cwd: home, env: { ...process.env, MEETLESS_HOME: home }, encoding: "utf8" },
      ),
    ).not.toThrow();
  });
});
