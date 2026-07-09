import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Behavioral lock for the §6.4 auth compat shim (proposal T29). readConfig must
// collapse the three accepted on-disk shapes (new nested `auth`, legacy
// top-level shared-key, legacy expanded user-token) into one CliAuth, derive the
// read-only `controlToken` projection, pin `actorUserId` under user-token (P3),
// and enforce the Gate-4 env conflict (Finding H / Blocking 4). writeConfig must
// round-trip ONLY the nested `auth`, never the derived controlToken.
//
// CFG_PATH is frozen from process.env.MEETLESS_HOME at config.ts import time, so
// every test re-points MEETLESS_HOME then jest.resetModules() + require so the
// module graph re-freezes against the test home. Env credential aliases
// (MEETLESS_CONTROL_TOKEN / MEETLESS_BACKEND_URL / MEETLESS_INTEL_URL) are read
// at readConfig() CALL time, so they are set/cleared per test without a reload.

type ConfigModule = typeof import("../../src/lib/config");

const ENV_KEYS = [
  "MEETLESS_CONTROL_TOKEN",
  "MEETLESS_BACKEND_URL",
  "MEETLESS_INTEL_URL",
  "MEETLESS_CONSOLE_URL",
] as const;

describe("config auth compat shim (§6.4, T29)", () => {
  let tmp: string;
  let home: string;
  let cfgPath: string;
  const savedEnv: Record<string, string | undefined> = {};
  let prevHome: string | undefined;

  beforeEach(() => {
    prevHome = process.env.MEETLESS_HOME;
    for (const k of ENV_KEYS) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mla-cfg-"));
    home = path.join(tmp, "home");
    fs.mkdirSync(home, { recursive: true });
    cfgPath = path.join(home, "cli-config.json");
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.MEETLESS_HOME;
    else process.env.MEETLESS_HOME = prevHome;
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function seed(raw: Record<string, unknown>): void {
    fs.writeFileSync(cfgPath, JSON.stringify(raw, null, 2) + "\n");
  }

  function loadConfig(): ConfigModule {
    process.env.MEETLESS_HOME = home;
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require("../../src/lib/config") as ConfigModule;
  }

  function readDisk(): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  }

  const FUTURE = new Date(Date.now() + 80 * 24 * 60 * 60 * 1000).toISOString();
  const ACCESS_FUTURE = new Date(Date.now() + 23 * 60 * 60 * 1000).toISOString();

  it("legacy top-level shared-key (controlToken, no refresh) -> shared-key", () => {
    seed({
      controlUrl: "http://127.0.0.1:3006",
      controlToken: "sk_legacy_123",
      mlaPath: "/usr/local/bin/mla",
    });
    const { readConfig } = loadConfig();
    const cfg = readConfig();
    expect(cfg.auth.mode).toBe("shared-key");
    if (cfg.auth.mode === "shared-key") {
      expect(cfg.auth.accessToken).toBe("sk_legacy_123");
    }
    // Derived controlToken mirrors the bearer for backwards compatibility.
    expect(cfg.controlToken).toBe("sk_legacy_123");
  });

  it("legacy expanded user-token (top-level + authMode) -> user-token, actorUserId pinned to user.id (P3)", () => {
    seed({
      controlUrl: "http://127.0.0.1:3006",
      controlToken: "at_access",
      refreshToken: "rt_refresh",
      accessExpiresAt: ACCESS_FUTURE,
      refreshExpiresAt: FUTURE,
      sessionId: "sess_1",
      authMode: "user-token",
      actorUserId: "u_should_be_ignored",
      user: { id: "u_real", displayName: "Ada Lovelace", email: "ada@example.com", role: "OWNER" },
      mlaPath: "/usr/local/bin/mla",
    });
    const { readConfig } = loadConfig();
    const cfg = readConfig();
    expect(cfg.auth.mode).toBe("user-token");
    if (cfg.auth.mode === "user-token") {
      expect(cfg.auth.accessToken).toBe("at_access");
      expect(cfg.auth.refreshToken).toBe("rt_refresh");
      expect(cfg.auth.sessionId).toBe("sess_1");
      expect(cfg.auth.user.id).toBe("u_real");
      expect(cfg.auth.user.role).toBe("OWNER");
    }
    // P3: actorUserId is pinned to auth.user.id, NOT the stale top-level value.
    expect(cfg.actorUserId).toBe("u_real");
    expect(cfg.controlToken).toBe("at_access");
  });

  it("nested {mode:'none'} -> none with empty derived controlToken", () => {
    seed({
      controlUrl: "http://127.0.0.1:3006",
      mlaPath: "/usr/local/bin/mla",
      auth: { mode: "none" },
    });
    const { readConfig } = loadConfig();
    const cfg = readConfig();
    expect(cfg.auth.mode).toBe("none");
    expect(cfg.controlToken).toBe("");
  });

  it("nested user-token round-trips and writeConfig persists ONLY nested auth (drops controlToken)", () => {
    seed({
      controlUrl: "http://127.0.0.1:3006",
      mlaPath: "/usr/local/bin/mla",
      auth: {
        mode: "user-token",
        accessToken: "at_1",
        refreshToken: "rt_1",
        accessExpiresAt: ACCESS_FUTURE,
        refreshExpiresAt: FUTURE,
        sessionId: "sess_x",
        user: { id: "u_1", displayName: "Dev", email: null, role: "MEMBER" },
      },
    });
    const { readConfig, writeConfig } = loadConfig();
    const cfg = readConfig();
    expect(cfg.auth.mode).toBe("user-token");
    writeConfig(cfg);
    const disk = readDisk();
    // controlToken is a read-time projection; it MUST NOT be serialized.
    expect(disk).not.toHaveProperty("controlToken");
    expect(disk.auth).toMatchObject({ mode: "user-token", accessToken: "at_1" });
    // Re-read is stable.
    const cfg2 = readConfig();
    expect(cfg2.auth.mode).toBe("user-token");
    expect(cfg2.controlToken).toBe("at_1");
  });

  it("actorUserId on a shared-key config survives the legacy->nested rewrite (Finding G)", () => {
    seed({
      controlUrl: "http://127.0.0.1:3006",
      controlToken: "sk_abc",
      actorUserId: "u_actor",
      mlaPath: "/usr/local/bin/mla",
    });
    const { readConfig, writeConfig } = loadConfig();
    const cfg = readConfig();
    expect(cfg.auth.mode).toBe("shared-key");
    expect(cfg.actorUserId).toBe("u_actor");
    writeConfig(cfg);
    const disk = readDisk();
    expect(disk).not.toHaveProperty("controlToken");
    expect(disk.actorUserId).toBe("u_actor");
    expect(disk.auth).toMatchObject({ mode: "shared-key", accessToken: "sk_abc" });
    expect(readConfig().actorUserId).toBe("u_actor");
  });

  it("MEETLESS_CONTROL_TOKEN under an on-disk user-token THROWS (Gate-4 / Finding H / Blocking 4)", () => {
    seed({
      controlUrl: "http://127.0.0.1:3006",
      mlaPath: "/usr/local/bin/mla",
      auth: {
        mode: "user-token",
        accessToken: "at_1",
        refreshToken: "rt_1",
        accessExpiresAt: ACCESS_FUTURE,
        refreshExpiresAt: FUTURE,
        sessionId: "sess_x",
        user: { id: "u_1", displayName: "Ada Lovelace", email: null, role: "OWNER" },
      },
    });
    const { readConfig } = loadConfig();
    process.env.MEETLESS_CONTROL_TOKEN = "sk_env";
    expect(() => readConfig()).toThrow(/MEETLESS_CONTROL_TOKEN is set but you are logged in as Ada Lovelace/);
  });

  it("MEETLESS_CONTROL_TOKEN under none overrides to shared-key (documented CI path)", () => {
    seed({
      controlUrl: "http://127.0.0.1:3006",
      mlaPath: "/usr/local/bin/mla",
      auth: { mode: "none" },
    });
    const { readConfig } = loadConfig();
    process.env.MEETLESS_CONTROL_TOKEN = "sk_env_ci";
    const cfg = readConfig();
    expect(cfg.auth.mode).toBe("shared-key");
    if (cfg.auth.mode === "shared-key") {
      expect(cfg.auth.accessToken).toBe("sk_env_ci");
    }
    expect(cfg.controlToken).toBe("sk_env_ci");
  });

  it("non-credential MEETLESS_BACKEND_URL / MEETLESS_INTEL_URL are honored even in none mode", () => {
    seed({
      controlUrl: "http://127.0.0.1:3006",
      intelUrl: "http://127.0.0.1:8100",
      mlaPath: "/usr/local/bin/mla",
      auth: { mode: "none" },
    });
    const { readConfig } = loadConfig();
    process.env.MEETLESS_BACKEND_URL = "http://control.example:9000";
    process.env.MEETLESS_INTEL_URL = "http://intel.example:9100";
    const cfg = readConfig();
    expect(cfg.controlUrl).toBe("http://control.example:9000");
    expect(cfg.intelUrl).toBe("http://intel.example:9100");
    // Still logged out: a plane selector is not a credential.
    expect(cfg.auth.mode).toBe("none");
  });

  it("user-token on disk with no access token fails loud (corrupt login)", () => {
    seed({
      controlUrl: "http://127.0.0.1:3006",
      mlaPath: "/usr/local/bin/mla",
      auth: {
        mode: "user-token",
        accessToken: "",
        refreshToken: "rt_1",
        accessExpiresAt: ACCESS_FUTURE,
        refreshExpiresAt: FUTURE,
        sessionId: "sess_x",
        user: { id: "u_1", displayName: "An", email: null, role: "OWNER" },
      },
    });
    const { readConfig } = loadConfig();
    expect(() => readConfig()).toThrow(/auth\.mode 'user-token' but no access token/);
  });

  it("unrecognized nested auth.mode fails loud rather than guessing a credential", () => {
    seed({
      controlUrl: "http://127.0.0.1:3006",
      mlaPath: "/usr/local/bin/mla",
      auth: { mode: "device-code-something" },
    });
    const { readConfig } = loadConfig();
    expect(() => readConfig()).toThrow(/unrecognized auth\.mode/);
  });

  it("writeConfig re-asserts 0600 even when the file already exists loose (overwrite ignores the mode option)", () => {
    // The token file holds a live refresh token; it must be owner-only. The
    // `{ mode: 0o600 }` on writeFileSync is honored ONLY on create, so a config
    // that ever landed loose (older CLI, permissive umask) would stay loose
    // across every refresh/re-login overwrite. Simulate that: seed a valid
    // config, force it world-readable, then writeConfig and assert the explicit
    // chmodSync tightened it back to 0600. POSIX-only; skip elsewhere.
    if (process.platform === "win32") return;
    seed({
      controlUrl: "http://127.0.0.1:3006",
      mlaPath: "/usr/local/bin/mla",
      auth: {
        mode: "user-token",
        accessToken: "at_1",
        refreshToken: "rt_secret",
        accessExpiresAt: ACCESS_FUTURE,
        refreshExpiresAt: FUTURE,
        sessionId: "sess_x",
        user: { id: "u_1", displayName: "An", email: null, role: "OWNER" },
      },
    });
    fs.chmodSync(cfgPath, 0o644);
    expect(fs.statSync(cfgPath).mode & 0o777).toBe(0o644);
    const { readConfig, writeConfig } = loadConfig();
    writeConfig(readConfig());
    expect(fs.statSync(cfgPath).mode & 0o777).toBe(0o600);
  });

  it("malformed cli-config.json throws ConfigError (operator-fixable), not a bare SyntaxError", () => {
    // The bug-report nudge classifier is message-blind and keys on the error
    // NAME. A raw JSON.parse SyntaxError would fall through to system_error and
    // wrongly scream "file a bug report" for a file the operator can just fix or
    // re-init. readConfig wraps it as ConfigError so it stays quiet, same as
    // every other config-load failure. Assert the NAME (not instanceof, which is
    // unstable across jest.resetModules) since that is exactly what the
    // classifier inspects.
    fs.writeFileSync(cfgPath, "{ definitely not: valid json ]");
    const { readConfig } = loadConfig();
    let thrown: unknown;
    try {
      readConfig();
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).name).toBe("ConfigError");
    expect((thrown as Error).message).toMatch(/not valid JSON/);
  });
});
