import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Behavioral lock for `mla whoami` (proposal §6.6, T26 / T29). Three auth modes,
// three behaviours: none -> not configured (exit 1); shared-key -> print mode, no
// /auth/me call; user-token -> resolve live identity from control, with a 401
// pointing at re-login and an unreachable control degrading to the cached
// identity marked "unverified". The getMe seam is injected so no server runs.

interface HttpishError extends Error {
  status?: number;
  body: string;
}
function httpErr(message: string, status?: number): HttpishError {
  return Object.assign(new Error(message), { status, body: "" });
}

describe("runWhoami", () => {
  let tmp: string;
  let home: string;
  let cfgPath: string;
  let prevHome: string | undefined;
  let prevToken: string | undefined;
  let logs: string[];
  let errs: string[];
  let errSpy: jest.SpyInstance;

  beforeEach(() => {
    prevHome = process.env.MEETLESS_HOME;
    prevToken = process.env.MEETLESS_CONTROL_TOKEN;
    delete process.env.MEETLESS_CONTROL_TOKEN;
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mla-whoami-"));
    home = path.join(tmp, "home");
    fs.mkdirSync(home, { recursive: true });
    cfgPath = path.join(home, "cli-config.json");
    logs = [];
    errs = [];
    errSpy = jest.spyOn(console, "error").mockImplementation((...a) => {
      errs.push(a.map(String).join(" "));
    });
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.MEETLESS_HOME;
    else process.env.MEETLESS_HOME = prevHome;
    if (prevToken === undefined) delete process.env.MEETLESS_CONTROL_TOKEN;
    else process.env.MEETLESS_CONTROL_TOKEN = prevToken;
    errSpy.mockRestore();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function loadRunWhoami(): typeof import("../../src/commands/whoami").runWhoami {
    process.env.MEETLESS_HOME = home;
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require("../../src/commands/whoami").runWhoami;
  }

  function seed(raw: Record<string, unknown>): void {
    fs.writeFileSync(cfgPath, JSON.stringify(raw, null, 2) + "\n");
  }

  const collect = (m: string) => logs.push(m);

  function userTokenConfig(): Record<string, unknown> {
    return {
      controlUrl: "http://127.0.0.1:3006",
      mlaPath: "/m",
      auth: {
        mode: "user-token",
        accessToken: "at_1",
        refreshToken: "rt_1",
        accessExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
        refreshExpiresAt: new Date(Date.now() + 80 * 86_400_000).toISOString(),
        sessionId: "sess_1",
        user: { id: "u_1", displayName: "Ada Lovelace", email: "ada@example.com", role: "OWNER" },
      },
    };
  }

  it("returns 1 when there is no cli-config.json", async () => {
    const runWhoami = loadRunWhoami();
    const code = await runWhoami([], { log: collect, getMeFn: async () => { throw new Error("nope"); } });
    expect(code).toBe(1);
    expect(logs.join("\n")).toMatch(/Not configured \(no cli-config\.json\)/);
  });

  it("returns 1 for auth.mode none", async () => {
    seed({ controlUrl: "http://127.0.0.1:3006", mlaPath: "/m", auth: { mode: "none" } });
    const runWhoami = loadRunWhoami();
    const code = await runWhoami([], { log: collect, getMeFn: async () => { throw new Error("nope"); } });
    expect(code).toBe(1);
    expect(logs.join("\n")).toMatch(/auth\.mode: none/);
  });

  it("prints shared-key without calling /auth/me", async () => {
    seed({ controlUrl: "http://127.0.0.1:3006", workspaceId: "ws_1", controlToken: "sk_1", mlaPath: "/m" });
    const getMeFn = jest.fn();
    const runWhoami = loadRunWhoami();
    const code = await runWhoami([], { log: collect, getMeFn });
    expect(code).toBe(0);
    expect(getMeFn).not.toHaveBeenCalled();
    expect(logs.join("\n")).toMatch(/auth\.mode: shared-key/);
  });

  it("resolves live identity for a user-token", async () => {
    seed(userTokenConfig());
    const getMeFn = jest.fn(async () => ({
      mode: "cli-session" as const,
      user: { id: "u_1", displayName: "Ada Lovelace", email: "ada@example.com", role: "OWNER" },
      workspace: { id: "ws_1", name: "Acme", slug: "acme" },
      sessionId: "sess_1",
      accessExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
      refreshExpiresAt: new Date(Date.now() + 80 * 86_400_000).toISOString(),
    }));
    const runWhoami = loadRunWhoami();
    const code = await runWhoami([], { log: collect, getMeFn });
    expect(code).toBe(0);
    expect(getMeFn).toHaveBeenCalledTimes(1);
    const out = logs.join("\n");
    expect(out).toMatch(/Logged in as Ada Lovelace <ada@example.com>/);
    expect(out).toMatch(/Workspace: Acme \(acme\)/);
    expect(out).not.toMatch(/at_1|rt_1/);
  });

  it("points at re-login on a 401 from /auth/me", async () => {
    seed(userTokenConfig());
    const getMeFn = jest.fn(async () => {
      throw httpErr("unauthorized", 401);
    });
    const runWhoami = loadRunWhoami();
    const code = await runWhoami([], { log: collect, getMeFn });
    expect(code).toBe(1);
    expect(errs.join("\n")).toMatch(/expired or was revoked.*mla login/);
  });

  it("degrades to the cached identity (unverified) when control is unreachable", async () => {
    seed(userTokenConfig());
    const getMeFn = jest.fn(async () => {
      throw httpErr("ECONNREFUSED");
    });
    const runWhoami = loadRunWhoami();
    const code = await runWhoami([], { log: collect, getMeFn });
    expect(code).toBe(1);
    expect(errs.join("\n")).toMatch(/Could not reach control/);
    expect(logs.join("\n")).toMatch(/Cached identity: Ada Lovelace <ada@example.com>.*unverified/);
  });

  it("rejects stray arguments with exit 2", async () => {
    seed(userTokenConfig());
    const runWhoami = loadRunWhoami();
    expect(await runWhoami(["extra"], { log: collect })).toBe(2);
  });
});
