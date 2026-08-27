// D3 SHADOW: run the canonical `POST /v1/coordination/pull` beside the legacy session-steer
// pull and compare the SET of delivered command ids. Same discipline as the D0 query shadow
// (query-shadow.ts): the legacy pull is authoritative, the shadow fires AFTER it has been
// cached, its result is never shown to the operator, and every failure is swallowed. A shadow
// that can change what the hook injects is not a shadow.
//
// WHAT IT COMPARES, and why it is a clean comparison unlike D0. The delivered unit is a steer
// id; the tier maps `steer.id -> commandId` (coordination.contract toDeliveries), so the two
// sides agree iff they claim the same ids. There is NO model loop here, so a mismatch is a real
// divergence rather than retrieval variance: control's `pullBySession` returns the full
// not-yet-injected set, NOT a delta, so firing the tier pull after the legacy pull finds no
// PENDING left to claim and returns the identical PULLED set. `same=false` therefore means the
// contract, not the loop.
//
// TWO COSTS, stated so they are not later mistaken for bugs. The tier pull DOUBLE-METERS
// `coordination_delivered` (it is a second real pull). And the tier re-checks the human's ADMIN
// governance floor at control, so a non-ADMIN user token yields a 403, reported as a skip with
// its HTTP status, never as a divergence. Off by default; MEETLESS_D3_SHADOW=1 turns it on.
import { egressFetch } from "./egress/fetch";

/** The one field of a cached steer the comparison needs: its id. */
interface SteerIdLike {
  id: string;
}

/** Delivered ids from the LEGACY pull, deduped and sorted. */
function legacySteerIds(steers: readonly SteerIdLike[]): string[] {
  return [...new Set(steers.map((s) => s.id).filter((id) => typeof id === "string" && id.length > 0))].sort();
}

/** Delivered ids from the CANONICAL pull body (`commands[].commandId`), deduped and sorted. */
function canonicalCommandIds(body: unknown): string[] {
  const commands = (body as { commands?: unknown[] } | null)?.commands;
  if (!Array.isArray(commands)) return [];
  return [
    ...new Set(
      commands
        .map((c) => (c as { commandId?: unknown }).commandId)
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    ),
  ].sort();
}

export interface SteerShadowComparison {
  ran: boolean;
  /** Why it did not run, when it did not. Never a silent no-op. */
  skipped?: string;
  status?: number;
  legacy?: string[];
  canonical?: string[];
  /** The two id sets are identical. */
  same?: boolean;
  /** How many ids both sides claimed. */
  overlap?: number;
  onlyLegacy?: string[];
  onlyCanonical?: string[];
  error?: string;
}

export function compareSteers(legacySteers: readonly SteerIdLike[], canonicalBody: unknown): SteerShadowComparison {
  const legacy = legacySteerIds(legacySteers);
  const canonical = canonicalCommandIds(canonicalBody);
  const l = new Set(legacy);
  const c = new Set(canonical);
  return {
    ran: true,
    legacy,
    canonical,
    same: legacy.length === canonical.length && legacy.every((r) => c.has(r)),
    overlap: legacy.filter((r) => c.has(r)).length,
    onlyLegacy: legacy.filter((r) => !c.has(r)),
    onlyCanonical: canonical.filter((r) => !l.has(r)),
  };
}

export interface CoordinationShadowOptions {
  platformUrl: string | undefined;
  accessToken: string | undefined;
  sessionId: string;
  legacySteers: readonly SteerIdLike[];
  enabled: boolean;
}

/**
 * Fire the canonical pull and compare. NEVER throws.
 *
 * The user token is what the tier expects: the shadow is a real `/v1/coordination/pull` by the
 * same human. Under a shared-key CLI there is no user token and no shadow, reported as a skip
 * (not an error) so "not applicable" stays distinct from "broken".
 */
export async function runCoordinationShadow(opts: CoordinationShadowOptions): Promise<SteerShadowComparison> {
  if (!opts.enabled) return { ran: false, skipped: "disabled" };
  if (!opts.platformUrl) return { ran: false, skipped: "no MEETLESS_PLATFORM_URL" };
  if (!opts.accessToken) return { ran: false, skipped: "no user token (shared-key CLI)" };

  try {
    const res = await egressFetch("control", `${opts.platformUrl.replace(/\/+$/, "")}/v1/coordination/pull`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${opts.accessToken}` },
      body: { sessionId: opts.sessionId },
    });
    const text = await res.text();
    if (!res.ok) return { ran: false, skipped: `canonical HTTP ${res.status}`, status: res.status };
    const parsed = JSON.parse(text) as unknown;
    return { ...compareSteers(opts.legacySteers, parsed), status: res.status };
  } catch (e) {
    // Swallowed on purpose. A shadow that can break a flush drain is worse than no shadow.
    return { ran: false, error: (e as Error).message?.slice(0, 200) };
  }
}

/** One stderr line. Machine-greppable, and never on stdout, which flush.sh parses as JSON. */
export function formatCoordinationShadow(cmp: SteerShadowComparison): string {
  if (!cmp.ran) return `d3_shadow skipped=${cmp.skipped ?? "error"}${cmp.error ? ` error=${cmp.error}` : ""}`;
  return (
    `d3_shadow same=${cmp.same} overlap=${cmp.overlap ?? 0} ` +
    `legacy=${cmp.legacy?.length ?? 0} canonical=${cmp.canonical?.length ?? 0}` +
    (cmp.same ? "" : ` only_legacy=[${cmp.onlyLegacy?.join(",")}] only_canonical=[${cmp.onlyCanonical?.join(",")}]`)
  );
}
