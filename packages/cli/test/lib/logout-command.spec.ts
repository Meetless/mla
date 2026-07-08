import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { revokeCliSession, RevokeResult } from "../../src/commands/logout";

// Behavioral lock for `mla logout` (proposal §6.6, §9, T25 / T29). The revoke
// call sends the refresh token as body proof with NO Authorization header and
// NEVER throws; runLogout ALWAYS clears to the terminal `none` state for a user
// session (even on a network failure or an expired access token), but never
// touches a shared-key or none config.

describe("revokeCliSession (body proof-of-possession)", () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it("POSTs {sessionId, refreshToken} with NO Authorization header on 200", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    global.fetch = (async (url: string, init: RequestInit) => {
      captured = { url, init };
      return { ok: true, status: 200, text: async () => "" } as unknown as Response;
    }) as unknown as typeof fetch;

    const r = await revokeCliSession("http://127.0.0.1:3006", "sess_1", "rt_secret");
    expect(r).toEqual({ serverCleared: true, detail: "session revoked" });
    expect(captured!.url).toBe("http://127.0.0.1:3006/internal/v1/auth/sessions/revoke");
    const headers = captured!.init.headers as Record<string, string>;
    expect(headers).not.toHaveProperty("Authorization");
    expect(JSON.parse(captured!.init.body as string)).toEqual({
      sessionId: "sess_1",
      refreshToken: "rt_secret",
    });
  });

  it("treats 401 and 410 as already-revoked (serverCleared true)", async () => {
    for (const status of [401, 410]) {
      global.fetch = (async () =>
        ({ ok: false, status, text: async () => "" }) as unknown as Response) as unknown as typeof fetch;
      const r = await revokeCliSession("http://c", "s", "rt");
      expect(r.serverCleared).toBe(true);
      expect(r.detail).toMatch(/already revoked/);
    }
  });

  it("reports a non-cleared result for an unexpected status", async () => {
    global.fetch = (async () =>
      ({ ok: false, status: 500, text: async () => "" }) as unknown as Response) as unknown as typeof fetch;
    const r = await revokeCliSession("http://c", "s", "rt");
    expect(r).toEqual({ serverCleared: false, detail: "control returned HTTP 500" });
  });

  it("never throws on a network failure; returns a non-cleared result", async () => {
    global.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const r = await revokeCliSession("http://c", "s", "rt");
    expect(r.serverCleared).toBe(false);
    expect(r.detail).toMatch(/control unreachable/);
  });
});

describe("runLogout", () => {
  let tmp: string;
  let home: string;
  let cfgPath: string;
  let prevHome: string | undefined;
  let prevToken: string | undefined;

  beforeEach(() => {
    prevHome = process.env.MEETLESS_HOME;
    prevToken = process.env.MEETLESS_CONTROL_TOKEN;
    delete process.env.MEETLESS_CONTROL_TOKEN;
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mla-logout-"));
    home = path.join(tmp, "home");
    fs.mkdirSync(home, { recursive: true });
    cfgPath = path.join(home, "cli-config.json");
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.MEETLESS_HOME;
    else process.env.MEETLESS_HOME = prevHome;
    if (prevToken === undefined) delete process.env.MEETLESS_CONTROL_TOKEN;
    else process.env.MEETLESS_CONTROL_TOKEN = prevToken;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function loadRunLogout(): typeof import("../../src/commands/logout").runLogout {
    process.env.MEETLESS_HOME = home;
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require("../../src/commands/logout").runLogout;
  }

  function seed(raw: Record<string, unknown>): void {
    fs.writeFileSync(cfgPath, JSON.stringify(raw, null, 2) + "\n");
  }

  function disk(): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  }

  function userTokenConfig(accessExpiresAt: string): Record<string, unknown> {
    return {
      controlUrl: "http://127.0.0.1:3006",
      mlaPath: "/m",
      auth: {
        mode: "user-token",
        accessToken: "at_1",
        refreshToken: "rt_1",
        accessExpiresAt,
        refreshExpiresAt: new Date(Date.now() + 80 * 86_400_000).toISOString(),
        sessionId: "sess_1",
        user: { id: "u_1", displayName: "An Pham", email: null, role: "OWNER" },
      },
    };
  }

  const logs: string[] = [];
  const collect = (m: string) => logs.push(m);
  beforeEach(() => {
    logs.length = 0;
  });

  it("revokes the session then clears to auth.mode none for a user-token", async () => {
    seed(userTokenConfig(new Date(Date.now() + 3600_000).toISOString()));
    const revokeFn = jest.fn(
      async (): Promise<RevokeResult> => ({ serverCleared: true, detail: "session revoked" }),
    );
    const runLogout = loadRunLogout();
    const code = await runLogout([], { revokeFn, log: collect });
    expect(code).toBe(0);
    expect(revokeFn).toHaveBeenCalledWith("http://127.0.0.1:3006", "sess_1", "rt_1");
    const d = disk();
    expect(d.auth).toEqual({ mode: "none" });
    expect(d).not.toHaveProperty("controlToken");
    expect(d).not.toHaveProperty("actorUserId");
    expect(logs.join("\n")).toMatch(/Logged out An Pham/);
  });

  it("succeeds even when the access token already expired (refresh token is the proof)", async () => {
    seed(userTokenConfig(new Date(Date.now() - 3600_000).toISOString()));
    const revokeFn = jest.fn(
      async (): Promise<RevokeResult> => ({ serverCleared: true, detail: "session revoked" }),
    );
    const runLogout = loadRunLogout();
    const code = await runLogout([], { revokeFn, log: collect });
    expect(code).toBe(0);
    expect(revokeFn).toHaveBeenCalledTimes(1);
    expect(disk().auth).toEqual({ mode: "none" });
  });

  it("still clears locally when the server revoke could not be confirmed", async () => {
    seed(userTokenConfig(new Date(Date.now() + 3600_000).toISOString()));
    const revokeFn = jest.fn(
      async (): Promise<RevokeResult> => ({
        serverCleared: false,
        detail: "control unreachable (AbortError)",
      }),
    );
    const runLogout = loadRunLogout();
    const code = await runLogout([], { revokeFn, log: collect });
    expect(code).toBe(0);
    expect(disk().auth).toEqual({ mode: "none" });
    expect(logs.join("\n")).toMatch(/may still be active server-side/);
  });

  it("does NOT touch a shared-key config (logout is not a key downgrade)", async () => {
    seed({ controlUrl: "http://127.0.0.1:3006", controlToken: "sk_1", mlaPath: "/m" });
    const revokeFn = jest.fn();
    const runLogout = loadRunLogout();
    const code = await runLogout([], { revokeFn, log: collect });
    expect(code).toBe(0);
    expect(revokeFn).not.toHaveBeenCalled();
    // shared-key on disk is normalized to nested auth on read, but logout never
    // rewrites it: the raw legacy shape is untouched.
    expect(disk().controlToken).toBe("sk_1");
    expect(logs.join("\n")).toMatch(/shared key/);
  });

  it("is idempotent on a none config", async () => {
    seed({ controlUrl: "http://127.0.0.1:3006", mlaPath: "/m", auth: { mode: "none" } });
    const revokeFn = jest.fn();
    const runLogout = loadRunLogout();
    const code = await runLogout([], { revokeFn, log: collect });
    expect(code).toBe(0);
    expect(revokeFn).not.toHaveBeenCalled();
    expect(logs.join("\n")).toMatch(/Already logged out/);
  });

  it("is idempotent with no cli-config.json at all", async () => {
    const revokeFn = jest.fn();
    const runLogout = loadRunLogout();
    const code = await runLogout([], { revokeFn, log: collect });
    expect(code).toBe(0);
    expect(revokeFn).not.toHaveBeenCalled();
    expect(logs.join("\n")).toMatch(/Nothing to do/);
  });

  it("rejects stray arguments with exit 2", async () => {
    seed({ controlUrl: "http://127.0.0.1:3006", mlaPath: "/m", auth: { mode: "none" } });
    const runLogout = loadRunLogout();
    expect(await runLogout(["--all"], { log: collect })).toBe(2);
  });
});
