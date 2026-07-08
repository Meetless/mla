import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Behavioral lock for `mla init` defaulting to auth.mode 'none' (§6.4). A fresh,
// tokenless `mla init` must SUCCEED (no "--control-token required" rejection),
// wire the machine, and write a logged-out config whose next step is `mla login`.
// The shared-key bootstrap is opt-in via --control-token. runWire is mocked: this
// pins the config + exit-code + next-step contract, not the hook-install IO.

describe("runInit auth.mode default (tokenless first run)", () => {
  let tmp: string;
  let home: string;
  let cfgPath: string;
  let prevHome: string | undefined;
  let prevToken: string | undefined;
  let logSpy: jest.SpyInstance;
  let errSpy: jest.SpyInstance;
  const logs: string[] = [];

  beforeEach(() => {
    prevHome = process.env.MEETLESS_HOME;
    prevToken = process.env.MEETLESS_CONTROL_TOKEN;
    // Gate-4 hard-errors if MEETLESS_CONTROL_TOKEN is set over a user-token; keep
    // the env clean so readConfig() never throws inside the idempotent re-run read.
    delete process.env.MEETLESS_CONTROL_TOKEN;
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mla-init-"));
    home = path.join(tmp, "home");
    fs.mkdirSync(home, { recursive: true });
    cfgPath = path.join(home, "cli-config.json");
    logs.length = 0;
    logSpy = jest.spyOn(console, "log").mockImplementation((m?: unknown) => {
      logs.push(String(m));
    });
    errSpy = jest.spyOn(console, "error").mockImplementation((m?: unknown) => {
      logs.push(String(m));
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    if (prevHome === undefined) delete process.env.MEETLESS_HOME;
    else process.env.MEETLESS_HOME = prevHome;
    if (prevToken === undefined) delete process.env.MEETLESS_CONTROL_TOKEN;
    else process.env.MEETLESS_CONTROL_TOKEN = prevToken;
    fs.rmSync(tmp, { recursive: true, force: true });
    jest.resetModules();
  });

  function loadRunInit(): typeof import("../../src/commands/init").runInit {
    process.env.MEETLESS_HOME = home;
    jest.resetModules();
    // Mock the wire seam: a real runWire copies hook scripts and probes flock.
    // The init token-default contract is independent of that, so stub it.
    jest.doMock("../../src/lib/wire", () => ({
      resolveMlaPath: () => "/fake/mla",
      runWire: () => ({
        copied: [],
        hooksAdded: [],
        settingsPath: "",
        skillDir: "",
        flock: { ok: true, detail: "" },
        projectRules: null,
      }),
      printWireResult: () => {},
    }));
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require("../../src/commands/init").runInit;
  }

  function disk(): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  }

  it("writes auth.mode none and returns 0 with no --control-token", async () => {
    const runInit = loadRunInit();
    const code = await runInit([]);

    expect(code).toBe(0);
    const d = disk();
    expect(d.auth).toEqual({ mode: "none" });
    // The derived shared-key projection is never persisted.
    expect(d).not.toHaveProperty("controlToken");
    // Next-step nudge points at the browser login, not doctor.
    const out = logs.join("\n");
    expect(out).toMatch(/Next: mla login/);
    expect(out).not.toMatch(/--control-token <token> is required/);
  });

  it("opts in to shared-key (and goes to doctor) when --control-token is given", async () => {
    const runInit = loadRunInit();
    const code = await runInit(["--control-token", "secret_key"]);

    expect(code).toBe(0);
    expect(disk().auth).toEqual({ mode: "shared-key", accessToken: "secret_key" });
    expect(logs.join("\n")).toMatch(/Next: mla doctor/);
  });

  it("preserves a live user-token on a tokenless re-run (no downgrade to none)", async () => {
    // Seed a browser-login config, then re-run `mla init` with no token. The
    // operator must stay logged in: re-init is "rewire", not "log me out".
    fs.writeFileSync(
      cfgPath,
      JSON.stringify(
        {
          controlUrl: "http://127.0.0.1:3006",
          intelUrl: "http://127.0.0.1:8100",
          mlaPath: "/m",
          auth: {
            mode: "user-token",
            accessToken: "at_1",
            refreshToken: "rt_1",
            accessExpiresAt: "2030-01-01T00:00:00.000Z",
            refreshExpiresAt: "2030-02-01T00:00:00.000Z",
            sessionId: "sess_1",
            user: { id: "u_1", displayName: "An", email: null, role: "OWNER" },
          },
        },
        null,
        2,
      ) + "\n",
    );

    const runInit = loadRunInit();
    const code = await runInit([]);

    expect(code).toBe(0);
    expect((disk().auth as { mode: string }).mode).toBe("user-token");
    expect(logs.join("\n")).toMatch(/Next: mla doctor/);
  });
});
