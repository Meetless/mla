// D0 SHADOW: run the canonical `POST /v1/query` beside the legacy Ask and compare.
//
// LEGACY IS AUTHORITATIVE AND STAYS THAT WAY. The shadow fires AFTER the real answer has
// been rendered, its result is never shown to the operator, and every failure is swallowed.
// A shadow that can change what the user sees is not a shadow.
//
// WHAT IT IS ACTUALLY COMPARING, and it is deliberately narrow: the GOVERNED EVIDENCE. The
// prose differs run to run for reasons that have nothing to do with the contract, so diffing
// answers would produce a permanent stream of false alarms that teaches everyone to ignore
// the log. Citations are the thing D0 promised to preserve.
//
// ONE `same=false` IS NOT A REGRESSION, AND THE MEASUREMENT SAYS SO. The two paths are two
// SEPARATE Ask invocations over a model-led retrieval loop. Measured 2026-08-20 on one
// question: three consecutive LEGACY runs returned an identical 4 documents, while four
// consecutive CANONICAL runs returned 3, 0, 0 and 5. The variance is in the loop, not in
// the contract, and it is present on both sides.
//
// So this reports `overlap`, not just `same`. Zero overlap on a question that returned
// evidence is worth looking at; four of five shared is the loop. A single line cannot tell
// you which, and pretending otherwise would produce the false-alarm stream this comparison
// was narrowed to avoid.
//
// IT COSTS A SECOND ASK. That is what a shadow is, and it is why this runs only on the
// deliberate, human-initiated `mla ask` and NOT on the per-prompt enrich path, which is
// orders of magnitude higher volume. Off by default is not the same as unmeasured: set
// MEETLESS_D0_SHADOW=1 to turn it on, and the dogfood machine does.
import { randomUUID } from "node:crypto";
import { egressFetch } from "./egress/fetch";

/**
 * Canonical citation refs from the LEGACY answer, sorted.
 *
 * TWO SHAPES, MEASURED. The first version of this read `result.citations`, which is intel's
 * raw `AskResponse` field, and got zero every time: `mla ask` does not return intel's
 * response. It returns ask-core's reshaping of it, `{ answer, confidence, mode, results,
 * warnings }`, where each `results[]` entry carries `path` / `docType` and no citation
 * object at all. The shadow's first live run reported `same=false legacy=0 canonical=1`,
 * which looked exactly like a contract regression and was a defect in this function.
 *
 * So both are read: `results[]` is what the CLI produces, `citations[]` is what a direct
 * intel caller produces, and a shadow that only understood one of them would report a
 * permanent false divergence for the other.
 */
function legacyRefs(result: unknown): string[] {
  const out: string[] = [];
  const r = result as { citations?: unknown[]; results?: unknown[] } | null;

  // ask-core's shape: one entry per retrieved document, keyed by `path` for a note.
  for (const raw of Array.isArray(r?.results) ? r.results : []) {
    const item = raw as Record<string, unknown>;
    if (typeof item.path === "string" && item.path) out.push(`NT:${item.path}`);
    else if (typeof item.caseId === "string" && item.caseId) out.push(`CC:${item.caseId}`);
    else if (typeof item.threadId === "string" && item.threadId) out.push(`TH:${item.threadId}`);
  }

  // intel's raw shape, for a caller that hits `/v1/ask` directly.
  for (const raw of Array.isArray(r?.citations) ? r.citations : []) {
    const c = raw as Record<string, unknown>;
    if (typeof c.note_path === "string" && c.note_path) out.push(`NT:${c.note_path}`);
    else if (typeof c.diff_id === "string" && c.diff_id) out.push(`CC:${c.diff_id}`);
    else if (typeof c.thread_id === "string" && c.thread_id) out.push(`TH:${c.thread_id}`);
    else if (typeof c.channel_id === "string" && typeof c.thread_ts === "string")
      out.push(`TH:${c.channel_id}:${c.thread_ts}`);
  }

  return [...new Set(out)].sort();
}

function canonicalRefs(body: unknown): string[] {
  const citations = (body as { citations?: unknown[] } | null)?.citations;
  if (!Array.isArray(citations)) return [];
  return citations
    .map((c) => (c as { ref?: unknown }).ref)
    .filter((r): r is string => typeof r === "string" && r.length > 0)
    .sort();
}

export interface ShadowComparison {
  ran: boolean;
  /** Why it did not run, when it did not. Never a silent no-op. */
  skipped?: string;
  status?: number;
  legacy?: string[];
  canonical?: string[];
  /** The two evidence sets are identical. Necessary for D0, and NOT sufficient evidence of a regression when false. */
  same?: boolean;
  /** How many refs both sides retrieved. The number that separates a real divergence from loop variance. */
  overlap?: number;
  onlyLegacy?: string[];
  onlyCanonical?: string[];
  error?: string;
}

export function compareEvidence(legacyResult: unknown, canonicalBody: unknown): ShadowComparison {
  const legacy = legacyRefs(legacyResult);
  const canonical = canonicalRefs(canonicalBody);
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

export interface ShadowOptions {
  platformUrl: string | undefined;
  accessToken: string | undefined;
  question: string;
  legacyResult: unknown;
  enabled: boolean;
}

/**
 * Fire the canonical path and compare. NEVER throws.
 *
 * The user token is what the tier expects: the shadow is a real `/v1/query` call by the same
 * human, which is the point. Under a shared-key CLI there is no user token and no shadow;
 * reported as a skip rather than an error, because "not applicable" and "broken" are
 * different facts and a skip counted as a failure would hide a real one.
 */
export async function runQueryShadow(opts: ShadowOptions): Promise<ShadowComparison> {
  if (!opts.enabled) return { ran: false, skipped: "disabled" };
  if (!opts.platformUrl) return { ran: false, skipped: "no MEETLESS_PLATFORM_URL" };
  if (!opts.accessToken) return { ran: false, skipped: "no user token (shared-key CLI)" };

  try {
    const res = await egressFetch("control", `${opts.platformUrl.replace(/\/+$/, "")}/v1/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${opts.accessToken}` },
      // A fresh per-call key: the shadow is an independent canonical run beside the legacy Ask
      // (the comparison needs its own answer, not a dedup onto the legacy submission), which is
      // exactly what happened before idempotencyKey was required and intel minted the id itself.
      body: { question: opts.question, idempotencyKey: randomUUID() },
    });
    const text = await res.text();
    if (!res.ok) return { ran: false, skipped: `canonical HTTP ${res.status}`, status: res.status };
    const parsed = JSON.parse(text) as unknown;
    return { ...compareEvidence(opts.legacyResult, parsed), status: res.status };
  } catch (e) {
    // Swallowed on purpose. A shadow that can fail a real ask is worse than no shadow.
    return { ran: false, error: (e as Error).message?.slice(0, 200) };
  }
}

/** One stderr line. Machine-greppable, and never on stdout, which scripts parse as JSON. */
export function formatShadow(cmp: ShadowComparison): string {
  if (!cmp.ran) return `d0_shadow skipped=${cmp.skipped ?? "error"}${cmp.error ? ` error=${cmp.error}` : ""}`;
  return (
    `d0_shadow same=${cmp.same} overlap=${cmp.overlap ?? 0} ` +
    `legacy=${cmp.legacy?.length ?? 0} canonical=${cmp.canonical?.length ?? 0}` +
    (cmp.same ? "" : ` only_legacy=[${cmp.onlyLegacy?.join(",")}] only_canonical=[${cmp.onlyCanonical?.join(",")}]`)
  );
}
