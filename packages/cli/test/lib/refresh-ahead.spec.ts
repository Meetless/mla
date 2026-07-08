import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Part 3 T10/T11 (notes/20260611-mla-hook-token-autorefresh-proposal.md §A
// "Proactive refresh-ahead"): the pure-bash freshness gate + spawn decision in
// common.sh that user-prompt-submit.sh calls BEFORE reading the enrich token.
//
// Design (decided at implementation; Open Question 1 in the proposal): a CHEAP
// bash check keeps the node spawn off the hot path. When the access token is
// comfortably fresh (the ~always case) maybe_refresh_ahead does nothing. It only
// spawns the TS gate (`mla _internal refresh --if-expiring-within <skew>`) when
// the token is within the skew window OR its timestamp cannot be parsed. The
// parse-failure branch is FAIL-SAFE: it spawns (the TS gate re-checks in
// well-tested Date logic and no-ops if actually fresh) rather than skipping a
// refresh the session may need. Best-effort: a non-zero refresh rc never
// propagates (the reactive 401 path is the real safety net).
//
// What this pins:
//   - iso_to_epoch parses a Z-form ISO timestamp and rejects garbage.
//   - fresh token  => NO spawn (hot path clean).
//   - near expiry  => spawns with --if-expiring-within <skew> --quiet.
//   - unparseable / missing expiry => spawns (fail-safe).
//   - non-user-token mode => never spawns.
//   - kill switch off => never spawns (even near expiry).
//   - custom MEETLESS_HOOK_REFRESH_SKEW_SECS is forwarded.
//   - a non-zero refresh rc is swallowed (maybe_refresh_ahead still returns 0).

const COMMON_SH = path.resolve(__dirname, "../../src/hooks-template/common.sh");

function sourceAndRun(home: string, body: string, env: Record<string, string> = {}): string {
  const script = ["source " + JSON.stringify(COMMON_SH), body].join("\n") + "\n";
  return execFileSync("bash", ["-c", script], {
    cwd: home,
    env: { ...process.env, MEETLESS_HOME: home, ...env },
    encoding: "utf8",
  });
}

interface AheadRun {
  rc: number;
  stubArgs: string[];
}

// Write a cli-config.json (with auth fields) + a stub mla that records its args
// and exits with a chosen code, then call maybe_refresh_ahead and echo its rc.
function runAhead(opts: {
  home: string;
  mode?: string; // auth.mode; default user-token
  expiresAt?: string | null; // auth.accessExpiresAt; null => omit the field
  exitCode?: number; // stub mla exit code (default 0)
  skew?: string; // MEETLESS_HOOK_REFRESH_SKEW_SECS
  env?: Record<string, string>;
}): AheadRun {
  const stubPath = path.join(opts.home, "mla-stub.sh");
  const argsLog = path.join(opts.home, "stub-args.log");
  fs.writeFileSync(
    stubPath,
    `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(argsLog)}\nexit ${
      opts.exitCode ?? 0
    }\n`,
  );
  fs.chmodSync(stubPath, 0o755);

  const auth: Record<string, unknown> = {
    mode: opts.mode ?? "user-token",
    accessToken: "at_initial",
    refreshToken: "rt_initial",
  };
  if (opts.expiresAt !== null && opts.expiresAt !== undefined) {
    auth.accessExpiresAt = opts.expiresAt;
  }
  const cfg = {
    controlUrl: "http://127.0.0.1:1",
    intelUrl: "http://127.0.0.1:8100",
    workspaceId: "ws_test",
    mlaPath: stubPath,
    auth,
  };
  fs.writeFileSync(path.join(opts.home, "cli-config.json"), JSON.stringify(cfg));

  const env: Record<string, string> = { ...(opts.env ?? {}) };
  if (opts.skew !== undefined) env.MEETLESS_HOOK_REFRESH_SKEW_SECS = opts.skew;

  const out = sourceAndRun(opts.home, 'rc=0\nmaybe_refresh_ahead || rc=$?\necho "RC=$rc"', env);
  const m = out.match(/RC=(\d+)/);
  const rc = m ? Number(m[1]) : NaN;
  const stubArgs = fs.existsSync(argsLog)
    ? fs.readFileSync(argsLog, "utf8").split("\n").filter((l) => l.trim().length > 0)
    : [];
  return { rc, stubArgs };
}

describe("iso_to_epoch (Part 3 bash date helper)", () => {
  let tmp: string;
  let home: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mla-isoepoch-"));
    home = path.join(tmp, "home");
    fs.mkdirSync(home, { recursive: true });
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("parses a Z-form ISO8601 timestamp to a plausible epoch", () => {
    // 2030-01-01T00:00:00Z == 1893456000 (UTC). Allow either branch (GNU/BSD).
    const out = sourceAndRun(home, 'iso_to_epoch "2030-01-01T00:00:00Z"');
    expect(out.trim()).toBe("1893456000");
  });

  it("returns nothing (and non-zero) for an unparseable string", () => {
    const out = sourceAndRun(
      home,
      'e="$(iso_to_epoch "not-a-real-date" || true)"\necho "E=[$e]"',
    );
    expect(out).toContain("E=[]");
  });
});

describe("maybe_refresh_ahead (Part 3 proactive gate)", () => {
  let tmp: string;
  let home: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mla-refreshahead-"));
    home = path.join(tmp, "home");
    fs.mkdirSync(home, { recursive: true });
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("comfortably-fresh token: does NOT spawn the CLI (hot path stays clean)", () => {
    const { rc, stubArgs } = runAhead({ home, expiresAt: "2999-01-01T00:00:00Z" });
    expect(rc).toBe(0);
    expect(stubArgs).toHaveLength(0);
  });

  it("near-expiry token: spawns the TS gate with --if-expiring-within <skew> --quiet", () => {
    const { rc, stubArgs } = runAhead({ home, expiresAt: "2020-01-01T00:00:00Z" });
    expect(rc).toBe(0);
    expect(stubArgs).toHaveLength(1);
    expect(stubArgs[0]).toContain("_internal refresh");
    expect(stubArgs[0]).toContain("--if-expiring-within 600");
    expect(stubArgs[0]).toContain("--quiet");
  });

  it("unparseable accessExpiresAt: spawns anyway (fail-safe, never skips a needed refresh)", () => {
    const { rc, stubArgs } = runAhead({ home, expiresAt: "garbage-not-a-date" });
    expect(rc).toBe(0);
    expect(stubArgs).toHaveLength(1);
    expect(stubArgs[0]).toContain("--if-expiring-within 600");
  });

  it("missing accessExpiresAt: spawns anyway (unknown expiry is fail-safe)", () => {
    const { rc, stubArgs } = runAhead({ home, expiresAt: null });
    expect(rc).toBe(0);
    expect(stubArgs).toHaveLength(1);
  });

  it("non-user-token mode (shared-key): never spawns", () => {
    const { rc, stubArgs } = runAhead({
      home,
      mode: "shared-key",
      expiresAt: "2020-01-01T00:00:00Z",
    });
    expect(rc).toBe(0);
    expect(stubArgs).toHaveLength(0);
  });

  it("ignores the removed MEETLESS_HOOK_AUTOREFRESH=0 flag: still spawns near expiry", () => {
    // Auto-refresh is unconditional; the old kill switch is inert. A near-expiry
    // token must still trigger the proactive spawn even with the flag set to "0".
    const { rc, stubArgs } = runAhead({
      home,
      expiresAt: "2020-01-01T00:00:00Z",
      env: { MEETLESS_HOOK_AUTOREFRESH: "0" },
    });
    expect(rc).toBe(0);
    expect(stubArgs).toHaveLength(1);
    expect(stubArgs[0]).toContain("--if-expiring-within 600");
  });

  it("forwards a custom MEETLESS_HOOK_REFRESH_SKEW_SECS to the TS gate", () => {
    const { stubArgs } = runAhead({
      home,
      expiresAt: "2020-01-01T00:00:00Z",
      skew: "120",
    });
    expect(stubArgs).toHaveLength(1);
    expect(stubArgs[0]).toContain("--if-expiring-within 120");
  });

  it("is best-effort: a non-zero refresh rc (e.g. 77 expired) does NOT propagate", () => {
    const { rc, stubArgs } = runAhead({
      home,
      expiresAt: "2020-01-01T00:00:00Z",
      exitCode: 77,
    });
    expect(rc).toBe(0); // swallowed; the reactive 401 path is the safety net
    expect(stubArgs).toHaveLength(1);
  });
});
