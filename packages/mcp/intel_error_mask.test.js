/**
 * Unit tests for the shared intel-failure classifier (intel_error_mask.js).
 *
 * This is the one place that decides, for BOTH MCP evidence tools:
 *   - what category an intel error is (auth | payment_required | unavailable | error),
 *   - whether it is transient (retryable) per the governed taxonomy,
 *   - what substrate-free message + guidance the agent should see,
 *   - and which billing sub-reason enum, if any, is safe to echo.
 *
 * The two consumers (evidence_actions.js retrieve mask, server.js query mask)
 * have their own integration tests; these pin the classifier's contract directly
 * so a change to the taxonomy is caught here first.
 *
 * Run: `node --test intel_error_mask.test.js`
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  classifyIntelError,
  isTransientIntelError,
  isTransientBillingDenial,
  isIntelHttpOrTransportError,
} from "./intel_error_mask.js";

function httpErr(status, body) {
  const e = new Error(`intel ${status}: ${typeof body === "string" ? body : JSON.stringify(body)}`);
  e.status = status;
  if (body !== undefined) e.body = body;
  return e;
}

// ---------- category mapping -------------------------------------------------

test("401/403 -> auth; not transient; not billing", () => {
  for (const s of [401, 403]) {
    const c = classifyIntelError(httpErr(s, "invalid bearer at 127.0.0.1:8100"));
    assert.equal(c.category, "auth");
    assert.equal(c.status, s);
    assert.equal(c.transient, false);
    assert.equal(c.billing, false);
    assert.match(c.message, /authentication failed/i);
    assert.ok(!c.message.includes("127.0.0.1"));
    assert.ok(!c.message.includes("invalid bearer"));
  }
});

test("402 -> payment_required; not transient; billing true; reason surfaced", () => {
  const c = classifyIntelError(
    httpErr(402, { detail: { code: "BILLING_DENIED", reason: "NO_PAYER" } }),
  );
  assert.equal(c.category, "payment_required");
  assert.equal(c.status, 402);
  assert.equal(c.transient, false);
  assert.equal(c.billing, true);
  assert.equal(c.reason, "NO_PAYER");
  assert.match(c.message, /billing denied \(NO_PAYER\)/);
  assert.match(c.message, /not an outage/i);
  assert.match(c.guidance, /do not fall back to grep/i);
});

// ---------- 402 transient carve-out: FULLY_RESERVED / NOT_PROVISIONED ---------
//
// These two reasons are self-clearing holds on a FUNDED, payer-bound workspace
// (its own in-flight jobs momentarily hold the balance; it comes back at
// settlement). Governed by intel billing_envelope.py TRANSIENT_DENY_REASONS and
// worker billing-denial.ts. The mask must call them transient and say "retry
// shortly", NOT the terminal "no payer bound; do not retry" it emits for NO_PAYER.

test("402 FULLY_RESERVED -> payment_required but TRANSIENT: billing hold, retry shortly", () => {
  const c = classifyIntelError(
    httpErr(402, { detail: { code: "BILLING_DENIED", reason: "FULLY_RESERVED" } }),
    { noun: "retrieval" },
  );
  assert.equal(c.category, "payment_required");
  assert.equal(c.status, 402);
  assert.equal(c.transient, true); // the hold clears at settlement; retry it
  assert.equal(c.billing, true);
  assert.equal(c.reason, "FULLY_RESERVED");
  assert.match(c.message, /billing hold \(FULLY_RESERVED\)/);
  assert.match(c.message, /retry shortly/i);
  assert.ok(!/do not retry/i.test(c.message)); // must NOT tell the agent to stop
  assert.ok(!/no.*payer/i.test(c.message)); // funded workspace; a payer IS bound
  assert.match(c.guidance, /retry shortly/i);
  assert.match(c.guidance, /do not escalate to bind a payer/i); // a payer IS bound
});

test("402 NOT_PROVISIONED is also transient (payer entitlement mid-mint)", () => {
  const c = classifyIntelError(httpErr(402, { detail: { reason: "NOT_PROVISIONED" } }));
  assert.equal(c.category, "payment_required");
  assert.equal(c.transient, true);
  assert.equal(c.billing, true);
  assert.equal(c.reason, "NOT_PROVISIONED");
  assert.match(c.message, /retry shortly/i);
});

test("NO_PAYER stays TERMINAL even though FULLY_RESERVED does not", () => {
  const c = classifyIntelError(httpErr(402, { detail: { reason: "NO_PAYER" } }));
  assert.equal(c.category, "payment_required");
  assert.equal(c.transient, false);
  assert.match(c.message, /do not retry/i);
  assert.ok(!/retry shortly/i.test(c.message));
});

test("isTransientBillingDenial: only FULLY_RESERVED / NOT_PROVISIONED; everything else false", () => {
  assert.equal(isTransientBillingDenial(httpErr(402, { detail: { reason: "FULLY_RESERVED" } })), true);
  assert.equal(isTransientBillingDenial(httpErr(402, { detail: { reason: "NOT_PROVISIONED" } })), true);
  assert.equal(isTransientBillingDenial(httpErr(402, { detail: { reason: "NO_PAYER" } })), false);
  assert.equal(isTransientBillingDenial(httpErr(402, { detail: { reason: "EXHAUSTED" } })), false);
  assert.equal(isTransientBillingDenial(httpErr(402)), false); // no body, no reason -> terminal
  assert.equal(isTransientBillingDenial(httpErr(503)), false); // transient, but not billing
  assert.equal(isTransientBillingDenial(httpErr(429)), false);
});

test("402 prefers the specific reason over the coarse code", () => {
  const c = classifyIntelError(httpErr(402, { detail: { code: "BILLING_DENIED", reason: "INSUFFICIENT_FUNDS" } }));
  assert.equal(c.reason, "INSUFFICIENT_FUNDS");
});

test("402 falls back to code when reason is absent", () => {
  const c = classifyIntelError(httpErr(402, { detail: { code: "BILLING_DENIED" } }));
  assert.equal(c.reason, "BILLING_DENIED");
});

test("402 with a detail-less body (top-level reason) still reads it", () => {
  const c = classifyIntelError(httpErr(402, { reason: "NO_PAYER" }));
  assert.equal(c.reason, "NO_PAYER");
});

test("402 rejects a non-enum reason (free text) as the SEC-3.2 guard", () => {
  const c = classifyIntelError(httpErr(402, { detail: { reason: "workspace acme owes $1234" } }));
  assert.equal(c.reason, undefined);
  assert.ok(!c.message.includes("acme"));
  assert.ok(!c.message.includes("1234"));
});

test("402 with an unparseable body yields no reason and no leak", () => {
  const c = classifyIntelError(httpErr(402, "<html>gateway timeout</html>"));
  assert.equal(c.category, "payment_required");
  assert.equal(c.reason, undefined);
  assert.ok(!c.message.includes("<html>"));
  assert.ok(!c.message.includes("gateway"));
});

test("402 accepts an already-parsed object body (not just a JSON string)", () => {
  const e = httpErr(402);
  e.body = { detail: { reason: "NO_PAYER" } }; // object, not string
  const c = classifyIntelError(e);
  assert.equal(c.reason, "NO_PAYER");
});

test("429 -> unavailable and transient (governed taxonomy: 429 retries)", () => {
  const c = classifyIntelError(httpErr(429, "rate limited"));
  assert.equal(c.category, "unavailable");
  assert.equal(c.transient, true);
  assert.match(c.message, /temporarily unavailable/i);
});

test("5xx -> unavailable and transient", () => {
  for (const s of [500, 502, 503, 599]) {
    const c = classifyIntelError(httpErr(s, "boom"));
    assert.equal(c.category, "unavailable");
    assert.equal(c.transient, true);
  }
});

test("other 4xx -> error; not transient; generic message", () => {
  for (const s of [400, 404, 409, 422]) {
    const c = classifyIntelError(httpErr(s, "pydantic ValidationError workspace_id"));
    assert.equal(c.category, "error");
    assert.equal(c.transient, false);
    assert.ok(!c.message.toLowerCase().includes("pydantic"));
    assert.ok(!c.message.includes("workspace_id"));
  }
});

test("no numeric status (transport failure) -> unavailable and transient", () => {
  const e = new Error("fetch failed");
  e.name = "TypeError";
  const c = classifyIntelError(e);
  assert.equal(c.category, "unavailable");
  assert.equal(c.transient, true);
  assert.equal(c.status, undefined);
});

// ---------- noun seeding -----------------------------------------------------

test("noun seeds the message voice", () => {
  const err = httpErr(503, "boom");
  assert.match(classifyIntelError(err, { noun: "retrieval" }).message, /^retrieval /);
  assert.match(classifyIntelError(err, { noun: "governed memory" }).message, /^governed memory /);
  // default noun
  assert.match(classifyIntelError(err).message, /^governed memory /);
});

// ---------- isTransientIntelError agrees with the mask -----------------------

test("isTransientIntelError: 5xx/429/transport true; 4xx/402/auth false", () => {
  assert.equal(isTransientIntelError(httpErr(500)), true);
  assert.equal(isTransientIntelError(httpErr(429)), true);
  assert.equal(isTransientIntelError(httpErr(402)), false);
  assert.equal(isTransientIntelError(httpErr(401)), false);
  assert.equal(isTransientIntelError(httpErr(422)), false);
  const t = new Error("fetch failed");
  t.name = "TypeError";
  assert.equal(isTransientIntelError(t), true);
});

// ---------- isIntelHttpOrTransportError: the mask-vs-passthrough gate ---------

test("numeric .status is an intel HTTP error", () => {
  assert.equal(isIntelHttpOrTransportError(httpErr(500)), true);
  assert.equal(isIntelHttpOrTransportError(httpErr(402)), true);
});

test("undici 'fetch failed' TypeError is a transport error", () => {
  const e = new TypeError("fetch failed");
  assert.equal(isIntelHttpOrTransportError(e), true);
});

test("a cause.code connection error is a transport error", () => {
  for (const code of ["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "UND_ERR_SOCKET"]) {
    const e = new Error("request failed");
    e.cause = { code };
    assert.equal(isIntelHttpOrTransportError(e), true, code);
  }
});

test("a plain validation error is NOT an intel transport error (passes through)", () => {
  assert.equal(isIntelHttpOrTransportError(new Error("unsupported mode: frobnicate")), false);
  assert.equal(isIntelHttpOrTransportError(new Error("synthesis timed out; try a narrower question")), false);
  assert.equal(isIntelHttpOrTransportError(null), false);
  assert.equal(isIntelHttpOrTransportError(undefined), false);
});
