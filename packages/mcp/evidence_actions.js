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
// TRANSIENT failures (transport errors + 5xx) a few times with short backoff;
// deterministic failures (4xx: bad input, auth, not-found) are NEVER retried.
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
 * A failure worth retrying. A numeric .status means intel answered: only 5xx is
 * transient (the instance hiccuped); every 4xx is the request's own fault and
 * deterministic. No .status at all means the transport failed (connection
 * refused mid-restart, DNS, an aborted/timed-out request): always transient.
 */
function isTransient(err) {
  const status = err && err.status;
  if (typeof status === "number") {
    return status >= 500 && status <= 599;
  }
  return true;
}

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
 * Re-throw an intel-side failure as a substrate-free error. SEC-3.2: the model
 * surface must never see intel's host/port, response body, or stack. A 401/403
 * gets a distinct (still leak-free) auth hint and preserves .status so server.js
 * can surface "re-auth needed". A transient failure (5xx / transport) becomes an
 * actionable "temporarily unavailable" line so the agent treats it as an infra
 * blip to retry, not a missing document to escalate. Everything else (a
 * deterministic 4xx) collapses to a single generic line.
 */
function maskRetrievalError(err) {
  const status = err && err.status;
  if (status === 401 || status === 403) {
    const e = new Error(
      "retrieval unavailable: authentication failed (check MEETLESS_CONTROL_TOKEN)",
    );
    e.status = status;
    e.masked = true;
    return e;
  }
  if (isTransient(err)) {
    const e = new Error(
      "retrieval temporarily unavailable (intel unreachable); retry shortly",
    );
    if (typeof status === "number") e.status = status;
    e.masked = true;
    e.transient = true;
    return e;
  }
  const e = new Error("retrieval unavailable");
  e.masked = true;
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
      if (!isTransient(err) || lastAttempt) break;
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
