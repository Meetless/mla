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
}

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

export type CanonicalFetchResult =
  | { ok: true; ctx: CanonicalTurnContext }
  | { ok: false; reason: FallbackReason };

/**
 * Fetch the canonical turn decision. NEVER throws. Returns the reason it could not serve one:
 * `canonical_unavailable` for a missing credential, a non-2xx, or a network failure;
 * `canonical_invalid` for a 2xx whose body carried no usable decision.
 */
export async function fetchCanonicalTurnContext(opts: CanonicalFetchOptions): Promise<CanonicalFetchResult> {
  if (!opts.platformUrl || !opts.accessToken) return { ok: false, reason: "canonical_unavailable" };
  try {
    const res = await egressFetch("control", `${opts.platformUrl.replace(/\/+$/, "")}/v1/turns/prepare`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${opts.accessToken}` },
      body: { task: opts.task, sessionId: opts.sessionId, ...(opts.signals ? { signals: opts.signals } : {}) },
    });
    if (!res.ok) return { ok: false, reason: "canonical_unavailable" };
    const ctx = normalizeCanonicalContext(JSON.parse(await res.text()) as unknown);
    return ctx ? { ok: true, ctx } : { ok: false, reason: "canonical_invalid" };
  } catch {
    return { ok: false, reason: "canonical_unavailable" };
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
export type AuthoritySource = "canonical" | "legacy_pre_cutover" | "legacy_fallback";

export interface PrepareTurnResult {
  output: AssembleOutput;
  authority: AuthoritySource;
  /** Set only on `legacy_fallback`: why the canonical decision could not serve. */
  reason?: FallbackReason;
}

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
    } else {
      result = {
        output: assembleContext(opts.legacyInput),
        authority: "legacy_fallback",
        reason: fetched.reason,
      };
    }
  }
  // The one lightweight observation at the authority boundary (An). Reuses the E1 stderr path; no
  // database, metric subsystem, flag, or telemetry framework.
  console.error(formatTurnAuthority(result));
  return result;
}
