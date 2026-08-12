// F1's OWN instrument, and the reason it needs one.
//
// The proposal (§7) proposed to judge F1 by Proactive Injection Utilization: 50 pointers
// fired, and if utilization has not cleared 15% the moment-of-need hypothesis is wrong.
// Code inspection says that criterion decides nothing, and it fails in BOTH of the ways
// a self-invalidating metric can fail.
//
// IT CANNOT SEE F1 SUCCEEDING. `injection_utilization`'s numerator is `referenced`
// (metrics.ts), and `referenced` is `pulled_within_window || report_cited`
// (envelope.ts EvidenceOutcomePayload; turn-recap.ts computes exactly
// `overlap(offered, [...pulled, ...cited])`). F1's designed success is the agent reading
// the resurfaced excerpt and STOPPING -- which pulls nothing and cites nothing -- or
// opening the named file, and `opened_source_ids` is deliberately kept OUT of
// `referenced_source_ids` so the historical series stays comparable. Both of F1's
// success modes score zero on the metric that was going to decide its fate.
//
// IT CAN MANUFACTURE F1 SUCCEEDING. If a pointer prompts the agent to call an evidence
// tool on the id the pointer named, `pulled_within_window` fires and utilization rises.
// That is mla telling the agent to do the thing mla grades itself on, and it is
// indistinguishable, in the metric, from the agent having found the evidence useful on
// its own.
//
// THE CORRECTION, which is what this module is:
//   1. F1 is scored on ENGAGEMENT (pulled | cited | opened), not on `referenced`, so the
//      quiet success mode is visible at all.
//   2. Engagement with an id that a pointer named THIS TURN is attributed to the
//      POINTER, and is reported separately from the turn-start injection's own rate, so
//      F1 can never inflate the number it exists to move.
//   3. The kill criterion reads `pointer_engagement_rate` over `pointer_fires`. Same
//      spirit as the proposal's (does the mechanism change behaviour?), on a
//      denominator and numerator that can actually answer it.
//
// This is telemetry. Nothing here gates, ranks, or trains.

import { PointerFire } from "../evidence-pointer";
import { normId } from "./followthrough";

/** The engagement signals a turn recap observed, narrowed to what this module needs. */
export interface TurnEngagement {
  session_id: string;
  turn_index: number;
  /** offered ids the agent pulled or cited (the historical `referenced` set). */
  referenced_source_ids: string[];
  /** offered ids whose file the agent opened. */
  opened_source_ids: string[];
}

export interface PointerOutcome {
  /** Pointers actually shown to the agent. */
  fires: number;
  /** Distinct (turn, id) pairs a pointer named. The rate's denominator. */
  pointed: number;
  /** Of those, how many the agent then engaged with in the same turn. */
  engaged: number;
  /** engaged / pointed, or null when nothing has been pointed at yet. */
  engagement_rate: number | null;
  /**
   * Engagement that is attributable to a POINTER rather than to the turn-start inject.
   * Subtract this before quoting a proactive-injection number, or F1 is grading itself.
   */
  attributed_source_ids: string[];
}

/**
 * Score the pointer mechanism against what the agent did afterwards.
 *
 * Attribution is deliberately COARSE and deliberately generous to the null hypothesis:
 * any engagement with a pointed-at id, in the turn the pointer fired, counts as
 * attributable. It cannot distinguish "engaged because of the pointer" from "was going
 * to engage anyway", so it OVER-attributes to F1 -- which is the safe direction, because
 * the number's job is to be SUBTRACTED from the injection rate. Over-subtracting
 * understates mla; under-subtracting would let mla take credit for its own prompting.
 */
export function scorePointerOutcomes(
  fires: PointerFire[],
  engagements: TurnEngagement[],
): PointerOutcome {
  const engagedByTurn = new Map<string, Set<string>>();
  for (const e of engagements) {
    const key = `${e.session_id} ${e.turn_index}`;
    const set = engagedByTurn.get(key) ?? new Set<string>();
    for (const id of [...e.referenced_source_ids, ...e.opened_source_ids]) set.add(normId(id));
    engagedByTurn.set(key, set);
  }

  // Deduped by (turn, id): two pointers at the same document in one turn are one
  // opportunity, not two, and counting them twice would let a chatty matcher move the
  // rate without changing a single behaviour.
  const pointed = new Map<string, { key: string; id: string }>();
  for (const f of fires) {
    const key = `${f.session_id} ${f.turn_index}`;
    const id = normId(f.source_id);
    pointed.set(`${key} ${id}`, { key, id });
  }

  const attributed: string[] = [];
  for (const { key, id } of pointed.values()) {
    if (engagedByTurn.get(key)?.has(id)) attributed.push(id);
  }

  return {
    fires: fires.length,
    pointed: pointed.size,
    engaged: attributed.length,
    engagement_rate: pointed.size ? attributed.length / pointed.size : null,
    attributed_source_ids: Array.from(new Set(attributed)),
  };
}

/**
 * The proposal's kill criterion, restated on a denominator that can answer it.
 *
 * Unchanged in spirit: 50 fires is still the sample, and a mechanism that fires 50 times
 * without moving behaviour is still removed rather than tuned. What changed is WHAT is
 * measured, because the original reading could neither see F1 working nor avoid
 * rewarding F1 for its own output.
 */
export const POINTER_KILL_MIN_FIRES = 50;
export const POINTER_KILL_MIN_ENGAGEMENT = 0.15;

export type PointerVerdict = "undecided" | "keep" | "remove";

export function pointerVerdict(o: PointerOutcome): PointerVerdict {
  if (o.pointed < POINTER_KILL_MIN_FIRES) return "undecided";
  if ((o.engagement_rate ?? 0) >= POINTER_KILL_MIN_ENGAGEMENT) return "keep";
  return "remove";
}

/**
 * Assemble the engagement rows for exactly the turns a pointer fired on.
 *
 * Deliberately NOT `computeTurnRecap` per turn: that reader parses the whole of
 * ask-traces.jsonl (35MB and growing) on every call, and it would be called once per
 * turn with a fire. Everything needed here is in three small spools, read once, and the
 * only ids that matter are the ones a pointer already named.
 */
export function buildPointerEngagements(
  fires: PointerFire[],
  spools: {
    mcpCalls: { session_id: string; turn_index: number; evidence_tool: boolean; source_ids: string[] }[];
    citations: { session_id: string; turn_index: number; source_ids: string[] }[];
    /** (session, turn) -> the absolute paths the agent Read that turn. */
    readsByTurn: Map<string, string[]>;
    /** The shared "does this read path name this id?" rule (turn-recap's matchOpenedIds). */
    matchOpened: (offered: string[], paths: string[]) => string[];
  },
): TurnEngagement[] {
  const turns = new Map<string, TurnEngagement>();
  for (const f of fires) {
    const key = `${f.session_id} ${f.turn_index}`;
    if (!turns.has(key)) {
      turns.set(key, {
        session_id: f.session_id,
        turn_index: f.turn_index,
        referenced_source_ids: [],
        opened_source_ids: [],
      });
    }
  }
  for (const [key, t] of turns) {
    const pointedHere = fires.filter((f) => `${f.session_id} ${f.turn_index}` === key).map((f) => f.source_id);
    const pulled: string[] = [];
    for (const c of spools.mcpCalls) {
      if (c.session_id !== t.session_id || c.turn_index !== t.turn_index || !c.evidence_tool) continue;
      pulled.push(...c.source_ids);
    }
    for (const r of spools.citations) {
      if (r.session_id !== t.session_id || r.turn_index !== t.turn_index) continue;
      pulled.push(...r.source_ids);
    }
    const pulledNorm = new Set(pulled.map(normId));
    t.referenced_source_ids = pointedHere.filter((id) => pulledNorm.has(normId(id)));
    t.opened_source_ids = spools.matchOpened(pointedHere, spools.readsByTurn.get(key) ?? []);
  }
  return Array.from(turns.values());
}

/**
 * The Proactive Injection reference count with F1's own contribution REMOVED.
 *
 * Called with a turn's referenced ids and the ids a pointer named that turn; returns
 * only the ids the agent reached for WITHOUT being told to. A caller that skips this is
 * quoting a number mla partly produced.
 */
export function referencedWithoutPointerCredit(
  referencedSourceIds: string[],
  pointedSourceIds: string[],
): string[] {
  const pointed = new Set(pointedSourceIds.map(normId));
  return referencedSourceIds.filter((id) => !pointed.has(normId(id)));
}
