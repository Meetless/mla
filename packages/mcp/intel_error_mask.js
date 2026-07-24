/**
 * Shared intel-failure classifier for the MCP evidence tools.
 *
 * WHY THIS EXISTS
 * ---------------
 * Two MCP tools call intel and can fail: meetless__retrieve_knowledge (via
 * evidence_actions.js -> POST /v1/ask/retrieve) and meetless__query (via
 * ask-core -> POST /v1/ask). Before this module, retrieve masked its failures
 * but collapsed a billing denial (HTTP 402) into a generic "retrieval
 * unavailable" line, and query did not mask at all: it surfaced the raw intel
 * error string plus the guidance "falling back to grep is OK". Both lied about
 * the same real failure mode. When a workspace has no payer bound, intel
 * answers 402 with a body like
 *   {"detail":{"code":"BILLING_DENIED","category":"payment_required",
 *              "reason":"NO_PAYER","topUpRequired":false}}
 * That is NOT an outage and grep is NOT a valid substitute: the evidence exists,
 * it is just gated. The agent needs to know the difference.
 *
 * This module is the one place that turns an intel error object into:
 *   - a substrate-free `message` (SEC-3.2: never leaks intel host/port, the
 *     response body, or a stack; the only free-text is our own copy),
 *   - a discriminated `category` (auth | payment_required | unavailable | error),
 *   - `transient` / `billing` booleans, and
 *   - `guidance`: one line telling the agent what the failure MEANS and whether
 *     grep is an acceptable fallback (Item 3, discriminated guidance).
 *
 * GOVERNED ERROR TAXONOMY (onboarding scout note, fixed):
 *   4xx except 429 is PERMANENT (do not retry). 5xx / 429 / network errors are
 *   TRANSIENT (retry with backoff). A 429 is transient and joins the 5xx/transport
 *   retry set. A 402 is USUALLY permanent, with one governed exception: the two
 *   billing reasons FULLY_RESERVED and NOT_PROVISIONED are self-clearing holds on
 *   a funded, payer-bound workspace (its own in-flight jobs momentarily hold the
 *   balance; it comes back at settlement). Those are transient; every other 402
 *   (NO_PAYER, EXHAUSTED, ...) is terminal. The retrieve retry loop and the mask
 *   agree because both route through the same two predicates below,
 *   isTransientIntelError() (infra) and isTransientBillingDenial() (billing hold).
 *
 * The error objects we classify come from two shapes, both already carrying the
 * fields we need:
 *   - live `mla mcp` path: http.ts buildError -> HttpError with numeric .status
 *     and full raw .body.
 *   - legacy env-key path: ask_modes.js makeIntelAsk, hardened to attach .status
 *     and .body the same way.
 *   - transport failures (connection refused mid-restart, DNS, abort): undici
 *     rejects with a TypeError "fetch failed" (or .cause.code); no .status.
 */

// A billing detail token we are willing to echo. Bounding it to a short
// SCREAMING_SNAKE enum is the SEC-3.2 guard: even if intel's 402 body grows new
// free-text fields, only a value matching this shape can ever escape, so a body
// like `{"detail":{"reason":"NO_PAYER"}}` yields "NO_PAYER" and nothing else.
const SAFE_ENUM = /^[A-Z0-9_]{1,40}$/;

// The only two 402 billing reasons that clear on their OWN, at settlement, in
// seconds. Mirrors intel `billing_envelope.py` TRANSIENT_DENY_REASONS and worker
// `billing-denial.ts` isTransientBillingDenial (the governed source of truth). A
// funded, payer-bound workspace whose balance is momentarily held by its own
// in-flight jobs (FULLY_RESERVED), or whose payer entitlement is still being
// lazily minted (NOT_PROVISIONED), gets a 402 that the SAME call answers
// differently once its siblings settle. Every other 402 (NO_PAYER, EXHAUSTED,
// NO_HEADROOM, and the structural refusals) is terminal: waiting cannot help,
// only a top-up or a config fix can. Kept as an allowlist so a reason nobody
// mirrors here fails CLOSED to the terminal path (never a retry storm), exactly
// like intel's frozenset does.
const TRANSIENT_BILLING_REASONS = new Set(["FULLY_RESERVED", "NOT_PROVISIONED"]);

/**
 * Best-effort extraction of the billing reason enum from a 402 error body,
 * without ever surfacing the raw body. Accepts the body as a JSON string (the
 * common case from buildError) or an already-parsed object. Returns a bounded
 * enum token (e.g. "NO_PAYER") or undefined. Never throws.
 */
function safeBillingReason(err) {
  let obj = err && err.body;
  if (typeof obj === "string") {
    try {
      obj = JSON.parse(obj);
    } catch {
      return undefined;
    }
  }
  if (!obj || typeof obj !== "object") return undefined;
  const detail =
    obj.detail && typeof obj.detail === "object" ? obj.detail : obj;
  // Prefer the specific `reason` (NO_PAYER, INSUFFICIENT_FUNDS, ...); fall back
  // to the coarser `code` (BILLING_DENIED). Only a bounded enum token escapes.
  for (const key of ["reason", "code"]) {
    const v = detail && detail[key];
    if (typeof v === "string" && SAFE_ENUM.test(v)) return v;
  }
  return undefined;
}

/**
 * Map an intel error to one of four categories:
 *   auth             401 / 403           re-auth needed
 *   payment_required 402                 no payer / billing denied (NOT an outage)
 *   unavailable      429 / 5xx / no-status  transient infra blip (retry)
 *   error            other 4xx           deterministic request fault
 */
function categoryOf(err) {
  const status = err && err.status;
  if (status === 401 || status === 403) return "auth";
  if (status === 402) return "payment_required";
  if (status === 429) return "unavailable";
  if (typeof status === "number") {
    return status >= 500 && status <= 599 ? "unavailable" : "error";
  }
  // No numeric status: the transport failed (connection refused mid-restart,
  // DNS, an aborted/timed-out request). Always transient.
  return "unavailable";
}

/**
 * A failure worth retrying, per the governed taxonomy. Shared by the retrieve
 * retry loop and the mask so they never disagree about what "transient" means.
 */
export function isTransientIntelError(err) {
  return categoryOf(err) === "unavailable";
}

/**
 * A 402 billing denial whose reason clears on its OWN at settlement
 * (FULLY_RESERVED / NOT_PROVISIONED). Retryable IN PLACE despite the 402 status:
 * the workspace is funded and its payer IS bound, the money is merely in flight.
 * Deliberately SEPARATE from isTransientIntelError so the two never blur; an infra
 * blip and a billing hold both may be retried but want different copy (one is an
 * outage, one is not). Mirrors worker `billing-denial.ts`; keyed on the same
 * governed reason set, read from the 402 body's `detail.reason` through the same
 * SEC-3.2 enum guard as the mask.
 */
export function isTransientBillingDenial(err) {
  return (
    categoryOf(err) === "payment_required" &&
    TRANSIENT_BILLING_REASONS.has(safeBillingReason(err))
  );
}

/**
 * True when `err` is an intel HTTP or transport failure (as opposed to a
 * deterministic, self-correctable validation error like "unsupported mode" or a
 * pre-shaped actionable error like the synthesis-timeout message). Used at the
 * meetless__query boundary to decide mask-vs-passthrough: only real intel
 * transport/HTTP failures get masked; everything else passes through so the
 * agent can self-correct on the original wording.
 */
export function isIntelHttpOrTransportError(err) {
  if (!err) return false;
  if (typeof err.status === "number") return true; // HTTP non-2xx from buildError
  // undici surfaces a connection-level failure as `TypeError: fetch failed`.
  if (
    err.name === "TypeError" &&
    /fetch failed/i.test(String(err.message || ""))
  ) {
    return true;
  }
  const code = err.cause && err.cause.code;
  if (
    typeof code === "string" &&
    /^(ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|EPIPE|ETIMEDOUT|UND_ERR_)/.test(
      code,
    )
  ) {
    return true;
  }
  return false;
}

const GUIDANCE = {
  auth:
    "Governed memory needs re-authentication (run 'mla login', or set " +
    "MEETLESS_CONTROL_TOKEN). Do not treat missing evidence as absent.",
  payment_required:
    "This is a terminal billing/payer denial, NOT an outage and NOT self-" +
    "clearing. Governed memory stays unreachable until a payer is bound or the " +
    "balance is funded. Do NOT fall back to grep as if the evidence were absent; " +
    "escalate to bind a payer or top up the balance.",
  payment_required_transient:
    "A TRANSIENT billing hold, NOT a missing payer and NOT an outage: the " +
    "workspace's own in-flight jobs are holding its balance, which clears at " +
    "settlement in seconds. The evidence exists. Retry shortly. Do NOT fall back " +
    "to grep as if the evidence were absent, and do NOT escalate to bind a payer; " +
    "one is already bound.",
  unavailable:
    "Intel is temporarily unreachable (an infra blip), not a permanent " +
    "failure. Retry shortly. For pure code-shape questions, grep is an " +
    "acceptable stopgap.",
  error:
    "Governed memory rejected this request. Re-check the query shape; for " +
    "pure code-shape questions, grep is an acceptable fallback.",
};

/**
 * Classify an intel failure into a substrate-free, discriminated result.
 *
 * @param {*} err                 the thrown intel error (HttpError / TypeError / Error)
 * @param {{noun?: string}} opts  `noun` seeds the user-facing message so each
 *                                tool keeps its own voice ("retrieval ...",
 *                                "governed memory ..."). Default: "governed memory".
 * @returns {{category: string, status: number|undefined, transient: boolean,
 *            billing: boolean, reason: string|undefined, message: string,
 *            guidance: string}}
 */
export function classifyIntelError(err, opts = {}) {
  const noun = opts.noun || "governed memory";
  const category = categoryOf(err);
  const status = err && typeof err.status === "number" ? err.status : undefined;

  let message;
  let reason;
  let transientBilling = false;
  if (category === "auth") {
    message = `${noun} unavailable: authentication failed (run 'mla login', or check MEETLESS_CONTROL_TOKEN)`;
  } else if (category === "payment_required") {
    reason = safeBillingReason(err);
    const suffix = reason ? ` (${reason})` : "";
    if (reason && TRANSIENT_BILLING_REASONS.has(reason)) {
      // Funded workspace, money in flight. The hold clears on its own; saying
      // "no payer / do not retry" here would send the operator to bind a payer
      // that is already bound and to grep past evidence that plainly exists.
      transientBilling = true;
      message = `${noun} temporarily unavailable: billing hold${suffix}; the workspace is funded but its balance is momentarily reserved by its own in-flight jobs and clears at settlement in seconds. Retry shortly.`;
    } else {
      // NO_PAYER / EXHAUSTED / NO_HEADROOM / structural: terminal for this call.
      message = `${noun} unavailable: billing denied${suffix}. This is not an outage and the evidence is not absent, only gated; it will not clear on its own, so do not retry.`;
    }
  } else if (category === "unavailable") {
    message = `${noun} temporarily unavailable (intel unreachable); retry shortly`;
  } else {
    message = `${noun} unavailable`;
  }

  return {
    category,
    status,
    transient: category === "unavailable" || transientBilling,
    billing: category === "payment_required",
    reason,
    message,
    guidance: transientBilling
      ? GUIDANCE.payment_required_transient
      : GUIDANCE[category],
  };
}
