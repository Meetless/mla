import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Behavioral lock for the §6.4/§6.5 control auth policy layered on doFetch
// (proposal T27 / T29): none-mode fail-fast, concurrency-safe user-token
// auto-refresh, the RaceRecoveryResult null-token defensive path, the transient-
// outage "busy" guard, and the doctor probe's allowUnauthenticated bypass.
//
// CFG_PATH and the sidecar LOCK_PATH are frozen from MEETLESS_HOME at config.ts
// import time, so each test re-points MEETLESS_HOME then jest.resetModules() +
// require so http.ts (and the config it imports) re-freeze against the test home.
// http.ts's refreshUserToken re-reads/writes that same on-disk config, so a
// single fs-backed temp home faithfully simulates two `mla` processes sharing
// one cli-config.json + one lock file.

type HttpModule = typeof import("../../src/lib/http");
type ConfigModule = typeof import("../../src/lib/config");

const PAST = () => new Date(Date.now() - 3600_000).toISOString();
const FUTURE = () => new Date(Date.now() + 3600_000).toISOString();
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
  | { kind: "transient" }
  | { kind: "null-tokens" }
  | { kind: "malformed" };

// Smart fetch: the health route is always 200 (unauthenticated probe); the
// refresh route follows `refresh`; every other control/intel call returns 200
// iff its bearer matches `validToken`, else 401.
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
      if (r.kind === "null-tokens") {
        return resp(
          200,
          JSON.stringify({
            sessionId: "sess_1",
            accessToken: null,
            refreshToken: null,
            accessExpiresAt: null,
            refreshExpiresAt: null,
          }),
        );
      }
      if (r.kind === "malformed") {
        return resp(200, JSON.stringify({ accessToken: "at_partial" }));
      }
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

describe("doFetch auth policy (§6.4/§6.5)", () => {
  let tmp: string;
  let home: string;
  let cfgPath: string;
  let prevHome: string | undefined;
  let prevToken: string | undefined;
  let prevFetch: typeof fetch;

  beforeEach(() => {
    prevHome = process.env.MEETLESS_HOME;
    prevToken = process.env.MEETLESS_CONTROL_TOKEN;
    prevFetch = global.fetch;
    delete process.env.MEETLESS_CONTROL_TOKEN;
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mla-refresh-"));
    home = path.join(tmp, "home");
    fs.mkdirSync(home, { recursive: true });
    cfgPath = path.join(home, "cli-config.json");
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.MEETLESS_HOME;
    else process.env.MEETLESS_HOME = prevHome;
    if (prevToken === undefined) delete process.env.MEETLESS_CONTROL_TOKEN;
    else process.env.MEETLESS_CONTROL_TOKEN = prevToken;
    global.fetch = prevFetch;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function load(): { http: HttpModule; config: ConfigModule } {
    process.env.MEETLESS_HOME = home;
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const config = require("../../src/lib/config") as ConfigModule;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const http = require("../../src/lib/http") as HttpModule;
    return { http, config };
  }

  function seedUserToken(accessToken: string, accessExpiresAt: string): void {
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        controlUrl: "http://127.0.0.1:3006",
        intelUrl: "http://127.0.0.1:8100",
        mlaPath: "/m",
        auth: {
          mode: "user-token",
          accessToken,
          refreshToken: "rt_1",
          accessExpiresAt,
          refreshExpiresAt: FAR(),
          sessionId: "sess_1",
          user: { id: "u_1", displayName: "Ada Lovelace", email: null, role: "OWNER" },
        },
      }),
    );
  }

  function seedNone(): void {
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({ controlUrl: "http://127.0.0.1:3006", intelUrl: "http://127.0.0.1:8100", mlaPath: "/m", auth: { mode: "none" } }),
    );
  }

  function disk(): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  }
  function diskAuth(): Record<string, unknown> {
    return disk().auth as Record<string, unknown>;
  }

  it("none-mode control call fails fast with 'not logged in' and never hits the network", async () => {
    seedNone();
    const { fn } = makeFetch({ validToken: "x" });
    global.fetch = fn as unknown as typeof fetch;
    const { http, config } = load();
    const cfg = config.readConfig();
    await expect(http.get(cfg, "/internal/v1/diffs")).rejects.toThrow(/Not logged in/);
    expect(fn).not.toHaveBeenCalled();
  });

  it("none-mode intel call fails fast too", async () => {
    seedNone();
    const { fn } = makeFetch({ validToken: "x" });
    global.fetch = fn as unknown as typeof fetch;
    const { http, config } = load();
    const cfg = config.readConfig();
    await expect(http.intelGet(cfg, "/v1/kb/x")).rejects.toThrow(/Not logged in/);
    expect(fn).not.toHaveBeenCalled();
  });

  it("refreshes the access token on a 401 and retries the original request once", async () => {
    seedUserToken("at_1", PAST());
    const { fn, counts } = makeFetch({
      validToken: "at_2",
      refresh: { kind: "rotate", accessToken: "at_2", accessExpiresAtMs: Date.now() + 3600_000 },
      body: JSON.stringify({ ok: true }),
    });
    global.fetch = fn as unknown as typeof fetch;
    const { http, config } = load();
    const cfg = config.readConfig();
    const out = await http.get<{ ok: boolean }>(cfg, "/internal/v1/diffs");
    expect(out).toEqual({ ok: true });
    expect(counts.refresh).toBe(1);
    // The rotated pair is persisted; controlToken is NOT serialized.
    expect(diskAuth().accessToken).toBe("at_2");
    expect(diskAuth().refreshToken).toBe("rt_rotated");
    expect(disk()).not.toHaveProperty("controlToken");
  });

  it("maps a second 401 (after refresh) to auth_expired", async () => {
    seedUserToken("at_1", PAST());
    const { fn } = makeFetch({
      // control rejects EVERY token: even the rotated one 401s on retry.
      validToken: "at_never",
      refresh: { kind: "rotate", accessToken: "at_2", accessExpiresAtMs: Date.now() + 3600_000 },
    });
    global.fetch = fn as unknown as typeof fetch;
    const { http, config } = load();
    const cfg = config.readConfig();
    await expect(http.get(cfg, "/internal/v1/diffs")).rejects.toThrow(/Your CLI login expired/);
  });

  it("does NOT tear the session down on a transient refresh outage (busy/retry)", async () => {
    seedUserToken("at_1", PAST());
    const { fn } = makeFetch({ validToken: "at_2", refresh: { kind: "transient" } });
    global.fetch = fn as unknown as typeof fetch;
    const { http, config } = load();
    const cfg = config.readConfig();
    await expect(http.get(cfg, "/internal/v1/diffs")).rejects.toThrow(
      /Another mla process is refreshing/,
    );
    // On-disk refresh token is untouched: the session survives.
    expect(diskAuth().accessToken).toBe("at_1");
    expect(diskAuth().refreshToken).toBe("rt_1");
  });

  it("never persists RaceRecoveryResult null tokens; fails to auth_expired when disk is still stale", async () => {
    seedUserToken("at_1", PAST());
    const { fn, counts } = makeFetch({ validToken: "at_2", refresh: { kind: "null-tokens" } });
    global.fetch = fn as unknown as typeof fetch;
    const { http, config } = load();
    const cfg = config.readConfig();
    await expect(http.get(cfg, "/internal/v1/diffs")).rejects.toThrow(/Your CLI login expired/);
    expect(counts.refresh).toBe(1);
    // The null tokens were NEVER written: disk still carries the original pair.
    expect(diskAuth().accessToken).toBe("at_1");
    expect(diskAuth().refreshToken).toBe("rt_1");
  });

  it("treats a malformed success body as transient (busy), not a partial credential", async () => {
    seedUserToken("at_1", PAST());
    const { fn } = makeFetch({ validToken: "at_2", refresh: { kind: "malformed" } });
    global.fetch = fn as unknown as typeof fetch;
    const { http, config } = load();
    const cfg = config.readConfig();
    await expect(http.get(cfg, "/internal/v1/diffs")).rejects.toThrow(
      /Another mla process is refreshing/,
    );
    expect(diskAuth().accessToken).toBe("at_1");
  });

  it("concurrent 401s on the same token fire exactly ONE refresh; the loser adopts via lock + re-read (Blocking 7)", async () => {
    seedUserToken("at_1", PAST());
    const { fn, counts } = makeFetch({
      validToken: "at_2",
      refresh: { kind: "rotate", accessToken: "at_2", accessExpiresAtMs: Date.now() + 3600_000 },
      body: JSON.stringify({ ok: true }),
    });
    global.fetch = fn as unknown as typeof fetch;
    const { http, config } = load();
    // Two independent cfg objects = two processes that each loaded the config.
    const cfgA = config.readConfig();
    const cfgB = config.readConfig();
    const [a, b] = await Promise.all([
      http.get<{ ok: boolean }>(cfgA, "/internal/v1/diffs"),
      http.get<{ ok: boolean }>(cfgB, "/internal/v1/diffs"),
    ]);
    expect(a).toEqual({ ok: true });
    expect(b).toEqual({ ok: true });
    // Exactly one network refresh: the lock + re-read made the loser adopt.
    expect(counts.refresh).toBe(1);
    expect(diskAuth().accessToken).toBe("at_2");
    // Neither process logged out: no lingering lock file either.
    expect(fs.existsSync(`${cfgPath}.lock`)).toBe(false);
  });

  it("adopts an already-rotated token with NO network call when the access token is still fresh", async () => {
    // Disk already carries a fresh access token (another process rotated). A 401
    // (e.g. a momentary server blip) must adopt-and-retry without a refresh POST.
    seedUserToken("at_2", FUTURE());
    const { fn, counts } = makeFetch({
      validToken: "at_2",
      refresh: { kind: "unauthorized" }, // would fail if ever called
      body: JSON.stringify({ ok: true }),
    });
    global.fetch = fn as unknown as typeof fetch;
    const { http, config } = load();
    const cfg = config.readConfig();
    // Force one 401 by sending a stale token, then the fresh-disk adopt path runs.
    cfg.controlToken = "at_stale";
    cfg.auth = { ...(cfg.auth as Record<string, unknown>) } as typeof cfg.auth;
    (cfg.auth as { accessToken: string }).accessToken = "at_stale";
    const out = await http.get<{ ok: boolean }>(cfg, "/internal/v1/diffs");
    expect(out).toEqual({ ok: true });
    expect(counts.refresh).toBe(0); // adopted from disk, never POSTed
  });

  it("doctor's ping probes the unauthenticated health route even in none mode (no refresh)", async () => {
    seedNone();
    const { fn, counts } = makeFetch({ validToken: "x" });
    global.fetch = fn as unknown as typeof fetch;
    const { http, config } = load();
    const cfg = config.readConfig();
    const r = await http.ping(cfg, "/internal/v1/health");
    expect(r.ok).toBe(true);
    expect(counts.health).toBe(1);
    expect(counts.refresh).toBe(0);
  });
});
