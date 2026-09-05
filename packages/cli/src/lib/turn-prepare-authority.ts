// E2 machinery: the authoritative turn-preparation path, with the flip HELD.
//
// This is the cutover plumbing the platform contract's E2 describes: MLA prepares a turn from the
// canonical `POST /v1/turns/prepare` decision instead of the local assembler. It is built and
// tested now, ahead of the switch, but the switch is HELD: `prepareTurn` uses the legacy path
// unless `cutover` is explicitly true, and nothing in the hot path passes `cutover: true` yet. The
// flip is one call-site change, made only when the E1 shadow evidence clears (§11 row 5). Rollback
// is the same switch back, and the local scan cache stays exactly as it is, a latency/offline
// projection, so a rollback loses nothing.
//
// LEGACY IS THE FALLBACK EVEN WHEN THE FLIP IS ON. If the canonical call fails, times out, or
// returns nothing usable, `prepareTurn` renders the legacy decision. The turn is never blocked or
// degraded because the tier was unreachable: the local cache already holds a complete decision.
import { egressFetch } from "./egress/fetch";
import {
  assembleContext,
  assembleFromCanonicalDecision,
  type AssembleInput,
  type AssembleOutput,
  type CanonicalTurnContext,
} from "./scanner/assemble";

export interface TurnPrepareSignals {
  explicitPaths?: string[];
  workingSet?: string[];
  reconcileDigests?: { path: string; digest: string }[];
}

export interface CanonicalFetchOptions {
  platformUrl: string | undefined;
  accessToken: string | undefined;
  task: string;
  sessionId: string;
  signals?: TurnPrepareSignals;
  /**
   * Hard ceiling on the canonical fetch, in ms. The injection path is per-turn and latency
   * sensitive, so a slow or hung tier must fail FAST to the legacy fallback INSIDE this wrapper,
   * never stall the turn waiting on the hook's outer kill. Defaults to a few seconds; the legacy
   * render is instant, so a healthy tier is well under it.
   */
  timeoutMs?: number;
}

/** Default hard ceiling for the per-turn canonical fetch. */
export const CANONICAL_FETCH_TIMEOUT_MS = 3500;

function asRuleArray(v: unknown): Array<Record<string, unknown>> {
  return Array.isArray(v) ? (v as Array<Record<string, unknown>>) : [];
}

/** Narrow the tier's response context to the shape the renderer consumes, or null if unusable. */
export function normalizeCanonicalContext(body: unknown): CanonicalTurnContext | null {
  const ctx = (body as { context?: unknown } | null)?.context;
  if (!ctx || typeof ctx !== "object") return null;
  const c = ctx as Record<string, unknown>;
  const floorRule = (r: Record<string, unknown>, fallback: "MUST" | "SHOULD") => ({
    ruleId: String(r.ruleId ?? ""),
    versionId: typeof r.versionId === "string" ? r.versionId : undefined,
    text: String(r.text ?? ""),
    strength: (r.strength === "MUST" || r.strength === "SHOULD" ? r.strength : fallback) as "MUST" | "SHOULD",
  });
  const out: CanonicalTurnContext = {
    floorMust: asRuleArray(c.floorMust).map((r) => floorRule(r, "MUST")).filter((r) => r.ruleId && r.text),
    floorShould: asRuleArray(c.floorShould).map((r) => floorRule(r, "SHOULD")).filter((r) => r.ruleId && r.text),
    scopedRequired: asRuleArray(c.scopedRequired).map((r) => floorRule(r, "MUST")).filter((r) => r.ruleId && r.text),
    bestEffort: asRuleArray(c.bestEffort)
      .map((r) => ({
        ruleId: String(r.ruleId ?? ""),
        text: String(r.text ?? ""),
        strength: (r.strength === "MUST" ? "MUST" : "SHOULD") as "MUST" | "SHOULD",
        source: (r.source === "floor" ? "floor" : "scoped") as "floor" | "scoped",
      }))
      .filter((r) => r.ruleId && r.text),
  };
  return out;
}

/**
 * Why a turn fell back to the legacy decision. Two stable, distinguishable causes so a post-cutover
 * reader can tell "the tier was down" from "the tier answered but its decision was unusable".
 */
export type FallbackReason = "canonical_unavailable" | "canonical_invalid";
/** The Platform explicitly refused the request (auth/scope/billing/rate/policy), or a credential was missing while configured. */
export type RefusalReason = "canonical_refused";

export type CanonicalFetchResult =
  | { ok: true; ctx: CanonicalTurnContext }
  /** The tier could not serve for an availability reason: legacy fallback is SAFE (read/decision path). */
  | { ok: false; disposition: "fallback"; reason: FallbackReason }
  /** The tier (or the credential state) explicitly refused: fail CLOSED, never legacy, or Platform policy is bypassed. */
  | { ok: false; disposition: "fail_closed"; reason: RefusalReason; status?: number };

/**
 * Fetch the canonical turn decision. NEVER throws. The disposition decides the caller's behavior:
 *   `fallback`     an AVAILABILITY problem (timeout, network, 5xx, or a 2xx whose body was unusable):
 *                  legacy may serve, because turn preparation is a read/decision path.
 *   `fail_closed`  an explicit REFUSAL (4xx: 400/401/402/403/429/other, or a missing/invalid credential
 *                  while configured): legacy must NOT serve, or the request would bypass Platform
 *                  auth/scope/billing/rate policy.
 */
export async function fetchCanonicalTurnContext(opts: CanonicalFetchOptions): Promise<CanonicalFetchResult> {
  // Configured (a platform URL is set) but no usable credential is an AUTH failure, not an outage:
  // fail closed, never legacy. When no URL is set the caller is not in cutover, so treat a missing
  // credential there as a plain availability fallback.
  if (!opts.accessToken) {
    return opts.platformUrl
      ? { ok: false, disposition: "fail_closed", reason: "canonical_refused" }
      : { ok: false, disposition: "fallback", reason: "canonical_unavailable" };
  }
  if (!opts.platformUrl) return { ok: false, disposition: "fallback", reason: "canonical_unavailable" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? CANONICAL_FETCH_TIMEOUT_MS);
  try {
    const res = await egressFetch("control", `${opts.platformUrl.replace(/\/+$/, "")}/v1/turns/prepare`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${opts.accessToken}` },
      body: { task: opts.task, sessionId: opts.sessionId, ...(opts.signals ? { signals: opts.signals } : {}) },
      signal: controller.signal,
    });
    if (!res.ok) {
      // A 4xx is an explicit policy/auth/scope/billing/rate rejection: falling back to the stale local
      // matcher would bypass the Platform's decision, so fail CLOSED. A 5xx is a server outage, which
      // is an availability problem the legacy path may safely cover.
      if (res.status >= 400 && res.status < 500) {
        return { ok: false, disposition: "fail_closed", reason: "canonical_refused", status: res.status };
      }
      return { ok: false, disposition: "fallback", reason: "canonical_unavailable" };
    }
    const ctx = normalizeCanonicalContext(JSON.parse(await res.text()) as unknown);
    return ctx ? { ok: true, ctx } : { ok: false, disposition: "fallback", reason: "canonical_invalid" };
  } catch {
    // A timeout aborts the fetch (AbortError) and lands here exactly like a network failure: an
    // availability problem, so the turn falls back to legacy fast rather than stalling on a hung tier.
    return { ok: false, disposition: "fallback", reason: "canonical_unavailable" };
  } finally {
    clearTimeout(timer);
  }
}

export interface PrepareTurnOptions extends CanonicalFetchOptions {
  /** THE HELD FLIP. false = legacy is authoritative (the default everywhere today). */
  cutover: boolean;
  /** The legacy assembler input; also the source of `base` and `safeTotal` for the canonical render. */
  legacyInput: AssembleInput;
}

/**
 * Which decision actually served the turn:
 *   `canonical`            the tier's decision was served (post-cutover, healthy);
 *   `legacy_pre_cutover`   the flip is held (`cutover` false), so legacy served by design;
 *   `legacy_fallback`      the flip is on but the canonical call could not serve, so legacy served.
 *
 * The distinction is the whole point of this telemetry: `legacy_fallback` is the only state that
 * blocks deleting the local matcher, and `legacy_pre_cutover` must never be mistaken for it.
 */
export type AuthoritySource = "canonical" | "legacy_pre_cutover" | "legacy_fallback" | "refused";

export interface PrepareTurnResult {
  output: AssembleOutput;
  authority: AuthoritySource;
  /** Set on `legacy_fallback` (why legacy served) or `refused` (why the tier refused). */
  reason?: FallbackReason | RefusalReason;
  /** On `refused` from a response: the HTTP status the tier returned. */
  status?: number;
}

/** The empty governed decision rendered on `refused`: base only, no floor/scoped/best-effort rules. */
const EMPTY_DECISION: CanonicalTurnContext = {
  floorMust: [],
  floorShould: [],
  scopedRequired: [],
  bestEffort: [],
};

/**
 * One line, reusing the E1 stderr convention (the shadow's `e1_shadow ...`). The hook redirects it
 * to the authority log when the flip wires `prepareTurn` in, so post-cutover we can prove
 * `legacy_fallback` traffic reached zero before deleting the local matcher (An, §11 row 5).
 */
export function formatTurnAuthority(r: PrepareTurnResult): string {
  return `e1_authority authority=${r.authority}${r.reason ? ` reason=${r.reason}` : ""}`;
}

/**
 * Produce the turn's injection envelope AND record which decision served it. Legacy is authoritative
 * unless `cutover` is true AND the canonical call yields a usable decision; otherwise it renders the
 * local decision, so a slow or down tier never blocks a turn. Emits exactly one `e1_authority` line
 * at the boundary so the authority source is observable on every turn.
 */
export async function prepareTurn(opts: PrepareTurnOptions): Promise<PrepareTurnResult> {
  let result: PrepareTurnResult;
  if (!opts.cutover) {
    result = { output: assembleContext(opts.legacyInput), authority: "legacy_pre_cutover" };
  } else {
    const fetched = await fetchCanonicalTurnContext(opts);
    if (fetched.ok) {
      result = {
        output: assembleFromCanonicalDecision(opts.legacyInput.base, fetched.ctx, opts.legacyInput.safeTotal),
        authority: "canonical",
      };
    } else if (fetched.disposition === "fallback") {
      result = {
        output: assembleContext(opts.legacyInput),
        authority: "legacy_fallback",
        reason: fetched.reason,
      };
    } else {
      // FAIL CLOSED. The Platform explicitly refused (4xx auth/scope/billing/rate/policy) or a
      // credential was missing while configured. Falling back to the local matcher would bypass that
      // decision, so inject NOTHING governed: render the EMPTY decision through the SAME renderer, and
      // record the refusal on the authority line. The turn is not blocked; it simply carries no
      // governed rules this turn.
      result = {
        output: assembleFromCanonicalDecision(opts.legacyInput.base, EMPTY_DECISION, opts.legacyInput.safeTotal),
        authority: "refused",
        reason: fetched.reason,
        status: fetched.status,
      };
    }
  }
  // The one lightweight observation at the authority boundary (An). Reuses the E1 stderr path; no
  // database, metric subsystem, flag, or telemetry framework.
  console.error(formatTurnAuthority(result));
  return result;
}
