import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// End-to-end behavioral lock for the dead-auth circuit breaker AS WIRED INTO
// doFetch (incident: a dead `mla login` self-DoSing control with a validate+
// refresh storm). The unit semantics live in auth-breaker.spec.ts; this file
// proves the wiring in http.ts actually:
//   1. TRIPS when control rejects the refresh token (and surfaces auth_expired),
//   2. STOPS THE FLOOD: the next call short-circuits with ZERO network calls,
//   3. SELF-HEALS after a re-login (fresh on-disk token => gate reopens),
//   4. HEALS A LIVE WORKER holding a stale in-memory cfg (the reason consult
//      reads the ON-DISK token, not the caller's cfg),
//   5. NEVER trips on a transient/throttled refresh (so the server's new 429 for
//      a rate-limit burst can never wedge a healthy session).
//
// Same fs-backed temp-home harness as http-auto-refresh.spec.ts: CFG_PATH and
// AUTH_BREAKER_PATH are frozen from MEETLESS_HOME at import, so each test
// re-points the home then resetModules() + require so http.ts, config.ts, and
// auth-breaker.ts re-freeze against it. A single on-disk config faithfully
// simulates several `mla` processes/workers sharing one cli-config.json.

type HttpModule = typeof import("../../src/lib/http");
type ConfigModule = typeof import("../../src/lib/config");
type BreakerModule = typeof import("../../src/lib/auth-breaker");

const PAST = () => new Date(Date.now() - 3600_000).toISOString();
const FAR = () => new Date(Date.now() + 80 * 86_400_000).toISOString();

function resp(status: number, body: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
    headers: { get: () => null },
  } as unknown as Response;
}

type RefreshMode =
  | { kind: "rotate"; accessToken: string; accessExpiresAtMs: number }
  | { kind: "unauthorized" }
  | { kind: "transient" };

// Mirrors http-auto-refresh.spec.ts: health always 200; refresh route follows
// `refresh`; every other call is 200 iff its bearer matches `validToken`.
function makeFetch(opts: { validToken: string; refresh?: RefreshMode; body?: string }) {
  const counts = { api: 0, refresh: 0, health: 0 };
  const fn = jest.fn(async (url: string, init: RequestInit) => {
    if (url.endsWith("/internal/v1/health")) {
      counts.health++;
      return resp(200, "{}");
    }
    if (url.endsWith("/internal/v1/auth/token/refresh")) {
      counts.refresh++;
      const r = opts.refresh;
      if (!r || r.kind === "transient") throw new Error("ECONNREFUSED");
      if (r.kind === "unauthorized") return resp(401, "");
      return resp(
        200,
        JSON.stringify({
          sessionId: "sess_1",
          accessToken: r.accessToken,
          refreshToken: "rt_rotated",
          accessExpiresAt: new Date(r.accessExpiresAtMs).toISOString(),
          refreshExpiresAt: FAR(),
        }),
      );
    }
    counts.api++;
    const headers = (init.headers ?? {}) as Record<string, string>;
    const token = (headers.Authorization ?? "").replace(/^Bearer /, "");
    if (token === opts.validToken) return resp(200, opts.body ?? "{}");
    return resp(401, "unauthorized");
  });
  return { fn, counts };
}

describe("doFetch dead-auth circuit breaker", () => {
  let tmp: string;
  let home: string;
  let cfgPath: string;
  let breakerPath: string;
  let prevHome: string | undefined;
  let prevToken: string | undefined;
  let prevFetch: typeof fetch;

  beforeEach(() => {
    prevHome = process.env.MEETLESS_HOME;
    prevToken = process.env.MEETLESS_CONTROL_TOKEN;
    prevFetch = global.fetch;
    delete process.env.MEETLESS_CONTROL_TOKEN;
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mla-breaker-http-"));
    home = path.join(tmp, "home");
    fs.mkdirSync(home, { recursive: true });
    cfgPath = path.join(home, "cli-config.json");
    breakerPath = path.join(home, "auth-dead.json");
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.MEETLESS_HOME;
    else process.env.MEETLESS_HOME = prevHome;
    if (prevToken === undefined) delete process.env.MEETLESS_CONTROL_TOKEN;
    else process.env.MEETLESS_CONTROL_TOKEN = prevToken;
    global.fetch = prevFetch;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function load(): { http: HttpModule; config: ConfigModule; breaker: BreakerModule } {
    process.env.MEETLESS_HOME = home;
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const config = require("../../src/lib/config") as ConfigModule;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const http = require("../../src/lib/http") as HttpModule;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const breaker = require("../../src/lib/auth-breaker") as BreakerModule;
    return { http, config, breaker };
  }

  function seedUserToken(
    accessToken: string,
    refreshToken: string,
    accessExpiresAt: string,
  ): void {
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        controlUrl: "http://127.0.0.1:3006",
        intelUrl: "http://127.0.0.1:8100",
        mlaPath: "/m",
        auth: {
          mode: "user-token",
          accessToken,
          refreshToken,
          accessExpiresAt,
          refreshExpiresAt: FAR(),
          sessionId: "sess_1",
          user: { id: "u_1", displayName: "Ada Lovelace", email: null, role: "OWNER" },
        },
      }),
    );
  }

  it("TRIPS the breaker and surfaces auth_expired when control rejects the refresh token", async () => {
    seedUserToken("at_1", "rt_1", PAST());
    const { fn, counts } = makeFetch({ validToken: "at_never", refresh: { kind: "unauthorized" } });
    global.fetch = fn as unknown as typeof fetch;
    const { http, config } = load();
    const cfg = config.readConfig();

    await expect(http.get(cfg, "/internal/v1/diffs")).rejects.toThrow(/Your CLI login expired/);
    // Exactly one validate + one refresh: the bounded burst before the gate shut.
    expect(counts.api).toBe(1);
    expect(counts.refresh).toBe(1);
    // Sentinel written, keyed to the rejected token.
    expect(fs.existsSync(breakerPath)).toBe(true);
  });

  it("STOPS THE FLOOD: a second call on the same dead on-disk token makes ZERO network calls", async () => {
    seedUserToken("at_1", "rt_1", PAST());
    const { http, config, breaker } = load();
    // Pre-trip exactly as a prior process would have, for THIS on-disk token.
    breaker.tripAuthBreaker("rt_1", "refresh_rejected");

    const { fn, counts } = makeFetch({ validToken: "at_never", refresh: { kind: "unauthorized" } });
    global.fetch = fn as unknown as typeof fetch;
    const cfg = config.readConfig();

    await expect(http.get(cfg, "/internal/v1/diffs")).rejects.toThrow(/Your CLI login expired/);
    // THE WHOLE POINT: the call short-circuited before any fetch. No validate,
    // no refresh -> control sees nothing -> the self-DoS is over.
    expect(counts.api).toBe(0);
    expect(counts.refresh).toBe(0);
    expect(fn).not.toHaveBeenCalled();
  });

  it("SELF-HEALS after re-login: a fresh on-disk token reopens the gate and clears the sentinel", async () => {
    // A prior process tripped the breaker against the now-dead rt_1...
    seedUserToken("at_dead", "rt_1", PAST());
    const { http, config, breaker } = load();
    breaker.tripAuthBreaker("rt_1", "refresh_rejected");
    // ...then the operator ran `mla login`: a fresh, valid pair lands on disk.
    seedUserToken("at_fresh", "rt_fresh", FAR());

    const { fn, counts } = makeFetch({
      validToken: "at_fresh",
      refresh: { kind: "unauthorized" }, // must never be needed
      body: JSON.stringify({ ok: true }),
    });
    global.fetch = fn as unknown as typeof fetch;
    const cfg = config.readConfig();

    const out = await http.get<{ ok: boolean }>(cfg, "/internal/v1/diffs");
    expect(out).toEqual({ ok: true });
    // The fresh access token works on the first try: no refresh needed.
    expect(counts.api).toBe(1);
    expect(counts.refresh).toBe(0);
    // consult saw the rotated on-disk token and cleared the stale sentinel.
    expect(fs.existsSync(breakerPath)).toBe(false);
  });

  it("HEALS A LIVE WORKER holding a stale in-memory cfg once disk rotates (the on-disk-compare invariant)", async () => {
    // The long-lived `mla mcp` worker bound its cfg ONCE at boot, with the token
    // that later died. The breaker is tripped for that token.
    seedUserToken("at_dead", "rt_1", PAST());
    const { http, config, breaker } = load();
    const workerCfg = config.readConfig(); // stale in-memory: at_dead / rt_1
    breaker.tripAuthBreaker("rt_1", "refresh_rejected");

    // An interactive `mla login` rotates the on-disk token under the worker.
    seedUserToken("at_fresh", "rt_fresh", FAR());

    const { fn, counts } = makeFetch({
      validToken: "at_fresh",
      refresh: { kind: "unauthorized" }, // never needed: disk access token is fresh
      body: JSON.stringify({ ok: true }),
    });
    global.fetch = fn as unknown as typeof fetch;

    // The worker calls with its STALE cfg. consult reads DISK (rt_fresh != rt_1),
    // clears the sentinel, lets the call through; doFetchOnce 401s on at_dead,
    // refreshUserToken re-reads disk, finds the fresh access token, adopts it with
    // NO network refresh, and the retry succeeds. No restart required.
    const out = await http.get<{ ok: boolean }>(workerCfg, "/internal/v1/diffs");
    expect(out).toEqual({ ok: true });
    expect(counts.refresh).toBe(0); // adopted the fresh on-disk token, never POSTed
    expect(fs.existsSync(breakerPath)).toBe(false);
    // The worker's in-memory cfg adopted the fresh token for the rest of its run.
    expect(workerCfg.controlToken).toBe("at_fresh");
  });

  it("NEVER trips on a transient/throttled refresh (a 429 burst maps to busy, session survives)", async () => {
    seedUserToken("at_1", "rt_1", PAST());
    const { fn } = makeFetch({ validToken: "at_2", refresh: { kind: "transient" } });
    global.fetch = fn as unknown as typeof fetch;
    const { http, config } = load();
    const cfg = config.readConfig();

    await expect(http.get(cfg, "/internal/v1/diffs")).rejects.toThrow(
      /Another mla process is refreshing/,
    );
    // The breaker is NOT armed: a transient/throttled outcome (the server's 429
    // for a rate-limit burst lands here) must never wedge a healthy session.
    expect(fs.existsSync(breakerPath)).toBe(false);
    // On-disk session is untouched.
    const diskAuth = JSON.parse(fs.readFileSync(cfgPath, "utf8")).auth;
    expect(diskAuth.accessToken).toBe("at_1");
    expect(diskAuth.refreshToken).toBe("rt_1");
  });
});
