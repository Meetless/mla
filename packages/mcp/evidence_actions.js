/**
 * D3: MCP evidence retrieval handler (meetless__retrieve_knowledge).
 *
 * The pull half of the two-layer enrichment design (notes/20260602-two-layer-
 * prompt-enrichment-plan.md §8). Claude (the coding agent) is in the driver
 * seat: the hook injects a static manifest + a zero-LLM starter pull (the push
 * half, D1/D4), then the agent calls THIS tool to pull more evidence on demand.
 * It wraps intel `POST /v1/ask/retrieve`, which returns `EvidenceCandidateDTO[]`
 * (the locked closed facade from app/graphs/ask/models.py): no scores, no
 * internal provenance, no substrate ids leak past the DTO boundary.
 *
 * Security invariants (rollout contract; held at the dogfood edge already):
 *   SEC-2.2  workspace is server/env-derived, NEVER a model parameter. We do
 *            not read args.workspace_id at all; a smuggled value is ignored.
 *   SEC-2.4  limit is clamped client-side; intel re-clamps to its server cap.
 *   SEC-3.2  intel transport/HTTP errors are MASKED before they reach the model
 *            surface (no host/port/body/stack leak). A 401/403 gets a distinct
 *            (still substrate-free) auth hint so an operator can re-auth.
 *   SEC-4    evidence DTOs pass through verbatim; intel owns the closed facade.
 *
 * Design notes (mirror relationship_actions.js / kb_actions.js):
 *   - Env is the CALLER's job; server.js binds `intelFetch` + `defaultWorkspaceId`.
 *   - Input-validation errors (empty query, bad limit) throw plainly so the LLM
 *     can self-correct; only intel-side failures are masked.
 */

import {
  classifyIntelError,
  isTransientIntelError,
  isTransientBillingDenial,
} from "./intel_error_mask.js";

const RETRIEVE_PATH = "/v1/ask/retrieve";

// SEC-2.4: a generous client-side ceiling. intel clamps further to its own
// server cap (enrich_retrieval_limit, currently 12); this guard only prevents
// a model from sending an absurd value over the wire.
export const MAX_CLIENT_LIMIT = 50;

// Resilience: a single fetch made the retrieve path brittle. In dogfood, intel
// at :8100 is restarted out from under us by other agents (cutover work, the
// flock poller-election dance, a stray /tmp boot shadowing the canonical
// uvicorn). During that window a connection is refused or a 5xx is returned for
// a few seconds; without a retry that transient blip became a hard
// "retrieval unavailable" that stopped the dogfood loop dead. We retry only
// SELF-CLEARING failures a few times with short backoff: transport errors + 5xx
// + 429, plus a transient billing hold (402 FULLY_RESERVED / NOT_PROVISIONED,
// whose balance returns at settlement). Deterministic failures (bad input, auth,
// not-found, and a TERMINAL 402 like NO_PAYER / EXHAUSTED) are NEVER retried.
export const MAX_RETRIEVE_ATTEMPTS = 3;
// Backoff between attempts: [after attempt 1, after attempt 2]. Short, because
// a restart window is seconds, not minutes, and the agent is waiting.
export const RETRIEVE_BACKOFF_MS = [200, 500];
// Per-attempt ceiling so a half-dead instance that ACCEPTS but never answers
// cannot hang the call forever; an abort surfaces as a transport error and is
// retried like any other transient failure.
export const RETRIEVE_TIMEOUT_MS = 8000;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One intel call with a hard per-attempt timeout. A fresh AbortController per
 * call; the timer is always cleared so a fast success leaves no dangling timer
 * (which would keep the event loop, and the test process, alive).
 */
async function fetchOnce(intelFetch, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RETRIEVE_TIMEOUT_MS);
  if (typeof timer.unref === "function") timer.unref();
  try {
    return await intelFetch(RETRIEVE_PATH, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Re-throw an intel-side failure as a substrate-free, discriminated error.
 * SEC-3.2: the model surface must never see intel's host/port, response body, or
 * stack. The shared classifier (intel_error_mask.js) turns the raw error into a
 * masked message plus a category the caller can act on:
 *   - auth (401/403): a leak-free "re-auth needed" hint, .status preserved.
 *   - payment_required (402), terminal (NO_PAYER / EXHAUSTED / ...): "billing
 *     denied; not an outage, do not retry" so the agent escalates to bind a payer
 *     or top up instead of treating the evidence as absent. The old generic line
 *     was lying about this case.
 *   - payment_required (402), transient (FULLY_RESERVED / NOT_PROVISIONED): a
 *     funded workspace whose balance is briefly held by its own in-flight jobs.
 *     "billing hold; retry shortly", with .transient set so the loop retries it
 *     and the agent re-calls rather than grepping past evidence that exists.
 *   - unavailable (429/5xx/transport): "temporarily unavailable; retry shortly"
 *     so the agent treats it as an infra blip, not a missing document.
 *   - error (other 4xx): a single generic "retrieval unavailable" line.
 * The category, .transient/.billing flags, the sanitized billing .reason, and a
 * one-line .guidance ride along on the masked error so server.js can surface
 * discriminated fallback guidance (Item 3) without re-classifying.
 */
function maskRetrievalError(err) {
  const c = classifyIntelError(err, { noun: "retrieval" });
  const e = new Error(c.message);
  e.masked = true;
  e.category = c.category;
  if (typeof c.status === "number") e.status = c.status;
  if (c.transient) e.transient = true;
  if (c.billing) e.billing = true;
  if (c.reason) e.reason = c.reason;
  e.guidance = c.guidance;
  return e;
}

/**
 * meetless__retrieve_knowledge handler. Pulls evidence candidates for a query
 * from the user's own corpus and returns them as the closed EvidenceCandidateDTO
 * facade. The model passes NO workspace_id (env-pinned); only `query` (required)
 * and an optional `limit`.
 */
export async function runRetrieveKnowledge(args, deps) {
  const { intelFetch, defaultWorkspaceId, sleep = defaultSleep } = deps;

  // SEC-2.2: workspace is env-derived, never a model parameter. args.workspace_id
  // is deliberately not read; the schema does not advertise it either.
  const workspaceId = defaultWorkspaceId;
  if (!workspaceId) {
    throw new Error("workspace is not configured (set MEETLESS_WORKSPACE_ID)");
  }

  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) {
    throw new Error("query is required (non-empty string)");
  }

  const body = {
    workspace_id: workspaceId,
    query,
    source_context: { surface: "mcp" },
  };

  if (args.limit !== undefined && args.limit !== null) {
    const n = Number(args.limit);
    if (!Number.isFinite(n) || n < 1) {
      throw new Error("limit must be a positive integer");
    }
    body.limit = Math.min(Math.floor(n), MAX_CLIENT_LIMIT);
  }

  const init = { method: "POST", body: JSON.stringify(body) };

  let response;
  let lastErr;
  for (let attempt = 0; attempt < MAX_RETRIEVE_ATTEMPTS; attempt++) {
    try {
      response = await fetchOnce(intelFetch, init);
      lastErr = undefined;
      break;
    } catch (err) {
      lastErr = err;
      const lastAttempt = attempt === MAX_RETRIEVE_ATTEMPTS - 1;
      // Retry the two self-clearing failure classes: an infra blip
      // (transport/5xx/429) AND a transient billing hold (402 FULLY_RESERVED /
      // NOT_PROVISIONED), whose balance returns at settlement. The short backoff
      // below is deliberate for BOTH: a synchronous, human-facing tool must not
      // block for a multi-second settlement, so we catch only fast clears here
      // (an intel restart window, a payer mid-mint, a single sibling settling)
      // and otherwise surface the honest "retry shortly" message for the agent
      // to re-call. A TERMINAL 402 (NO_PAYER / EXHAUSTED) is never retried.
      const retryable =
        isTransientIntelError(err) || isTransientBillingDenial(err);
      if (!retryable || lastAttempt) break;
      const backoff =
        RETRIEVE_BACKOFF_MS[attempt] ??
        RETRIEVE_BACKOFF_MS[RETRIEVE_BACKOFF_MS.length - 1];
      await sleep(backoff);
    }
  }
  if (lastErr) throw maskRetrievalError(lastErr);

  const candidates = Array.isArray(response.candidates)
    ? response.candidates
    : [];

  return {
    tool: "meetless__retrieve_knowledge",
    workspace: workspaceId,
    query,
    count: candidates.length,
    candidates,
  };
}
