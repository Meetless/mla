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
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

/** The 402 shape intel actually puts on the wire (app/api/billing_errors.py). */
function denyErr(reason) {
  return httpErr(402, { detail: { code: "BILLING_DENIED", category: "payment_required", reason } });
}

// control is the ONLY producer of these reason codes; this file is one of four
// consumers of them. Read the producer's enum rather than restating it, so a
// rename or a new member on control's side lands here as a red test instead of as
// a terminal 402 the agent is handed the wrong remedy for.
const CONTROL_CONSTANTS_TS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../apps/control/src/billing/billing-envelope.constants.ts",
);

// "Does this copy ADVISE buying credit?" is the question the ruling asks, and it is
// NOT the same question as "does this copy contain the word top-up". Banning the
// vocabulary outright would fail the strongest possible copy ("topping up will not
// lift it") while passing copy that stays silent and lets a 402 labelled
// `payment_required` imply the remedy on its own. So: split into sentences, look
// only at the ones that raise a money remedy, and require every one of them to
// negate it. An affirmative mention in any sentence is advice.
const MONEY_REMEDY = /top ?-?up|topping up|add (credit|funds)|fund the balance|upgrade|checkout|purchase|subscribe|buy /i;
const NEGATED = /\b(not|never|no|cannot|can't|won't|nothing|irrelevant|wrong)\b/i;

function advisesBuyingCredit(text) {
  return text
    .split(/(?<=[.;:])\s+/)
    .filter((sentence) => MONEY_REMEDY.test(sentence))
    .some((sentence) => !NEGATED.test(sentence));
}

function controlDenyReasons() {
  const text = readFileSync(CONTROL_CONSTANTS_TS, "utf8");
  const start = text.indexOf("export const AdmissionDenyReason = {");
  assert.ok(start >= 0, `AdmissionDenyReason not found in ${CONTROL_CONSTANTS_TS}`);
  const end = text.indexOf("} as const;", start);
  assert.ok(end > start, "AdmissionDenyReason block is unterminated");
  const block = text.slice(start, end);
  return [...block.matchAll(/^\s+[A-Z0-9_]+:\s*"([A-Z0-9_]+)",/gm)].map((m) => m[1]);
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

// ---------- ACCOUNT_SUSPENDED is terminal, and is NOT a money state -----------
//
// Owner ruling 2026-07-27, Proof 3: "account_suspended must not be treated as
// 'buy more credit,' and callers must not retry it automatically." Both halves are
// tested here because they fail independently: the retry contract already held by
// construction (the transient set is an allowlist of two), while the COPY handed
// to the agent said "escalate to bind a payer or top up the balance" for every
// terminal 402, which is exactly the prohibited treatment.

test("ACCOUNT_SUSPENDED is TERMINAL: never retried, never called transient", () => {
  const c = classifyIntelError(denyErr("ACCOUNT_SUSPENDED"));
  assert.equal(c.category, "payment_required");
  assert.equal(c.status, 402);
  assert.equal(c.transient, false);
  assert.equal(c.billing, true);
  assert.equal(c.reason, "ACCOUNT_SUSPENDED");
  assert.equal(isTransientBillingDenial(denyErr("ACCOUNT_SUSPENDED")), false);
  assert.equal(isTransientIntelError(denyErr("ACCOUNT_SUSPENDED")), false);
  assert.match(c.message, /do not retry/i);
  assert.ok(!/retry shortly/i.test(c.message));
  assert.ok(!/retry/i.test(c.guidance.replace(/do NOT retry/gi, "")));
});

test("ACCOUNT_SUSPENDED never advises buying credit", () => {
  const c = classifyIntelError(denyErr("ACCOUNT_SUSPENDED"));
  assert.equal(advisesBuyingCredit(`${c.message}\n${c.guidance}`), false, `${c.message}\n${c.guidance}`);
  // Silence is not enough: copy that merely omits the remedy leaves the reader to
  // supply it themselves, and "402, payment_required" supplies it for them. The
  // prohibition has to be stated.
  assert.match(c.guidance, /not a money problem/i);
  assert.match(c.guidance, /will not lift it/i);
  assert.match(c.message, /not a spent balance/i);
});

test("ACCOUNT_SUSPENDED is not described as a billing denial or an outage", () => {
  const c = classifyIntelError(denyErr("ACCOUNT_SUSPENDED"));
  assert.ok(!/billing denied/i.test(c.message), c.message);
  assert.match(c.message, /suspended/i);
  assert.match(c.message, /not an outage/i);
  assert.match(c.guidance, /NOT an outage and NOT self-clearing/i);
  // Governed memory is gated, not absent: grep is still not a substitute.
  assert.match(c.guidance, /do NOT fall back to grep/i);
  // Suspension stops cost-bearing execution only; it is not a sign-out.
  assert.match(c.guidance, /sign-in, reading, and export are unaffected/i);
  assert.match(c.guidance, /support/i);
});

test("the RETIRED NO_HEADROOM falls through to the generic terminal copy", () => {
  // KEPT rather than deleted when control retired the reason on 2026-08-14, and
  // repointed rather than repurposed, mirroring intel's ruling on the same
  // deletion (5670080e): deleting this case would delete the only test that uses
  // a REAL string control once emitted to prove what happens when control answers
  // a reason this build has never heard of.
  //
  // The answer must be the generic terminal bucket. It stays terminal, and it must
  // not guess a remedy: the retired copy sent the reader "to an operator to raise
  // the workspace cap", advice for a brake that no longer exists and that no
  // operator could ever arm.
  const c = classifyIntelError(denyErr("NO_HEADROOM"));
  assert.equal(c.transient, false);
  assert.equal(advisesBuyingCredit(`${c.message}\n${c.guidance}`), false, c.guidance);
  assert.doesNotMatch(c.guidance, /raise the workspace cap/i);
  assert.equal(c.guidance, classifyIntelError(denyErr("PRICING_UNSUPPORTED")).guidance);
});

test("EXHAUSTED DOES advise a top-up (the one reason where money is the answer)", () => {
  // Pinned from the other direction so a blanket "never mention a top-up" edit
  // cannot pass: EXHAUSTED is the only reason for which control sets
  // topUpRequired, and it is the only one this module may say it for.
  const c = classifyIntelError(denyErr("EXHAUSTED"));
  assert.equal(c.transient, false);
  assert.equal(advisesBuyingCredit(c.guidance), true, c.guidance);
  assert.match(c.guidance, /top up the balance/i);
});

test("NO_PAYER advises binding a payer, not funding one", () => {
  const c = classifyIntelError(denyErr("NO_PAYER"));
  assert.match(c.guidance, /bind a payer/i);
  assert.equal(advisesBuyingCredit(c.guidance), false, c.guidance);
});

test("the three terminal remedies never share a guidance line", () => {
  const reasons = ["NO_PAYER", "EXHAUSTED", "ACCOUNT_SUSPENDED"];
  const seen = new Map();
  for (const r of reasons) {
    const g = classifyIntelError(denyErr(r)).guidance;
    assert.ok(!seen.has(g), `${r} shares its guidance with ${seen.get(g)}; the remedies differ`);
    seen.set(g, r);
  }
  // ...and none of them is the generic fallback, which names no remedy at all.
  const generic = classifyIntelError(denyErr("PRICING_UNSUPPORTED")).guidance;
  assert.ok(!seen.has(generic), "a keyed reason fell through to the generic terminal copy");
});

test("an unknown terminal reason names NO remedy it cannot vouch for", () => {
  // A reason this build has never heard of (control ships one, we lag a deploy).
  // It must stay terminal and must not guess: guessing is the whole defect.
  const c = classifyIntelError(denyErr("SOME_FUTURE_REFUSAL"));
  assert.equal(c.transient, false);
  assert.equal(c.reason, "SOME_FUTURE_REFUSAL");
  assert.equal(advisesBuyingCredit(c.guidance), false, c.guidance);
  assert.ok(!/bind a payer/i.test(c.guidance), c.guidance);
  assert.match(c.guidance, /escalate with the reason code/i);
});

// ---------- exhaustive over control's producer enum ---------------------------

test("every AdmissionDenyReason control can emit is classified, and only the allowlisted two retry", () => {
  const reasons = controlDenyReasons();
  assert.ok(reasons.length >= 8, `parsed too few reasons (${reasons.length}); the regex or the enum shape moved`);

  // The governed transient allowlist, restated here as the assertion's subject.
  const transient = new Set(["FULLY_RESERVED", "NOT_PROVISIONED"]);
  for (const reason of reasons) {
    const err = denyErr(reason);
    const c = classifyIntelError(err);
    assert.equal(c.category, "payment_required", `${reason} must map to payment_required`);
    assert.equal(c.reason, reason, `${reason} must survive the SEC-3.2 enum guard`);
    assert.equal(c.transient, transient.has(reason), `${reason} retry contract`);
    assert.equal(isTransientBillingDenial(err), transient.has(reason), `${reason} retry predicate`);
    assert.ok(typeof c.guidance === "string" && c.guidance.length > 0, `${reason} has no guidance`);
    if (!transient.has(reason)) {
      assert.match(c.message, /do not retry/i, `${reason} must tell the caller not to retry`);
      // EXHAUSTED is the ONLY reason in the whole enum where the money is actually
      // gone, so it is the only one allowed to send anyone to buy credit.
      assert.equal(
        advisesBuyingCredit(`${c.message}\n${c.guidance}`),
        reason === "EXHAUSTED",
        `${reason} buy-credit advice`,
      );
    }
  }

  // The three we key a specific remedy on must still EXIST upstream. A rename on
  // control's side would otherwise silently demote that reason to the generic copy.
  // NO_HEADROOM was a fourth until control retired it on 2026-08-14; this loop is
  // exactly the guard that caught the drift, two days late only because mla-ci is
  // path-filtered to meetless-cli/** and the deletion landed in apps/control.
  for (const keyed of ["NO_PAYER", "EXHAUSTED", "ACCOUNT_SUSPENDED"]) {
    assert.ok(reasons.includes(keyed), `control no longer emits ${keyed}; update TERMINAL_BILLING_GUIDANCE_KEY`);
  }
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

// ---------- the three `unavailable` shapes are told apart --------------------
//
// One category, one retry contract, three different facts about the world. The
// mask used to render all three as "intel unreachable", which is FALSE for the
// two where intel answered us: it sends an operator to check DNS, ingress and
// the deploy for a fault that is plainly inside a reachable service, and it
// hides the one shape (429) where retrying without backoff makes it worse.

test("429 says intel is UP and rate limiting, never 'unreachable'", () => {
  const c = classifyIntelError(httpErr(429, "rate limited"));
  assert.match(c.message, /rate limiting/i);
  assert.match(c.message, /429/);
  assert.doesNotMatch(c.message, /unreachable/i);
  assert.match(c.guidance, /rate limit/i);
  assert.match(c.guidance, /back off/i);
});

test("5xx says intel is REACHABLE and faulted, never 'unreachable'", () => {
  for (const s of [500, 502, 503, 599]) {
    const c = classifyIntelError(httpErr(s, "boom"));
    assert.match(c.message, /server error/i);
    assert.match(c.message, new RegExp(String(s)));
    assert.doesNotMatch(c.message, /unreachable/i);
    assert.match(c.guidance, /reachable/i);
  }
});

test("a status-free failure names NO service and asserts NO connection failure (An review §2)", () => {
  const e = new TypeError("fetch failed");
  const c = classifyIntelError(e);
  // Neutral: it does not know which service failed, or even that the transport did.
  assert.match(c.message, /did not complete/i);
  assert.doesNotMatch(c.message, /\bintel\b/i);
  assert.doesNotMatch(c.message, /unreachable/i);
  assert.doesNotMatch(c.message, /connection failed/i);
});

test("a status-free NON-transport throw (parse/local) is also neutral, not 'intel unreachable'", () => {
  // The review's point: no numeric status does not prove a transport failure. A plain
  // Error thrown by local code (a JSON parse, a cancellation) must get the same neutral
  // copy, never a service name. Extends this file's coverage rather than adding another.
  const c = classifyIntelError(new Error("Unexpected token < in JSON at position 0"));
  assert.equal(c.category, "unavailable");
  assert.equal(c.status, undefined);
  assert.match(c.message, /did not complete/i);
  assert.doesNotMatch(c.message, /\bintel\b/i);
  assert.doesNotMatch(c.message, /connection failed/i);
});

test("the three shapes never share a message or a guidance line", () => {
  const shapes = [
    classifyIntelError(httpErr(429)),
    classifyIntelError(httpErr(503)),
    classifyIntelError(new TypeError("fetch failed")),
  ];
  assert.equal(new Set(shapes.map((c) => c.message)).size, 3);
  assert.equal(new Set(shapes.map((c) => c.guidance)).size, 3);
  // ...while still agreeing on the contract every consumer keys on.
  for (const c of shapes) {
    assert.equal(c.category, "unavailable");
    assert.equal(c.transient, true);
    assert.equal(c.billing, false);
    assert.match(c.guidance, /grep is an acceptable stopgap/);
  }
});

test("a masked 5xx still leaks no substrate", () => {
  // The status is already a field of the result, so naming it in the message is
  // not a new disclosure. The BODY still must never escape.
  const e = httpErr(503, '{"detail":"upstream weaviate at 10.1.2.3:8080 refused"}');
  const c = classifyIntelError(e);
  assert.ok(!c.message.includes("weaviate"));
  assert.ok(!c.message.includes("10.1.2.3"));
  assert.ok(!c.message.includes("8080"));
  assert.equal(c.status, 503);
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

// --- G2 DEFECT PIN -------------------------------------------------------------------
//
// notes/20260812-did-mla-help-session-8751d447-both-clients-blamed-the-wrong-service.md
//
// These record CURRENT behaviour, so they are GREEN today. They exist because the
// taxonomy below is RIGHT and was still wrong on the wire, which no existing test could
// have caught: every test above hands the classifier an error that already carries
// `.status`, so the branch that fires in production is the one branch nothing exercised
// against a real outage.
//
// MEASURED, session 8751d447, 2026-08-12. `control` was down, so intel answered
// `503 {"detail":"Auth backend unavailable"}` on POST /v1/ask/retrieve in 0.15s, from the
// exact URL the MCP is bound to. `meetless__retrieve_knowledge` nonetheless reported
// "intel is unreachable (the connection failed)": the NO-STATUS branch. intel was up,
// answering /health in 4.5ms, and had just returned a numeric status on that same path.
//
// This module's own docstring names the harm precisely: collapsing the shapes "sends an
// operator to check DNS, ingress and the deploy when intel is plainly answering". It did
// exactly that. The taxonomy is not the defect; a caller that loses `.status` is, and
// this file cannot see that caller. What it CAN pin is the asymmetry that makes the loss
// expensive: with a status the copy is careful and correct, without one it names a
// service it has no evidence about.
//
// THE FIX THAT SHIPPED (G2a): the no-status branch describes the failure without
// asserting WHICH service failed, because a status-free error is exactly the case where
// the module does not know. G2b (a leg that drops `.status`) was investigated and
// REFUTED on current code: the retrieve path preserves intel's HTTP status end-to-end
// (a 503 arrives as server_error, not no_status) -- see evidence_actions.test.js and
// mcp-fetchers.spec.ts. So there is no producer change; the no_status copy is the fix.

test("G2: WITH a status the copy is careful, and says intel is reachable", () => {
  const c = classifyIntelError(httpErr(503, { detail: "Auth backend unavailable" }), { noun: "retrieval" });
  assert.equal(c.category, "unavailable");
  assert.equal(c.status, 503);
  assert.equal(c.transient, true);
  // The status-bearing half stays specific: intel DID answer, so naming it is honest.
  assert.match(c.message, /server error \(HTTP 503\)/);
  assert.match(c.message, /Intel is reachable; this is not a connectivity fault/);
  assert.doesNotMatch(c.message, /the connection failed/);
});

test("G2: WITHOUT a status it names NO service and asserts NO connection failure", () => {
  // The shape a transport failure arrives in: undici's TypeError, no .status.
  const e = new TypeError("fetch failed");
  const c = classifyIntelError(e, { noun: "retrieval" });
  assert.equal(c.category, "unavailable");
  assert.equal(c.status, undefined);
  assert.equal(c.transient, true);
  // SHIPPED: neutral. It no longer names intel or asserts a connection failure on no
  // evidence, which is exactly what session 8751d447 recorded it doing while intel was up.
  assert.match(c.message, /did not complete/i);
  assert.doesNotMatch(c.message, /\bintel\b/i);
  assert.doesNotMatch(c.message, /unreachable/i);
  assert.doesNotMatch(c.message, /connection failed/i);
  // The guidance carried the same overclaim; it too is neutral now.
  assert.doesNotMatch(c.guidance, /\bintel\b.*unreachable/i);
});

test("G2 pin: the two branches must never converge, in either direction", () => {
  // VACUITY GUARD. Without this, deleting shapeOfUnavailable and hardcoding one string
  // would leave one pin above green and read as health. The point of the finding is that
  // these are two DIFFERENT facts about the world; a fix may reword either, never merge
  // them.
  const withStatus = classifyIntelError(httpErr(503, "boom"), { noun: "retrieval" }).message;
  const without = classifyIntelError(new TypeError("fetch failed"), { noun: "retrieval" }).message;
  assert.notEqual(withStatus, without);
  // 429 is the third shape and the one where retrying without backoff makes it worse, so
  // it must stay distinct from both.
  const rate = classifyIntelError(httpErr(429, "slow down"), { noun: "retrieval" }).message;
  assert.notEqual(rate, withStatus);
  assert.notEqual(rate, without);
});
