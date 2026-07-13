/**
 * Behavioral tests for the 2026-05-20 ingest-eval MCP wrapper fixes.
 *
 * Run: `node --test ask_modes.test.js`
 *
 * Pins the three regressions found during the dogfood ladder eval:
 *   #1 caller workspace_id is honored (was: env workspace always won, so an
 *      MCP query could never reach another workspace's corpus).
 *   #2 search mode does NOT send mode:"search" to intel (intel 422s on it);
 *      it runs answer-mode retrieval and returns citations with null prose.
 *   #3 canonical no-INDEX-match fallback also avoids mode:"search".
 *
 * makeIntelAsk's HTTP contract is tested with a stub fetch so no live intel
 * server is required.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  makeIntelAsk,
  makeAskModes,
  normalizeIntelResponse,
} from "./ask_modes.js";
import { statusFallback } from "./status_fallback.js";

// ---------- Helpers ---------------------------------------------------------

/**
 * Build an askModes bundle whose intelAsk records every call and returns a
 * canned intel response. Returns { modes, calls }.
 */
function harness({
  intelResponse = { answer: "synth", confidence: "high", citations: [] },
  matchCanonical = () => ({ matches: [], reason: "no INDEX.md match" }),
  defaultWorkspaceId = "ws_env_default",
} = {}) {
  const calls = [];
  const intelAsk = async (payload) => {
    calls.push(payload);
    return intelResponse;
  };
  const modes = makeAskModes({
    intelAsk,
    defaultWorkspaceId,
    matchCanonical,
    statusFallback,
  });
  return { modes, calls };
}

// ---------- Bug #1: workspace override --------------------------------------

test("runAnswer honors caller workspace_id", async () => {
  const { modes, calls } = harness();
  await modes.runAnswer({ query: "q", workspace_id: "ws_ladder_eval_20260520" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].workspaceId, "ws_ladder_eval_20260520");
  assert.equal(calls[0].mode, "answer");
});

test("runAnswer falls back to default workspace when caller omits it", async () => {
  const { modes, calls } = harness({ defaultWorkspaceId: "ws_env_default" });
  await modes.runAnswer({ query: "q" });
  assert.equal(calls[0].workspaceId, "ws_env_default");
});

test("runSearch honors caller workspace_id", async () => {
  const { modes, calls } = harness();
  await modes.runSearch({ query: "q", workspace_id: "ws_X" });
  assert.equal(calls[0].workspaceId, "ws_X");
});

test("runCanonical (unique match) honors caller workspace_id", async () => {
  const matchCanonical = () => ({
    matches: [{ path: "p.md", topic: "T", status: "SHIPPED", lastReviewed: "2026-01-01" }],
    reason: "exact topic",
  });
  const { modes, calls } = harness({ matchCanonical });
  await modes.runCanonical({ query: "T", workspace_id: "ws_Y" });
  assert.equal(calls[0].workspaceId, "ws_Y");
});

// ---------- Bug #2/#3: no mode:"search" reaches intel -----------------------

test("runSearch sends mode:answer to intel (never mode:search) and nulls prose", async () => {
  const { modes, calls } = harness({
    intelResponse: {
      answer: "should be dropped",
      confidence: "high",
      citations: [{ type: "note", note_path: "a.md" }],
    },
  });
  const out = await modes.runSearch({ query: "q" });
  assert.equal(calls[0].mode, "answer"); // critical: not "search"
  assert.equal(out.answer, null); // search is retrieval-only
  assert.equal(out.results.length, 1);
  assert.equal(out.results[0].path, "a.md");
});

test("runCanonical no-INDEX-match fallback sends mode:answer (never mode:search)", async () => {
  const { modes, calls } = harness({
    matchCanonical: () => ({ matches: [], reason: "no INDEX.md match" }),
    intelResponse: { answer: "x", confidence: "medium", citations: [] },
  });
  const out = await modes.runCanonical({ query: "unknown topic" });
  assert.equal(calls[0].mode, "answer"); // critical: not "search"
  assert.equal(out.answer, null);
  assert.ok(
    out.warnings.some((w) => w.includes("no INDEX.md match")),
    "expected a no-match warning",
  );
});

// ---------- canonical: ambiguous + unique path surfacing --------------------

test("runCanonical ambiguous match returns all candidates without calling intel", async () => {
  const matchCanonical = () => ({
    matches: [
      { path: "a.md", topic: "T", status: "SHIPPED", lastReviewed: "" },
      { path: "b.md", topic: "T", status: "PROPOSED", lastReviewed: "" },
    ],
    reason: "alias",
  });
  const { modes, calls } = harness({ matchCanonical });
  const out = await modes.runCanonical({ query: "T" });
  assert.equal(calls.length, 0, "ambiguous path must not hit intel");
  assert.equal(out.results.length, 2);
  assert.ok(out.warnings[0].includes("ambiguous canonical match"));
});

test("runCanonical unique match guarantees the canonical path is in results", async () => {
  const matchCanonical = () => ({
    matches: [{ path: "canon.md", topic: "T", status: "SHIPPED", lastReviewed: "2026-01-01" }],
    reason: "exact topic",
  });
  // intel returns NOTHING -> the handler must still surface canon.md.
  const { modes } = harness({
    matchCanonical,
    intelResponse: { answer: "x", confidence: "high", citations: [] },
  });
  const out = await modes.runCanonical({ query: "T" });
  assert.ok(out.results.find((r) => r.path === "canon.md"));
});

test("runCanonical unique match flags canonical:true even when intel also returned the path", async () => {
  const matchCanonical = () => ({
    matches: [{ path: "canon.md", topic: "T", status: "DECIDED", lastReviewed: "2026-06-09" }],
    reason: "alias",
  });
  // intel's own retrieval ALSO surfaces canon.md (content match) as a PLAIN hit
  // (no canonical flag). The handler must still assert canonicality on it.
  const { modes } = harness({
    matchCanonical,
    intelResponse: {
      answer: "x",
      confidence: "high",
      citations: [
        { type: "note", note_path: "other.md" },
        { type: "note", note_path: "canon.md" },
      ],
    },
  });
  const out = await modes.runCanonical({ query: "T" });
  const canon = out.results.find((r) => r.path === "canon.md");
  assert.ok(canon, "canonical path must be present");
  assert.equal(canon.canonical, true, "canonical winner must read canonical:true");
  assert.equal(out.results[0].path, "canon.md", "canonical winner must lead the results");
  assert.equal(
    out.results.filter((r) => r.path === "canon.md").length,
    1,
    "no duplicate canonical row",
  );
});

// ---------- runCompare is INDEX-only (no intel call) ------------------------

test("runCompare never calls intel and separates canonical from proposed", async () => {
  const matchCanonical = () => ({
    matches: [
      { path: "canon.md", topic: "T", status: "SHIPPED", lastReviewed: "" },
      { path: "prop.md", topic: "T", status: "PROPOSED", lastReviewed: "" },
    ],
    reason: "exact topic",
  });
  const { modes, calls } = harness({ matchCanonical });
  const out = await modes.runCompare({ query: "T" });
  assert.equal(calls.length, 0);
  assert.equal(out.canonical.path, "canon.md");
  assert.equal(out.proposed.length, 1);
  assert.equal(out.proposed[0].path, "prop.md");
});

// ---------- normalizeIntelResponse: note citation mapping -------------------

test("normalizeIntelResponse maps intel note citations to the D2 result shape", () => {
  const out = normalizeIntelResponse(
    {
      answer: "ans",
      confidence: "high",
      citations: [
        { type: "note", note_path: "20260201-wedge-v5-flows.md", note_title: "Flows" },
      ],
    },
    "answer",
  );
  assert.equal(out.results[0].path, "20260201-wedge-v5-flows.md");
  assert.equal(out.results[0].docType, "note");
  assert.equal(out.results[0].title, "Flows");
  assert.equal(out.confidence, "high");
});

// ---------- makeIntelAsk HTTP contract (stub fetch) -------------------------

test("makeIntelAsk posts workspace_id + bearer and parses JSON", async () => {
  let captured = null;
  const fetchImpl = async (url, init) => {
    captured = { url, init };
    return { ok: true, json: async () => ({ answer: "ok", citations: [] }) };
  };
  const intelAsk = makeIntelAsk({
    intelBaseUrl: "http://intel.test",
    apiKey: "SECRET",
    fetchImpl,
  });
  const res = await intelAsk({ question: "q", workspaceId: "ws_Z", mode: "answer" });
  assert.equal(res.answer, "ok");
  assert.equal(captured.url, "http://intel.test/v1/ask");
  assert.equal(captured.init.headers.Authorization, "Bearer SECRET");
  const body = JSON.parse(captured.init.body);
  assert.equal(body.workspace_id, "ws_Z");
  assert.equal(body.surface, "mcp");
  assert.equal(body.stream, false);
});

test("makeIntelAsk throws with status + body snippet on non-2xx", async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 422,
    text: async () => '{"detail":"literal_error"}',
  });
  const intelAsk = makeIntelAsk({ intelBaseUrl: "http://intel.test", apiKey: "K", fetchImpl });
  await assert.rejects(
    () => intelAsk({ question: "q", workspaceId: "ws", mode: "answer" }),
    /intel \/v1\/ask 422/,
  );
});

// ---------- B9: valid-time `as_of` reaches the request body -----------------
// `mla ask --as-of T` (the MLA front-end) forwards a request-level valid-time
// cutoff. It must ride the SAME /v1/ask body as `as_of` so the intel side
// (AskRequest.as_of) can pin the answer point-in-time. The MCP front-end never
// sets it, so when absent the body must be byte-identical to today (no `as_of`
// key at all); the back-compat invariant the MCP path rides on.

test("makeIntelAsk includes as_of in the body when provided", async () => {
  let captured = null;
  const fetchImpl = async (url, init) => {
    captured = { url, init };
    return { ok: true, json: async () => ({ answer: "ok", citations: [] }) };
  };
  const intelAsk = makeIntelAsk({ intelBaseUrl: "http://intel.test", apiKey: "K", fetchImpl });
  await intelAsk({ question: "q", workspaceId: "ws", mode: "answer", asOf: "2026-04-10T00:00:00.000Z" });
  const body = JSON.parse(captured.init.body);
  assert.equal(body.as_of, "2026-04-10T00:00:00.000Z");
});

test("makeIntelAsk omits as_of from the body when not provided (byte-identical MCP path)", async () => {
  let captured = null;
  const fetchImpl = async (url, init) => {
    captured = { url, init };
    return { ok: true, json: async () => ({ answer: "ok", citations: [] }) };
  };
  const intelAsk = makeIntelAsk({ intelBaseUrl: "http://intel.test", apiKey: "K", fetchImpl });
  await intelAsk({ question: "q", workspaceId: "ws", mode: "answer" });
  const body = JSON.parse(captured.init.body);
  assert.ok(!("as_of" in body), "as_of must be absent from the body when not requested");
});

// ---------- Delivery key: every ask is a metered spend ----------------------
// Intel turns submission_id into the Control delivery key `mcp:<id>:answer`. That
// key is what collapses a RE-delivered request onto the one money authorization it
// already opened, instead of buying the run a second time. Control admits a spend
// only against a delivery key, so an ask that posts none is denied outright: the
// key is mandatory on this path, never best-effort.

test("makeIntelAsk always sends a submission_id, even when the caller mints none", async () => {
  const bodies = [];
  const fetchImpl = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return { ok: true, json: async () => ({ answer: "ok", citations: [] }) };
  };
  const intelAsk = makeIntelAsk({ intelBaseUrl: "http://intel.test", apiKey: "K", fetchImpl });

  await intelAsk({ question: "q", workspaceId: "ws", mode: "answer" });
  await intelAsk({ question: "q", workspaceId: "ws", mode: "answer" });

  assert.equal(typeof bodies[0].submission_id, "string");
  assert.ok(bodies[0].submission_id.length > 0);
  // Two separate calls are two separate deliveries: each buys its own
  // authorization. Reusing one key would collide two executions under one id.
  assert.notEqual(bodies[1].submission_id, bodies[0].submission_id);
});

test("makeIntelAsk prefers the caller's submissionId over minting one", async () => {
  let captured = null;
  const fetchImpl = async (_url, init) => {
    captured = JSON.parse(init.body);
    return { ok: true, json: async () => ({ answer: "ok", citations: [] }) };
  };
  const intelAsk = makeIntelAsk({ intelBaseUrl: "http://intel.test", apiKey: "K", fetchImpl });

  await intelAsk({
    question: "q",
    workspaceId: "ws",
    mode: "answer",
    submissionId: "tool-call-abc",
  });

  // `mla mcp` mints one id per TOOL CALL and passes it down, so a replayed tool
  // call reuses the key and collapses. Only the caller knows what a delivery is.
  assert.equal(captured.submission_id, "tool-call-abc");
});

test("every ask mode forwards args.submission_id to intel", async () => {
  // The mode handlers are the seam between the MCP tool boundary (which mints the
  // per-tool-call key) and the transport. A mode that drops the key silently
  // downgrades a replay from "collapse" to "buy it twice".
  for (const [name, args] of [
    ["runAnswer", { query: "q", submission_id: "sid-1" }],
    ["runSearch", { query: "q", submission_id: "sid-2" }],
    ["runCanonical", { query: "q", submission_id: "sid-3" }], // no INDEX match -> retrieval fallback
  ]) {
    const { modes, calls } = harness();
    await modes[name](args);
    assert.equal(calls.length, 1, `${name} must make exactly one intel call`);
    assert.equal(calls[0].submissionId, args.submission_id, `${name} dropped the delivery key`);
  }
});

test("runCanonical forwards the delivery key on the unique-INDEX-match path", async () => {
  const { modes, calls } = harness({
    matchCanonical: () => ({
      matches: [{ path: "notes/x.md", topic: "X", status: "SHIPPED", lastReviewed: "2026-01-01" }],
      reason: "exact topic",
    }),
  });
  await modes.runCanonical({ query: "q", submission_id: "sid-4" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].submissionId, "sid-4");
});

test("runAnswer threads args.as_of into the intel call", async () => {
  const { modes, calls } = harness();
  await modes.runAnswer({ query: "q", as_of: "2026-04-10T00:00:00.000Z" });
  assert.equal(calls[0].asOf, "2026-04-10T00:00:00.000Z");
});

test("runAnswer omits asOf from the intel call when caller did not set it", async () => {
  const { modes, calls } = harness();
  await modes.runAnswer({ query: "q" });
  assert.equal(calls[0].asOf, undefined);
});
