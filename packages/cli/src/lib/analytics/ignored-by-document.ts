// F6: consume the IGNORED signal, per DOCUMENT.
//
// `IGNORED` is already computed for every inject window. Today it is spent on a per-turn
// footer and then discarded, so a document that has been pushed into fifteen turns and
// never once engaged with is indistinguishable, in every surface we have, from one that
// was pushed once yesterday.
//
// TELEMETRY ONLY, and that boundary is the whole design, not a phase.
//
// Ignored is a WEAK negative and it is weak in a specific way: an agent can ignore
// evidence it did not need, evidence that arrived before the question formed (which is
// the measured failure F1 exists for), or evidence it read inline and never referenced.
// Every one of those looks identical here. The same trap was already walked into once
// with the agent-proxy `not_useful` rating, so this is a CANDIDATE negative for a human
// to look at, never a training label and never a ranking input.
//
// Concretely, this module:
//   - returns counts, nothing else. No score, no weight, no penalty, no ordering key
//     that anything downstream consumes.
//   - has no writer. It derives from inject/outcome rows the dashboard already reads,
//     so there is no new store, no new event, and no new lifecycle state.
//
// The number it exists to produce is "this document has been offered N times and
// engaged with zero times", which is a question for a human about the CORPUS (is this
// note mis-ranked, or is it simply not useful?), not an instruction to the ranker.

import { normId } from "./followthrough";

export interface DocumentOfferRecord {
  /** The ids this inject offered. */
  offered_source_ids: string[];
  /** The ids the agent then referenced, or [] when the window closed unreferenced. */
  referenced_source_ids: string[];
  /**
   * Whether the window CLOSED. An inject still pending, or one that landed on the
   * session's last turn (`no_opportunity`), proves nothing about the document and is
   * excluded: counting it would manufacture ignored-ness out of a window that never
   * had a chance to close.
   */
  decided: boolean;
}

export interface IgnoredDocument {
  source_id: string;
  offered: number;
  referenced: number;
}

/**
 * Documents offered at least `minOffers` times across DECIDED windows and never once
 * referenced.
 *
 * `minOffers` exists because one unreferenced offer is not a signal about anything; the
 * interesting shape is repetition. Default 3: below that the list fills with documents
 * that were simply new.
 */
export function ignoredDocuments(
  records: DocumentOfferRecord[],
  minOffers = 3,
): IgnoredDocument[] {
  const offered = new Map<string, { id: string; offered: number; referenced: number }>();
  for (const r of records) {
    if (!r.decided) continue;
    const referencedHere = new Set(r.referenced_source_ids.map(normId));
    // Deduped WITHIN one inject: a document offered twice in one payload is one offer.
    for (const id of new Set(r.offered_source_ids.map((s) => normId(s)))) {
      const original = r.offered_source_ids.find((s) => normId(s) === id) ?? id;
      const row = offered.get(id) ?? { id: original, offered: 0, referenced: 0 };
      row.offered += 1;
      if (referencedHere.has(id)) row.referenced += 1;
      offered.set(id, row);
    }
  }
  return Array.from(offered.values())
    .filter((r) => r.referenced === 0 && r.offered >= minOffers)
    .map((r) => ({ source_id: r.id, offered: r.offered, referenced: r.referenced }))
    .sort((a, b) => b.offered - a.offered || a.source_id.localeCompare(b.source_id));
}
