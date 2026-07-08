import { describeAuthMode } from "../../src/commands/doctor";
import type { CliAuth } from "../../src/lib/config";

// Behavioral lock for the §6.4 `mla doctor` credential-path line (T29). Pure
// function over the CliAuth union: one line per mode, never a token, and a
// user-token runway that an operator can read at a glance to predict the
// auto-refresh trigger. No server, no filesystem.

function userToken(
  accessExpiresAt: string,
  refreshExpiresAt: string = new Date(Date.now() + 80 * 86_400_000).toISOString(),
): CliAuth {
  return {
    mode: "user-token",
    accessToken: "at_secret",
    refreshToken: "rt_secret",
    accessExpiresAt,
    refreshExpiresAt,
    sessionId: "sess_1",
    user: { id: "u_1", displayName: "An Pham", email: "an@x.com", role: "OWNER" },
  };
}

describe("describeAuthMode", () => {
  it("describes none with a call to action", () => {
    expect(describeAuthMode({ mode: "none" })).toBe("none (not logged in; run `mla login`)");
  });

  it("describes shared-key as identity-free", () => {
    expect(describeAuthMode({ mode: "shared-key", accessToken: "sk_1" })).toBe(
      "shared-key (internal key; no user identity)",
    );
  });

  it("names the user and shows hours of runway under 48h", () => {
    // +3h30m so Math.floor stays at 3h even after a few ms elapse before the
    // function re-reads Date.now().
    const out = describeAuthMode(
      userToken(new Date(Date.now() + 3 * 3600_000 + 30 * 60_000).toISOString()),
    );
    expect(out).toBe("user-token (An Pham; access expires ~3h)");
  });

  it("shows days of runway at or beyond 48h", () => {
    // +5d12h so the hours->days floor lands on 5 regardless of elapsed ms.
    const out = describeAuthMode(
      userToken(new Date(Date.now() + 5 * 86_400_000 + 12 * 3600_000).toISOString()),
    );
    expect(out).toBe("user-token (An Pham; access expires ~5d)");
  });

  it("flags an expired access token as conditionally refreshable, NOT a guaranteed refresh", () => {
    // Access expired, refresh window still locally-fresh. Auto-refresh MIGHT
    // work, but if the refresh token is dead server-side it does not; the line
    // must point at `mla login` as the fallback and never promise a refresh that
    // could fail (the old "(will auto-refresh)" lie trapped operators).
    const out = describeAuthMode(userToken(new Date(Date.now() - 3600_000).toISOString()));
    expect(out).toBe("user-token (An Pham; access token expired (auto-refresh, else `mla login`))");
    expect(out).not.toMatch(/will auto-refresh/);
  });

  it("calls a fully-lapsed session (access AND refresh expired) what it is", () => {
    const out = describeAuthMode(
      userToken(
        new Date(Date.now() - 3600_000).toISOString(),
        new Date(Date.now() - 86_400_000).toISOString(),
      ),
    );
    expect(out).toBe("user-token (An Pham; session expired; run `mla login`)");
  });

  it("tolerates an unparseable expiry without crashing", () => {
    const out = describeAuthMode(userToken("not-a-date"));
    expect(out).toBe("user-token (An Pham; expiry unknown)");
  });

  it("falls back to the user id when the display name is empty, and never prints a token", () => {
    const auth = userToken(new Date(Date.now() + 3600_000).toISOString());
    (auth as { user: { displayName: string } }).user.displayName = "";
    const out = describeAuthMode(auth);
    expect(out).toMatch(/^user-token \(u_1; /);
    expect(out).not.toMatch(/at_secret|rt_secret/);
  });
});
