import type { CliConfig } from "../../src/lib/config";
import type { HttpError } from "../../src/lib/http";
import {
  makeControlFetchFromCli,
  makeIntelFetchFromCli,
  makeIntelAskFromCli,
  type HttpVerbs,
} from "../../src/lib/mcp-fetchers";

// Slice 1 of the `mla mcp` refactor (notes/20260530-mla-init-browser-login-
// proposal.md keystone + 20260610-dogfood-issue-collection.md). These adapters
// turn http.ts (user-token auth + auto-refresh) into the env-free fetch-closure
// contract the MCP handlers (relationship_actions.js, kb_actions.js,
// evidence_actions.js, ask_modes.js) were built against:
//
//   async (pathAndQuery, init?) => parsedJson
//
// where init is undefined (GET), {method:"GET"}, or
// {method:"POST", body: JSON.stringify(obj)}. This drops the service key: the
// MCP authenticates as the logged-in human, exactly like the rest of `mla`.

function userTokenConfig(): CliConfig {
  return {
    controlUrl: "http://control.test",
    controlToken: "ml_at_initial",
    intelUrl: "http://intel.test",
    mlaPath: "/tmp/mla",
    actorUserId: "u1",
    auth: {
      mode: "user-token",
      accessToken: "ml_at_initial",
      refreshToken: "ml_rt_initial",
      accessExpiresAt: "2999-01-01T00:00:00.000Z",
      refreshExpiresAt: "2999-02-01T00:00:00.000Z",
      sessionId: "s1",
      user: { id: "u1", displayName: "An", email: null, role: "OWNER" },
    },
  };
}

function sharedKeyConfig(): CliConfig {
  return {
    controlUrl: "http://control.test",
    controlToken: "internal-key",
    intelUrl: "http://intel.test",
    mlaPath: "/tmp/mla",
    auth: { mode: "shared-key", accessToken: "internal-key" },
  };
}

function http401(): HttpError {
  const e = new Error("GET http://intel.test/x -> HTTP 401: ") as HttpError;
  e.status = 401;
  e.body = "";
  return e;
}

function http404(): HttpError {
  const e = new Error("GET http://intel.test/x -> HTTP 404: nope") as HttpError;
  e.status = 404;
  e.body = "nope";
  return e;
}

// When intelPost's AbortController fires (synthesis ran past the deadline),
// undici rejects the fetch with a DOMException named "AbortError" whose message
// is the generic "This operation was aborted". intelPost rethrows it raw and it
// has no .status, so it reaches the MCP query handler verbatim.
function abortError(): Error {
  const e = new Error("This operation was aborted");
  e.name = "AbortError";
  return e;
}

describe("mcp-fetchers — control fetch adapter", () => {
  it("dispatches an init-less call as a GET through http.get", async () => {
    const calls: Array<[string, string, unknown]> = [];
    const verbs: HttpVerbs = {
      get: async (_c, p) => {
        calls.push(["get", p, undefined]);
        return { ok: true };
      },
      post: async () => ({}),
      patch: async () => ({}),
    };
    const cfg = userTokenConfig();
    const controlFetch = makeControlFetchFromCli(cfg, verbs);

    const out = await controlFetch("/internal/v1/relationship-candidates?x=1");

    expect(out).toEqual({ ok: true });
    expect(calls).toEqual([
      ["get", "/internal/v1/relationship-candidates?x=1", undefined],
    ]);
  });

  it("dispatches {method:'POST', body: JSON.stringify(obj)} by parsing the body into http.post", async () => {
    const calls: Array<[string, string, unknown]> = [];
    const verbs: HttpVerbs = {
      get: async () => ({}),
      post: async (_c, p, b) => {
        calls.push(["post", p, b]);
        return { accepted: true };
      },
      patch: async () => ({}),
    };
    const cfg = userTokenConfig();
    const controlFetch = makeControlFetchFromCli(cfg, verbs);

    const out = await controlFetch("/internal/v1/relationship-candidates/abc/accept", {
      method: "POST",
      body: JSON.stringify({ userId: "u1", note: "ok" }),
    });

    expect(out).toEqual({ accepted: true });
    // The body reaches http.post as a PARSED object (http.ts re-stringifies it),
    // never the double-encoded string.
    expect(calls).toEqual([
      ["post", "/internal/v1/relationship-candidates/abc/accept", { userId: "u1", note: "ok" }],
    ]);
  });

  it("passes the SAME cfg object to http.ts so an in-run token rotation is visible", async () => {
    let seenCfg: CliConfig | undefined;
    const verbs: HttpVerbs = {
      get: async (c) => {
        seenCfg = c;
        return {};
      },
      post: async () => ({}),
      patch: async () => ({}),
    };
    const cfg = userTokenConfig();
    const controlFetch = makeControlFetchFromCli(cfg, verbs);

    await controlFetch("/internal/v1/x");

    expect(seenCfg).toBe(cfg);
  });
});

describe("mcp-fetchers — intel fetch adapter (reactive refresh)", () => {
  it("propagates a non-401 HttpError unchanged so handlers can read err.status (e.g. kb 404)", async () => {
    const verbs: HttpVerbs = {
      get: async () => {
        throw http404();
      },
      post: async () => ({}),
      patch: async () => ({}),
    };
    const refresh = jest.fn();
    const cfg = userTokenConfig();
    const intelFetch = makeIntelFetchFromCli(cfg, verbs, refresh);

    await expect(intelFetch("/internal/v1/kb/documents/x/detail")).rejects.toMatchObject({
      status: 404,
    });
    expect(refresh).not.toHaveBeenCalled();
  });

  it("on a 401 under user-token, runs refreshUserToken and retries once on 'refreshed'", async () => {
    let attempt = 0;
    const verbs: HttpVerbs = {
      get: async () => {
        attempt += 1;
        if (attempt === 1) throw http401();
        return { recovered: true };
      },
      post: async () => ({}),
      patch: async () => ({}),
    };
    const refresh = jest.fn(async () => "refreshed" as const);
    const cfg = userTokenConfig();
    const intelFetch = makeIntelFetchFromCli(cfg, verbs, refresh);

    const out = await intelFetch("/internal/v1/kb/documents/x/detail");

    expect(out).toEqual({ recovered: true });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith(cfg);
    expect(attempt).toBe(2);
  });

  it("on a 401 where refresh returns 'expired', rethrows the 401 and does NOT retry", async () => {
    let attempt = 0;
    const verbs: HttpVerbs = {
      get: async () => {
        attempt += 1;
        throw http401();
      },
      post: async () => ({}),
      patch: async () => ({}),
    };
    const refresh = jest.fn(async () => "expired" as const);
    const cfg = userTokenConfig();
    const intelFetch = makeIntelFetchFromCli(cfg, verbs, refresh);

    await expect(intelFetch("/internal/v1/kb/documents/x/detail")).rejects.toMatchObject({
      status: 401,
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(attempt).toBe(1);
  });

  it("does NOT attempt refresh on a 401 in shared-key mode (no user session to rotate)", async () => {
    let attempt = 0;
    const verbs: HttpVerbs = {
      get: async () => {
        attempt += 1;
        throw http401();
      },
      post: async () => ({}),
      patch: async () => ({}),
    };
    const refresh = jest.fn(async () => "refreshed" as const);
    const cfg = sharedKeyConfig();
    const intelFetch = makeIntelFetchFromCli(cfg, verbs, refresh);

    await expect(intelFetch("/internal/v1/kb/documents/x/detail")).rejects.toMatchObject({
      status: 401,
    });
    expect(refresh).not.toHaveBeenCalled();
    expect(attempt).toBe(1);
  });
});

describe("mcp-fetchers — intelAsk adapter", () => {
  it("builds the /v1/ask payload (surface mcp, defaults) and returns intel's parsed json", async () => {
    const calls: Array<[string, unknown]> = [];
    const intelPostFn = async (_c: CliConfig, p: string, b: unknown) => {
      calls.push([p, b]);
      return { answer: "hi", results: [] };
    };
    const cfg = userTokenConfig();
    const intelAsk = makeIntelAskFromCli(cfg, intelPostFn);

    const out = await intelAsk({ question: "what is X?", workspaceId: "ws_1" });

    expect(out).toEqual({ answer: "hi", results: [] });
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe("/v1/ask");
    expect(calls[0][1]).toEqual({
      workspace_id: "ws_1",
      question: "what is X?",
      surface: "mcp",
      stream: false,
      language: "en",
      thread_text: null,
      mode: "answer",
      filters: {},
      max_results: 8,
      min_results: 3,
      // The delivery key. Minted here because this caller passed none; asserted
      // in its own test below.
      submission_id: expect.any(String),
    });
    // as_of is omitted entirely when not supplied (byte-identical to today).
    expect(Object.prototype.hasOwnProperty.call(calls[0][1], "as_of")).toBe(false);
  });

  // An ask is a metered spend, and Control admits a spend only against a delivery
  // key: the key is what makes a re-delivered request collapse onto the ONE money
  // authorization it already opened instead of buying the run a second time. A
  // keyless ask is denied, so the key can never be optional on this path.
  it("always posts a submission_id, even when the caller mints none (a keyless ask is a denied spend)", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const intelPostFn = async (_c: CliConfig, _p: string, b: unknown) => {
      bodies.push(b as Record<string, unknown>);
      return {};
    };
    const cfg = userTokenConfig();
    const intelAsk = makeIntelAskFromCli(cfg, intelPostFn);

    await intelAsk({ question: "q", workspaceId: "ws_1" });
    await intelAsk({ question: "q", workspaceId: "ws_1" });

    expect(typeof bodies[0].submission_id).toBe("string");
    expect(bodies[0].submission_id).not.toBe("");
    // Two genuinely separate calls are two separate deliveries: each buys its own
    // authorization. Reusing one key here would collide two different executions
    // under one delivery id.
    expect(bodies[1].submission_id).not.toBe(bodies[0].submission_id);
  });

  it("prefers the caller's submissionId over minting one (mla mcp mints per tool call)", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const intelPostFn = async (_c: CliConfig, _p: string, b: unknown) => {
      bodies.push(b as Record<string, unknown>);
      return {};
    };
    const cfg = userTokenConfig();
    const intelAsk = makeIntelAskFromCli(cfg, intelPostFn);

    await intelAsk({
      question: "q",
      workspaceId: "ws_1",
      submissionId: "tool-call-abc",
    });

    expect(bodies[0].submission_id).toBe("tool-call-abc");
  });

  it("reuses the same submission_id across the 401 refresh retry (one delivery, one authorization)", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    let attempt = 0;
    const intelPostFn = async (_c: CliConfig, _p: string, b: unknown) => {
      bodies.push(b as Record<string, unknown>);
      attempt += 1;
      if (attempt === 1) throw http401();
      return { answer: "ok" };
    };
    const refresh = jest.fn(async () => "refreshed" as const);
    const cfg = userTokenConfig();
    const intelAsk = makeIntelAskFromCli(cfg, intelPostFn, refresh);

    await intelAsk({ question: "q", workspaceId: "ws_1" });

    // The refresh re-posts the SAME logical request. If the retry minted a fresh
    // key, Control would see a brand-new delivery and open (and hold funds for) a
    // second authorization for one user-visible ask.
    expect(bodies).toHaveLength(2);
    expect(bodies[1].submission_id).toBe(bodies[0].submission_id);
  });

  it("posts /v1/ask with a synthesis timeout larger than intelPost's 15s default", async () => {
    const timeouts: Array<number | undefined> = [];
    const intelPostFn = async (
      _c: CliConfig,
      _p: string,
      _b: unknown,
      timeoutMs?: number,
    ) => {
      timeouts.push(timeoutMs);
      return {};
    };
    const cfg = userTokenConfig();
    const intelAsk = makeIntelAskFromCli(cfg, intelPostFn);

    await intelAsk({ question: "what is X?", workspaceId: "ws_1" });

    // LLM answer synthesis at /v1/ask routinely runs ~18s; intelPost's 15s
    // default aborts it ("This operation was aborted"). The ask path must
    // pass its own generous deadline so MCP answer mode stops timing out.
    expect(timeouts).toHaveLength(1);
    expect(timeouts[0]).toBeGreaterThan(15000);
  });

  it("includes as_of and honors mode/filters/maxResults/minResults overrides", async () => {
    const calls: Array<unknown> = [];
    const intelPostFn = async (_c: CliConfig, _p: string, b: unknown) => {
      calls.push(b);
      return {};
    };
    const cfg = userTokenConfig();
    const intelAsk = makeIntelAskFromCli(cfg, intelPostFn);

    await intelAsk({
      question: "q",
      workspaceId: "ws_1",
      mode: "draft_response",
      filters: { canonical: true },
      maxResults: 4,
      minResults: 1,
      asOf: "2026-06-01T00:00:00.000Z",
    });

    expect(calls[0]).toMatchObject({
      mode: "draft_response",
      filters: { canonical: true },
      max_results: 4,
      min_results: 1,
      as_of: "2026-06-01T00:00:00.000Z",
    });
  });

  it("translates a synthesis-timeout AbortError into a clear, actionable error (never the bare 'This operation was aborted')", async () => {
    const intelPostFn = async () => {
      throw abortError();
    };
    const cfg = userTokenConfig();
    const intelAsk = makeIntelAskFromCli(cfg, intelPostFn);

    const err = (await intelAsk({ question: "q", workspaceId: "ws_1" }).catch(
      (e) => e,
    )) as Error;

    expect(err).toBeInstanceOf(Error);
    // No longer the cryptic raw abort message the user used to see.
    expect(err.message).not.toBe("This operation was aborted");
    // Names the actual failure...
    expect(err.message).toMatch(/timed out/i);
    // ...and points at a non-synthesis fallback or the override knob.
    expect(err.message).toMatch(/search|retrieve|MEETLESS_ASK_TIMEOUT_MS/i);
  });

  it("does NOT swallow non-abort errors (a 500 propagates unchanged by identity)", async () => {
    const e = new Error("intel 500") as HttpError;
    e.status = 500;
    const intelPostFn = async () => {
      throw e;
    };
    const cfg = userTokenConfig();
    const intelAsk = makeIntelAskFromCli(cfg, intelPostFn);

    await expect(
      intelAsk({ question: "q", workspaceId: "ws_1" }),
    ).rejects.toBe(e);
  });

  it("recovers an expired-token ask via refresh + retry (the primary MCP path is intel-only)", async () => {
    let attempt = 0;
    const intelPostFn = async () => {
      attempt += 1;
      if (attempt === 1) throw http401();
      return { answer: "recovered" };
    };
    const refresh = jest.fn(async () => "refreshed" as const);
    const cfg = userTokenConfig();
    const intelAsk = makeIntelAskFromCli(cfg, intelPostFn, refresh);

    const out = await intelAsk({ question: "q", workspaceId: "ws_1" });

    expect(out).toEqual({ answer: "recovered" });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(attempt).toBe(2);
  });
});
