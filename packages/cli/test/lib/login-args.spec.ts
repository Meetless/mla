import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { parseLoginArgs } from "../../src/commands/login";

// Behavioral lock for `mla login` arg parsing + the early-return policy gates
// (proposal §6.6, T24 / T29): auto-bootstrap a hosted-prod cli-config.json when
// none exists (then proceed to login), and no-op when already logged in with a
// fresh refresh token.

describe("parseLoginArgs", () => {
  it("accepts no args", () => {
    expect(parseLoginArgs([])).toEqual({});
  });
  it("parses --no-browser, --console-url, --port", () => {
    expect(parseLoginArgs(["--no-browser"])).toEqual({ noBrowser: true });
    expect(parseLoginArgs(["--console-url", "http://c:3003"])).toEqual({
      consoleUrl: "http://c:3003",
    });
    expect(parseLoginArgs(["--port", "8765"])).toEqual({ port: 8765 });
  });
  it("rejects a non-integer / out-of-range port", () => {
    expect(() => parseLoginArgs(["--port", "abc"])).toThrow(/Invalid --port/);
    expect(() => parseLoginArgs(["--port", "70000"])).toThrow(/Invalid --port/);
    expect(() => parseLoginArgs(["--port", "0"])).toThrow(/Invalid --port/);
  });
  it("rejects a value flag swallowing the next flag", () => {
    expect(() => parseLoginArgs(["--console-url", "--no-browser"])).toThrow(
      /Missing value for --console-url/,
    );
  });
  it("rejects a missing trailing value", () => {
    expect(() => parseLoginArgs(["--console-url"])).toThrow(/Missing value for --console-url/);
  });
  it("rejects unknown flags and positionals", () => {
    expect(() => parseLoginArgs(["--bogus"])).toThrow(/Unknown flag/);
    expect(() => parseLoginArgs(["JIRA-1"])).toThrow(/positional/);
  });
});

describe("runLogin early-return gates", () => {
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
    delete process.env.MEETLESS_CONTROL_TOKEN;
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mla-login-"));
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

  // A complete browser-login bundle for the bootstrap-then-login path. Shape
  // mirrors the dead-session-heal block's freshBundle (control's exchange
  // response), so the injected browserLogin returns something writeConfig accepts.
  const freshBundle = {
    sessionId: "sess_boot",
    accessToken: "at_boot",
    refreshToken: "rt_boot",
    accessExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
    refreshExpiresAt: new Date(Date.now() + 80 * 86_400_000).toISOString(),
    user: {
      id: "u_1",
      displayName: "An Pham",
      email: "an@x.com",
      avatarUrl: null,
      role: "OWNER",
      roleVersion: 1,
      canCreateDiff: true,
      canAdminDiff: true,
    },
    workspace: { id: "ws_1", name: "Meetless", slug: "meetless", iconUrl: null, language: "en" },
  };

  function loadRunLogin(): (
    argv: string[],
    deps?: {
      verifySession?: (cfg: unknown) => Promise<void>;
      browserLogin?: (opts: unknown) => Promise<typeof freshBundle>;
    },
  ) => Promise<number> {
    process.env.MEETLESS_HOME = home;
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require("../../src/commands/login").runLogin;
  }

  it("returns 2 when --no-browser is passed without --port", async () => {
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({ controlUrl: "http://127.0.0.1:3006", mlaPath: "/m", auth: { mode: "none" } }),
    );
    const runLogin = loadRunLogin();
    expect(await runLogin(["--no-browser"])).toBe(2);
    expect(errs.join("\n")).toMatch(/--port <n> is required with --no-browser/);
  });

  it("auto-bootstraps a hosted-prod cli-config.json and proceeds to login when none exists", async () => {
    expect(fs.existsSync(cfgPath)).toBe(false);
    const browserLogin = jest.fn(async () => freshBundle);
    const runLogin = loadRunLogin();
    expect(await runLogin([], { browserLogin })).toBe(0);
    // A machine config was created at the hosted-prod default (no `mla init` needed).
    expect(fs.existsSync(cfgPath)).toBe(true);
    const written = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    expect(written.controlUrl).toBe("https://control.meetless.ai");
    expect(written.intelUrl).toBe("https://intel.meetless.ai");
    expect(logs.join("\n")).toMatch(/No cli-config\.json found; created/);
    // Bootstrap does NOT short-circuit: it falls through to the browser flow,
    // which writes the user-token and logs success.
    expect(browserLogin).toHaveBeenCalledTimes(1);
    expect(logs.join("\n")).toMatch(/Logged in as An Pham/);
    expect(JSON.parse(fs.readFileSync(cfgPath, "utf8")).auth.mode).toBe("user-token");
  });

  it("no-ops (returns 0) when logged in and control confirms the session is still live", async () => {
    const farFuture = new Date(Date.now() + 80 * 86_400_000).toISOString();
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        controlUrl: "http://127.0.0.1:3006",
        mlaPath: "/m",
        auth: {
          mode: "user-token",
          accessToken: "at_1",
          refreshToken: "rt_1",
          accessExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
          refreshExpiresAt: farFuture,
          sessionId: "sess_1",
          user: { id: "u_1", displayName: "An Pham", email: "an@x.com", role: "OWNER" },
        },
      }),
    );
    const runLogin = loadRunLogin();
    // A locally-live access token is NOT proof of a live session, so login ALWAYS
    // probes control before claiming "already logged in" (the fix for the blind-
    // trust dead loop An hit). Here control confirms the session, so it no-ops.
    const verifySession = jest.fn(async () => {});
    expect(await runLogin([], { verifySession })).toBe(0);
    expect(verifySession).toHaveBeenCalledTimes(1);
    expect(logs.join("\n")).toMatch(/Already logged in as An Pham/);
    // Never echoes a token.
    expect(logs.join("\n")).not.toMatch(/at_1|rt_1/);
  });
});

// T29.1: the dead-session self-heal. The on-disk refresh window can read
// locally-fresh while the refresh token is already dead server-side (rotated
// away or revoked). Before this, `mla login` trusted only the local timestamp
// and no-op'd on a dead session -> the operator was told "run `mla login`" by
// every 401, ran it, and got "already logged in" with no recovery. These lock
// the new behavior: verify against control when the access token is expired, and
// re-authenticate (not no-op) when control rejects the session.
describe("runLogin dead-session self-heal", () => {
  let tmp: string;
  let home: string;
  let cfgPath: string;
  let prevHome: string | undefined;
  let prevToken: string | undefined;
  let logs: string[];
  let errs: string[];
  let logSpy: jest.SpyInstance;
  let errSpy: jest.SpyInstance;

  const freshBundle = {
    sessionId: "sess_new",
    accessToken: "at_new",
    refreshToken: "rt_new",
    accessExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
    refreshExpiresAt: new Date(Date.now() + 80 * 86_400_000).toISOString(),
    user: {
      id: "u_1",
      displayName: "An Pham",
      email: "an@x.com",
      avatarUrl: null,
      role: "OWNER",
      roleVersion: 1,
      canCreateDiff: true,
      canAdminDiff: true,
    },
    workspace: { id: "ws_1", name: "Meetless", slug: "meetless", iconUrl: null, language: "en" },
  };

  function writeExpiredAccessConfig(): void {
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        controlUrl: "http://127.0.0.1:3006",
        mlaPath: "/m",
        auth: {
          mode: "user-token",
          accessToken: "at_old",
          refreshToken: "rt_old",
          // Access expired a minute ago; refresh window still locally-fresh (~80d).
          accessExpiresAt: new Date(Date.now() - 60_000).toISOString(),
          refreshExpiresAt: new Date(Date.now() + 80 * 86_400_000).toISOString(),
          sessionId: "sess_old",
          user: { id: "u_1", displayName: "An Pham", email: "an@x.com", role: "OWNER" },
        },
      }),
    );
  }

  beforeEach(() => {
    prevHome = process.env.MEETLESS_HOME;
    prevToken = process.env.MEETLESS_CONTROL_TOKEN;
    delete process.env.MEETLESS_CONTROL_TOKEN;
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mla-login-heal-"));
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

  function loadRunLogin(): (
    argv: string[],
    deps?: {
      verifySession?: (cfg: unknown) => Promise<void>;
      browserLogin?: (opts: unknown) => Promise<typeof freshBundle>;
    },
  ) => Promise<number> {
    process.env.MEETLESS_HOME = home;
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require("../../src/commands/login").runLogin;
  }

  it("re-authenticates (does NOT no-op) when control rejects the locally-fresh session", async () => {
    writeExpiredAccessConfig();
    const verifySession = jest.fn(async () => {
      const e = new Error("HTTP 401: Your CLI login expired.") as Error & { status?: number };
      e.status = 401;
      throw e;
    });
    const browserLogin = jest.fn(async () => freshBundle);
    const runLogin = loadRunLogin();

    expect(await runLogin([], { verifySession, browserLogin })).toBe(0);
    expect(verifySession).toHaveBeenCalledTimes(1);
    expect(browserLogin).toHaveBeenCalledTimes(1);
    expect(logs.join("\n")).toMatch(/Re-authenticating/i);
    expect(logs.join("\n")).toMatch(/Logged in as An Pham/);
    // The dead tokens were replaced on disk with the freshly-minted ones.
    const written = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    expect(written.auth.accessToken).toBe("at_new");
    expect(written.auth.refreshToken).toBe("rt_new");
    // Never echoes any token.
    expect(logs.join("\n")).not.toMatch(/at_old|rt_old|at_new|rt_new/);
  });

  it("re-authenticates when the access token is locally-live but control has revoked the session", async () => {
    // The bug An hit (2026-06-11): a control-dev reseed revoked the session
    // server-side while the access JWT was still inside its 24h TTL. The old
    // fast-path trusted the unexpired access token and no-op'd ("Already logged
    // in") WITHOUT probing control, leaving a dead session that every hook 401'd
    // on all day. A locally-live access token is NOT proof of a live session:
    // login must verify against control before claiming "already logged in".
    const farFuture = new Date(Date.now() + 80 * 86_400_000).toISOString();
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        controlUrl: "http://127.0.0.1:3006",
        mlaPath: "/m",
        auth: {
          mode: "user-token",
          accessToken: "at_old",
          refreshToken: "rt_old",
          // Access token still locally LIVE (~1h left); refresh window fresh (~80d).
          accessExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
          refreshExpiresAt: farFuture,
          sessionId: "sess_old",
          user: { id: "u_1", displayName: "An Pham", email: "an@x.com", role: "OWNER" },
        },
      }),
    );
    const verifySession = jest.fn(async () => {
      const e = new Error("HTTP 401: session revoked.") as Error & { status?: number };
      e.status = 401;
      throw e;
    });
    const browserLogin = jest.fn(async () => freshBundle);
    const runLogin = loadRunLogin();

    expect(await runLogin([], { verifySession, browserLogin })).toBe(0);
    // The fix: even a fresh access token is probed, so the revoked session is caught.
    expect(verifySession).toHaveBeenCalledTimes(1);
    expect(browserLogin).toHaveBeenCalledTimes(1);
    expect(logs.join("\n")).toMatch(/Re-authenticating/i);
    expect(logs.join("\n")).toMatch(/Logged in as An Pham/);
  });

  it("no-ops when the access token is expired but control confirms the session is still live", async () => {
    writeExpiredAccessConfig();
    const verifySession = jest.fn(async () => {
      /* /auth/me succeeded: session is live (doFetch may have refreshed). */
    });
    const browserLogin = jest.fn(async () => freshBundle);
    const runLogin = loadRunLogin();

    expect(await runLogin([], { verifySession, browserLogin })).toBe(0);
    expect(verifySession).toHaveBeenCalledTimes(1);
    expect(browserLogin).not.toHaveBeenCalled();
    expect(logs.join("\n")).toMatch(/Already logged in as An Pham/);
  });

  it("keeps the cached session (no doomed browser flow) when control is unreachable", async () => {
    writeExpiredAccessConfig();
    const verifySession = jest.fn(async () => {
      // Network failure: no `status` field (see http.ts HttpError contract).
      throw new Error("fetch failed: ECONNREFUSED");
    });
    const browserLogin = jest.fn(async () => freshBundle);
    const runLogin = loadRunLogin();

    expect(await runLogin([], { verifySession, browserLogin })).toBe(0);
    expect(verifySession).toHaveBeenCalledTimes(1);
    expect(browserLogin).not.toHaveBeenCalled();
    expect(logs.join("\n")).toMatch(/Already logged in as An Pham/);
    expect(logs.join("\n")).toMatch(/could not verify/i);
  });

  it("--force re-authenticates even when the session is fully fresh (skips the probe)", async () => {
    const farFuture = new Date(Date.now() + 80 * 86_400_000).toISOString();
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        controlUrl: "http://127.0.0.1:3006",
        mlaPath: "/m",
        auth: {
          mode: "user-token",
          accessToken: "at_old",
          refreshToken: "rt_old",
          accessExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
          refreshExpiresAt: farFuture,
          sessionId: "sess_old",
          user: { id: "u_1", displayName: "An Pham", email: "an@x.com", role: "OWNER" },
        },
      }),
    );
    const verifySession = jest.fn(async () => {
      throw new Error("verifySession must not be called under --force");
    });
    const browserLogin = jest.fn(async () => freshBundle);
    const runLogin = loadRunLogin();

    expect(await runLogin(["--force"], { verifySession, browserLogin })).toBe(0);
    expect(verifySession).not.toHaveBeenCalled();
    expect(browserLogin).toHaveBeenCalledTimes(1);
    expect(logs.join("\n")).toMatch(/Logged in as An Pham/);
  });
});
