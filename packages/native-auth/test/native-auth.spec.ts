/**
 * Tests for what the EXTRACTION changed, not for the flow itself.
 *
 * The loopback dance, the CSRF check, the browser launcher and the bundle
 * validation all keep their existing coverage in the CLI's `test/lib/login-*.spec.ts`,
 * which run unchanged against this package through the CLI's binding. Repeating
 * them here would mean one behaviour failing two files for the same reason.
 *
 * What is genuinely new is that `clientId` and the transport became parameters.
 * Those are what a second first-party client will supply differently, so they are
 * what this file pins.
 */
import { exchangeGrant, runBrowserLogin, type NativeAuthFetch, type TokenBundle } from "../src/index";

const BUNDLE: TokenBundle = {
  sessionId: "sess_1",
  accessToken: "ml_at_x",
  refreshToken: "ml_rt_x",
  accessExpiresAt: "2026-08-21T00:00:00.000Z",
  refreshExpiresAt: "2026-09-19T00:00:00.000Z",
  user: {
    id: "wu_1",
    displayName: "An",
    email: null,
    avatarUrl: null,
    role: "OWNER",
    roleVersion: 1,
    canCreateDiff: true,
    canAdminDiff: true,
  },
  workspace: null,
};

function okFetch(capture: { calls: Parameters<NativeAuthFetch>[] }): NativeAuthFetch {
  return async (destination, url, init) => {
    capture.calls.push([destination, url, init]);
    return { ok: true, status: 200, text: async () => JSON.stringify(BUNDLE) };
  };
}

describe("the transport is injected, not imported", () => {
  it("sends the exchange through the supplied fetch", async () => {
    const capture = { calls: [] as Parameters<NativeAuthFetch>[] };
    const bundle = await exchangeGrant("http://127.0.0.1:3006", "code_1", "verifier_1", {
      fetchImpl: okFetch(capture),
      userAgent: "test-agent/1.0",
    });

    expect(bundle.sessionId).toBe("sess_1");
    expect(capture.calls).toHaveLength(1);
    const [destination, url, init] = capture.calls[0];
    expect(destination).toBe("control");
    expect(url).toBe("http://127.0.0.1:3006/internal/v1/auth/cli-login-grants/exchange");
    expect(init.body).toEqual({ code: "code_1", codeVerifier: "verifier_1", userAgent: "test-agent/1.0" });
  });

  it("sends NO Authorization header, because the code plus verifier ARE the proof", async () => {
    // Control rejects this endpoint with 400 unexpected_authorization_header if one
    // is present (proposal §0.01 clause 1). The invariant survived the move, so it
    // is asserted here rather than assumed to have.
    const capture = { calls: [] as Parameters<NativeAuthFetch>[] };
    await exchangeGrant("http://127.0.0.1:3006", "c", "v", {
      fetchImpl: okFetch(capture),
      userAgent: "ua",
    });

    const headers = capture.calls[0][2].headers;
    expect(Object.keys(headers).map((k) => k.toLowerCase())).toEqual(["content-type"]);
  });

  it("surfaces a failed exchange without echoing the request", async () => {
    const fetchImpl: NativeAuthFetch = async () => ({
      ok: false,
      status: 400,
      text: async () => "invalid_or_expired",
    });

    await expect(
      exchangeGrant("http://127.0.0.1:3006", "the-secret-code", "the-secret-verifier", {
        fetchImpl,
        userAgent: "ua",
      }),
    ).rejects.toThrow(/HTTP 400.*invalid_or_expired/);

    // The message names the failure and NEVER the code or the verifier.
    await exchangeGrant("http://127.0.0.1:3006", "the-secret-code", "the-secret-verifier", {
      fetchImpl,
      userAgent: "ua",
    }).catch((e: Error) => {
      expect(e.message).not.toContain("the-secret-code");
      expect(e.message).not.toContain("the-secret-verifier");
    });
  });

  it("rejects a bundle missing required identity fields rather than persisting it", async () => {
    const fetchImpl: NativeAuthFetch = async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ accessToken: "a" }),
    });

    await expect(
      exchangeGrant("u", "c", "v", { fetchImpl, userAgent: "ua" }),
    ).rejects.toThrow(/missing required token\/identity fields/);
  });
});

describe("clientId is a parameter, so a second client is a string and not a fork", () => {
  async function capturedAuthUrl(clientId: string): Promise<URL> {
    let authUrl = "";
    await runBrowserLogin({
      controlUrl: "http://127.0.0.1:3006",
      clientId,
      fetchImpl: (async () => {
        throw new Error("unreachable: exchangeFn is injected");
      }) as NativeAuthFetch,
      userAgent: "ua",
      log: () => undefined,
      openBrowserFn: async (url: string) => {
        authUrl = url;
        return 0;
      },
      // Resolve immediately so the loopback listener is torn down and the test does
      // not wait five minutes for a callback that will never arrive.
      exchangeFn: async () => BUNDLE,
      timeoutMs: 50,
    }).catch(() => undefined);
    return new URL(authUrl);
  }

  it("puts the caller's clientId on the authorize URL", async () => {
    expect((await capturedAuthUrl("mla")).searchParams.get("client_id")).toBe("mla");
    expect((await capturedAuthUrl("meetless-desktop")).searchParams.get("client_id")).toBe(
      "meetless-desktop",
    );
  });

  it("keeps the RFC 8252 shape: S256 PKCE and a 127.0.0.1 redirect", async () => {
    const url = await capturedAuthUrl("mla");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // 127.0.0.1 ONLY. Never 0.0.0.0, never localhost: a LAN peer must not be able
    // to reach the callback (RFC 8252 §7.3).
    expect(url.searchParams.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  });

  it("carries a state nonce distinct per attempt", async () => {
    const a = (await capturedAuthUrl("mla")).searchParams.get("state");
    const b = (await capturedAuthUrl("mla")).searchParams.get("state");
    expect(a).toBeTruthy();
    expect(a).not.toBe(b);
  });
});

describe("console URL inference", () => {
  it("fails loud rather than guessing an origin", async () => {
    await expect(
      runBrowserLogin({
        controlUrl: "https://control.example.invalid",
        clientId: "mla",
        fetchImpl: (async () => {
          throw new Error("unreachable");
        }) as NativeAuthFetch,
        userAgent: "ua",
        log: () => undefined,
      }),
    ).rejects.toThrow(/Pass --console-url/);
  });
});
