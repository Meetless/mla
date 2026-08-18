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
// and the structural refusals) is terminal: waiting cannot help,
// only a top-up or a config fix can. Kept as an allowlist so a reason nobody
// mirrors here fails CLOSED to the terminal path (never a retry storm), exactly
// like intel's frozenset does.
const TRANSIENT_BILLING_REASONS = new Set(["FULLY_RESERVED", "NOT_PROVISIONED"]);

// The terminal 402s do NOT share a remedy, and naming the wrong one is not a
// cosmetic error: it sends the agent (and whoever it escalates to) to do a thing
// that cannot possibly lift the denial, and then to conclude the system is broken
// when it does not. This module used to answer every terminal 402 with one
// sentence, "escalate to bind a payer or top up the balance". That sentence is
// true for exactly two of the reasons control can return and false for the rest:
//
//   NO_PAYER          bind a payer. Money changes nothing until one exists.
//   EXHAUSTED         top up. The ONLY reason where the money is genuinely gone,
//                     and the only one for which control sets topUpRequired.
//   ACCOUNT_SUSPENDED an operator suspended cost-bearing execution for the
//                     principal that owns this payer (abuse defense Change Set B,
//                     owner ruling 2026-07-27). Explicitly NOT a money state:
//                     control checks it BEFORE reading any balance, so a fully
//                     funded account is denied all the same. Telling an agent to
//                     top up here is the one thing the ruling forbids by name.
//
// Structural refusals (PRICING_UNSUPPORTED, the delivery-key family,
// ACTOR_NOT_IN_WORKSPACE) and any reason invented later fall through to the
// generic terminal copy, which asserts no remedy it cannot vouch for.
//
// NO_HEADROOM was a fourth keyed remedy ("only an operator can raise the cap")
// until control RETIRED it on 2026-08-14: the runaway-brake column had no writer
// anywhere, so no operator could arm it and none ever had. Intel mirrored the
// deletion the same day (5670080e). The key is dropped rather than kept pointing
// at dead copy, so a control that somehow still emits it lands in the generic
// terminal bucket, which is the CORRECT answer: a control emitting a vocabulary
// this build does not mirror is a coordination defect, and the fail-closed
// fallthrough is what makes it loud instead of silently well-phrased.
const TERMINAL_BILLING_GUIDANCE_KEY = {
  NO_PAYER: "payment_required_no_payer",
  EXHAUSTED: "payment_required_exhausted",
  ACCOUNT_SUSPENDED: "payment_required_suspended",
};

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
 *
 * `unavailable` is deliberately ONE category covering three different failures,
 * because the retry contract is identical for all three and both the mask and the
 * retrieve retry loop key on it. The COPY is not identical: see shapeOfUnavailable.
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
 * Which of the three `unavailable` failures this is. Same category, same retry
 * contract, three MUTUALLY EXCLUSIVE facts about the world:
 *
 *   unreachable   no numeric status: the connection never completed (refused
 *                 mid-restart, DNS, abort). Intel really is out of contact.
 *   rate_limited  429: intel answered. It is up, healthy, and shedding load.
 *   server_error  5xx: intel answered. It is up and faulted on this request.
 *
 * Collapsing these into one "intel unreachable" line (as this module did until
 * now) is not a cosmetic sloppiness: it sends an operator to check DNS, ingress
 * and the deploy when intel is plainly answering, and it hides a rate limit,
 * which is the one shape where retrying WITHOUT backoff makes things worse. The
 * status is already returned in the result's `status` field, so naming it in the
 * message discloses nothing new (SEC-3.2 is about the body, host and stack).
 */
function shapeOfUnavailable(err) {
  const status = err && err.status;
  if (typeof status !== "number") return "unreachable";
  return status === 429 ? "rate_limited" : "server_error";
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
  // Generic terminal fallback: a structural refusal, or a reason this build does
  // not know. It deliberately names NO remedy, because guessing one wrong is the
  // defect the per-reason keys below exist to fix.
  payment_required:
    "This is a terminal billing denial, NOT an outage and NOT self-clearing. " +
    "Governed memory stays gated until an operator resolves it. Do NOT fall back " +
    "to grep as if the evidence were absent, and do NOT retry; escalate with the " +
    "reason code above.",
  payment_required_no_payer:
    "Terminal: this workspace has NO PAYER bound, so no metered work can run. " +
    "NOT an outage and NOT self-clearing. Funding a balance cannot help until a " +
    "payer exists. Do NOT fall back to grep as if the evidence were absent, and " +
    "do NOT retry; escalate to bind a payer to this workspace.",
  payment_required_exhausted:
    "Terminal: the balance is spent. NOT an outage and NOT self-clearing. Do NOT " +
    "fall back to grep as if the evidence were absent, and do NOT retry; escalate " +
    "to top up the balance.",
  payment_required_suspended:
    "Terminal: an operator has SUSPENDED cost-bearing execution for this " +
    "account. This is NOT a money problem and must not be treated as one: the " +
    "balance is irrelevant, topping up will not lift it, and no checkout page or " +
    "upgrade will either. It is NOT an outage and NOT self-clearing. Do NOT fall " +
    "back to grep as if the evidence were absent, and do NOT retry; sign-in, " +
    "reading, and export are unaffected. Contact support to have the suspension " +
    "reviewed and lifted.",
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
  unavailable_rate_limited:
    "Intel is UP and answering; it is shedding load (rate limit), not down. " +
    "This is not an outage and the evidence is not absent. Back off before " +
    "retrying: an immediate retry makes the limit worse. For pure code-shape " +
    "questions, grep is an acceptable stopgap.",
  unavailable_server_error:
    "Intel is REACHABLE and faulted on this request (a server error), so this " +
    "is not a connectivity problem: do not go chasing DNS, ingress or the " +
    "deploy. Transient; retry shortly. If it persists, the fault is inside " +
    "intel and belongs in its logs. For pure code-shape questions, grep is an " +
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
  let guidanceKey = category;
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
      // NO_PAYER / EXHAUSTED / NO_HEADROOM / ACCOUNT_SUSPENDED / structural:
      // terminal for this call. The retry contract is unchanged and stays keyed on
      // the allowlist alone, so any reason nobody mirrored lands here rather than
      // in a retry loop. What is NOT shared is the remedy, hence the per-reason
      // guidance key.
      guidanceKey = TERMINAL_BILLING_GUIDANCE_KEY[reason] || "payment_required";
      message =
        reason === "ACCOUNT_SUSPENDED"
          ? // "billing denied" would describe a balance nobody looked at: control
            // checks the suspension after resolving the payer and BEFORE reading
            // any balance, and a reader who hears "billing" reaches for a top-up
            // that cannot lift it.
            `${noun} unavailable: cost-bearing execution is suspended for this account${suffix}. This is not an outage, not a spent balance, and the evidence is not absent, only gated; topping up will not lift it and it will not clear on its own, so do not retry.`
          : `${noun} unavailable: billing denied${suffix}. This is not an outage and the evidence is not absent, only gated; it will not clear on its own, so do not retry.`;
    }
  } else if (category === "unavailable") {
    // Same category, same retry contract, three different facts. Say which one
    // actually happened instead of asserting "unreachable" about an intel that
    // just answered us.
    const shape = shapeOfUnavailable(err);
    if (shape === "rate_limited") {
      guidanceKey = "unavailable_rate_limited";
      message = `${noun} temporarily unavailable: intel is rate limiting this request (HTTP 429). Intel is up; back off before retrying.`;
    } else if (shape === "server_error") {
      guidanceKey = "unavailable_server_error";
      message = `${noun} temporarily unavailable: intel answered with a server error (HTTP ${status}). Intel is reachable; this is not a connectivity fault. Retry shortly.`;
    } else {
      message = `${noun} temporarily unavailable: intel is unreachable (the connection failed); retry shortly`;
    }
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
      : GUIDANCE[guidanceKey],
  };
}
