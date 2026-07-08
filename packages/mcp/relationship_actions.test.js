/**
 * Phase F §F7.1 unit tests for the MCP relationship handlers.
 *
 * Strategy: inject a stub controlFetch so tests never touch a real network
 * or spawn the stdio MCP server. The stub records (path, init) tuples and
 * returns canned responses; assertions read from that recorded log.
 *
 * Run: `node --test relationship_actions.test.js`
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ensureAllowed,
  makeControlFetch,
  runRelationships,
  runVerdict,
  ALLOWED_PRIOR_OUTCOMES,
  VERDICT_ACTIONS,
} from "./relationship_actions.js";

const WS = "ws_test";
const USER = "u_test";

/** Build a controlFetch stub that records calls and returns a queued reply. */
function stubFetch(reply = { items: [] }) {
  const calls = [];
  const fn = async (pathAndQuery, init = {}) => {
    calls.push({ path: pathAndQuery, init });
    return typeof reply === "function" ? reply(pathAndQuery, init) : reply;
  };
  fn.calls = calls;
  return fn;
}

// ---------- ensureAllowed ----------------------------------------------------

test("ensureAllowed passes through null / undefined unchanged", () => {
  assert.equal(
    ensureAllowed(undefined, ALLOWED_PRIOR_OUTCOMES, "expected_prior_outcome"),
    null,
  );
  assert.equal(
    ensureAllowed(null, ALLOWED_PRIOR_OUTCOMES, "expected_prior_outcome"),
    null,
  );
});

test("ensureAllowed echoes a member value", () => {
  assert.equal(
    ensureAllowed("ACCEPTED", ALLOWED_PRIOR_OUTCOMES, "expected_prior_outcome"),
    "ACCEPTED",
  );
  assert.equal(
    ensureAllowed("PENDING", ALLOWED_PRIOR_OUTCOMES, "expected_prior_outcome"),
    "PENDING",
  );
});

test("ensureAllowed throws with the allowed-set in the message", () => {
  assert.throws(
    () => ensureAllowed("BANANA", ALLOWED_PRIOR_OUTCOMES, "expected_prior_outcome"),
    /unsupported expected_prior_outcome: "BANANA" \(allowed: PENDING, ACCEPTED, REJECTED\)/,
  );
});

// ---------- makeControlFetch -------------------------------------------------

test("makeControlFetch requires baseUrl and apiKey", () => {
  assert.throws(() => makeControlFetch({ apiKey: "k" }), /baseUrl required/);
  assert.throws(() => makeControlFetch({ baseUrl: "u" }), /apiKey required/);
});

test("makeControlFetch attaches Bearer + JSON Content-Type for body requests", async () => {
  const captured = {};
  const fakeFetch = async (url, init) => {
    captured.url = url;
    captured.init = init;
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true }),
    };
  };
  const cf = makeControlFetch({
    baseUrl: "http://example",
    apiKey: "k-test",
    fetchImpl: fakeFetch,
  });
  const out = await cf("/internal/v1/x", {
    method: "POST",
    body: JSON.stringify({ a: 1 }),
  });
  assert.deepEqual(out, { ok: true });
  assert.equal(captured.url, "http://example/internal/v1/x");
  assert.equal(captured.init.method, "POST");
  assert.equal(captured.init.headers.Authorization, "Bearer k-test");
  assert.equal(captured.init.headers["Content-Type"], "application/json");
});

test("makeControlFetch omits Content-Type for body-less GET", async () => {
  let seenHeaders;
  const cf = makeControlFetch({
    baseUrl: "http://example",
    apiKey: "k",
    fetchImpl: async (_url, init) => {
      seenHeaders = init.headers;
      return { ok: true, status: 200, text: async () => "" };
    },
  });
  await cf("/internal/v1/y", { method: "GET" });
  assert.equal(seenHeaders.Authorization, "Bearer k");
  assert.equal(seenHeaders["Content-Type"], undefined);
});

test("makeControlFetch throws on non-2xx with a body snippet", async () => {
  const cf = makeControlFetch({
    baseUrl: "http://example",
    apiKey: "k",
    fetchImpl: async () => ({
      ok: false,
      status: 422,
      text: async () => "field bad: posture must be SHADOW or LIVE",
    }),
  });
  await assert.rejects(
    () => cf("/internal/v1/z", { method: "GET" }),
    /control GET \/internal\/v1\/z 422: field bad: posture must be SHADOW or LIVE/,
  );
});

// ---------- runRelationships -------------------------------------------------
//
// §10.x single-authority cutover: mode='relationships' now lists intel's
// claim-grain RelationAssertion pending queue (GET /internal/v1/relation-
// assertions/pending) via an injected intelFetch, so the assertionId it returns
// feeds straight into runVerdict. It no longer touches control's retired
// whole-doc candidate graph, and the candidate-era filters are gone.

test("runRelationships requires a configured workspace (env-pinned, no param)", async () => {
  await assert.rejects(
    () =>
      runRelationships({}, { intelFetch: stubFetch(), defaultWorkspaceId: null }),
    /workspace is not configured/,
  );
});

test("§12.6: a smuggled workspace_id cannot substitute for an unconfigured env workspace", async () => {
  // Even with a workspace_id in args, an absent defaultWorkspaceId must throw:
  // the param is never read.
  await assert.rejects(
    () =>
      runRelationships(
        { workspace_id: "ws_foreign" },
        { intelFetch: stubFetch(), defaultWorkspaceId: null },
      ),
    /workspace is not configured/,
  );
});

test("runRelationships lists the intel pending assertion queue with the env-pinned workspace", async () => {
  const cf = stubFetch({ items: [], count: 0 });
  await runRelationships({}, { intelFetch: cf, defaultWorkspaceId: WS });
  assert.equal(cf.calls.length, 1);
  const url = new URL(`http://x${cf.calls[0].path}`);
  assert.equal(url.pathname, "/internal/v1/relation-assertions/pending");
  assert.equal(url.searchParams.get("workspaceId"), WS);
  assert.equal(cf.calls[0].init.method, "GET");
});

test("§12.6: runRelationships IGNORES a smuggled args.workspace_id (env-pinned only)", async () => {
  const cf = stubFetch({ items: [] });
  await runRelationships(
    { workspace_id: "ws_foreign" },
    { intelFetch: cf, defaultWorkspaceId: WS },
  );
  assert.equal(cf.calls.length, 1);
  const url = new URL(`http://x${cf.calls[0].path}`);
  assert.equal(
    url.searchParams.get("workspaceId"),
    WS,
    "the env-pinned workspace must win; the smuggled ws_foreign must never reach intel",
  );
  assert.ok(!cf.calls[0].path.includes("ws_foreign"));
});

test("runRelationships defaults limit to 100 and clamps to [1, 500] (matching the intel route bound)", async () => {
  const cases = [
    { input: undefined, expected: "100" },
    { input: 0, expected: "1" },
    { input: -5, expected: "1" },
    { input: 9999, expected: "500" },
    { input: 250, expected: "250" },
  ];
  for (const { input, expected } of cases) {
    const cf = stubFetch({ items: [] });
    const args = {};
    if (input !== undefined) args.limit = input;
    await runRelationships(args, { intelFetch: cf, defaultWorkspaceId: WS });
    const url = new URL(`http://x${cf.calls[0].path}`);
    assert.equal(url.searchParams.get("limit"), expected, `limit ${input}`);
  }
});

test("runRelationships projects the assertion shape: assertionId leads, proposition is readable", async () => {
  const raw = {
    items: [
      {
        assertionId: "ra_1",
        assertionFingerprint: "fp_abc",
        subjectStableIdentity: "claim:subj",
        relationType: "SUPERSEDES",
        objectStableIdentity: "claim:obj",
        normalizedQualifiers: { scope: "sprint-3" },
        assertionSchemaVersion: "v2",
        reviewOutcome: "PENDING",
        lifecycleStatus: "ACTIVE",
        reviewedBy: null,
        createdAt: "2026-06-20T00:00:00Z",
        subjectLabel: "Old auth design",
        objectLabel: "New auth design",
      },
    ],
    count: 1,
  };
  const out = await runRelationships(
    {},
    { intelFetch: stubFetch(raw), defaultWorkspaceId: WS },
  );
  assert.equal(out.mode, "relationships");
  assert.equal(out.items.length, 1);
  const it = out.items[0];
  // The id the verdict tool consumes leads the row.
  assert.equal(it.assertionId, "ra_1");
  assert.equal(it.relationType, "SUPERSEDES");
  assert.deepEqual(it.subject, {
    stableIdentity: "claim:subj",
    label: "Old auth design",
  });
  assert.deepEqual(it.object, {
    stableIdentity: "claim:obj",
    label: "New auth design",
  });
  assert.deepEqual(it.qualifiers, { scope: "sprint-3" });
  assert.equal(it.reviewOutcome, "PENDING");
  assert.equal(it.lifecycleStatus, "ACTIVE");
  assert.equal(it.fingerprint, "fp_abc");
  assert.equal(it.schemaVersion, "v2");
  // No candidate-era plumbing leaks through.
  assert.equal(it.statusId, undefined);
  assert.equal(it.postureId, undefined);
  assert.equal(it.sourceArtifactId, undefined);
});

test("runRelationships surfaces the full pending backlog count for a badge", async () => {
  // The route returns `count` independent of the page `limit`, so a reviewer
  // paging at limit=1 still sees how much is queued behind it.
  const cf = stubFetch({ items: [{ assertionId: "ra_1" }], count: 142 });
  const out = await runRelationships(
    { limit: 1 },
    { intelFetch: cf, defaultWorkspaceId: WS },
  );
  assert.equal(out.count, 142);
  assert.equal(out.items.length, 1);
  assert.deepEqual(out.appliedFilters, { workspaceId: WS, limit: 1 });
});

test("runRelationships tolerates a missing items array and a missing count", async () => {
  const out = await runRelationships(
    {},
    { intelFetch: stubFetch({}), defaultWorkspaceId: WS },
  );
  assert.deepEqual(out.items, []);
  // count falls back to the projected length when the route omits it.
  assert.equal(out.count, 0);
});

test("runRelationships nulls absent subject/object labels (optional on the route)", async () => {
  const raw = {
    items: [
      {
        assertionId: "ra_2",
        relationType: "REFERENCES",
        subjectStableIdentity: "claim:a",
        objectStableIdentity: "jira:PDM-9",
        reviewOutcome: "PENDING",
        lifecycleStatus: "ACTIVE",
        createdAt: "2026-06-21T00:00:00Z",
        // no subjectLabel / objectLabel / normalizedQualifiers
      },
    ],
  };
  const out = await runRelationships(
    {},
    { intelFetch: stubFetch(raw), defaultWorkspaceId: WS },
  );
  const it = out.items[0];
  assert.equal(it.subject.label, null);
  assert.equal(it.object.label, null);
  assert.deepEqual(it.qualifiers, {});
});

// ---------- runVerdict -------------------------------------------------------
//
// §10.2 hard swap: the verdict now records onto intel's RelationAssertion trust
// model (POST /internal/v1/relation-assertions/{id}/verdict), so the handler is
// driven by an injected `intelFetch` and acts on `assertion_id`.

test("runVerdict rejects unsupported actions with the (accept, reject) allowed-set", async () => {
  await assert.rejects(
    () =>
      runVerdict(
        { action: "obliterate", assertion_id: "ra_1" },
        { intelFetch: stubFetch(), defaultWorkspaceId: WS, defaultUserId: USER },
      ),
    /unsupported action: "obliterate" \(allowed: accept, reject\)/,
  );
});

test("runVerdict rejects the dropped candidate-era verbs", async () => {
  for (const action of ["defer", "promote-posture", "propose-correction"]) {
    await assert.rejects(
      () =>
        runVerdict(
          { action, assertion_id: "ra_1" },
          { intelFetch: stubFetch(), defaultWorkspaceId: WS, defaultUserId: USER },
        ),
      /unsupported action:/,
      `${action} must no longer be accepted`,
    );
  }
});

test("runVerdict requires assertion_id", async () => {
  await assert.rejects(
    () =>
      runVerdict(
        { action: "accept" },
        { intelFetch: stubFetch(), defaultWorkspaceId: WS, defaultUserId: USER },
      ),
    /assertion_id is required/,
  );
});

test("runVerdict requires a configured workspace (env-pinned, no fallback)", async () => {
  await assert.rejects(
    () =>
      runVerdict(
        { action: "accept", assertion_id: "ra_1" },
        { intelFetch: stubFetch(), defaultWorkspaceId: null, defaultUserId: USER },
      ),
    /workspace is not configured/,
  );
});

test("SEC-2.2: runVerdict IGNORES a smuggled workspace_id (env-pinned only)", async () => {
  const cf = stubFetch({ reviewEventId: "rev_1" });
  await runVerdict(
    { action: "accept", assertion_id: "ra_1", workspace_id: "ws_foreign" },
    { intelFetch: cf, defaultWorkspaceId: WS, defaultUserId: USER },
  );
  assert.equal(cf.calls.length, 1);
  const url = new URL(`http://x${cf.calls[0].path}`);
  assert.equal(
    url.searchParams.get("workspaceId"),
    WS,
    "the env-pinned workspace must win; ws_foreign must never reach intel",
  );
  assert.ok(!cf.calls[0].path.includes("ws_foreign"));
});

test("runVerdict requires user_id (no default operator)", async () => {
  await assert.rejects(
    () =>
      runVerdict(
        { action: "accept", assertion_id: "ra_1" },
        { intelFetch: stubFetch(), defaultWorkspaceId: WS, defaultUserId: null },
      ),
    /user_id is required \(or set MEETLESS_OPERATOR_USER_ID/,
  );
});

test("runVerdict rejects an out-of-band expected_prior_outcome", async () => {
  await assert.rejects(
    () =>
      runVerdict(
        {
          action: "accept",
          assertion_id: "ra_1",
          expected_prior_outcome: "MAYBE",
        },
        { intelFetch: stubFetch(), defaultWorkspaceId: WS, defaultUserId: USER },
      ),
    /unsupported expected_prior_outcome: "MAYBE" \(allowed: PENDING, ACCEPTED, REJECTED\)/,
  );
});

test("runVerdict POSTs to the intel assertion-verdict path with the workspace query param", async () => {
  const cf = stubFetch({ reviewEventId: "rev_1" });
  await runVerdict(
    { action: "accept", assertion_id: "ra_42" },
    { intelFetch: cf, defaultWorkspaceId: WS, defaultUserId: USER },
  );
  assert.equal(cf.calls.length, 1);
  const url = new URL(`http://x${cf.calls[0].path}`);
  assert.equal(url.pathname, "/internal/v1/relation-assertions/ra_42/verdict");
  assert.equal(url.searchParams.get("workspaceId"), WS);
  assert.equal(cf.calls[0].init.method, "POST");
});

test("runVerdict maps accept -> ACCEPTED and reject -> REJECTED in the body outcome", async () => {
  for (const [action, outcome] of [
    ["accept", "ACCEPTED"],
    ["reject", "REJECTED"],
  ]) {
    const cf = stubFetch({ reviewEventId: "rev_1" });
    await runVerdict(
      { action, assertion_id: "ra_1" },
      { intelFetch: cf, defaultWorkspaceId: WS, defaultUserId: USER },
    );
    const body = JSON.parse(cf.calls[0].init.body);
    assert.deepEqual(body, {
      outcome,
      expectedPriorOutcome: "PENDING",
      actorUserId: USER,
    });
  }
});

test("runVerdict body wiring: outcome + actorUserId always; expectedPriorOutcome defaults to PENDING", async () => {
  // default prior outcome
  const cf1 = stubFetch({ reviewEventId: "rev_1" });
  await runVerdict(
    { action: "accept", assertion_id: "ra_1" },
    { intelFetch: cf1, defaultWorkspaceId: WS, defaultUserId: USER },
  );
  assert.deepEqual(JSON.parse(cf1.calls[0].init.body), {
    outcome: "ACCEPTED",
    expectedPriorOutcome: "PENDING",
    actorUserId: USER,
  });

  // explicit prior outcome is honored
  const cf2 = stubFetch({ reviewEventId: "rev_1" });
  await runVerdict(
    {
      action: "reject",
      assertion_id: "ra_1",
      expected_prior_outcome: "ACCEPTED",
    },
    { intelFetch: cf2, defaultWorkspaceId: WS, defaultUserId: USER },
  );
  assert.deepEqual(JSON.parse(cf2.calls[0].init.body), {
    outcome: "REJECTED",
    expectedPriorOutcome: "ACCEPTED",
    actorUserId: USER,
  });
});

test("runVerdict forwards idempotency_key when present, omits it when absent/empty", async () => {
  const cf1 = stubFetch({ reviewEventId: "rev_1" });
  await runVerdict(
    { action: "accept", assertion_id: "ra_1", idempotency_key: "idem-9" },
    { intelFetch: cf1, defaultWorkspaceId: WS, defaultUserId: USER },
  );
  assert.equal(JSON.parse(cf1.calls[0].init.body).idempotencyKey, "idem-9");

  const cf2 = stubFetch({ reviewEventId: "rev_1" });
  await runVerdict(
    { action: "accept", assertion_id: "ra_1", idempotency_key: "" },
    { intelFetch: cf2, defaultWorkspaceId: WS, defaultUserId: USER },
  );
  assert.ok(!("idempotencyKey" in JSON.parse(cf2.calls[0].init.body)));
});

test("runVerdict url-encodes the assertion_id in the path", async () => {
  const cf = stubFetch({ reviewEventId: "rev_1" });
  await runVerdict(
    { action: "accept", assertion_id: "ra with space/and slash" },
    { intelFetch: cf, defaultWorkspaceId: WS, defaultUserId: USER },
  );
  assert.equal(
    cf.calls[0].path,
    "/internal/v1/relation-assertions/ra%20with%20space%2Fand%20slash/verdict?workspaceId=ws_test",
  );
});

test("runVerdict returns the {action, assertionId, workspaceId, actorUserId, outcome, result} envelope", async () => {
  const reply = {
    reviewEventId: "rev_1",
    assertionId: "ra_1",
    newOutcome: "ACCEPTED",
    idempotentReplay: false,
  };
  const cf = stubFetch(reply);
  const out = await runVerdict(
    { action: "accept", assertion_id: "ra_1" },
    { intelFetch: cf, defaultWorkspaceId: WS, defaultUserId: USER },
  );
  assert.deepEqual(out, {
    action: "accept",
    assertionId: "ra_1",
    workspaceId: WS,
    actorUserId: USER,
    outcome: "ACCEPTED",
    result: reply,
  });
});

// ---------- enum surface area sanity ----------------------------------------

test("exported allowed-set sizes match the post-cutover verdict contract", () => {
  // The candidate-era list filter enums (posture / status / review_mode /
  // promotion_status / direction) are GONE with the single-authority cutover:
  // mode='relationships' now lists the intel pending queue, whose only knob is
  // `limit`. The surviving surface is the verdict authority.
  assert.equal(VERDICT_ACTIONS.size, 2);
  assert.deepEqual([...VERDICT_ACTIONS], ["accept", "reject"]);
  assert.equal(ALLOWED_PRIOR_OUTCOMES.size, 3);
  assert.deepEqual([...ALLOWED_PRIOR_OUTCOMES], ["PENDING", "ACCEPTED", "REJECTED"]);
});

