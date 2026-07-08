import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Unit lock for the dead-auth circuit breaker (auth-breaker.ts). The breaker's
// whole correctness rests on FINGERPRINT-KEYING against the ON-DISK refresh
// token: it stays open only while the dead token is still on disk, and self-
// clears the instant a re-login rotates it. AUTH_BREAKER_PATH is frozen from
// MEETLESS_HOME at import, so each test re-points the home then resetModules() +
// require to re-freeze (same pattern as http-auto-refresh.spec.ts).

type BreakerModule = typeof import("../../src/lib/auth-breaker");

const FAR = () => new Date(Date.now() + 80 * 86_400_000).toISOString();

describe("auth-breaker (dead-auth circuit breaker)", () => {
  let tmp: string;
  let home: string;
  let cfgPath: string;
  let breakerPath: string;
  let prevHome: string | undefined;
  let prevToken: string | undefined;

  beforeEach(() => {
    prevHome = process.env.MEETLESS_HOME;
    prevToken = process.env.MEETLESS_CONTROL_TOKEN;
    delete process.env.MEETLESS_CONTROL_TOKEN;
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mla-breaker-"));
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
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function load(): BreakerModule {
    process.env.MEETLESS_HOME = home;
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require("../../src/lib/auth-breaker") as BreakerModule;
  }

  function seedUserToken(refreshToken: string): void {
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        controlUrl: "http://127.0.0.1:3006",
        auth: {
          mode: "user-token",
          accessToken: "at_1",
          refreshToken,
          accessExpiresAt: FAR(),
          refreshExpiresAt: FAR(),
          sessionId: "sess_1",
          user: { id: "u_1", displayName: "An", email: null, role: "OWNER" },
        },
      }),
    );
  }

  function seedShared(): void {
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        controlUrl: "http://127.0.0.1:3006",
        auth: { mode: "shared-key", accessToken: "sk_1" },
      }),
    );
  }

  it("fingerprintToken is deterministic, 16 hex chars, and collision-distinct", () => {
    const b = load();
    expect(b.fingerprintToken("rt_1")).toBe(b.fingerprintToken("rt_1"));
    expect(b.fingerprintToken("rt_1")).toMatch(/^[0-9a-f]{16}$/);
    expect(b.fingerprintToken("rt_1")).not.toBe(b.fingerprintToken("rt_2"));
  });

  it("tripAuthBreaker writes a sentinel keyed to the token's fingerprint", () => {
    const b = load();
    b.tripAuthBreaker("rt_dead", "refresh_rejected");
    expect(fs.existsSync(breakerPath)).toBe(true);
    const s = JSON.parse(fs.readFileSync(breakerPath, "utf8"));
    expect(s.refreshFingerprint).toBe(b.fingerprintToken("rt_dead"));
    expect(s.reason).toBe("refresh_rejected");
    expect(typeof s.deadSince).toBe("string");
  });

  it("consult is OPEN (true) while the dead token is still on disk", () => {
    const b = load();
    seedUserToken("rt_dead");
    b.tripAuthBreaker("rt_dead", "refresh_rejected");
    expect(b.consultAuthBreaker()).toBe(true);
  });

  it("consult self-clears (false) once the on-disk token has rotated (re-login)", () => {
    const b = load();
    seedUserToken("rt_dead");
    b.tripAuthBreaker("rt_dead", "refresh_rejected");
    // Simulate `mla login`: a fresh refresh token lands on disk.
    seedUserToken("rt_fresh");
    expect(b.consultAuthBreaker()).toBe(false);
    expect(fs.existsSync(breakerPath)).toBe(false); // stale sentinel removed
  });

  it("consult is CLOSED (false) when no sentinel exists", () => {
    const b = load();
    seedUserToken("rt_1");
    expect(b.consultAuthBreaker()).toBe(false);
  });

  it("consult fails CLOSED + clears when the config is no longer user-token", () => {
    const b = load();
    seedUserToken("rt_dead");
    b.tripAuthBreaker("rt_dead", "refresh_rejected");
    seedShared(); // operator switched to a shared key
    expect(b.consultAuthBreaker()).toBe(false);
    expect(fs.existsSync(breakerPath)).toBe(false);
  });

  it("consult fails CLOSED on an unreadable/garbage sentinel rather than blocking", () => {
    const b = load();
    seedUserToken("rt_dead");
    fs.writeFileSync(breakerPath, "{not json");
    expect(b.consultAuthBreaker()).toBe(false);
  });

  it("clearAuthBreaker removes the sentinel and is idempotent", () => {
    const b = load();
    b.tripAuthBreaker("rt_dead", "refresh_rejected");
    expect(fs.existsSync(breakerPath)).toBe(true);
    b.clearAuthBreaker();
    expect(fs.existsSync(breakerPath)).toBe(false);
    expect(() => b.clearAuthBreaker()).not.toThrow(); // already gone
  });
});
