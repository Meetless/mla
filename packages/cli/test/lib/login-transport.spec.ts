import * as crypto from "crypto";
import * as http from "http";

import {
  consoleUrlFromControl,
  exchangeGrant,
  generatePkce,
  openLoopbackServer,
  runBrowserLogin,
  TokenBundle,
} from "../../src/lib/login";

// Behavioral lock for the `mla login` loopback OAuth + PKCE transport (proposal
// §6.1-§6.3, T21 / T29). Exercises the real loopback HTTP listener on 127.0.0.1
// with injected browser-open + grant-exchange seams, so the full dance runs with
// no live Console/control. Security invariants asserted: redirect_uri is
// loopback-only, the CSRF `state` is enforced constant-time, and the exchange
// POST carries NO Authorization header (the code + PKCE verifier ARE the proof).

// A real HTTP GET against the loopback callback. Resolves {status, body}.
function getCallback(port: number, query: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: "127.0.0.1", port, path: `/callback?${query}` },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
  });
}

function sampleBundle(): TokenBundle {
  const future = new Date(Date.now() + 3600_000).toISOString();
  return {
    sessionId: "sess_1",
    accessToken: "at_secret",
    refreshToken: "rt_secret",
    accessExpiresAt: future,
    refreshExpiresAt: new Date(Date.now() + 80 * 86_400_000).toISOString(),
    user: {
      id: "u_1",
      displayName: "Ada Lovelace",
      email: "ada@example.com",
      avatarUrl: null,
      role: "OWNER",
      roleVersion: 1,
      canCreateDiff: true,
      canAdminDiff: true,
    },
    workspace: { id: "ws_1", name: "Acme", slug: "acme", iconUrl: null, language: "en" },
  };
}

describe("PKCE (RFC 7636 S256)", () => {
  it("challenge is base64url(sha256(verifier)) and round-trips", () => {
    const { verifier, challenge } = generatePkce();
    const expected = crypto.createHash("sha256").update(verifier).digest("base64url");
    expect(challenge).toBe(expected);
    // base64url: no padding, no + or /.
    expect(challenge).not.toMatch(/[+/=]/);
    expect(verifier).not.toMatch(/[+/=]/);
  });

  it("generates a fresh verifier each call", () => {
    expect(generatePkce().verifier).not.toBe(generatePkce().verifier);
  });
});

describe("consoleUrlFromControl pair table", () => {
  it("maps the local dev control port to the verified console dev port (3003)", () => {
    expect(consoleUrlFromControl("http://127.0.0.1:3006")).toBe("http://127.0.0.1:3003");
  });
  it("maps the production control (the default backend) to the production console", () => {
    expect(consoleUrlFromControl("https://control.meetless.ai")).toBe("https://app.meetless.ai");
  });
  it("returns null for a non-default control origin so the caller must pass --console-url", () => {
    // Self-hosted / internal backends have no hardcoded pair by design; they
    // authenticate with an explicit --console-url / MEETLESS_CONSOLE_URL.
    expect(consoleUrlFromControl("https://control.acme.io")).toBeNull();
    expect(consoleUrlFromControl("https://control.example.dev")).toBeNull();
  });
});

describe("openLoopbackServer (§6.3)", () => {
  it("resolves the callback promise on a state-valid GET with a code, then 200s", async () => {
    const { server, port, callbackPromise } = await openLoopbackServer({ state: "st_ok" });
    try {
      const r = await getCallback(port, "code=grant_123&state=st_ok");
      expect(r.status).toBe(200);
      await expect(callbackPromise).resolves.toEqual({ code: "grant_123" });
    } finally {
      server.close();
    }
  });

  it("refuses a state mismatch with 400 and never resolves the callback (CSRF)", async () => {
    const { server, port, callbackPromise } = await openLoopbackServer({ state: "st_real" });
    let settled = false;
    callbackPromise.then(() => (settled = true)).catch(() => (settled = true));
    try {
      const r = await getCallback(port, "code=grant_123&state=st_attacker");
      expect(r.status).toBe(400);
      expect(r.body).toMatch(/State mismatch/);
      // Give any stray microtask a tick; the promise must remain pending.
      await new Promise((res) => setTimeout(res, 20));
      expect(settled).toBe(false);
    } finally {
      server.close();
    }
  });

  it("rejects a state-valid callback that carries no code (malformed) with 400", async () => {
    const { server, port, callbackPromise } = await openLoopbackServer({ state: "st_ok" });
    // Attach the rejection handler BEFORE triggering, so the rejection is never
    // momentarily unhandled (jest fails a suite on an unhandled rejection).
    const rejection = callbackPromise.then(
      () => {
        throw new Error("callback should not have resolved");
      },
      (e: Error) => e,
    );
    try {
      const r = await getCallback(port, "state=st_ok");
      expect(r.status).toBe(400);
      const err = await rejection;
      expect(err.message).toMatch(/without an authorization code/);
    } finally {
      server.close();
    }
  });

  it("404s a non-/callback path", async () => {
    const { server, port } = await openLoopbackServer({ state: "st_ok" });
    try {
      const r = await getCallback(port, "x=1").catch(() => ({ status: 0, body: "" }));
      // getCallback hits /callback; hit a different path directly instead.
      const r2 = await new Promise<{ status: number }>((resolve, reject) => {
        const req = http.get({ host: "127.0.0.1", port, path: "/nope" }, (res) => {
          res.resume();
          resolve({ status: res.statusCode ?? 0 });
        });
        req.on("error", reject);
      });
      expect(r2.status).toBe(404);
      void r;
    } finally {
      server.close();
    }
  });
});

describe("runBrowserLogin orchestration (§6.1-§6.3)", () => {
  it("opens a loopback redirect_uri, drives the callback, and exchanges the code", async () => {
    let capturedUrl = "";
    let exchangedCode = "";
    const openBrowserFn = async (url: string): Promise<number> => {
      capturedUrl = url;
      const u = new URL(url);
      const redirect = u.searchParams.get("redirect_uri") ?? "";
      const state = u.searchParams.get("state") ?? "";
      // The browser would hit Console; simulate Console redirecting back to the
      // loopback with a grant code.
      const ru = new URL(redirect);
      await getCallback(Number(ru.port), `code=grant_xyz&state=${encodeURIComponent(state)}`);
      return 0;
    };
    const exchangeFn = async (
      _controlUrl: string,
      code: string,
    ): Promise<TokenBundle> => {
      exchangedCode = code;
      return sampleBundle();
    };

    const bundle = await runBrowserLogin({
      controlUrl: "http://127.0.0.1:3006",
      openBrowserFn,
      exchangeFn,
      log: () => {},
      timeoutMs: 5000,
    });

    expect(bundle.user.id).toBe("u_1");
    expect(exchangedCode).toBe("grant_xyz");
    // Security: redirect_uri MUST be loopback (127.0.0.1), never localhost/0.0.0.0.
    const u = new URL(capturedUrl);
    expect(u.pathname).toBe("/cli/authorize");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("client_id")).toBe("mla");
    const redirect = new URL(u.searchParams.get("redirect_uri") ?? "");
    expect(redirect.hostname).toBe("127.0.0.1");
    expect(redirect.pathname).toBe("/callback");
  });

  it("times out when no callback ever arrives", async () => {
    await expect(
      runBrowserLogin({
        controlUrl: "http://127.0.0.1:3006",
        openBrowserFn: async () => 0, // launched, but Console never redirects back
        exchangeFn: async () => sampleBundle(),
        log: () => {},
        timeoutMs: 200,
      }),
    ).rejects.toThrow(/timed out/i);
  });

  it("fails loud when the Console URL cannot be inferred and none was provided", async () => {
    await expect(
      runBrowserLogin({
        controlUrl: "https://control.acme.io",
        openBrowserFn: async () => 0,
        exchangeFn: async () => sampleBundle(),
        log: () => {},
        timeoutMs: 200,
      }),
    ).rejects.toThrow(/Could not infer the Console URL/);
  });
});

describe("exchangeGrant (§4.1, §0.01 clause 1)", () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it("POSTs {code, codeVerifier, userAgent} with NO Authorization header", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    global.fetch = (async (url: string, init: RequestInit) => {
      captured = { url, init };
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(sampleBundle()),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const bundle = await exchangeGrant("http://127.0.0.1:3006", "grant_abc", "verifier_xyz");
    expect(bundle.accessToken).toBe("at_secret");
    expect(captured!.url).toBe(
      "http://127.0.0.1:3006/internal/v1/auth/cli-login-grants/exchange",
    );
    const headers = captured!.init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers).not.toHaveProperty("Authorization");
    // The exchange also carries the version heartbeat (userAgent) so control can
    // record which mla build each user runs; the shape is mla/<semver> (<os>-<arch>).
    expect(JSON.parse(captured!.init.body as string)).toEqual({
      code: "grant_abc",
      codeVerifier: "verifier_xyz",
      userAgent: expect.stringMatching(/^mla\/\d+\.\d+\.\d+ \(.+-.+\)$/),
    });
  });

  it("surfaces a non-2xx without echoing the secret verifier", async () => {
    global.fetch = (async () =>
      ({
        ok: false,
        status: 400,
        text: async () => "invalid_or_expired",
      }) as unknown as Response) as unknown as typeof fetch;

    await expect(
      exchangeGrant("http://127.0.0.1:3006", "grant_abc", "super_secret_verifier"),
    ).rejects.toThrow(/Grant exchange failed: HTTP 400/);
    await expect(
      exchangeGrant("http://127.0.0.1:3006", "grant_abc", "super_secret_verifier"),
    ).rejects.not.toThrow(/super_secret_verifier/);
  });
});
