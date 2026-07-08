/**
 * D3 unit tests for the MCP evidence retrieval handler
 * (meetless__retrieve_knowledge -> intel POST /v1/ask/retrieve).
 *
 * Strategy mirrors relationship_actions.test.js: inject a stub intelFetch so
 * tests never touch a real network or spawn the stdio MCP server. The stub
 * records (path, init) tuples and returns canned responses; assertions read
 * from that recorded log.
 *
 * The four security invariants this surface must hold (rollout contract;
 * enforced at the dogfood edge already):
 *   SEC-2.2  workspace is server/env-derived, NEVER a model parameter.
 *   SEC-2.4  limit is clamped client-side (intel re-clamps to its server cap).
 *   SEC-3.2  intel transport/HTTP errors are MASKED (no host/port/body leak).
 *   SEC-4    evidence DTOs pass through verbatim (intel owns the closed facade).
 *
 * Run: `node --test evidence_actions.test.js`
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { runRetrieveKnowledge } from "./evidence_actions.js";

const WS = "ws_test";

/** Build an intelFetch stub that records calls and returns a queued reply. */
function stubFetch(reply = { candidates: [] }) {
  const calls = [];
  const fn = async (pathAndQuery, init = {}) => {
    calls.push({ path: pathAndQuery, init });
    return typeof reply === "function" ? reply(pathAndQuery, init) : reply;
  };
  fn.calls = calls;
  return fn;
}

/** A fetch that always throws the given error (records nothing). */
function throwingFetch(err) {
  const calls = [];
  const fn = async (pathAndQuery, init = {}) => {
    calls.push({ path: pathAndQuery, init });
    throw err;
  };
  fn.calls = calls;
  return fn;
}

/** A fetch that throws `err` for the first `failures` calls, then returns `reply`. */
function flakyFetch(failures, err, reply = { candidates: [] }) {
  const calls = [];
  const fn = async (pathAndQuery, init = {}) => {
    calls.push({ path: pathAndQuery, init });
    if (calls.length <= failures) throw err;
    return reply;
  };
  fn.calls = calls;
  return fn;
}

/** A no-op sleep so retry-backoff tests run instantly (no real timers). */
const noSleep = async () => {};

const DTO = {
  citation: "NT:20260202-wedge-v5-prd.md",
  title: "Wedge V5 PRD",
  snippet: "The Decision Diff is the core object...",
  category: "note",
  provenance: "accepted",
  status: "accepted",
  relevance: "high",
};

// ---------- happy path -------------------------------------------------------

test("posts to /v1/ask/retrieve with method POST and surface=mcp", async () => {
  const cf = stubFetch({ candidates: [DTO] });
  const out = await runRetrieveKnowledge(
    { query: "what is a decision diff" },
    { intelFetch: cf, defaultWorkspaceId: WS },
  );
  assert.equal(cf.calls.length, 1);
  assert.equal(cf.calls[0].path, "/v1/ask/retrieve");
  assert.equal(cf.calls[0].init.method, "POST");
  const body = JSON.parse(cf.calls[0].init.body);
  assert.equal(body.query, "what is a decision diff");
  assert.deepEqual(body.source_context, { surface: "mcp" });
  assert.equal(out.tool, "meetless__retrieve_knowledge");
  assert.equal(out.count, 1);
  assert.deepEqual(out.candidates, [DTO]);
});

test("trims the query before sending", async () => {
  const cf = stubFetch({ candidates: [] });
  const out = await runRetrieveKnowledge(
    { query: "   spaced query   " },
    { intelFetch: cf, defaultWorkspaceId: WS },
  );
  const body = JSON.parse(cf.calls[0].init.body);
  assert.equal(body.query, "spaced query");
  assert.equal(out.query, "spaced query");
});

// ---------- SEC-2.2: workspace is env-pinned, never a model param ------------

test("workspace_id comes from env, NOT from args (SEC-2.2)", async () => {
  const cf = stubFetch({ candidates: [] });
  await runRetrieveKnowledge(
    { query: "q", workspace_id: "ws_someone_elses" },
    { intelFetch: cf, defaultWorkspaceId: WS },
  );
  const body = JSON.parse(cf.calls[0].init.body);
  assert.equal(body.workspace_id, WS);
  assert.notEqual(body.workspace_id, "ws_someone_elses");
});

test("throws when no workspace is configured", async () => {
  const cf = stubFetch({ candidates: [] });
  await assert.rejects(
    () => runRetrieveKnowledge({ query: "q" }, { intelFetch: cf, defaultWorkspaceId: undefined }),
    /workspace is not configured/,
  );
  assert.equal(cf.calls.length, 0);
});

// ---------- query validation (no intel call on bad input) --------------------

test("empty query throws and never calls intel", async () => {
  const cf = stubFetch({ candidates: [] });
  await assert.rejects(
    () => runRetrieveKnowledge({ query: "" }, { intelFetch: cf, defaultWorkspaceId: WS }),
    /query is required/,
  );
  assert.equal(cf.calls.length, 0);
});

test("whitespace-only query throws and never calls intel", async () => {
  const cf = stubFetch({ candidates: [] });
  await assert.rejects(
    () => runRetrieveKnowledge({ query: "    " }, { intelFetch: cf, defaultWorkspaceId: WS }),
    /query is required/,
  );
  assert.equal(cf.calls.length, 0);
});

test("non-string query throws and never calls intel", async () => {
  const cf = stubFetch({ candidates: [] });
  await assert.rejects(
    () => runRetrieveKnowledge({ query: 42 }, { intelFetch: cf, defaultWorkspaceId: WS }),
    /query is required/,
  );
  assert.equal(cf.calls.length, 0);
});

// ---------- SEC-2.4: limit clamping ------------------------------------------

test("omitted limit sends no limit key (intel uses its server cap)", async () => {
  const cf = stubFetch({ candidates: [] });
  await runRetrieveKnowledge({ query: "q" }, { intelFetch: cf, defaultWorkspaceId: WS });
  const body = JSON.parse(cf.calls[0].init.body);
  assert.equal("limit" in body, false);
});

test("small limit passes through; huge limit clamps to client cap (SEC-2.4)", async () => {
  const cf = stubFetch({ candidates: [] });
  await runRetrieveKnowledge({ query: "q", limit: 5 }, { intelFetch: cf, defaultWorkspaceId: WS });
  assert.equal(JSON.parse(cf.calls[0].init.body).limit, 5);

  const cf2 = stubFetch({ candidates: [] });
  await runRetrieveKnowledge({ query: "q", limit: 10000 }, { intelFetch: cf2, defaultWorkspaceId: WS });
  assert.equal(JSON.parse(cf2.calls[0].init.body).limit, 50);
});

test("invalid limit throws and never calls intel", async () => {
  for (const bad of [0, -1, "abc", 1.5 === 1.5 ? NaN : 0]) {
    const cf = stubFetch({ candidates: [] });
    await assert.rejects(
      () => runRetrieveKnowledge({ query: "q", limit: bad }, { intelFetch: cf, defaultWorkspaceId: WS }),
      /limit must be a positive integer/,
    );
    assert.equal(cf.calls.length, 0);
  }
});

test("floors a fractional limit", async () => {
  const cf = stubFetch({ candidates: [] });
  await runRetrieveKnowledge({ query: "q", limit: 7.9 }, { intelFetch: cf, defaultWorkspaceId: WS });
  assert.equal(JSON.parse(cf.calls[0].init.body).limit, 7);
});

// ---------- SEC-3.2: error masking (no substrate leak) -----------------------

const LEAKY = "intel POST /v1/ask/retrieve 500: Traceback weaviate.exceptions at 127.0.0.1:8100 table chunk_fts";

test("masks a persistent 500 with a leaky body, no substrate leak (SEC-3.2)", async () => {
  const err = new Error(LEAKY);
  err.status = 500;
  err.body = LEAKY;
  const cf = throwingFetch(err);
  await assert.rejects(
    () =>
      runRetrieveKnowledge(
        { query: "q" },
        { intelFetch: cf, defaultWorkspaceId: WS, sleep: noSleep },
      ),
    (thrown) => {
      // a 5xx is transient: after exhausting retries the agent gets an
      // actionable "temporarily unavailable" signal, never the substrate.
      assert.match(thrown.message, /temporarily unavailable/i);
      assert.ok(!thrown.message.includes("127.0.0.1"));
      assert.ok(!thrown.message.includes("weaviate"));
      assert.ok(!thrown.message.includes("chunk_fts"));
      assert.ok(!thrown.message.includes("Traceback"));
      return true;
    },
  );
});

test("masks a 422 leaky body the same way", async () => {
  const err = new Error("intel POST /v1/ask/retrieve 422: pydantic ValidationError field workspace_id");
  err.status = 422;
  const cf = throwingFetch(err);
  await assert.rejects(
    () => runRetrieveKnowledge({ query: "q" }, { intelFetch: cf, defaultWorkspaceId: WS }),
    (thrown) => {
      assert.equal(thrown.message, "retrieval unavailable");
      assert.ok(!thrown.message.toLowerCase().includes("pydantic"));
      assert.ok(!thrown.message.includes("workspace_id"));
      return true;
    },
  );
});

test("401 surfaces an auth hint (still substrate-free) and preserves status", async () => {
  const err = new Error("intel POST /v1/ask/retrieve 401: invalid bearer at 127.0.0.1:8100");
  err.status = 401;
  const cf = throwingFetch(err);
  await assert.rejects(
    () => runRetrieveKnowledge({ query: "q" }, { intelFetch: cf, defaultWorkspaceId: WS }),
    (thrown) => {
      assert.match(thrown.message, /authentication failed/i);
      assert.equal(thrown.status, 401);
      assert.ok(!thrown.message.includes("127.0.0.1"));
      assert.ok(!thrown.message.includes("invalid bearer"));
      return true;
    },
  );
});

test("403 is masked like 401", async () => {
  const err = new Error("intel POST /v1/ask/retrieve 403: forbidden");
  err.status = 403;
  const cf = throwingFetch(err);
  await assert.rejects(
    () => runRetrieveKnowledge({ query: "q" }, { intelFetch: cf, defaultWorkspaceId: WS }),
    (thrown) => {
      assert.match(thrown.message, /authentication failed/i);
      assert.equal(thrown.status, 403);
      return true;
    },
  );
});

// ---------- resilience: transient retry (intel restart / 5xx blip) -----------

test("retries a transient network error (ECONNREFUSED) then succeeds", async () => {
  // a fetch that throws with NO .status is a transport error: intel was
  // unreachable, e.g. mid-restart by another agent. Must be retried.
  const netErr = new Error("fetch failed");
  const cf = flakyFetch(2, netErr, { candidates: [DTO] });
  const out = await runRetrieveKnowledge(
    { query: "q" },
    { intelFetch: cf, defaultWorkspaceId: WS, sleep: noSleep },
  );
  assert.equal(cf.calls.length, 3); // 2 failures + 1 success
  assert.equal(out.count, 1);
  assert.deepEqual(out.candidates, [DTO]);
});

test("retries a 503 then succeeds", async () => {
  const e = new Error("intel POST /v1/ask/retrieve 503: service unavailable");
  e.status = 503;
  const cf = flakyFetch(1, e, { candidates: [] });
  const out = await runRetrieveKnowledge(
    { query: "q" },
    { intelFetch: cf, defaultWorkspaceId: WS, sleep: noSleep },
  );
  assert.equal(cf.calls.length, 2);
  assert.equal(out.count, 0);
});

test("gives up after the attempt cap on a persistent transient failure", async () => {
  const e = new Error("intel POST /v1/ask/retrieve 500: boom");
  e.status = 500;
  const cf = throwingFetch(e);
  await assert.rejects(
    () =>
      runRetrieveKnowledge(
        { query: "q" },
        { intelFetch: cf, defaultWorkspaceId: WS, sleep: noSleep },
      ),
    /temporarily unavailable/i,
  );
  assert.equal(cf.calls.length, 3); // capped at 3 attempts
});

test("does NOT retry a deterministic 4xx (422); one call only", async () => {
  const e = new Error("intel POST /v1/ask/retrieve 422: pydantic ValidationError");
  e.status = 422;
  const cf = throwingFetch(e);
  await assert.rejects(
    () =>
      runRetrieveKnowledge(
        { query: "q" },
        { intelFetch: cf, defaultWorkspaceId: WS, sleep: noSleep },
      ),
    (thrown) => {
      assert.equal(thrown.message, "retrieval unavailable");
      return true;
    },
  );
  assert.equal(cf.calls.length, 1); // 4xx is deterministic, never retried
});

test("does NOT retry an auth failure (401); one call only", async () => {
  const e = new Error("intel 401 invalid bearer");
  e.status = 401;
  const cf = throwingFetch(e);
  await assert.rejects(
    () =>
      runRetrieveKnowledge(
        { query: "q" },
        { intelFetch: cf, defaultWorkspaceId: WS, sleep: noSleep },
      ),
    (thrown) => {
      assert.match(thrown.message, /authentication failed/i);
      assert.equal(thrown.status, 401);
      return true;
    },
  );
  assert.equal(cf.calls.length, 1); // auth is deterministic, never retried
});

// ---------- SEC-4: DTO passthrough -------------------------------------------

test("candidates pass through verbatim (intel owns the closed facade)", async () => {
  const cf = stubFetch({ candidates: [DTO, { ...DTO, citation: "DD:abc", category: "decision" }] });
  const out = await runRetrieveKnowledge({ query: "q" }, { intelFetch: cf, defaultWorkspaceId: WS });
  assert.equal(out.count, 2);
  assert.deepEqual(out.candidates[0], DTO);
  assert.equal(out.candidates[1].citation, "DD:abc");
});

test("a missing/absent candidates array yields count 0 and empty list", async () => {
  const cf = stubFetch({});
  const out = await runRetrieveKnowledge({ query: "q" }, { intelFetch: cf, defaultWorkspaceId: WS });
  assert.equal(out.count, 0);
  assert.deepEqual(out.candidates, []);
});
