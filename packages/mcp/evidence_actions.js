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
 *   - payment_required (402), terminal (NO_PAYER / EXHAUSTED / NO_HEADROOM /
 *     ACCOUNT_SUSPENDED / structural): "not an outage, do not retry", plus the
 *     ONE remedy that actually fits the reason, so the agent escalates instead of
 *     treating the evidence as absent. The remedies are not interchangeable: only
 *     EXHAUSTED is fixed by money, NO_PAYER needs a payer bound, NO_HEADROOM needs
 *     an operator to raise the workspace cap, and ACCOUNT_SUSPENDED is not a money
 *     state at all. Naming the wrong one is the same class of lie as the old
 *     generic "retrieval unavailable" line this mask replaced.
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

/** The corpus states this client has a message for. See `explainEmptyPull`. */
const CORPUS_STATES = new Set(["empty", "captured_not_indexed", "populated"]);

// Allow-listed for the same reason CORPUS_STATES is: an unrecognised band must not
// reach the agent looking like a product word we have a meaning for.
const SERVED_RELEVANCE_BANDS = new Set(["high", "medium", "low", "unmeasured"]);

/**
 * Say WHICH empty a zero-candidate pull is, or null when there is nothing to say.
 *
 * A bare empty result is ambiguous and the ambiguity is expensive: an agent reads
 * "no candidates" as "this workspace has no such decision" when the truth is often
 * "this workspace has never indexed anything, and every query will return this
 * forever". Prod on 2026-07-26: one operator held 22 auto-provisioned workspaces
 * with zero documents between them, and 17 of that week's 21 zero-retrievals were
 * his agent asking an empty corpus. Nothing in the product ever told him.
 *
 * intel now returns `corpus_empty` on the empty path (it already computed the same
 * boolean for PostHog). Three states, three different things to tell the agent:
 *   true      -> onboarding gap. No rewording will ever help. Name the remedy.
 *   false     -> a real corpus, a retriever miss. Rewording MIGHT help; absence is
 *                still not proof.
 *   undefined -> an intel that predates the field. Say "if", never assert.
 * Only ever called with zero candidates, so a served pull carries no warning.
 *
 * `corpusState` splits that `true` in half, because one boolean was carrying two
 * product states with opposite remedies. A workspace that captured nothing and a
 * workspace that captured hundreds of documents down a NON-GROUNDING lane are both
 * `corpus_empty=true`, and the message above is a lie to the second one: it has
 * indexed documents, it did run onboarding, and being told to run it again produces
 * more of the same unservable rows.
 *
 * Prod on 2026-08-02, fleet-wide with zero exceptions: DERIVED_ONLY/agent_turn
 * capture holds 629 documents and 0 groundable rows, PUBLISHED/git_commit holds 322
 * and 322. Retrievability is decided entirely by the capture lane. Nine workspaces
 * held 299 documents in the first state and every one of them was being told it had
 * indexed nothing.
 *
 *   empty                -> nothing was ever captured. "Add something" is true.
 *   captured_not_indexed -> capture ran, indexing did not. Different remedy.
 *   populated            -> same as `corpus_empty === false`.
 *
 * State wins when we recognize it; otherwise fall back to the boolean, which every
 * intel has sent since the field shipped. An UNRECOGNIZED state falls back too: a
 * future fourth state must never reach the agent as a word we cannot explain.
 *
 * No message carries a count. The pull crosses an ACL boundary, so corpus size is
 * not ours to disclose; intel deliberately sends no number and we do not invent one.
 */
/**
 * Is this empty pull an ONBOARDING GAP, i.e. the one branch below whose remedy is "index this
 * repository"? Defined once and consumed by both the message and the telemetry sink, so the two
 * can never drift into disagreeing about which state the user is in.
 *
 * True for exactly one of the four branches:
 *   captured_not_indexed -> false. The workspace DID onboard; its documents went down a
 *                           non-grounding capture lane. Telling it to onboard again is the
 *                           false remedy the three-way split exists to stop.
 *   corpus_empty === true -> TRUE. Nothing indexed, no rewording will ever help, and the offer
 *                           is actionable.
 *   corpus_empty === false -> false. A real corpus and a retriever miss.
 *   undefined             -> false. An intel that predates the field; we say "if", and we do not
 *                           count a hedge as an established gap.
 */
export function isOnboardingGapPull(corpusEmpty, corpusState) {
  return corpusState !== "captured_not_indexed" && corpusEmpty === true;
}

function explainEmptyPull(corpusEmpty, corpusState) {
  if (corpusState === "captured_not_indexed") {
    return (
      "This workspace has captured content, but none of it is in the searchable index, " +
      "so retrieval returns nothing for EVERY query, not just this one. Agent session " +
      "memory is kept for review and is never indexed, and anything added in the last " +
      "few minutes may still be processing. Index a document to make it answerable " +
      "(`mla kb add <path>`, or the /mla onboard skill for this repository). Do NOT " +
      "report the absence of evidence as an absence of the fact."
    );
  }
  if (isOnboardingGapPull(corpusEmpty, corpusState)) {
    return (
      "This workspace has no indexed documents, so retrieval returns nothing for EVERY " +
      "query, not just this one. That is an onboarding gap, not a bad query: run the " +
      "/mla onboard skill to index this repository (or `mla kb add <path>` for a single " +
      "document). Do NOT report the absence of evidence as an absence of the fact."
    );
  }
  if (corpusEmpty === false) {
    return (
      "The workspace has indexed documents but none matched this query. Try different " +
      "wording or a broader phrasing before concluding the fact is not recorded."
    );
  }
  return (
    "No evidence matched. If this workspace was never ingested, retrieval will stay " +
    "empty for every query: run `mla kb summary` to check, and the /mla onboard skill " +
    "if it is empty."
  );
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

  const result = {
    tool: "meetless__retrieve_knowledge",
    workspace: workspaceId,
    query,
    count: candidates.length,
    candidates,
  };

  // A SERVED pull can be as empty as an empty one, and `count` cannot say so: a page
  // of twelve irrelevant rows and a page of twelve on-point ones are the same shape.
  // Measured on the dogfood workspace 2026-08-08, twelve candidates on every probe:
  // all three real queries returned at least one `high` band, none of the three
  // nonsense ones did, and `low` appeared only in the nonsense ones. Carried through
  // verbatim (allow-listed), never rendered into a warning: this reports, the agent
  // decides. Nothing is filtered here or upstream.
  if (candidates.length > 0 && SERVED_RELEVANCE_BANDS.has(response.served_relevance)) {
    result.served_relevance = response.served_relevance;
  }

  // An empty pull is a finding, not a non-answer. Carry intel's verdict verbatim
  // (a boolean about the caller's OWN workspace, no substrate) plus the one line
  // that tells the agent what to do about it.
  if (candidates.length === 0) {
    const corpusEmpty =
      typeof response.corpus_empty === "boolean" ? response.corpus_empty : undefined;
    // Allow-listed, never echoed: an unrecognized state must not reach the agent as
    // a product word we have no message for.
    const corpusState = CORPUS_STATES.has(response.corpus_state)
      ? response.corpus_state
      : undefined;
    if (corpusEmpty !== undefined) result.corpus_empty = corpusEmpty;
    if (corpusState !== undefined) result.corpus_state = corpusState;
    result.warnings = [explainEmptyPull(corpusEmpty, corpusState)];
    // P0-2: the offer, at the moment the miss actually happened. Fires only on the
    // onboarding-gap branch, so a retriever miss and an already-onboarded workspace whose
    // capture lane does not ground are both silent here. Optional and swallowed: this server
    // owns no fs and no env, the sink is injected by `mla mcp`, and a telemetry fault must
    // never turn a working pull into a failed tool call.
    if (isOnboardingGapPull(corpusEmpty, corpusState) && typeof deps.recordOnboardingGap === "function") {
      try {
        deps.recordOnboardingGap();
      } catch {
        /* never break the pull that observed it */
      }
    }
  }

  return result;
}
