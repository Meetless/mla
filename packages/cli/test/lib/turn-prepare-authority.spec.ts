import {
  fetchCanonicalTurnContext,
  formatTurnAuthority,
  normalizeCanonicalContext,
  prepareTurn,
  type PrepareTurnOptions,
} from "../../src/lib/turn-prepare-authority";
import type { AssembleInput, AssembleOutput } from "../../src/lib/scanner/assemble";

const legacyInput: AssembleInput = {
  base: "BASE",
  prompt: "",
  floorRules: [{ ruleId: "f1", versionId: "f1v", text: "floor one", strength: "MUST" }],
  scopedRules: [],
  explicitPaths: [],
  workingSetPaths: [],
  safeTotal: 100_000,
};

const opts = (over: Partial<PrepareTurnOptions>): PrepareTurnOptions => ({
  cutover: false,
  platformUrl: "http://127.0.0.1:3020",
  accessToken: "tok",
  task: "t",
  sessionId: "s",
  legacyInput,
  ...over,
});

describe("normalizeCanonicalContext", () => {
  it("extracts the four tiers and drops malformed rules", () => {
    const ctx = normalizeCanonicalContext({
      context: {
        floorMust: [{ ruleId: "f1", versionId: "f1v", text: "a", strength: "MUST" }, { ruleId: "", text: "x" }],
        floorShould: [{ ruleId: "fs1", text: "b", strength: "SHOULD" }],
        scopedRequired: [{ ruleId: "s1", text: "c", strength: "MUST", signal: "turn_trigger" }],
        bestEffort: [{ ruleId: "be1", text: "d", strength: "SHOULD", source: "scoped" }],
      },
    });
    expect(ctx?.floorMust.map((r) => r.ruleId)).toEqual(["f1"]); // the blank-id rule dropped
    expect(ctx?.scopedRequired[0]).toMatchObject({ ruleId: "s1", text: "c", strength: "MUST" });
    expect(ctx?.bestEffort[0]).toMatchObject({ ruleId: "be1", source: "scoped" });
  });

  it("returns null for a body with no context", () => {
    expect(normalizeCanonicalContext(null)).toBeNull();
    expect(normalizeCanonicalContext({ nope: 1 })).toBeNull();
  });
});

// A deterministic mock of the socket global.fetch returning a fixed status/body, so the
// availability-vs-refusal taxonomy (4xx vs 5xx vs malformed) is testable without a live tier.
async function withMockFetch<T>(status: number, body: string, fn: () => Promise<T>): Promise<T> {
  const real = global.fetch;
  global.fetch = (() => Promise.resolve(new Response(body, { status }))) as unknown as typeof global.fetch;
  try {
    return await fn();
  } finally {
    global.fetch = real;
  }
}

describe("fetchCanonicalTurnContext availability-vs-refusal taxonomy", () => {
  it("no URL (nothing to call) is a plain availability FALLBACK", async () => {
    expect(await fetchCanonicalTurnContext(opts({ platformUrl: undefined }))).toEqual({
      ok: false,
      disposition: "fallback",
      reason: "canonical_unavailable",
    });
  });

  it("a missing credential WHILE CONFIGURED FAILS CLOSED (an auth failure, not an outage)", async () => {
    expect(await fetchCanonicalTurnContext(opts({ accessToken: undefined }))).toEqual({
      ok: false,
      disposition: "fail_closed",
      reason: "canonical_refused",
    });
  });

  it("an unreachable tier is an availability FALLBACK (not a throw)", async () => {
    expect(await fetchCanonicalTurnContext(opts({ platformUrl: "http://127.0.0.1:9" }))).toEqual({
      ok: false,
      disposition: "fallback",
      reason: "canonical_unavailable",
    });
  });

  it("a 4xx (401/403/429) is an explicit REFUSAL: fail closed, never legacy", async () => {
    for (const status of [400, 401, 402, 403, 429]) {
      const r = await withMockFetch(status, '{"error":"nope"}', () => fetchCanonicalTurnContext(opts()));
      expect(r).toEqual({ ok: false, disposition: "fail_closed", reason: "canonical_refused", status });
    }
  });

  it("a 5xx is a server OUTAGE: availability fallback, legacy may serve", async () => {
    const r = await withMockFetch(503, "upstream down", () => fetchCanonicalTurnContext(opts()));
    expect(r).toEqual({ ok: false, disposition: "fallback", reason: "canonical_unavailable" });
  });

  it("a 2xx with a malformed decision is a fallback (canonical_invalid)", async () => {
    const r = await withMockFetch(200, '{"context":null}', () => fetchCanonicalTurnContext(opts()));
    expect(r).toEqual({ ok: false, disposition: "fallback", reason: "canonical_invalid" });
  });

  it("a 2xx with a usable decision succeeds", async () => {
    const body = JSON.stringify({ context: { floorMust: [{ ruleId: "f1", versionId: "f1v", text: "a", strength: "MUST" }] } });
    const r = await withMockFetch(200, body, () => fetchCanonicalTurnContext(opts()));
    expect(r.ok).toBe(true);
  });
});

describe("formatTurnAuthority", () => {
  it("is one greppable line, with the reason only on a fallback", () => {
    const out = {} as AssembleOutput;
    expect(formatTurnAuthority({ output: out, authority: "canonical" })).toBe("e1_authority authority=canonical");
    expect(formatTurnAuthority({ output: out, authority: "legacy_pre_cutover" })).toBe(
      "e1_authority authority=legacy_pre_cutover",
    );
    expect(formatTurnAuthority({ output: out, authority: "legacy_fallback", reason: "canonical_invalid" })).toBe(
      "e1_authority authority=legacy_fallback reason=canonical_invalid",
    );
  });
});

describe("prepareTurn holds the flip, falls back, and records the authority source", () => {
  let spy: jest.SpyInstance;
  beforeEach(() => {
    spy = jest.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => spy.mockRestore());

  it("records legacy_pre_cutover when cutover is off (the default everywhere today)", async () => {
    const r = await prepareTurn(opts({ cutover: false }));
    expect(r.authority).toBe("legacy_pre_cutover");
    expect(r.reason).toBeUndefined();
    expect(r.output.delivered.map((d) => d.ruleId)).toEqual(["f1"]);
    // The observation fires at the boundary, distinct from a fallback, so it can never be mistaken for one.
    expect(spy).toHaveBeenCalledWith("e1_authority authority=legacy_pre_cutover");
  });

  it("records legacy_fallback + canonical_unavailable when cutover is on but the tier is unreachable", async () => {
    const r = await prepareTurn(opts({ cutover: true, platformUrl: "http://127.0.0.1:9" }));
    expect(r.authority).toBe("legacy_fallback");
    expect(r.reason).toBe("canonical_unavailable");
    expect(r.output.text).toContain("floor one"); // the turn is still prepared, never blocked
    expect(spy).toHaveBeenCalledWith("e1_authority authority=legacy_fallback reason=canonical_unavailable");
  });

  it("FAILS CLOSED on a 4xx refusal: no legacy injection, no governed rules, records the refusal", async () => {
    const r = await withMockFetch(403, '{"error":"forbidden"}', () => prepareTurn(opts({ cutover: true })));
    expect(r.authority).toBe("refused");
    expect(r.reason).toBe("canonical_refused");
    expect(r.status).toBe(403);
    // The whole point: the stale local matcher must NOT serve, so its floor rule is NOT injected.
    expect(r.output.delivered).toEqual([]);
    expect(r.output.text).not.toContain("floor one");
    expect(spy).toHaveBeenCalledWith("e1_authority authority=refused reason=canonical_refused");
  });

  it("FAILS CLOSED on a missing credential while configured (no legacy bypass)", async () => {
    const r = await prepareTurn(opts({ cutover: true, accessToken: undefined }));
    expect(r.authority).toBe("refused");
    expect(r.output.delivered).toEqual([]);
    expect(r.output.text).not.toContain("floor one");
  });
});

// Step 5 safety: the per-turn canonical fetch is bounded, so a hung tier fails fast to legacy
// INSIDE the wrapper rather than stalling the injection path waiting on the hook's outer kill.
describe("fetchCanonicalTurnContext timeout", () => {
  it("falls back to canonical_unavailable when the tier does not answer within timeoutMs", async () => {
    const realFetch = global.fetch;
    // A fetch that never resolves until aborted: the AbortController's timeout must rescue the turn.
    global.fetch = ((_url: string, init: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      })) as unknown as typeof global.fetch;
    try {
      const start = Date.now();
      const r = await fetchCanonicalTurnContext({
        platformUrl: "http://127.0.0.1:3020",
        accessToken: "t",
        task: "x",
        sessionId: "s",
        timeoutMs: 15,
      });
      expect(r).toEqual({ ok: false, disposition: "fallback", reason: "canonical_unavailable" });
      expect(Date.now() - start).toBeLessThan(2000); // bounded, not a hang
    } finally {
      global.fetch = realFetch;
    }
  });
});
