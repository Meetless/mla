// E1 SHADOW: run the canonical `POST /v1/turns/prepare` beside the legacy turn-preparation
// decision and compare DECISION SEMANTICS (rule ids and warning identities), not rendered text.
//
// LEGACY IS AUTHORITATIVE AND STAYS THAT WAY. This fires from the hook AFTER the injection is
// already on stdout (the agent's context is delivered before any of this runs), the canonical
// result is never injected, and every failure is swallowed. A shadow that can change what the
// agent sees is not a shadow.
//
// WHAT IT COMPARES, per dimension: the SET of governed rule ids the two paths selected at each
// tier (floor-must, scoped-required, best-effort) and the SET of warning paths. Same discipline
// as the D0/D3 shadows. There is NO predeclared overlap threshold: the point of the first runs is
// to record enough raw data to tell exact agreement from an explainable input/freshness difference
// from a genuine conflict, and the E1-specific comparator is derived from those samples later
// (§11 row 5), never inherited from D0/D3.
//
// WHY DIVERGENCE HERE IS NOT AUTOMATICALLY A REGRESSION. The legacy decision runs over the LOCAL
// scan cache, which carries both the governed bundle projection AND local `.claude/rules` file
// rules; the canonical runs over control's GOVERNED bundle only. So a legacy-only rule is usually
// a local file rule (not governed) or cache staleness, and a canonical-only rule is usually the
// cache being behind the bundle. The raw only_legacy / only_canonical id sets are what let the
// analysis attribute each difference; a single same=false cannot.
//
// EXCLUDED is deliberately `not_comparable`: the legacy audit exposes budget-omitted ids, while
// the canonical exposes a trigger-not-fired COUNT. Those are different notions of "excluded", so
// reverse-engineering a common number would be a fake equivalence.
import { egressFetch } from "./egress/fetch";

/** The legacy decision, reduced to the id/path sets the shadow compares. */
export interface LegacyTurnDecision {
  floorMust: string[];
  scopedRequired: string[];
  bestEffort: string[];
  /** Reconciliation warning paths the legacy cache carries. */
  warnings: string[];
}

/** One dimension's set comparison. */
export interface DimensionDiff {
  same: boolean;
  overlap: number;
  legacy: number;
  canonical: number;
  onlyLegacy: string[];
  onlyCanonical: string[];
}

export interface TurnShadowComparison {
  ran: boolean;
  skipped?: string;
  status?: number;
  floorMust?: DimensionDiff;
  scopedRequired?: DimensionDiff;
  bestEffort?: DimensionDiff;
  warnings?: DimensionDiff;
  /**
   * SEQUENCE agreement (not just set) for the required tiers, where injection ORDER is
   * governance-meaningful and neither path drops for budget. `true` means identical id sequence;
   * combined with the set `same`, a `same=true order=false` isolates a pure ordering difference.
   * best_effort is deliberately excluded: the canonical candidate set is unbudgeted and unordered
   * against the legacy budget order, so an order compare there would be a fake equivalence.
   */
  orderFloorMust?: boolean;
  orderScopedRequired?: boolean;
  error?: string;
}

/** Identical id SEQUENCE (order-sensitive), the order counterpart to the set compare in `diff`. */
function sameOrder(legacy: string[], canonical: string[]): boolean {
  return legacy.length === canonical.length && legacy.every((x, i) => x === canonical[i]);
}

function diff(legacy: string[], canonical: string[]): DimensionDiff {
  const l = [...new Set(legacy)].sort();
  const c = [...new Set(canonical)].sort();
  const cs = new Set(c);
  const ls = new Set(l);
  return {
    same: l.length === c.length && l.every((x) => cs.has(x)),
    overlap: l.filter((x) => cs.has(x)).length,
    legacy: l.length,
    canonical: c.length,
    onlyLegacy: l.filter((x) => !cs.has(x)),
    onlyCanonical: c.filter((x) => !ls.has(x)),
  };
}

function ids(list: unknown, key: string): string[] {
  if (!Array.isArray(list)) return [];
  return list
    .map((e) => (e as Record<string, unknown>)?.[key])
    .filter((v): v is string => typeof v === "string" && v.length > 0);
}

/** Compare the legacy decision against the canonical `turns/prepare` body. Pure. */
export function compareTurnDecisions(legacy: LegacyTurnDecision, canonicalBody: unknown): TurnShadowComparison {
  const ctx = (canonicalBody as { context?: Record<string, unknown> } | null)?.context ?? {};
  const warnings = (canonicalBody as { warnings?: unknown } | null)?.warnings;
  const canonFloor = ids(ctx.floorMust, "ruleId");
  const canonScoped = ids(ctx.scopedRequired, "ruleId");
  return {
    ran: true,
    floorMust: diff(legacy.floorMust, canonFloor),
    scopedRequired: diff(legacy.scopedRequired, canonScoped),
    bestEffort: diff(legacy.bestEffort, ids(ctx.bestEffort, "ruleId")),
    warnings: diff(legacy.warnings, ids(warnings, "path")),
    orderFloorMust: sameOrder(legacy.floorMust, canonFloor),
    orderScopedRequired: sameOrder(legacy.scopedRequired, canonScoped),
  };
}

/** One rule that both paths selected but at a DIFFERENT version: a same-id, different-content hit. */
export interface RuleVersionMismatch {
  ruleId: string;
  legacyVersionId: string;
  canonicalVersionId: string;
}

export interface RuleVersionComparison {
  /** ruleIds present in BOTH required tiers whose versionId disagrees. Empty => version parity. */
  mismatches: RuleVersionMismatch[];
  /** How many shared ruleIds carried a versionId on both sides and were actually compared. */
  comparedRuleIds: number;
}

/**
 * The rule-VERSION identity comparison An required before cutover (step 1): matching rule ids and
 * order can still hide a different rule VERSION or content. This uses the `versionId` both sides
 * ALREADY carry (legacy `FloorRuleEntry.versionId` / `ScopedRuleEntry.versionId`; canonical
 * `ContextRule.versionId`), so it invents no new fingerprint, adds no persistence, and is NOT
 * wired into the per-turn e1_shadow line. It is a pure comparator the pre-cutover proof calls.
 *
 * A ruleId present on only one side is an id-SET divergence that `compareTurnDecisions` already
 * reports; it is not a version question, so it is skipped here (only the intersection is compared).
 */
export function compareRuleVersions(
  legacyVersions: Record<string, string>,
  canonicalBody: unknown,
): RuleVersionComparison {
  const ctx = (canonicalBody as { context?: Record<string, unknown> } | null)?.context ?? {};
  const canonical: Record<string, string> = {};
  for (const tier of ["floorMust", "scopedRequired"] as const) {
    const list = ctx[tier];
    if (!Array.isArray(list)) continue;
    for (const r of list) {
      const rr = r as { ruleId?: unknown; versionId?: unknown };
      if (typeof rr.ruleId === "string" && typeof rr.versionId === "string") {
        canonical[rr.ruleId] = rr.versionId;
      }
    }
  }
  const mismatches: RuleVersionMismatch[] = [];
  let comparedRuleIds = 0;
  for (const [ruleId, legacyVersionId] of Object.entries(legacyVersions)) {
    const canonicalVersionId = canonical[ruleId];
    if (canonicalVersionId === undefined) continue; // not in both required tiers: an id-set diff, not a version diff
    comparedRuleIds++;
    if (canonicalVersionId !== legacyVersionId) {
      mismatches.push({ ruleId, legacyVersionId, canonicalVersionId });
    }
  }
  return { mismatches, comparedRuleIds };
}

export interface TurnShadowOptions {
  platformUrl: string | undefined;
  accessToken: string | undefined;
  enabled: boolean;
  legacy: LegacyTurnDecision;
  task: string;
  sessionId: string;
  signals?: { explicitPaths?: string[]; workingSet?: string[]; reconcileDigests?: { path: string; digest: string }[] };
}

/**
 * Fire the canonical path and compare. NEVER throws. The user token is what the tier expects; a
 * shared-key CLI has no user token and no shadow, reported as a skip, not an error.
 */
export async function runTurnPrepareShadow(opts: TurnShadowOptions): Promise<TurnShadowComparison> {
  if (!opts.enabled) return { ran: false, skipped: "disabled" };
  if (!opts.platformUrl) return { ran: false, skipped: "no MEETLESS_PLATFORM_URL" };
  if (!opts.accessToken) return { ran: false, skipped: "no user token (shared-key CLI)" };

  try {
    const res = await egressFetch("control", `${opts.platformUrl.replace(/\/+$/, "")}/v1/turns/prepare`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${opts.accessToken}` },
      body: { task: opts.task, sessionId: opts.sessionId, ...(opts.signals ? { signals: opts.signals } : {}) },
    });
    const text = await res.text();
    if (!res.ok) return { ran: false, skipped: `canonical HTTP ${res.status}`, status: res.status };
    const parsed = JSON.parse(text) as unknown;
    return { ...compareTurnDecisions(opts.legacy, parsed), status: res.status };
  } catch (e) {
    // Swallowed on purpose. The injection is already delivered; a shadow must never disturb it.
    return { ran: false, error: (e as Error).message?.slice(0, 200) };
  }
}

function dim(name: string, d: DimensionDiff | undefined): string {
  if (!d) return `${name}=?`;
  const tail = d.same ? "" : ` only_L=[${d.onlyLegacy.join(",")}] only_C=[${d.onlyCanonical.join(",")}]`;
  return `${name}[same=${d.same} overlap=${d.overlap} L=${d.legacy} C=${d.canonical}]${tail}`;
}

/** One stderr line. Machine-greppable, never on stdout. `excluded` is not_comparable by design. */
export function formatTurnPrepareShadow(cmp: TurnShadowComparison): string {
  if (!cmp.ran) return `e1_shadow skipped=${cmp.skipped ?? "error"}${cmp.error ? ` error=${cmp.error}` : ""}`;
  return (
    `e1_shadow ${dim("floor_must", cmp.floorMust)} ${dim("scoped_required", cmp.scopedRequired)} ` +
    `${dim("best_effort", cmp.bestEffort)} ${dim("warnings", cmp.warnings)} ` +
    `order[floor_must=${cmp.orderFloorMust ?? "?"} scoped_required=${cmp.orderScopedRequired ?? "?"}] ` +
    `excluded=not_comparable`
  );
}

// ── Read-only summary over an accumulated e1-shadow.log ──────────────────────────────────────────
//
// The inverse of `formatTurnPrepareShadow`, kept in the same file so the two cannot drift. It reports
// what the raw log already holds; it invents nothing, weighs nothing, and is NOT a gate. There is no
// magic sample count: the reader decides when "enough of the meaningful decision-input varieties have
// been exercised" from the distinct-id lists below, which are exactly what attributes each divergence
// (an only_L id is usually a local `.claude/rules` file rule or a stale cache; an only_C id is usually
// the cache running behind the governed bundle).

const DIMENSIONS = ["floor_must", "scoped_required", "best_effort", "warnings"] as const;
export type ShadowDimension = (typeof DIMENSIONS)[number];

export interface ShadowSummary {
  /** ran=true lines: turns where BOTH paths produced a decision and were compared. */
  comparable: number;
  /** Per dimension, how many comparable turns had exact-set agreement (same=true). */
  agree: Record<ShadowDimension, number>;
  /** skipped=/error lines grouped by reason (canonical unavailable, shared-key CLI, disabled, ...). */
  skips: Record<string, number>;
  /** Distinct legacy-only rule ids across all comparable turns → how many turns each appeared in. */
  onlyLegacy: Record<string, number>;
  /** Distinct canonical-only rule ids across all comparable turns → how many turns each appeared in. */
  onlyCanonical: Record<string, number>;
  /** Lines that began `e1_shadow` but did not parse (format drift signal). */
  malformed: number;
}

function bump(m: Record<string, number>, key: string): void {
  m[key] = (m[key] ?? 0) + 1;
}

/** Parse the ids inside one dimension's `only_L=[...] only_C=[...]` tail, if the dimension diverged. */
function dimTail(line: string, name: string): { onlyL: string[]; onlyC: string[] } | null {
  const m = line.match(new RegExp(`${name}\\[[^\\]]*\\](?: only_L=\\[([^\\]]*)\\] only_C=\\[([^\\]]*)\\])?`));
  if (!m) return null;
  const split = (s: string | undefined) => (s ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  return { onlyL: split(m[1]), onlyC: split(m[2]) };
}

/** Summarize accumulated e1_shadow log lines. Pure; ignores anything that is not an e1_shadow line. */
export function summarizeShadowLog(lines: string[]): ShadowSummary {
  const s: ShadowSummary = {
    comparable: 0,
    agree: { floor_must: 0, scoped_required: 0, best_effort: 0, warnings: 0 },
    skips: {},
    onlyLegacy: {},
    onlyCanonical: {},
    malformed: 0,
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line.startsWith("e1_shadow ")) continue;
    const skip = line.match(/^e1_shadow skipped=(.+?)(?: error=.*)?$/);
    if (skip) {
      bump(s.skips, skip[1]);
      continue;
    }
    if (!/excluded=not_comparable$/.test(line)) {
      s.malformed++;
      continue;
    }
    s.comparable++;
    for (const name of DIMENSIONS) {
      const same = new RegExp(`${name}\\[same=(true|false) `).exec(line);
      if (same && same[1] === "true") s.agree[name]++;
      const tail = dimTail(line, name);
      if (tail) {
        for (const id of tail.onlyL) bump(s.onlyLegacy, id);
        for (const id of tail.onlyC) bump(s.onlyCanonical, id);
      }
    }
  }
  return s;
}

function idBlock(title: string, m: Record<string, number>): string {
  const entries = Object.entries(m).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (entries.length === 0) return `${title}: (none)`;
  return `${title}:\n${entries.map(([id, n]) => `  ${id}: ${n}`).join("\n")}`;
}

/** A compact, human-readable report. Descriptive only; sets no threshold and passes no judgement. */
export function formatShadowSummary(s: ShadowSummary, source?: string): string {
  const N = s.comparable;
  const agree = (d: ShadowDimension) => `  ${d.padEnd(16)} agree ${s.agree[d]}/${N}`;
  const skips = Object.entries(s.skips).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return [
    `e1_shadow summary${source ? ` over ${source}` : ""}`,
    `comparable turns: ${N}`,
    ...DIMENSIONS.map(agree),
    s.malformed ? `unparsed e1_shadow lines: ${s.malformed}` : null,
    `skips/failures:${skips.length ? "" : " (none)"}`,
    ...skips.map(([r, n]) => `  ${r}: ${n}`),
    idBlock("only_L ids (legacy-only: usually a local .claude/rules rule or a stale cache)", s.onlyLegacy),
    idBlock("only_C ids (canonical-only: usually the cache behind the governed bundle)", s.onlyCanonical),
  ]
    .filter((x): x is string => x !== null)
    .join("\n");
}
