import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Contract lock for `mla _internal refresh` (Part 3, T1-T4). This subcommand is
// a thin policy wrapper over the existing concurrency-safe `refreshUserToken`
// (lib/http.ts). It maps the RefreshOutcome to a sysexits process exit code that
// the bash hooks branch on with a clean `case "$rc"`:
//
//   refreshed -> 0   (token rotated, or adopted from a concurrent winner, or
//                     `--if-expiring-within` and the token is comfortably fresh)
//   busy      -> 75  (EX_TEMPFAIL: lock contended / transient outage; untouched)
//   expired   -> 77  (EX_NOPERM: refresh token dead server-side; run `mla login`)
//   wrong mode-> 64  (EX_USAGE: shared-key / none / unreadable config / bad args)
//
// The wire numbers (75/77/64) are hardcoded in common.sh, so they are asserted
// here as literals to lock the contract: changing them silently desyncs bash.
//
// SECURITY: the subcommand must NEVER print a token. Every test that drives a
// refresh seeds recognizable token strings and asserts they never surface.

describe("mla _internal refresh", () => {
  let tmp: string;
  let home: string;
  let cfgPath: string;
  let prevHome: string | undefined;
  let prevToken: string | undefined;
  let logs: string[];
  let errs: string[];
  let logSpy: jest.SpyInstance;
  let errSpy: jest.SpyInstance;

  beforeEach(() => {
    prevHome = process.env.MEETLESS_HOME;
    prevToken = process.env.MEETLESS_CONTROL_TOKEN;
    // A shared-key env var would shadow an on-disk user-token in readConfig and
    // also hard-error; keep the test env clean so the on-disk auth is authoritative.
    delete process.env.MEETLESS_CONTROL_TOKEN;
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mla-refresh-"));
    home = path.join(tmp, "home");
    fs.mkdirSync(home, { recursive: true });
    cfgPath = path.join(home, "cli-config.json");
    logs = [];
    errs = [];
    logSpy = jest.spyOn(console, "log").mockImplementation((...a) => {
      logs.push(a.map(String).join(" "));
    });
    errSpy = jest.spyOn(console, "error").mockImplementation((...a) => {
      errs.push(a.map(String).join(" "));
    });
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.MEETLESS_HOME;
    else process.env.MEETLESS_HOME = prevHome;
    if (prevToken === undefined) delete process.env.MEETLESS_CONTROL_TOKEN;
    else process.env.MEETLESS_CONTROL_TOKEN = prevToken;
    logSpy.mockRestore();
    errSpy.mockRestore();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function loadRun(): (
    argv: string[],
    deps?: {
      refresh?: (cfg: unknown) => Promise<"refreshed" | "busy" | "expired">;
      now?: () => number;
    },
  ) => Promise<number> {
    process.env.MEETLESS_HOME = home;
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require("../../src/commands/internal-refresh").runInternalRefresh;
  }

  function writeUserTokenConfig(opts?: { accessExpiresAt?: string }): void {
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        controlUrl: "http://127.0.0.1:3006",
        mlaPath: "/m",
        auth: {
          mode: "user-token",
          accessToken: "at_secret_value",
          refreshToken: "rt_secret_value",
          accessExpiresAt:
            opts?.accessExpiresAt ?? new Date(Date.now() + 3600_000).toISOString(),
          refreshExpiresAt: new Date(Date.now() + 80 * 86_400_000).toISOString(),
          sessionId: "sess_1",
          user: { id: "u_1", displayName: "Ada Lovelace", email: "ada@example.com", role: "OWNER" },
        },
      }),
    );
  }

  function writeSharedKeyConfig(): void {
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        controlUrl: "http://127.0.0.1:3006",
        mlaPath: "/m",
        auth: { mode: "shared-key", accessToken: "internal_api_key_secret" },
      }),
    );
  }

  function writeNoneConfig(): void {
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        controlUrl: "http://127.0.0.1:3006",
        mlaPath: "/m",
        auth: { mode: "none" },
      }),
    );
  }

  function noLeak(): void {
    const all = [...logs, ...errs].join("\n");
    expect(all).not.toMatch(/at_secret_value|rt_secret_value|internal_api_key_secret/);
  }

  it("exits 0 when refresh reports refreshed", async () => {
    writeUserTokenConfig();
    const run = loadRun();
    const refresh = jest.fn(async () => "refreshed" as const);
    expect(await run([], { refresh })).toBe(0);
    expect(refresh).toHaveBeenCalledTimes(1);
    noLeak();
  });

  it("exits 75 (EX_TEMPFAIL) when refresh reports busy", async () => {
    writeUserTokenConfig();
    const run = loadRun();
    const refresh = jest.fn(async () => "busy" as const);
    expect(await run([], { refresh })).toBe(75);
    expect(refresh).toHaveBeenCalledTimes(1);
    noLeak();
  });

  it("exits 77 (EX_NOPERM) when refresh reports expired", async () => {
    writeUserTokenConfig();
    const run = loadRun();
    const refresh = jest.fn(async () => "expired" as const);
    expect(await run([], { refresh })).toBe(77);
    expect(refresh).toHaveBeenCalledTimes(1);
    noLeak();
  });

  it("exits 64 for a shared-key session WITHOUT calling refresh, advising control-token", async () => {
    writeSharedKeyConfig();
    const run = loadRun();
    const refresh = jest.fn(async () => "refreshed" as const);
    expect(await run([], { refresh })).toBe(64);
    expect(refresh).not.toHaveBeenCalled();
    expect(errs.join("\n")).toMatch(/shared-key|control-token/i);
    noLeak();
  });

  it("exits 64 for a none (logged-out) session WITHOUT calling refresh, advising mla login", async () => {
    writeNoneConfig();
    const run = loadRun();
    const refresh = jest.fn(async () => "refreshed" as const);
    expect(await run([], { refresh })).toBe(64);
    expect(refresh).not.toHaveBeenCalled();
    expect(errs.join("\n")).toMatch(/mla login/);
    noLeak();
  });

  it("exits 64 when no cli-config.json exists (readConfig throws), without calling refresh", async () => {
    // no config written
    const run = loadRun();
    const refresh = jest.fn(async () => "refreshed" as const);
    expect(await run([], { refresh })).toBe(64);
    expect(refresh).not.toHaveBeenCalled();
    expect(errs.join("\n").length).toBeGreaterThan(0);
  });

  it("--if-expiring-within no-ops (exit 0) WITHOUT calling refresh when the token is comfortably fresh", async () => {
    const now = Date.UTC(2026, 5, 11, 12, 0, 0);
    // access expires in 1h; window is 10 min => comfortably fresh => no refresh.
    writeUserTokenConfig({ accessExpiresAt: new Date(now + 3600_000).toISOString() });
    const run = loadRun();
    const refresh = jest.fn(async () => "refreshed" as const);
    expect(await run(["--if-expiring-within", "600"], { refresh, now: () => now })).toBe(0);
    expect(refresh).not.toHaveBeenCalled();
    noLeak();
  });

  it("--if-expiring-within triggers refresh (exit 0) when the token is within the window", async () => {
    const now = Date.UTC(2026, 5, 11, 12, 0, 0);
    // access expires in 5 min; window is 10 min => within window => refresh.
    writeUserTokenConfig({ accessExpiresAt: new Date(now + 300_000).toISOString() });
    const run = loadRun();
    const refresh = jest.fn(async () => "refreshed" as const);
    expect(await run(["--if-expiring-within", "600"], { refresh, now: () => now })).toBe(0);
    expect(refresh).toHaveBeenCalledTimes(1);
    noLeak();
  });

  it("--if-expiring-within triggers refresh when the access token has already expired", async () => {
    const now = Date.UTC(2026, 5, 11, 12, 0, 0);
    writeUserTokenConfig({ accessExpiresAt: new Date(now - 60_000).toISOString() });
    const run = loadRun();
    const refresh = jest.fn(async () => "refreshed" as const);
    expect(await run(["--if-expiring-within", "600"], { refresh, now: () => now })).toBe(0);
    expect(refresh).toHaveBeenCalledTimes(1);
    noLeak();
  });

  it("--if-expiring-within with an unparseable expiry refreshes rather than trusting a broken timestamp", async () => {
    const now = Date.UTC(2026, 5, 11, 12, 0, 0);
    writeUserTokenConfig({ accessExpiresAt: "not-a-date" });
    const run = loadRun();
    const refresh = jest.fn(async () => "refreshed" as const);
    expect(await run(["--if-expiring-within", "600"], { refresh, now: () => now })).toBe(0);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("exits 64 on an unknown flag or a non-numeric --if-expiring-within value, without calling refresh", async () => {
    writeUserTokenConfig();
    let run = loadRun();
    const refresh = jest.fn(async () => "refreshed" as const);
    expect(await run(["--bogus"], { refresh })).toBe(64);
    run = loadRun();
    expect(await run(["--if-expiring-within", "abc"], { refresh })).toBe(64);
    run = loadRun();
    expect(await run(["--if-expiring-within"], { refresh })).toBe(64);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("--quiet suppresses the success stdout line but still exits 0", async () => {
    writeUserTokenConfig();
    const run = loadRun();
    const refresh = jest.fn(async () => "refreshed" as const);
    expect(await run(["--quiet"], { refresh })).toBe(0);
    expect(logs.join("\n")).toBe("");
    noLeak();
  });
});
