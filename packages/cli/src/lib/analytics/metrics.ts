// The North Star metric family (spec §5, INV-METRIC-DEFINITION-1). The review
// killed the single ambiguous "Evidence Utilization Rate" and replaced it with
// four metrics that are DEFINED SEPARATELY and never collapsed into one number:
//
//   Injection Utilization Rate    injects referenced / injects with offered>0
//                                 the wall metric: did the injection land at all
//                                 DECIDED windows only (F4, 2026-08-08): see below
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
//
// F4 (2026-08-08), CENSORING. Three outcomes mean "the opportunity was never
// observed", and none of them is evidence of a miss:
//
//   no_opportunity  the inject landed on the session's final turn (already censored
//                   since ce081439: "the agent never had a turn is not a missed use")
//   pending         the window is still open; the correlator has not ruled yet
//   unknown         the deadline passed on a session that may still be alive
//
// `unknown` keeps its own denominator (Unknown Coverage) because it is a CLOSED
// window with an inconclusive verdict, and measuring how often we cannot classify is
// the whole point of that term. `pending` and `no_opportunity` are not closed at all,
// so they are censored out of every rate.
//
// The bug this fixes: a still-open window entered `injection_utilization`'s
// denominator with `referenced: false`, which is arithmetically identical to scoring
// it a miss. The session that produced this change had ONE inject and ZERO outcomes
// and the dashboard read "0% referenced" -- an assertion about an opportunity nobody
// had observed. The honest reading of an entirely-unresolved window is `null`.
//
// This is the rule `no_opportunity` already carried, extended to the other unobserved
// class, so it EXTENDS the governed direction of notes/20260607 §7.4 rather than
// reversing it. INV-LOCAL-STATS-2's two surviving claims still hold exactly: a pending
// inject is never dropped from the report, and never counted `ignored`.

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
  // F4: the censored population, named. `unresolved` = pending + no_opportunity: the
  // windows whose opportunity was never observed and which are therefore in NO rate
  // denominator. Reported beside every rate so the sample size behind it is legible
  // and a rate over two decided windows can never be mistaken for a rate over twenty.
  // Deliberately NOT a rate itself: "how much we could not measure" is a count.
  unresolved: number;
  closed_windows: number; // used + ignored + unknown (pending is open; no_opportunity is excluded)
}

export function computeMetrics(inputs: MetricInput[]): MetricFamily {
  // The DECIDED population. `no_opportunity` (the inject landed on the session's LAST
  // turn) and `pending` (the window is still open) both mean the opportunity was never
  // observed, so neither is a missed use. Both are excluded from every rate denominator
  // and reported as standalone side counts, so neither can drag down a utilization or
  // precision rate. See the F4 block at the top of this file for why `unknown` is NOT
  // in this list.
  const scored = inputs.filter((i) => i.outcome !== "no_opportunity" && i.outcome !== "pending");

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
    unresolved: pending + noOpportunity,
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

// M1 (2026-08-08). The two "Utilization" labels below were renamed. "Utilization" says the
// evidence was USED; the numerator is `referenced`, which is an explicit pull, citation or
// open aimed at an offered id. Those are different claims, and the gap is not academic: an
// agent that opens a note to reject it counts in the numerator, and an agent that reads an
// injected snippet inline and changes course does not.
//
// The FIELD names (`injection_utilization`, `evidence_item_utilization`) are unchanged, so
// no stored series, JSON consumer or test fixture moves. Only the human-facing string does,
// which is where the over-claim was being made.
export const EVIDENCE_ITEM_REFERENCE_RATE_LABEL = "Evidence Item Reference Rate";

// The dashboard label for injection_utilization. Renamed from "Injection
// Utilization" 2026-08-06: the metric counts PROACTIVE PUSHES ONLY, and the
// unqualified name read as "how much of mla's evidence gets used" while being
// structurally blind to the agent's own retrieve_knowledge calls -- which, measured
// over a real session, were where all the value came from. A metric that omits the
// channel doing the work must say so in its name; the pull half is reported beside
// it (analytics/pull.ts) and the two are never merged.
export const PROACTIVE_INJECTION_UTILIZATION_LABEL = "Proactive Injection Reference Rate";
