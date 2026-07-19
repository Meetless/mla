// The North Star metric family (spec §5, INV-METRIC-DEFINITION-1). The review
// killed the single ambiguous "Evidence Utilization Rate" and replaced it with
// four metrics that are DEFINED SEPARATELY and never collapsed into one number:
//
//   Injection Utilization Rate    injects referenced / injects with offered>0
//                                 the wall metric: did the injection land at all
//   Evidence Item Utilization     distinct referenced ids / distinct offered ids
//                                 the drilldown: did the offered DOCS get used
//   Reference follow-through (v1) used / (used + ignored)
//                                 v1 used:=referenced, so this is a reference-
//                                 followthrough proxy, NOT material use. The
//                                 dashboard MUST label it "Reference follow-through
//                                 (v1)", never "Inject Precision" and no longer
//                                 "Reference Precision" (§4.2, rollout step 4 §13).
//   Unknown Coverage              unknown / closed inject windows
//                                 the honesty term: how often we could not classify
//
// Injection Utilization can read 100% while Evidence Item Utilization reads 18%
// (a 10-doc inject where one doc was used is a utilized injection but a 1-in-10
// item rate). Both are true; they answer different questions; they render side by
// side, never merged.

import { InjectOutcome } from "./envelope";
import { normId } from "./followthrough";

// One evaluated inject: its offered evidence plus the correlator's verdict. The
// caller assembles this by joining an mla_evidence_inject line with its
// mla_evidence_outcome (or outcome=pending when the window is still open).
export interface MetricInput {
  evidence_offered: number;
  offered_source_ids: string[];
  referenced: boolean;
  referenced_source_ids: string[];
  outcome: InjectOutcome;
}

export interface MetricFamily {
  // The wall metric. null when no inject offered anything (denominator zero).
  injection_utilization: number | null;
  // The drilldown over distinct source ids. null when nothing was offered.
  evidence_item_utilization: number | null;
  // v1 reference-followthrough precision. null when no window has closed with a
  // used/ignored verdict.
  reference_precision_v1: number | null;
  // The honesty term. null when no inject window has closed yet.
  unknown_coverage: number | null;

  // The raw counts behind the rates, so the dashboard and tests can show the
  // fractions, never just the percentages.
  injects_offered: number; // injects with evidence_offered > 0
  injects_referenced: number; // of those, how many were referenced
  distinct_offered: number;
  distinct_referenced: number;
  used: number;
  ignored: number;
  unknown: number;
  no_opportunity: number; // inject landed on the session's final turn (agent never had a turn)
  pending: number;
  closed_windows: number; // used + ignored + unknown (pending is open; no_opportunity is excluded)
}

export function computeMetrics(inputs: MetricInput[]): MetricFamily {
  // `no_opportunity` (the inject landed on the session's LAST turn) is NOT a missed
  // use: the agent never got a turn to act on the evidence. It is excluded from every
  // rate denominator and reported as a standalone side count, so it can never drag
  // down a utilization or precision rate.
  const scored = inputs.filter((i) => i.outcome !== "no_opportunity");

  // Injection Utilization: only injects that actually offered evidence count in
  // the denominator (a zero-result inject is a coverage gap, not a missed use).
  const offeredInjects = scored.filter((i) => i.evidence_offered > 0);
  const referencedInjects = offeredInjects.filter((i) => i.referenced);

  // Evidence Item Utilization: distinct source ids, normalized by the SAME rule
  // the join uses so "NT:foo.md" and "NT:foo" collapse on both sides. no_opportunity
  // injects are skipped here too: their offered docs had no turn to be used.
  const distinctOffered = new Set<string>();
  const distinctReferenced = new Set<string>();
  for (const i of scored) {
    for (const id of i.offered_source_ids) distinctOffered.add(normId(id));
    for (const id of i.referenced_source_ids) distinctReferenced.add(normId(id));
  }

  let used = 0;
  let ignored = 0;
  let unknown = 0;
  let noOpportunity = 0;
  let pending = 0;
  for (const i of inputs) {
    if (i.outcome === "used") used++;
    else if (i.outcome === "ignored") ignored++;
    else if (i.outcome === "unknown") unknown++;
    else if (i.outcome === "no_opportunity") noOpportunity++;
    else if (i.outcome === "pending") pending++;
  }
  const closedWindows = used + ignored + unknown;

  return {
    injection_utilization: offeredInjects.length
      ? referencedInjects.length / offeredInjects.length
      : null,
    evidence_item_utilization: distinctOffered.size
      ? distinctReferenced.size / distinctOffered.size
      : null,
    reference_precision_v1: used + ignored ? used / (used + ignored) : null,
    unknown_coverage: closedWindows ? unknown / closedWindows : null,

    injects_offered: offeredInjects.length,
    injects_referenced: referencedInjects.length,
    distinct_offered: distinctOffered.size,
    distinct_referenced: distinctReferenced.size,
    used,
    ignored,
    unknown,
    no_opportunity: noOpportunity,
    pending,
    closed_windows: closedWindows,
  };
}

// The v1 dashboard label for reference_precision_v1. Centralized so every render
// path (mla stats, mla adoption) shows the same honest wording (§4.2). Relabeled
// from "Reference Precision (v1)" to "Reference follow-through (v1)" as the
// material-incorporation correlator rollout step 4 (§13): the deterministic
// number now reads over the full all_decided population (referenced / all_decided)
// and its name no longer over-claims "precision".
export const REFERENCE_PRECISION_V1_LABEL = "Reference follow-through (v1)";
