/**
 * Task 7 unit tests for the MCP meetless__dismiss_conflict handler.
 *
 * Strategy (mirrors relationship_actions.test.js): inject a stub controlFetch so
 * tests never touch a real network or spawn the stdio MCP server. The stub
 * records (path, init) tuples and can be told to throw a shaped error so the
 * typed-409 mapping is exercised on BOTH front doors:
 *   - the legacy env bin, whose makeControlFetch attaches `err.reason`, and
 *   - the `mla mcp` path, whose http.ts HttpError carries only `.status`+`.body`
 *     (the raw response text), forcing the reason to be parsed from the body.
 *
 * Run: `node --test dismiss_conflict_action.test.js`
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  runDismissConflict,
  readControlErrorReason,
} from "./dismiss_conflict_action.js";
import {
  TOOLS,
  ADVERTISED_EVIDENCE_TOOLS,
  MUTATING_TOOL_NAMES,
  assertReadOnlyManifest,
} from "./tool_manifest.js";

const WS = "ws_test";
const CASE = "case_abc123";

/** A controlFetch stub that records calls and returns a queued reply. */
function stubFetch(reply = {}) {
  const calls = [];
  const fn = async (pathAndQuery, init = {}) => {
    calls.push({ path: pathAndQuery, init });
    return typeof reply === "function" ? reply(pathAndQuery, init) : reply;
  };
  fn.calls = calls;
  return fn;
}

/** A controlFetch stub that always throws the given error object. */
function throwingFetch(err) {
  const calls = [];
  const fn = async (pathAndQuery, init = {}) => {
    calls.push({ path: pathAndQuery, init });
    throw err;
  };
  fn.calls = calls;
  return fn;
}

// Build a control-shaped 409 error the way each front door surfaces it.
function legacyBin409(reason) {
  // makeControlFetch (relationship_actions.js) attaches `.reason` directly.
  const e = new Error(`control POST ... 409: {"details":{"reason":"${reason}"}}`);
  e.status = 409;
  e.reason = reason;
  e.body = JSON.stringify({
    statusCode: 409,
    code: "CONFLICT",
    message: "conflict",
    details: { reason },
  });
  return e;
}

function mlaMcp409(reason) {
  // http.ts HttpError carries only `.status` + `.body` (raw response text).
  const body = JSON.stringify({
    statusCode: 409,
    code: "CONFLICT",
    message: "conflict",
    details: { reason },
  });
  const e = new Error(`POST ... failed with 409`);
  e.status = 409;
  e.body = body;
  // deliberately NO e.reason: this is the live-path shape.
  return e;
}

// ---------- manifest boot ----------------------------------------------------

test("manifest: the dismiss tool is MUTATING, never advertised as evidence", () => {
  assert.ok(
    MUTATING_TOOL_NAMES.includes("meetless__dismiss_conflict"),
    "dismiss_conflict must be registered as a mutating tool",
  );
  assert.ok(
    !ADVERTISED_EVIDENCE_TOOLS.includes("meetless__dismiss_conflict"),
    "a mutating tool must never sit in the read-only evidence manifest",
  );
  // The boot guard must still pass with the new registry entry.
  assert.doesNotThrow(() => assertReadOnlyManifest());
});

test("manifest: the dismiss tool schema is closed and env-pins the workspace", () => {
  const t = TOOLS.find((x) => x.name === "meetless__dismiss_conflict");
  assert.ok(t, "dismiss_conflict must be in TOOLS");
  assert.equal(t.inputSchema.additionalProperties, false);
  assert.deepEqual(t.inputSchema.required, ["case_id", "rationale"]);
  assert.deepEqual(
    Object.keys(t.inputSchema.properties).sort(),
    ["case_id", "rationale"],
  );
  // SEC-2.2: no model-supplied workspace on a mutation.
  assert.ok(
    !Object.prototype.hasOwnProperty.call(
      t.inputSchema.properties,
      "workspace_id",
    ),
    "dismiss_conflict must not advertise workspace_id",
  );
});

// ---------- input validation -------------------------------------------------

test("runDismissConflict requires case_id", async () => {
  await assert.rejects(
    () =>
      runDismissConflict(
        { rationale: "fp" },
        { controlFetch: stubFetch(), defaultWorkspaceId: WS, agentRuntime: null },
      ),
    /case_id is required/,
  );
});

test("runDismissConflict requires rationale", async () => {
  await assert.rejects(
    () =>
      runDismissConflict(
        { case_id: CASE },
        { controlFetch: stubFetch(), defaultWorkspaceId: WS, agentRuntime: null },
      ),
    /rationale is required/,
  );
});

test("runDismissConflict requires a configured workspace (env-pinned, no fallback)", async () => {
  await assert.rejects(
    () =>
      runDismissConflict(
        { case_id: CASE, rationale: "fp" },
        { controlFetch: stubFetch(), defaultWorkspaceId: null, agentRuntime: null },
      ),
    /workspace is not configured/,
  );
});

// ---------- happy path wiring ------------------------------------------------

test("runDismissConflict POSTs to the agent-dismiss path with the env-pinned workspaceId", async () => {
  const cf = stubFetch({ caseId: CASE, resolution: "FALSE_POSITIVE" });
  await runDismissConflict(
    { case_id: CASE, rationale: "both claims agree; detector double-counted" },
    { controlFetch: cf, defaultWorkspaceId: WS, agentRuntime: "claude_code" },
  );
  assert.equal(cf.calls.length, 1);
  const url = new URL(`http://x${cf.calls[0].path}`);
  assert.equal(
    url.pathname,
    `/internal/v1/session-conflicts/${CASE}/agent-dismiss`,
  );
  assert.equal(url.searchParams.get("workspaceId"), WS);
  assert.equal(cf.calls[0].init.method, "POST");
});

test("runDismissConflict body carries rationale + runtimeHint from deps.agentRuntime", async () => {
  const cf = stubFetch({ resolution: "FALSE_POSITIVE" });
  await runDismissConflict(
    { case_id: CASE, rationale: "verified fp" },
    { controlFetch: cf, defaultWorkspaceId: WS, agentRuntime: "claude_code" },
  );
  const body = JSON.parse(cf.calls[0].init.body);
  assert.deepEqual(body, { rationale: "verified fp", runtimeHint: "claude_code" });
});

test("runDismissConflict sends runtimeHint:null when no agentRuntime is configured", async () => {
  const cf = stubFetch({ resolution: "FALSE_POSITIVE" });
  await runDismissConflict(
    { case_id: CASE, rationale: "verified fp" },
    { controlFetch: cf, defaultWorkspaceId: WS, agentRuntime: null },
  );
  const body = JSON.parse(cf.calls[0].init.body);
  assert.equal(body.runtimeHint, null);
});

test("An #5 / SEC-2.2: a smuggled args.workspace_id is IGNORED (env-pinned only)", async () => {
  const cf = stubFetch({ resolution: "FALSE_POSITIVE" });
  await runDismissConflict(
    { case_id: CASE, rationale: "fp", workspace_id: "ws_foreign" },
    { controlFetch: cf, defaultWorkspaceId: WS, agentRuntime: null },
  );
  const url = new URL(`http://x${cf.calls[0].path}`);
  assert.equal(
    url.searchParams.get("workspaceId"),
    WS,
    "the env-pinned workspace must win; ws_foreign must never reach control",
  );
  assert.ok(!cf.calls[0].path.includes("ws_foreign"));
  // and it must not have leaked into the body either.
  const body = JSON.parse(cf.calls[0].init.body);
  assert.ok(!("workspace_id" in body) && !("workspaceId" in body));
});

test("runDismissConflict url-encodes the case_id in the path", async () => {
  const cf = stubFetch({ resolution: "FALSE_POSITIVE" });
  await runDismissConflict(
    { case_id: "case/with space", rationale: "fp" },
    { controlFetch: cf, defaultWorkspaceId: WS, agentRuntime: null },
  );
  assert.ok(
    cf.calls[0].path.startsWith(
      "/internal/v1/session-conflicts/case%2Fwith%20space/agent-dismiss?workspaceId=",
    ),
  );
});

test("runDismissConflict returns the dismissed envelope with durable-but-async wording", async () => {
  const cf = stubFetch({ caseId: CASE, resolution: "FALSE_POSITIVE" });
  const out = await runDismissConflict(
    { case_id: CASE, rationale: "fp" },
    { controlFetch: cf, defaultWorkspaceId: WS, agentRuntime: null },
  );
  assert.equal(out.status, "dismissed");
  assert.equal(out.caseId, CASE);
  assert.equal(out.resolution, "FALSE_POSITIVE");
  assert.match(out.message, /durably queued/);
  assert.match(out.message, /asynchronously/);
});

// ---------- typed 409 mapping (both front doors) -----------------------------

test("typed 409 (legacy-bin shape, err.reason) -> not_dismissed, mapped message, NO throw", async () => {
  const cf = throwingFetch(legacyBin409("NOT_DURABLY_SUPPRESSIBLE"));
  const out = await runDismissConflict(
    { case_id: CASE, rationale: "fp" },
    { controlFetch: cf, defaultWorkspaceId: WS, agentRuntime: null },
  );
  assert.equal(out.status, "not_dismissed");
  assert.equal(out.caseId, CASE);
  assert.equal(out.reason, "NOT_DURABLY_SUPPRESSIBLE");
  assert.match(out.message, /Leave it for a human in \/now/);
});

test("typed 409 (mla mcp shape, only .status+.body) -> reason parsed from body, not_dismissed", async () => {
  // This is the live path the plan's original err.reason-only handler would miss.
  const cf = throwingFetch(mlaMcp409("APPROVED_LANE_HUMAN_ONLY"));
  const out = await runDismissConflict(
    { case_id: CASE, rationale: "fp" },
    { controlFetch: cf, defaultWorkspaceId: WS, agentRuntime: null },
  );
  assert.equal(out.status, "not_dismissed");
  assert.equal(out.reason, "APPROVED_LANE_HUMAN_ONLY");
  assert.match(out.message, /a human must resolve it/);
});

test("every mapped reason yields a distinct not_dismissed message on the live path", async () => {
  const reasons = [
    "ALREADY_RESOLVED",
    "APPROVED_LANE_HUMAN_ONLY",
    "CONFLICT_INELIGIBLE",
    "NOT_DURABLY_SUPPRESSIBLE",
    "NOT_SESSION_CONTRADICTION",
  ];
  const seen = new Set();
  for (const reason of reasons) {
    const cf = throwingFetch(mlaMcp409(reason));
    const out = await runDismissConflict(
      { case_id: CASE, rationale: "fp" },
      { controlFetch: cf, defaultWorkspaceId: WS, agentRuntime: null },
    );
    assert.equal(out.status, "not_dismissed");
    assert.equal(out.reason, reason);
    assert.ok(out.message && out.message.length > 0, `${reason} maps to text`);
    seen.add(out.message);
  }
  assert.equal(seen.size, reasons.length, "each reason maps to a distinct message");
});

// ---------- re-throw for untyped failures ------------------------------------

test("a 500 (no typed reason) re-throws rather than reporting a silent dismiss", async () => {
  const e = new Error("control POST ... 500: internal error");
  e.status = 500;
  e.body = "internal error"; // non-JSON body
  const cf = throwingFetch(e);
  await assert.rejects(
    () =>
      runDismissConflict(
        { case_id: CASE, rationale: "fp" },
        { controlFetch: cf, defaultWorkspaceId: WS, agentRuntime: null },
      ),
    /500: internal error/,
  );
});

test("a 409 with an UNKNOWN reason re-throws (only the mapped set is swallowed)", async () => {
  const cf = throwingFetch(mlaMcp409("SOME_FUTURE_REASON"));
  await assert.rejects(
    () =>
      runDismissConflict(
        { case_id: CASE, rationale: "fp" },
        { controlFetch: cf, defaultWorkspaceId: WS, agentRuntime: null },
      ),
    /409/,
  );
});

test("a network error (no status/body) re-throws", async () => {
  const cf = throwingFetch(new Error("ECONNREFUSED"));
  await assert.rejects(
    () =>
      runDismissConflict(
        { case_id: CASE, rationale: "fp" },
        { controlFetch: cf, defaultWorkspaceId: WS, agentRuntime: null },
      ),
    /ECONNREFUSED/,
  );
});

// ---------- readControlErrorReason (helper) ----------------------------------

test("readControlErrorReason prefers err.reason, falls back to err.body.details.reason", () => {
  assert.equal(
    readControlErrorReason({ reason: "ALREADY_RESOLVED" }),
    "ALREADY_RESOLVED",
  );
  assert.equal(
    readControlErrorReason({
      status: 409,
      body: JSON.stringify({ details: { reason: "CONFLICT_INELIGIBLE" } }),
    }),
    "CONFLICT_INELIGIBLE",
  );
});

test("readControlErrorReason returns null for a non-JSON / reason-less / missing body", () => {
  assert.equal(readControlErrorReason(null), null);
  assert.equal(readControlErrorReason({}), null);
  assert.equal(readControlErrorReason({ body: "not json" }), null);
  assert.equal(
    readControlErrorReason({ body: JSON.stringify({ message: "no reason here" }) }),
    null,
  );
});
