// Per-turn assist recap (Layer A of notes/20260609-mla-per-turn-assist-recap-plan.md).
//
// The session-level `mla stats` / `mla adoption` reader answers "across this
// session, how often was injected evidence used?" This module is the per-TURN
// analog: for one (session_id, turn_index) it answers the two operator questions
// An asked for at the end of every turn:
//
//   liveness   -- did mla run this turn, or silently not fire? (ran / not_run_reason)
//   usefulness -- if it offered evidence, was the evidence pulled or cited, or
//                 ignored? (verdict USED / IGNORED / NO_OFFER / NOT_RUN)
//
// It reuses the SAME three local spool files and the SAME overlap math as the
// followthrough reader (INV-ADOPTION-SOURCE-1) so a per-turn USED is exactly the
// per-turn instance of the session-level A1c. The only new parse is a single-turn
// ask-traces reader; mcp-calls and report-citations go through followthrough's
// parsers unchanged. Window is 0 (same turn): this is computed at Stop, when all
// of the turn's pulls (written during the turn) and citations (written by stop.sh
// moments earlier) are already on disk, so the cross-turn window the session
// reader needs does not apply here.

import { readLogJsonl } from "./logs";
import { renderFloorDelta, type FloorDelta } from "../scanner/floor-delta";
import { overlap, parseMcpCalls, parseReportCitations } from "./followthrough";
import { parsePointerFires, type PointerFire } from "../evidence-pointer";

// The stored verdict. `IGNORED` is a WIRE SPELLING, not a finding: it means "mla offered
// evidence and no engagement with it was observed this turn", which is a statement about
// our instrument, never about the agent's mind.
//
// Why the misleading name survives: intel pins Literal["USED","IGNORED","NO_OFFER","NOT_RUN"]
// on POST /v1/observability/turn-recap (observability.py), so renaming the member is a
// coordinated CLI+intel deploy in exchange for zero behaviour change, and a newer CLI would
// 422 against a running prod intel in the meantime. The rendering is where the claim is made
// to a human, so that is where it was fixed: every surface now reports the OBSERVATION on
// both arms ("explicit evidence reference observed" / "no explicit evidence reference
// observed"), never the outcome. `USED` is just as much a wire spelling as `IGNORED`.
export type Verdict = "USED" | "IGNORED" | "NO_OFFER" | "NOT_RUN";

// Why mla wrote a liveness row instead of an enrich row for a turn.
//
// The last four are new, and each one closes a path that used to write NOTHING.
// Session 5734f9de left 6 rows for 8 turns; the two absentees were
// `<task-notification>` wake-ups that hit a silent early return. A missing row is
// not readable as "skipped" -- it is byte-identical to a crash, a kill, or mla not
// being installed -- so every rate computed over the log was silently conditioned
// on "turns that happened to reach the writer". These reasons make the skip
// falsifiable. See the exit-path table in test/lib/hook-trace-completeness.spec.ts.
export type NotRunReason =
  | "muted"
  | "not_activated"
  | "suppressed"
  | "timeout"
  | "error"
  | "empty_prompt"
  | "harness_event"
  | "delivery_failed"
  | "cancelled";

// The Item 4 discriminator: when mla ran but offered nothing, WHY. intel already
// classified the reason (enrich_no_offer.py) and rides it back on the enrich
// trace; this collapses that taxonomy into the one distinction An asked for:
// "correctly abstained" vs "should have matched but didn't" vs "the seam failed".
//   correct_abstain:     there was nothing to offer (zero_candidates) or a
//                        deliberate safe abstain (unresolved_conflict,
//                        primary_surface_no_offer).
//   should_have_matched: candidates existed but the score floor / cap dropped
//                        them all (all_failed_relevance). THIS is the
//                        recall/ranking debt.
//   not_routed:          the intent router declined to route the prompt at all
//                        (router_low_confidence), so retrieval never ran and no
//                        candidate ever existed. Also recall debt, but ROUTER
//                        recall, and it is fixed in a different place.
//   provider_failure:    a surface was degraded or the budget was blown
//                        (surface_provider_missing, over_budget); not a recall
//                        gap, a plumbing gap.
//
// WHY not_routed IS ITS OWN CLASS (2026-07-27 pulse):
// router_low_confidence used to land in should_have_matched, which contradicted
// this file's own definition of that class (see retrieved_count below: "retrieved>0
// && selected==0 is the should-have-matched signature"). intel emits
// router_low_confidence from intent_router.py's final "Nothing matched. Do NOT
// guess (P0): abstain" branch, at confidence 0.0 and BEFORE any retrieval call, so
// retrieved_count is structurally 0 and no candidate was ever dropped.
//
// It was not a rounding error. intel's router enables exactly one live surface
// (governed_kb, on narrow explicit governed phrasing) and abstains on everything
// else by design, so every ordinary coding prompt lands here. Measured over 62
// production turns: 58 were labelled should_have_matched, all 62 with
// retrieved_count 0. The recall-debt gauge read ~94% purely by construction, which
// is worse than no gauge: it buries the real all_failed_relevance misses in noise
// the router is supposed to produce. Splitting the class keeps both numbers
// readable and points each at the code that owns it.
// TWO MORE MEMBERS, and neither comes from intel's reason (2026-08-10 owner ruling).
// They are the result of applying the turn's own contrary evidence ON TOP of the
// reason-derived class, in `applyContraryEvidence`:
//   unverified_abstain: the reason said correct_abstain, and the same turn's record
//                       falsifies the "correct" half -- a successful evidence pull
//                       resolved governed material after mla declined to offer any.
//                       It is NOT a miss: proving a miss needs the pulled document to
//                       have been ELIGIBLE for the push mechanism at that moment, and
//                       this process holds no corpus facts to establish that with.
//                       The honest word is unverified.
//   missed_offer:       the same shape WITH eligibility established. Only a reader
//                       that can query the corpus (tools/mla-helpfulness/analyze.py,
//                       via `classify_hand_pulls`) can ever reach it; the member lives
//                       here so both readers share one vocabulary rather than growing
//                       two.
//
// The previous fix left the class saying `correct_abstain` and appended
// "(unverified: ...)" to the RENDERED footer only, so every machine reader -- the
// Langfuse score comment, the emitted recap, any aggregate over abstain_class -- still
// counted a falsified abstention as correct. The word had to move into the class.
export type AbstainClass = "correct_abstain" | "unverified_abstain" | "missed_offer" | "should_have_matched" | "not_routed" | "provider_failure" | null;

// intel's FULL no_offer vocabulary (models.py `NoOfferReason`), mirrored here so
// the classifier is provably total over it. Every member MUST classify to a
// non-null AbstainClass: null is reserved for "instrumentation absent" (a
// pre-trace line, or no trace at all), and a live reason landing there reads as
// "we have no idea" when in fact intel told us exactly what happened.
//
// This list exists because the classifier silently drifted from it. It handled
// six of the nine and its own comment asserted six was the whole set, so
// primary_surface_no_offer (deliberately routed, intent KNOWN, and live in the
// local spool) came back as null on a NO_OFFER turn. Mirroring the vocabulary
// turns the next divergence into a failing test instead of a silent null.
export const INTEL_NO_OFFER_REASONS = [
  "primary_surface_no_offer",
  "router_low_confidence",
  "surface_provider_missing",
  "zero_candidates",
  "all_failed_posture_freshness_supersession",
  "all_failed_relevance",
  "unresolved_conflict",
  "would_require_uncited_synthesis",
  "over_budget",
  "empty_prompt",
  // Added 2026-08-08, and the FIRST of these was already live and already drifting:
  // intel has emitted `machine_envelope` since 2026-07-31 (199 of 898 production
  // turns, 22.2%) and this mirror never grew it, so the single largest NO_OFFER
  // population recapped with abstain_class null, which is the reserved value for
  // "instrumentation absent". The list existed to catch exactly that and nothing was
  // reading it; the spec beside it now asserts both members by name.
  "machine_envelope",
  "self_echo_only",
  // Added 2026-08-10 alongside the intel member. Every candidate was dropped because
  // this session already had it: a note it wrote, or a payload it was already handed.
  // It used to arrive as all_failed_relevance, which classifies should_have_matched, so
  // a long session that had been served everything its retrieval finds booked the
  // suppression working as a stream of recall misses.
  "all_excluded_by_caller",
] as const;

export interface TurnRecap {
  session_id: string;
  turn_index: number;
  // The turn's $TRACE_ID from its ask-traces line == its Langfuse trace id (Layer D).
  trace_id: string | null;

  // Liveness (answers "did mla run this turn?")
  ran: boolean; // an ask-traces line exists for this turn
  injected_floor: boolean; // hook.injected (Layer 1 static floor landed)
  // M6: one compact clause naming the rules that joined or left the delivered floor
  // since the previous assembly, or null on the overwhelming majority of turns where
  // it did not move. Null-on-quiet is what makes its presence mean something.
  floor_delta: string | null;
  injected_evidence: boolean; // hook.layer2_injected (Layer 2 enrichment landed)

  // How much context actually entered the prompt, in MEASURED characters, or null on
  // a trace that predates the field. Characters rather than tokens on purpose: the
  // `head_tokens` in `mla_rule_injection` is ESTIMATED (`rule-meter.ts` divides bytes
  // by BYTES_PER_TOKEN), and `injected_chars` is the measured input to that estimate.
  // Reporting the measured number means the recap never asserts a precision it lacks.
  // On a layer-2 turn this covers floor AND evidence, which is the honest total: it is
  // what the model was actually handed.
  //
  // It exists because session 607da042 paid ~4,589 estimated head tokens over six turns
  // for one scoped-rule fire, and the recap said only "floor only, offered: none". An
  // invisible recurring cost is what the /value page was rebuilt to stop rendering.
  injected_chars: number | null;
  not_run_reason: NotRunReason | null;
  enrich_latency_ms: number | null;

  // Offer (what mla put in front of the agent)
  evidence_offered: boolean;
  offered_source_ids: string[];
  zero_results: boolean;
  coverage_gap_type: string | null; // why nothing was offered, if applicable

  // A NO_OFFER is honest only if you can tell "we looked, nothing matched" from
  // "we could not look because the evidence backend was down". This is true only
  // for the second case: the enrich call could not get a usable answer from intel
  // (unreachable / timed out / errored), so this NO_OFFER is a backend outage, NOT
  // a merits result. False for a merits abstain and for enrich_unauthorized (intel
  // is UP; the session just needs re-auth). See notes/20260514-dogfood-friction.md.
  evidence_layer_down: boolean;

  // A qualifier ON evidence_layer_down, never a standalone claim: the outage this
  // turn hit is OVER, because the NEXT turn reached intel. The recap the hook
  // injects describes the PREVIOUS turn, so without this the agent read
  // "⚠ evidence layer DOWN" in the present tense inside the very hook invocation
  // that had just gotten a healthy answer (70 such turns in the local spool).
  evidence_layer_recovered: boolean;

  // Enrichment instrumentation (Item 4). These come from the governed-KB enrich
  // trace intel returns; null on turns predating the trace or that never ran
  // enrich. retrieved_count is the candidate count BEFORE the score-floor/cap;
  // selected_count is how many survived to render. retrieved>0 && selected==0 is
  // the "should have matched" signature: we found candidates and dropped them all.
  retrieved_count: number | null;
  selected_count: number | null;
  // H4. See AskTrace.delivered_citations: null is UNMEASURED, [] is zero delivered.
  delivered_source_ids: string[] | null;
  abstain_class: AbstainClass;

  // Followthrough (answers "what engagement with the offer did we OBSERVE?")
  //
  // Four RAW signals, reported separately and never merged, because they are not the same
  // kind of evidence and a single "USED" that mixes an observed tool call with a text
  // heuristic is how a metric stops being evidence:
  //
  //   pulled  -- the agent called a meetless evidence tool naming the id (deterministic)
  //   cited   -- the agent's final report carried the [XX:id] marker (deterministic)
  //   opened  -- the agent Read the file the offered id names (deterministic)
  //   echoed  -- a distinctive span of the injected snippet reappeared in the agent's own
  //              output (HEURISTIC; see evidence-echo.ts)
  //
  // None of the four proves usefulness. An agent that opens a note to reject it is not
  // "helped" by it, and an agent that quotes a snippet to explain why it is obsolete has
  // echoed it without being helped. What they prove is engagement, which is the most a
  // local instrument can observe, and the field names say exactly that.
  evidence_tools_pulled: string[]; // distinct meetless evidence tools called this turn
  pull_count: number;
  // D3. Evidence pulls this turn that intel REFUSED (unreachable, a billing denial, an
  // auth failure), recovered from the transcript at Stop because Claude Code fires no
  // PostToolUse for them. Held OUT of `pull_count`: that number has meant "pulls that
  // ran" for the whole history of this log, and a refusal did not run.
  //
  // On be3cbc73 turn 1 the agent reached for governed memory twice and was refused
  // twice, and this recap said `pulled 0` -- byte-identical to a turn where it never
  // reached at all.
  pull_refused_count: number;
  referenced_source_ids: string[]; // offered ids that were pulled or cited this turn
  cited_source_ids: string[]; // ids the final answer cited

  // Every governed source id a SUCCESSFUL evidence pull resolved this turn, offered or
  // not. On a NO_OFFER turn there is nothing offered, so this is exactly "what the agent
  // had to go and get by hand" -- the falsifier for an abstention that graded itself
  // correct.
  //
  // Successful and RESOLVED are both load-bearing. A refused pull never reached the
  // corpus, and a `retrieve_knowledge` that came back empty is the corpus AGREEING with
  // the abstention; counting either as contrary evidence is how a pull COUNT (the
  // previous rule) manufactures a falsifier out of a confirmation.
  hand_pulled_source_ids: string[];

  // Offered ids whose FILE the agent opened this turn (Read of the path the id names).
  // Deterministic and local: no model, no network. This is the signal that catches the
  // ordinary case the pull/cite pair cannot see, where the agent goes straight to the
  // document mla named instead of re-fetching it through an evidence tool.
  opened_source_ids: string[];

  // Offered ids the agent explicitly TARGETED by path this turn, witnessed by the PreToolUse
  // evidence pointer (`matched_on: "path"`, read intent).
  //
  // DELIBERATELY NOT FOLDED INTO `opened_source_ids`. A pointer receipt proves the agent aimed
  // a read-intent command at the source; it does not prove a completed read, and on the turn
  // that motivated this the pointer's own text told the agent it could skip the lookup.
  // Reusing the "opened" bucket would have cost one honest field name to save one line.
  //
  // WHY IT IS ENGAGEMENT ANYWAY. The causal order is the whole argument: by the time
  // PreToolUse fires, the model has ALREADY chosen the path. The pointer is a passive witness
  // to a decision it did not influence, which is exactly what makes it upstream-clean of the
  // self-grading case `pointer-outcome.ts` exists to prevent.
  path_targeted_source_ids: string[];

  // Offered ids whose injected SNIPPET reappeared verbatim in the agent's own output.
  // Explicitly a heuristic and deliberately NOT part of engaged_source_ids: it cannot
  // distinguish "acted on this" from "quoted this to disagree with it", and a value metric
  // we report about ourselves must never be allowed to err in the flattering direction.
  // Reported so the blind spot is measurable, not so it can be scored.
  echoed_source_ids: string[];

  // The union of the DETERMINISTIC signals (pulled, cited, opened, path-targeted). This is
  // what decides USED. Kept as its own field rather than widening referenced_source_ids so
  // the older pulled-or-cited number stays comparable across the whole history of the log.
  //
  // NOTE THAT THIS UNION IS NOT HISTORICALLY STABLE, and pretending otherwise was a claim
  // this change had to retract. `referenced_source_ids` comparisons survive untouched;
  // USED/IGNORED was definitionally corrected on 2026-08-11 when path targeting was admitted.
  // The metric was wrong before, so the series is not comparable across that boundary, and
  // the honest fix is to say so once rather than to carry a metric version forever.
  engaged_source_ids: string[];

  verdict: Verdict;
}

export interface TurnRecapDeps {
  // Read one jsonl spool file under the live logs dir. Defaults to readLogJsonl so
  // the live CLI reads the same files the hook wrote; tests inject a fake.
  readLog?: (file: string) => Record<string, unknown>[];
  // M6: what moved on or off the delivered floor at the most recent assembly, or null
  // when it did not move. Defaults to reading the assembler's own delivery receipt
  // (assemble-audit.json), which the hot path writes on every turn and which is the
  // only artifact that records the previously-delivered rule set.
  readFloorDelta?: () => FloorDelta | null;
}

// --- single-turn ask-traces parse -------------------------------------------

export interface AskTrace {
  session_id: string;
  turn_index: number;
  trace_id: string | null;
  injected_floor: boolean;
  injected_evidence: boolean;
  injected_chars: number | null;
  enrich_latency_ms: number | null;
  offered_source_ids: string[];
  arb_reason: string;
  fail_open_reason: string | null;
  not_run_reason: NotRunReason | null;
  has_error: boolean;
  // From the governed-KB enrich trace the hook now persists (Item 4). Null when
  // the line predates the trace or enrich never produced one.
  retrieved_count: number | null;
  selected_count: number | null;
  primary_no_offer_reason: string | null;
  // H4. What the evidence block actually DELIVERED after the inline budget took its cut.
  // THREE STATES and they must not collapse: null is UNMEASURED (the row predates the
  // field, or no evidence block rendered), [] is "a block rendered and nothing survived",
  // and a list is what reached the model. `?? []` here would print a confident 0 for a
  // turn nobody measured, which is the reading error this field exists to end.
  delivered_citations: string[] | null;
}

function asObj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

function asStr(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function asNum(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

const NOT_RUN_REASONS: NotRunReason[] = [
  "muted",
  "not_activated",
  "suppressed",
  "timeout",
  "error",
  "empty_prompt",
  "harness_event",
  "delivery_failed",
  "cancelled",
];

function asNotRunReason(v: unknown): NotRunReason | null {
  return typeof v === "string" && (NOT_RUN_REASONS as string[]).includes(v) ? (v as NotRunReason) : null;
}

// parseAskTrace reads ONE ask-traces.jsonl line into the fields the recap needs.
// Returns null when the line cannot join (no session_id or non-numeric turn).
// The offered set mirrors parseInjectTurns: enrichment.context_items[] with
// injected===true and a non-empty source_id (the ids mla actually PUSHED).
export function parseAskTrace(line: Record<string, unknown>): AskTrace | null {
  const session_id = asStr(line.session_id);
  const turn_index = asNum(line.turn_index);
  if (!session_id || turn_index === null) return null;

  const hook = asObj(line.hook);
  const arbitration = asObj(line.arbitration);
  const enrichment = asObj(line.enrichment);

  const items = Array.isArray(enrichment.context_items) ? enrichment.context_items : [];
  const offered: string[] = [];
  for (const raw of items) {
    const item = asObj(raw);
    if (item.injected !== true) continue;
    const sid = asStr(item.source_id);
    if (sid) offered.push(sid);
  }

  const failOpen = asStr(hook.fail_open_reason);
  // The early-exit minimal line (Phase 1 §5 enabling change) names its reason
  // explicitly; accept it from hook or top-level so the writer has either home.
  const explicitReason = asNotRunReason(hook.not_run_reason) ?? asNotRunReason(line.not_run_reason);

  // The governed-KB enrich trace (Item 4). The hook writes it verbatim under
  // governed_kb_trace; old lines simply lack the key and read as all-null.
  const gkb = asObj(line.governed_kb_trace);

  return {
    session_id,
    turn_index,
    trace_id: typeof line.trace_id === "string" && line.trace_id ? line.trace_id : null,
    injected_floor: hook.injected === true,
    injected_evidence: hook.layer2_injected === true,
    // asNum returns null for a missing key, so an old trace reads unknown, never 0.
    injected_chars: asNum(hook.injected_chars),
    enrich_latency_ms: asNum(hook.enrich_latency_ms),
    offered_source_ids: Array.from(new Set(offered)),
    arb_reason: asStr(arbitration.reason),
    fail_open_reason: failOpen || null,
    not_run_reason: explicitReason,
    has_error: line.error != null,
    retrieved_count: asNum(gkb.retrieved_count),
    selected_count: asNum(gkb.selected_count),
    primary_no_offer_reason: asStr(gkb.primary_no_offer_reason) || null,
    // Array.isArray, not truthiness: `[]` is truthy, so only the array test separates
    // an explicit empty delivery from an absent field.
    delivered_citations: Array.isArray(hook.delivered_citations)
      ? hook.delivered_citations.filter((c): c is string => typeof c === "string")
      : null,
  };
}

// Why mla did not RUN (or suppressed injection) this turn. Only meaningful when
// the floor was not injected (a control, suppression, or early-exit). An explicit
// minimal-line reason wins; otherwise the injected=false control maps to
// "suppressed". An injected floor means it ran, so this is null there.
function deriveNotRunReason(t: AskTrace | null): NotRunReason | null {
  if (!t) return null; // no line at all: reason unknown
  if (t.not_run_reason) return t.not_run_reason;
  const arb = t.arb_reason.toLowerCase();
  if (arb.includes("pull_only") || arb.includes("suppress")) return "suppressed";
  if (t.fail_open_reason === "timeout") return "timeout";
  if (t.fail_open_reason === "error" || t.has_error) return "error";
  return null;
}

// Why nothing was OFFERED this turn though mla ran (floor injected, no evidence).
// Feeds the NO_OFFER footer and the session-level "coverage gaps" vocabulary.
function deriveCoverageGap(t: AskTrace): string | null {
  // Prefer intel's own classification: enrich_no_offer.py already ranked the
  // reason with a precedence the hook now persists verbatim. Old ask-traces
  // lines predate the trace and fall back to the arb/fail-open heuristic below.
  if (t.primary_no_offer_reason) return t.primary_no_offer_reason;
  const arb = t.arb_reason.toLowerCase();
  const fail = (t.fail_open_reason ?? "").toLowerCase();
  if (arb.includes("no_relevant_context")) return "no_relevant_context";
  // Auth rejection (expired/revoked CLI token) is checked before the generic
  // error so a dead session reads as "re-auth", not "enrichment failed".
  if (fail === "unauthorized" || arb.includes("unauthorized")) return "enrich_unauthorized";
  // Connection refused / DNS / network: the hook records fail_open_reason
  // "intel_down" (arb "enrichment_intel_down"). Without this branch it matched
  // NEITHER "timeout" NOR "error" and fell through to null -> "nothing relevant
  // offered", i.e. the textbook outage rendered exactly like a merits abstain.
  if (fail === "intel_down" || arb.includes("intel_down")) return "enrich_unreachable";
  if (fail === "timeout" || arb.includes("timeout")) return "enrich_timeout";
  // intel's own guard fired mid-answer. Same shape as the intel_down branch above and
  // found the same way: the hook sets fail_open_reason "stop_guard" (arb
  // "enrichment_stop_guard"), which contains none of "timeout" / "error" /
  // "unauthorized" / "intel_down", so it matched nothing and fell through to null,
  // rendering a guard trip exactly like a merits abstain. 23 rows in the local ledger.
  //
  // Deliberately NOT in EVIDENCE_DOWN_GAPS: intel is UP and it answered, so this is not
  // a backend outage and counting it as one would manufacture the phantom-recovery
  // arithmetic `intelAnswered` warns about. Naming the gap and flipping the outage flag
  // are different claims, and only the first one was missing.
  if (fail === "stop_guard" || arb.includes("stop_guard")) return "enrich_stop_guard";
  if (fail === "error" || arb.includes("error")) return "enrich_error";
  if (arb.includes("missing_token")) return "missing_token";
  return null;
}

// Map intel's no_offer_reason taxonomy to the one distinction that drives action
// (see AbstainClass). Every member of INTEL_NO_OFFER_REASONS classifies; anything
// else (the legacy arb/fail-open strings, or no trace at all) stays null, because
// we cannot honestly say whether a pre-trace NO_OFFER was a correct abstain or a
// missed match. Null here means "instrumentation absent", not "correct abstain".
// Exported for ONE reason: the hook's F2 decline block gates on the reasons that
// classify `not_routed`, and a second hand-written copy of that membership in bash
// is exactly the drift this taxonomy has already suffered twice. The guard in
// intercept-hook.spec.ts derives the set from HERE and asserts the hook covers it.
export function deriveAbstainClass(reason: string | null): AbstainClass {
  switch (reason) {
    case "zero_candidates":
    case "unresolved_conflict":
    // The router recognized the intent and policy routed it to no_offer on
    // purpose (enrich_router_plan.py:144, the intent_type != "unknown" arm). In
    // prod that is intent_type "generic_coding" at confidence 0.7, and the
    // no_offer arm is there because it WON a pre-registered trial: the governed_kb
    // arm lost B7 by 1.37x (intent_router.py). The most deliberate abstain we
    // make, and it used to fall through to null.
    case "primary_surface_no_offer":
    // Answering would require synthesis the surface cannot cite, so we abstain
    // rather than assert something uncitable. Same family as unresolved_conflict:
    // the safe choice, not a miss.
    case "would_require_uncited_synthesis":
    // Candidates existed and the posture / freshness / supersession gates dropped
    // them all. Withholding a superseded or posture-blocked doc is governance
    // working, not recall debt, so it is NOT should_have_matched. It is the one
    // correct_abstain member where retrieved_count can be > 0, which stays visible
    // because the footer renders the counts next to the class. If this ever carries
    // real volume, re-open whether a governance-withheld class earns its own name;
    // today nothing in intel emits it (declared vocabulary, zero emit sites).
    case "all_failed_posture_freshness_supersession":
    // F6: every selected item was the asking agent's own same-session exhaust, so the
    // delivery would have carried no information. Candidates existed and the provider
    // succeeded, exactly like the posture case above, which is why this belongs here
    // and NOT with all_failed_relevance: filing a deliberate precision suppression as
    // a recall miss would grow the recall dashboard a permanent phantom on the turns
    // where mla did the right thing.
    case "self_echo_only":
    // The harness re-invoked the agent and no human asked anything (a heartbeat, a
    // task notification, a scheduled run). Withholding is correct and it is 22% of
    // production turns, so it is far too large a population to leave classifying null.
    case "machine_envelope":
    // Every candidate was dropped because this session already had it: a document it
    // authored, or a payload it was already handed. Candidates existed and the provider
    // succeeded, exactly like the posture and self_echo_only cases above, and the thing
    // that dropped them is the caller's own declaration rather than a relevance gate.
    // Session cba778a7 turn 9 is the row: ten candidates, three of them banded high,
    // and it recapped should_have_matched because intel had no word for this yet.
    case "all_excluded_by_caller":
      return "correct_abstain";
    case "all_failed_relevance":
      return "should_have_matched";
    // Retrieval never ran: the router abstained before it. Distinct from
    // all_failed_relevance, which means we DID retrieve and dropped everything.
    case "router_low_confidence":
      return "not_routed";
    case "surface_provider_missing":
    case "over_budget":
    // The caller sent no prompt at all. OUR plumbing, not intel's judgement, so it
    // sits with the other failures rather than with not_routed: crediting the router
    // with a decision it never got to make is exactly what hid this for 232 prod
    // turns, where an empty prompt was byte-identical to an honest abstention.
    case "empty_prompt":
      return "provider_failure";
    default:
      return null;
  }
}

// The coverage-gap types that mean "the enrich call could not GET a usable answer
// from intel" (backend down, no response in budget, or an error body), as opposed
// to a merits abstain (intel answered and offered nothing) or enrich_unauthorized
// (intel is UP; re-auth). Only these flip evidence_layer_down.
const EVIDENCE_DOWN_GAPS = new Set(["enrich_unreachable", "enrich_timeout", "enrich_error"]);

// True only when a NO_OFFER is caused by a retrieval-backend OUTAGE, so an operator
// never mistakes "we could not look" for "we looked, nothing matched". Keyed off
// the coverage gap (not the verdict alone) so it stays null-safe on every other
// verdict, where coverage_gap_type is null.
function deriveEvidenceLayerDown(verdict: Verdict, coverageGap: string | null): boolean {
  return verdict === "NO_OFFER" && coverageGap != null && EVIDENCE_DOWN_GAPS.has(coverageGap);
}

/**
 * Apply the turn's own contrary evidence to a reason-derived abstain class.
 *
 * `correct_abstain` is derived ENTIRELY from intel's no_offer reason, so on its own it
 * is a DECISION wearing the name of an OUTCOME: the turn that decided not to offer is
 * also the turn that grades the non-offer correct. When the same turn's record shows a
 * successful evidence pull that RESOLVED governed material, the "correct" half is
 * falsified and the class must stop saying it.
 *
 * What this does NOT do is claim a miss. `missed_offer` requires the pulled document to
 * have been eligible for the push mechanism at that moment, which is a corpus fact this
 * process does not hold. Uncertainty is preserved instead of manufacturing either a win
 * or a miss; the analyzer, which can query the corpus, resolves the rest.
 *
 * Scoped to correct_abstain on purpose: not_routed, should_have_matched and
 * provider_failure never claimed correctness, so there is nothing to walk back.
 */
export function applyContraryEvidence(base: AbstainClass, handPulled: string[]): AbstainClass {
  if (base !== "correct_abstain") return base;
  return handPulled.length > 0 ? "unverified_abstain" : base;
}

// Did intel demonstrably ANSWER on this turn? Two proofs, either sufficient:
// evidence came back injected, or an enrich trace rode home with the response.
// A governed no-offer still proves reachability (intel replied "nothing to
// offer"), which is why the second proof is not redundant. Deliberately NOT
// "the next turn did not fail the same way": a turn that failed for another
// reason (stop_guard, muted, unauthorized) proves nothing about the backend,
// and treating it as healthy is what manufactured 160 phantom recoveries in
// the first measurement of this defect.
function intelAnswered(t: AskTrace): boolean {
  if (t.injected_evidence) return true;
  return t.retrieved_count != null || t.selected_count != null || t.primary_no_offer_reason != null;
}

// --- the read side: which offered FILE did the agent open? -------------------

// One markdown Read the agent performed, as post-tool-use.sh spools it locally to
// file-reads.jsonl. Metadata only: a path, never content.
export interface FileRead {
  session_id: string;
  turn_index: number;
  path: string;
}

export function parseFileReads(lines: Record<string, unknown>[]): FileRead[] {
  const out: FileRead[] = [];
  for (const line of lines) {
    const session_id = asStr(line.session_id);
    const turn_index = asNum(line.turn_index);
    const p = asStr(line.path);
    if (!session_id || turn_index === null || !p) continue;
    out.push({ session_id, turn_index, path: p });
  }
  return out;
}

// Ids that name a FILE we could plausibly have opened. An offered id is `KIND:locator`; only
// the note kind's locator is a path in this repo's vault, and everything else (DE: a decision
// record, CC: a coordination case, AU: an audit event, TH: a thread) names a governed object
// with no file on this disk at all. Restricting the match by KIND rather than by "does the
// string look pathish" is what stops a coincidentally-named local file from manufacturing an
// engagement signal for a decision id.
const FILE_BACKED_ID_KINDS = new Set(["nt"]);

// Normalize for comparison: lowercase and drop a prose extension, mirroring normId's rule so
// the two sides of the compare are stripped the same way.
function normPathish(s: string): string {
  return s.trim().replace(/\.(md|markdown|mdx|rst|txt|adoc)$/i, "").toLowerCase();
}

/**
 * Offered ids whose file the agent opened this turn.
 *
 * The id side is a vault-relative locator (`NT:notes/20260808-x.md`); the read side is
 * whatever absolute path the tool call carried
 * (`/Users/alice/projects/app/notes/20260808-x.md`). They match when the read path ENDS
 * WITH the locator at a SEGMENT BOUNDARY, which is the same rule (and the same accepted
 * cost) as followthrough's idMatches: a bare-basename locator can collide with a
 * same-named note in another directory, and `notes/x` is never satisfied by
 * `other-notes/x`.
 */
export function matchOpenedIds(offered: string[], reads: FileRead[]): string[] {
  if (!offered.length || !reads.length) return [];
  const readNorms = reads.map((r) => normPathish(r.path));
  return offered.filter((id) => {
    const colon = id.indexOf(":");
    if (colon <= 0) return false;
    if (!FILE_BACKED_ID_KINDS.has(id.slice(0, colon).toLowerCase())) return false;
    const locator = normPathish(id.slice(colon + 1));
    if (!locator) return false;
    return readNorms.some((p) => p === locator || p.endsWith(`/${locator}`));
  });
}

// --- the target side: which offered FILE did the agent aim a command at? ------

/**
 * Offered ids a read-intent pointer fire named this turn (G1, 2026-08-11).
 *
 * THE DEFECT THIS CLOSES. `opened_source_ids` is fed by `file-reads.jsonl`, which
 * post-tool-use.sh writes on `TOOL == "Read"` only. A `sed`, `cat`, `head` or `grep` of the
 * same markdown file writes nothing, so the strongest available engagement signal was
 * invisible to the verdict. Measured across the whole pointer spool: 14 of 15 path-matched
 * fires are Bash and exactly 1 is Read, so the ledger was wired to the channel carrying 7%
 * of the signal. Session 06e2aec1 turn 12 is the canonical case -- injection, interception,
 * and a corrected production claim -- and it scored IGNORED with `engaged_reported: 0`.
 *
 * NO NEW CAPTURE AND NO SHELL PARSING HERE. The pointer already did the path matching, using
 * the same "does this read path name this id?" rule as `matchOpenedIds`, and it already
 * classified read intent while it had the command in hand. This is a filter and a set
 * intersection over a spool that has been written all along.
 *
 * THREE ADMISSION RULES, each of which is a false-positive class that was measured:
 *   - `matched_on === "path"` only. A term match says a word the agent grepped for appears
 *     in a delivered document's prose, which is a lexical coincidence; F5 stopped those at
 *     the matcher, and this holds the same line at the reader so a future widening of the
 *     matcher cannot silently start minting engagement.
 *   - read intent, and it FAILS CLOSED: `read_intent === true`, never `!== false`. A fire that
 *     predates the stamp carries no answer, and the measured population is exactly why
 *     unknown cannot be read as yes: 3 of the 15 path fires on record are
 *     `git diff --stat -- <note>.md` and `git log -- <note>.md`, each on a note the agent was
 *     AUTHORING. Those name the file and never consume it. Admitting unknown would let 3
 *     known-bad rows in to collect 12 good ones, which is the flattering direction this whole
 *     change exists to close, applied to its own migration. Legacy fires therefore contribute
 *     NOTHING, and no backfill, inference, re-parse of old commands, version flag or migration
 *     machinery is used to recover them. The instrument is correct going forward; the
 *     historical spool cannot separate the 12 from the 3 on its own evidence, so it abstains.
 *   - same session, same turn, and the id must have been OFFERED this turn. `engaged` is a
 *     subset of `offered` by construction, and that is what makes the rate a rate.
 */
export function matchPathTargetedIds(offered: string[], fires: PointerFire[]): string[] {
  if (!offered.length || !fires.length) return [];
  const targeted = fires
    .filter((f) => f.matched_on === "path" && f.read_intent === true)
    .map((f) => f.source_id);
  return overlap(offered, targeted);
}

// --- the echo side: did a distinctive span come back out? --------------------

// One echo verdict, as `mla _internal echo-scan` spools it at Stop. The scan itself lives in
// evidence-echo.ts; this reader only joins its answer to the turn.
export interface EvidenceEcho {
  session_id: string;
  turn_index: number;
  source_ids: string[];
}

export function parseEvidenceEchoes(lines: Record<string, unknown>[]): EvidenceEcho[] {
  const out: EvidenceEcho[] = [];
  for (const line of lines) {
    const session_id = asStr(line.session_id);
    const turn_index = asNum(line.turn_index);
    if (!session_id || turn_index === null) continue;
    const ids = Array.isArray(line.source_ids) ? line.source_ids.filter((x): x is string => typeof x === "string") : [];
    out.push({ session_id, turn_index, source_ids: ids });
  }
  return out;
}

// --- the join ----------------------------------------------------------------

/**
 * The floor delta recorded by the most recent assembly OF THIS SESSION, read from the
 * assembler's own per-turn delivery receipt. Best-effort in every direction: no workspace,
 * no receipt, a malformed receipt, or a build that predates the field all read as "no
 * delta", which renders as silence rather than as a false alarm.
 *
 * The session id is the point. This receipt is per-session (cache.ts, assembleAuditPath)
 * because the delta it carries is a claim about "since YOUR last turn", and the reader has
 * to agree with the writer about whose turn that was. Reading the workspace-shaped path
 * here would hand this session whatever the last of 10+ concurrent sessions happened to
 * write, which is the defect that produced `removed: []` while three [MUST] rules left the
 * floor (floor-delta-session-scope.spec.ts).
 *
 * Deliberately NO fallback to the legacy workspace-shaped file when the session's receipt
 * is missing. A stranger's delta is worse than none: silence is merely uninformative, while
 * a foreign delta is a false statement about this agent's own obligations.
 */
function defaultReadFloorDelta(sessionId: string): FloorDelta | null {
  try {
    // Required lazily: the recap is also computed by `mla turn N` and by the detached
    // emitter, neither of which should pull the scanner graph in when nothing changed.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { tryResolveWorkspaceId } = require("../workspace") as typeof import("../workspace");
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { readAssembleAudit } = require("../scanner/cache") as typeof import("../scanner/cache");
    const workspaceId = tryResolveWorkspaceId();
    if (!workspaceId) return null;
    const audit = readAssembleAudit(undefined, workspaceId, sessionId);
    const d = audit?.floorDelta;
    if (!d) return null;
    return { added: d.added ?? [], removed: d.removed ?? [] };
  } catch {
    return null;
  }
}

/** Never let a decorative clause be the thing that breaks a recap. */
function renderFloorDeltaSafely(read: () => FloorDelta | null): string | null {
  try {
    const d = read();
    return d ? renderFloorDelta(d) : null;
  } catch {
    return null;
  }
}

export function computeTurnRecap(sessionId: string, turnIndex: number, deps: TurnRecapDeps = {}): TurnRecap {
  const readLog = deps.readLog ?? readLogJsonl;
  const readFloorDelta = deps.readFloorDelta ?? (() => defaultReadFloorDelta(sessionId));

  const askLines = readLog("ask-traces.jsonl");
  const mcpLines = parseMcpCalls(readLog("mcp-calls.jsonl"));
  const citeLines = parseReportCitations(readLog("report-citations.jsonl"));

  // The single ask-traces line for this turn. One line per turn is the invariant
  // (write_trace is the sole emitter); take the last match so a re-emit wins.
  // The NEXT turn's line answers "is the backend still down?" for free: the hook
  // calls write_trace for turn k BEFORE it appends turn k-1's recap block, so by
  // the time this renders, turn k is already on disk. `mla turn N` gets the same
  // correction with no extra plumbing.
  let trace: AskTrace | null = null;
  let nextTrace: AskTrace | null = null;
  for (const raw of askLines) {
    const t = parseAskTrace(raw);
    if (!t || t.session_id !== sessionId) continue;
    if (t.turn_index === turnIndex) trace = t;
    else if (t.turn_index === turnIndex + 1) nextTrace = t;
  }

  const ran = trace !== null;
  const injected_floor = trace?.injected_floor ?? false;
  const injected_evidence = trace?.injected_evidence ?? false;
  const offered_source_ids = trace?.offered_source_ids ?? [];
  const evidence_offered = offered_source_ids.length > 0;

  // Same-turn, same-session pulls and citations (window=0).
  const pulledIds: string[] = [];
  const toolSet = new Set<string>();
  let pull_count = 0;
  let pull_refused_count = 0;
  for (const c of mcpLines) {
    if (c.session_id !== sessionId || c.turn_index !== turnIndex || !c.evidence_tool) continue;
    // D3: a REFUSED pull is counted on its own arm and contributes no ids or tools.
    // It never reached the corpus, so admitting it to pull_count would redefine a
    // number that has meant "pulls that ran" for the whole history of this log.
    if (c.outcome === "error") {
      pull_refused_count += 1;
      continue;
    }
    pull_count += 1;
    pulledIds.push(...c.source_ids);
    if (c.tool) toolSet.add(c.tool);
  }
  // The ids those successful pulls RESOLVED, deduped, in call order. Refusals were
  // already skipped above (they never reached the corpus), and an empty result
  // contributes nothing, so this is exactly "governed material the agent got by hand".
  const hand_pulled_source_ids = Array.from(new Set(pulledIds));

  const cited_source_ids: string[] = [];
  for (const r of citeLines) {
    if (r.session_id !== sessionId || r.turn_index !== turnIndex) continue;
    cited_source_ids.push(...r.source_ids);
  }

  // Referenced = offered ids the agent pulled (via an evidence tool) or cited. Deliberately
  // UNCHANGED: this number has been computed the same way for the whole history of the log,
  // and widening it in place would silently redefine every past comparison.
  const referenced_source_ids = overlap(offered_source_ids, [...pulledIds, ...cited_source_ids]);

  // Opened = offered ids whose file the agent Read this turn. The third deterministic signal,
  // and the one that sees the ordinary push-path success the other two structurally cannot:
  // the agent goes to the document mla named rather than re-fetching it.
  const turnReads = parseFileReads(readLog("file-reads.jsonl")).filter(
    (r) => r.session_id === sessionId && r.turn_index === turnIndex,
  );
  const opened_source_ids = matchOpenedIds(offered_source_ids, turnReads);

  // Path-targeted = offered ids a read-intent pointer fire named this turn. The fourth
  // deterministic signal, and the one that sees a Bash read of the served document, which is
  // 14 of the 15 path-matched opens on record.
  const turnFires = parsePointerFires(readLog("evidence-pointers.jsonl")).filter(
    (f) => f.session_id === sessionId && f.turn_index === turnIndex,
  );
  const path_targeted_source_ids = matchPathTargetedIds(offered_source_ids, turnFires);

  // Echoed = offered ids whose snippet reappeared in the agent's own output. HEURISTIC, and
  // kept out of the union below on purpose.
  const echoedIds: string[] = [];
  for (const e of parseEvidenceEchoes(readLog("evidence-echoes.jsonl"))) {
    if (e.session_id !== sessionId || e.turn_index !== turnIndex) continue;
    echoedIds.push(...e.source_ids);
  }
  const echoed_source_ids = overlap(offered_source_ids, echoedIds);

  // Engaged = the union of the DETERMINISTIC signals only.
  const engaged_source_ids = offered_source_ids.filter(
    (id) =>
      referenced_source_ids.includes(id) ||
      opened_source_ids.includes(id) ||
      path_targeted_source_ids.includes(id),
  );

  const notRun = !ran || !injected_floor;
  const not_run_reason = notRun ? deriveNotRunReason(trace) : null;
  const coverage_gap_type = !notRun && !evidence_offered ? deriveCoverageGap(trace as AskTrace) : null;

  let verdict: Verdict;
  if (notRun) verdict = "NOT_RUN";
  else if (!evidence_offered) verdict = "NO_OFFER";
  // "no engagement was observed", which is what this arm has always meant and never said.
  // See the Verdict type for why the wire spelling stays `IGNORED`.
  else if (engaged_source_ids.length === 0) verdict = "IGNORED";
  else verdict = "USED";

  // The abstain class is only meaningful when mla ran and offered nothing; a
  // turn that offered evidence has no NO_OFFER reason to classify.
  const abstain_class =
    verdict === "NO_OFFER"
      ? applyContraryEvidence(deriveAbstainClass(trace?.primary_no_offer_reason ?? null), hand_pulled_source_ids)
      : null;
  const evidence_layer_down = deriveEvidenceLayerDown(verdict, coverage_gap_type);
  // Fail LOUD: no next turn on disk means nothing yet proves recovery, so the
  // alarm stands. Only a turn that actually reached intel clears it.
  const evidence_layer_recovered = evidence_layer_down && nextTrace != null && intelAnswered(nextTrace);

  return {
    session_id: sessionId,
    turn_index: turnIndex,
    trace_id: trace?.trace_id ?? null,
    ran,
    injected_floor,
    floor_delta: renderFloorDeltaSafely(readFloorDelta),
    injected_chars: trace?.injected_chars ?? null,
    injected_evidence,
    not_run_reason,
    enrich_latency_ms: trace?.enrich_latency_ms ?? null,
    evidence_offered,
    offered_source_ids,
    zero_results: !evidence_offered,
    coverage_gap_type,
    evidence_layer_down,
    evidence_layer_recovered,
    retrieved_count: trace?.retrieved_count ?? null,
    selected_count: trace?.selected_count ?? null,
    delivered_source_ids: trace?.delivered_citations ?? null,
    abstain_class,
    evidence_tools_pulled: Array.from(toolSet),
    pull_refused_count,
    pull_count,
    referenced_source_ids,
    cited_source_ids,
    hand_pulled_source_ids,
    opened_source_ids,
    path_targeted_source_ids,
    echoed_source_ids,
    engaged_source_ids,
    verdict,
  };
}

// --- render ------------------------------------------------------------------

function gapPhrase(t: string | null): string {
  switch (t) {
    // Legacy arb/fail-open reasons (pre-Item-4 lines).
    case "no_relevant_context":
      return "no candidate matched your prompt";
    case "enrich_unreachable":
      return "could not reach intel";
    case "enrich_timeout":
      return "enrichment timed out";
    case "enrich_unauthorized":
      return "Meetless session expired, run `mla login`";
    case "enrich_error":
      return "enrichment failed";
    // Says intel STOPPED, not that intel was absent: the operator's next move is to look
    // at the guard, not to restart a service that is running.
    case "enrich_stop_guard":
      return "intel stopped itself mid-answer (stop guard)";
    case "missing_token":
      return "no auth token";
    // intel's governed-KB no_offer taxonomy (enrich_no_offer.py), persisted verbatim.
    case "zero_candidates":
      return "retrieval found nothing to offer";
    case "all_failed_relevance":
      return "candidates found but all fell below the score floor";
    case "all_failed_posture_freshness_supersession":
      return "candidates found but all withheld by posture, freshness or supersession";
    case "router_low_confidence":
      return "router was not confident enough to retrieve";
    case "primary_surface_no_offer":
      return "the router offers nothing for this kind of prompt";
    case "would_require_uncited_synthesis":
      return "abstained rather than answer without a citation";
    case "unresolved_conflict":
      return "abstained on an unresolved conflict";
    case "surface_provider_missing":
      return "a source surface was unavailable";
    case "over_budget":
      return "enrichment budget was exhausted";
    case "self_echo_only":
      return "withheld: the only candidates were this session's own turns";
    case "all_excluded_by_caller":
      return "withheld: this session already had every candidate";
    case "machine_envelope":
      return "no human asked anything this turn";
    default:
      return "nothing relevant offered";
  }
}

// The counts+class tail appended to a NO_OFFER footer when the governed-KB trace
// is present. "retrieved 5, selected 0 · should_have_matched" is the whole point
// of Item 4: it makes a dropped-all-candidates miss visible at a glance.
function abstainPhrase(r: TurnRecap): string {
  const counts = `retrieved ${r.retrieved_count}, selected ${r.selected_count ?? 0}`;
  if (!r.abstain_class) return counts;
  return `${counts} · ${r.abstain_class}${unverifiedSuffix(r)}`;
}

// Name the falsifier next to the class, so the claim can be checked rather than taken.
// The CLASS itself already carries the correction (`applyContraryEvidence` demoted it
// to `unverified_abstain`); this only says what did the demoting.
//
// The previous version keyed on `pull_count`, which counts CALLS. A pull that resolved
// nothing is the corpus agreeing with the abstention, and it was being rendered as a
// falsifier. This keys on the ids the pulls actually resolved.
function unverifiedSuffix(r: TurnRecap): string {
  if (r.abstain_class !== "unverified_abstain") return "";
  return ` (unverified: agent pulled ${pulledPhrase(r)} by hand)`;
}

function notRunPhrase(r: NotRunReason | null): string {
  switch (r) {
    case "muted":
      return "muted this session";
    case "not_activated":
      return "not activated for this repo";
    case "suppressed":
      return "injection suppressed";
    case "timeout":
      return "hook timed out";
    case "error":
      return "hook error";
    case "empty_prompt":
      return "no prompt to work from";
    case "harness_event":
      return "harness event, not a human turn";
    case "delivery_failed":
      return "required rules did not fit, prompt blocked";
    case "cancelled":
      return "hook was cancelled before it finished";
    default:
      return "did not run (reason unknown)";
  }
}

function pulledPhrase(r: TurnRecap): string {
  // A refusal is reported beside the count, never inside it. "0" and "0 (2 refused)"
  // are opposite facts about the agent: one never asked, the other asked and was told
  // no, and only the second is evidence that mla's push path left a real gap.
  const refused = r.pull_refused_count > 0 ? ` (${r.pull_refused_count} refused)` : "";
  if (r.pull_count === 0) return `0${refused}`;
  const names = r.evidence_tools_pulled.length ? r.evidence_tools_pulled.join("+") : "evidence";
  return `${names} ×${r.pull_count}${refused}`;
}

// D5. What the agent cited, split by whether mla was the one that handed it over.
//
// This line used to render the RAW `cited_source_ids` beside a verdict computed from
// the INTERSECTION of offered against pulled+cited. On be3cbc73 turn 2 that printed
// `cited NT:notes/...-8779efcf-fix-proposal.md · IGNORED` for a document mla never
// offered -- the agent had named it itself, out of eval-harness output it was already
// holding. Nothing about the metric was wrong; the sentence was.
//
// Both facts are kept because both are real, and the second one is arguably the more
// interesting: `cited-elsewhere` is the agent reaching governed material mla did NOT
// supply, which is exactly the gap the push side exists to close. It is rendered as a
// COUNT rather than a list, which is what keeps the richer form inside the byte budget
// this block is already fighting, and the suffix is omitted entirely when it would be
// zero so every line that was never ambiguous keeps its exact previous shape.
function citedPhrase(r: TurnRecap): string {
  const fromOffer = r.cited_source_ids.filter((id) => r.referenced_source_ids.includes(id));
  const elsewhere = r.cited_source_ids.length - fromOffer.length;
  const head = fromOffer.length ? fromOffer.join(", ") : "0";
  return elsewhere > 0 ? `${head} (+${elsewhere} elsewhere)` : head;
}

function openedPhrase(r: TurnRecap): string {
  return r.opened_source_ids.length ? r.opened_source_ids.join(", ") : "0";
}

// The fourth deterministic signal, rendered only when it fired and with its own word, which
// is deliberately "targeted" and not "opened". This line is fighting a byte budget, and on
// the overwhelming majority of turns nothing was path-targeted; a permanent `targeted 0`
// would spend bytes to say nothing. When it DID fire it is usually the only reason the turn
// reads USED, so a reader who cannot see it cannot explain the verdict.
function targetedPhrase(r: TurnRecap): string {
  return r.path_targeted_source_ids.length ? ` · targeted ${r.path_targeted_source_ids.join(", ")}` : "";
}

// The heuristic signal, rendered only when it fired and always with its own word. It never
// appears as a count beside the deterministic ones when it is zero, so an absent echo can
// never be read as a measured zero on a turn where the scan did not run at all.
function echoPhrase(r: TurnRecap): string {
  return r.echoed_source_ids.length ? ` · echoed ${r.echoed_source_ids.length} (heuristic)` : "";
}

// What the offered arm is allowed to CLAIM.
//
// `USED` is an observation: a deterministic signal fired. Its complement is not "IGNORED",
// which asserts the agent saw the evidence and set it aside; it is "we watched for four
// signals and saw none", and this session is the proof that the two differ. Turns 7 and 8 of
// 85d97591 changed what the agent did, one of them reversing a conclusion the owner had
// already ruled on, and both scored the complement.
//
// NAMING THE SUBJECT (2026-08-08). "no use observed" fixed the mental-state half and left
// the SCOPE half standing. mla injects on TWO channels in one payload -- Layer 1 floor
// rules, which land on every turn, and Layer 2 evidence, which is what these four signals
// watch -- and a bare complement at the end of the line reads as a verdict on the TURN.
// Session f5e19825 is the falsifier: three turns, three decisions changed by the Premise
// Gate floor rule, and every one of them rendered the complement. What went unused was the
// evidence; the floor channel was never measured at all (see analyze.py's floor census).
// Two words, and the footer stops telling the operator a productive turn was wasted.
//
// M1 (2026-08-08). The complement had been fixed twice; the POSITIVE arm still said "USED",
// and it makes the same class of claim in the flattering direction. What the three
// deterministic signals prove is that the agent PULLED, CITED or OPENED an offered id: an
// explicit, observable act aimed at the evidence. None of them proves the evidence was used,
// and one of them routinely is not: an agent that opens a note to reject it fires `opened`.
//
// So both arms now name the observation rather than the outcome, and they are parallel on
// purpose. A reader who sees "explicit evidence reference observed" beside "no explicit
// evidence reference observed" can tell they are the two sides of ONE instrument. "USED"
// beside "no evidence use observed" reads as a verdict beside a hedge, which is exactly the
// asymmetry that let every historical helpfulness rollup treat this number as adoption.
//
// The WIRE spelling is untouched (`Verdict` stays "USED"/"IGNORED", intel still pins the
// Literal, the Langfuse `mla_assist` score keeps its name and its series). This is the
// presentation layer, which is where the claim is made to a human.
function outcomePhrase(r: TurnRecap): string {
  return r.verdict === "USED"
    ? "explicit evidence reference observed"
    : "no explicit evidence reference observed";
}

/**
 * B.6 (notes/20260804-value-program-closeout-and-browser-delivery.md §4.4): the ask.
 *
 * `mla label` has shipped since 2026-06-03 and works. Over 4,251 real traces `operator_label` is
 * non-null on exactly ONE and `future_helpfulness` on none. The affordance was never missing; the
 * ask was.
 *
 * The trace id is EMBEDDED, and that is the whole correctness story. `mla label` with no positional
 * argument resolves "the latest trace in the current session" (commands/label.ts), so an invitation
 * printed on turn 7 and acted on at turn 9 would silently label turn 9's trace: the label would land
 * on the wrong evidence and nothing would say so. Naming the trace makes the command exact-trace by
 * construction, and it settles the concurrent-session case for free, because an explicit id needs no
 * CLAUDE_CODE_SESSION_ID at all.
 *
 * Returns null when there is no trace to name rather than emitting an ambiguous invitation. An ask
 * that cannot be answered correctly is worse than no ask.
 */
export function labelInvitation(r: TurnRecap): string | null {
  if (!r.trace_id) return null;
  return `useful? mla label ${r.trace_id} --useful | --noisy`;
}

// The single-line, scannable footer (Section 7). Also used as the Langfuse score
// comment (Layer D) and the `mla turn` headline, so all three surfaces agree.
//
// `opts.inviteLabel` is decided by the CALLER, not here: it depends on once-per-session state that
// lives on disk, and this function is pure so the Langfuse comment and the `mla turn` headline can
// reuse it without touching the filesystem. See runInternalTurnRecap for the gate.
export function renderFooter(r: TurnRecap, opts: { inviteLabel?: boolean } = {}): string {
  // The size rides the head so it appears on every verdict that injected anything.
  // NOT_RUN returns early below and carries no size, which is correct: nothing was
  // injected, so there is nothing to report.
  const size = injectedPhrase(r);
  const head = `🔎 mla · turn ${r.turn_index}${size ? ` · ${size}` : ""}`;
  if (r.verdict === "NOT_RUN") return withFloorDelta(`${head} · ${notRunPhrase(r.not_run_reason)} · NOT_RUN`, r);
  if (r.verdict === "NO_OFFER") {
    // What Layer 2 actually did, which is NOT the same question as whether anything
    // governed was offered. See `layerPhrase`.
    const layer = layerPhrase(r);
    // Outage first: a NO_OFFER caused by the evidence backend being down must be
    // unmistakable, never read as "we looked, nothing matched". No governed-KB
    // trace rides an outage, so there are no counts to append here.
    if (r.evidence_layer_down) {
      // Past tense, no warning sign, once a later turn reached intel. This recap
      // is read one turn LATE, so a live-alarm rendering of a resolved outage is
      // a false alarm, and a false alarm teaches the agent to ignore the real one.
      if (r.evidence_layer_recovered) {
        return withFloorDelta(`${head} · ${layer} · evidence layer was down then (${gapPhrase(r.coverage_gap_type)}), recovered since · NO_OFFER`, r);
      }
      return withFloorDelta(`${head} · ${layer} · ⚠ evidence layer DOWN (${gapPhrase(r.coverage_gap_type)}) · NO_OFFER`, r);
    }
    // Append the retrieved/selected counts + abstain class only when the
    // governed-KB trace is present, so pre-Item-4 lines keep their exact format.
    const tail = r.retrieved_count != null ? ` · ${abstainPhrase(r)}` : "";
    return withFloorDelta(`${head} · ${layer} · ${gapPhrase(r.coverage_gap_type)}${tail} · NO_OFFER`, r);
  }
  const latency = r.enrich_latency_ms != null ? `${r.enrich_latency_ms}ms` : "?ms";
  // F2 (2026-08-10): count WHAT REACHED THE MODEL, not what intel offered.
  //
  // `offered_source_ids` is the OFFER -- intel's `context_items[*].injected` -- and it is
  // fixed before the hook's inline budget takes its cut, so it cannot see a drop.
  // `delivered_source_ids` is `hook.delivered_citations`, read back off the budgeted block
  // through the same predicate the budgeter segments on (H4), and is the only field that
  // can. They disagree on measured turns: session `carryrem` turn 2 offered 3, delivered 2,
  // and this line said 3.
  //
  // null is UNMEASURED, `[]` is a measured zero, and they are NOT the same fact. On a row
  // predating the field the offer is still the best answer available; reporting 0 there
  // would invent a delivery failure out of an instrumentation gap.
  //
  // NOT the fix the 08-09 note proposed. It read this line's "1 src" as counting a
  // governance block and asked for `selected_count` instead. The floor rides its own block
  // and carries no citation, so it has never been counted here; that "1 src" was a real
  // note served by the corpus-probe pull arm, which governed-KB retrieval does not account
  // for. Counting `selected_count` would have rendered a turn that genuinely delivered a
  // document as if it delivered nothing. See turn-recap-delivered-headline.spec.ts.
  const deliveredCount = r.delivered_source_ids?.length ?? r.offered_source_ids.length;
  // The one case that would otherwise print a contradiction ("injected (0 src)"): a
  // measured zero against a non-empty offer means the budget took everything. The
  // per-item floors make this unreachable today, so this names it rather than hiding it.
  const cut =
    r.delivered_source_ids != null && deliveredCount === 0 && r.offered_source_ids.length > 0
      ? `, all ${r.offered_source_ids.length} cut to fit`
      : "";
  const offer = `evidence injected (${deliveredCount} src${cut}, ${latency})`;
  const base = `${head} · ${offer} · pulled ${pulledPhrase(r)} · cited ${citedPhrase(r)} · opened ${openedPhrase(r)}${targetedPhrase(r)}${echoPhrase(r)} · ${outcomePhrase(r)}`;
  // Only this arm can carry the invitation: NOT_RUN and NO_OFFER return above, so by construction
  // the ask only ever appears on a turn that actually delivered a governed item. Asking "was this
  // useful?" about a turn where nothing was offered is a question with no referent.
  const invite = opts.inviteLabel ? labelInvitation(r) : null;
  return withFloorDelta(invite ? `${base} · ${invite}` : base, r);
}

/**
 * M6: append the floor-change clause when, and only when, the floor moved.
 *
 * It rides EVERY verdict, including NOT_RUN and NO_OFFER, because whether the agent's
 * obligations changed has nothing to do with whether evidence was offered. A rule
 * withdrawn on a turn that offered nothing is exactly as invisible as one withdrawn on
 * a turn that offered three, and the measured case (the duplicate Mermaid rule leaving
 * between turn 1 and turn 3) was not an evidence turn.
 *
 * It STATES the delta and never argues about it: the dedup that triggered this was
 * correct, and a line that editorialized about a legitimate edit would be noise.
 */
function withFloorDelta(line: string, r: TurnRecap): string {
  return r.floor_delta ? `${line} · ${r.floor_delta}` : line;
}

// The C-lite injection payload: the footer wrapped in a context block with one
// soft, optional nudge. Best-effort surfacing; never a command (D3).
export function renderBlockContext(r: TurnRecap): string {
  return [
    `<meetless-context kind="turn-recap" for-turn="${r.turn_index}">`,
    renderFooter(r),
    // Name the subject explicitly. This block rides the NEXT prompt, so an agent
    // reading it as a status report on the turn it is answering right now will
    // report a resolved outage as a current one.
    `This recaps turn ${r.turn_index}, which has already finished; it is not the turn you are answering now.`,
    "You may surface this assist recap to the operator as a one-line footer if useful.",
    "</meetless-context>",
  ].join("\n");
}


/** "2,897 chars", or null when the trace never recorded a size. Measured, not estimated. */
function injectedPhrase(r: TurnRecap): string | null {
  return r.injected_chars == null ? null : `${r.injected_chars.toLocaleString("en-US")} chars`;
}

// What LAYER 2 actually did on a turn that offered nothing governed. Only ever used on
// the NO_OFFER arm; the offered arm says "evidence injected (N src)" and needs no help.
//
// S5 (2026-08-05). This arm hardcoded "floor only", so turn 8 of session 0db6e770
// printed
//
//     🔎 mla · turn 8 · 6,423 chars · floor only · ... · NO_OFFER
//
// for a turn whose trace recorded `layer2_injected: true` with three items. Both halves
// are wrong at once and in opposite directions: "floor only" denies an injection that
// happened, while the 6,423 chars beside it silently INCLUDES the payload being denied.
//
// The two questions were being answered with one word. "Did anything governed get
// offered?" is the verdict, and NO_OFFER is the right answer for a self-echo turn.
// "What entered the prompt?" is this, and it is a different fact. The recap already
// carried it -- `injected_evidence` is `hook.layer2_injected` -- and never read it here.
//
// Deliberately three states and not four. An mixed floor+governed payload would land on
// the offered arm above and never reach this function, and the trace does not currently
// distinguish a session_local payload that ALSO carried governed items, so this does not
// pretend to. Reporting a mixed payload needs the surface on the wire; inventing it from
// two booleans would be the same class of error as the line it replaces.
function layerPhrase(r: TurnRecap): string {
  return r.injected_evidence ? "self-echo only, no governed offer" : "floor only";
}

// The full multi-line expansion for `mla turn` human output.
export function renderBlock(r: TurnRecap): string {
  const ranDesc = !r.ran
    ? "no (no trace for this turn)"
    : !r.injected_floor
      ? `suppressed (${r.not_run_reason ?? "control"})`
      : r.injected_evidence
        ? "floor + evidence"
        : "floor only";
  const offeredDesc = r.evidence_offered
    ? `${r.offered_source_ids.length} source(s): ${r.offered_source_ids.join(", ")}`
    : `none${r.coverage_gap_type ? ` (${r.coverage_gap_type})` : ""}`;
  const lines = [
    `🔎 mla turn ${r.turn_index} recap`,
    `  ran:        ${ranDesc}`,
    ...(injectedPhrase(r) ? [`  injected:   ${injectedPhrase(r)}`] : []),
    `  offered:    ${offeredDesc}`,
    `  latency:    ${r.enrich_latency_ms != null ? `${r.enrich_latency_ms}ms` : "n/a"}`,
    `  pulled:     ${pulledPhrase(r)}`,
    `  cited:      ${citedPhrase(r)}`,
    `  opened:     ${openedPhrase(r)}`,
    // "targeted", never "opened": a pointer receipt proves the agent aimed a read-intent
    // command at the file, and the pointer's own text may then have told it to skip the read.
    ...(r.path_targeted_source_ids.length
      ? [`  targeted:   ${r.path_targeted_source_ids.join(", ")} (read-intent path pointer)`]
      : []),
    ...(r.echoed_source_ids.length ? [`  echoed:     ${r.echoed_source_ids.join(", ")} (heuristic, not scored)`] : []),
    `  referenced: ${r.referenced_source_ids.length ? r.referenced_source_ids.join(", ") : "none"}`,
    `  engaged:    ${r.engaged_source_ids.length ? r.engaged_source_ids.join(", ") : "none"}`,
    // The verdict LINE reports what we observed, for the same reason the footer does. The
    // stored value is still r.verdict and `--json` still emits it verbatim.
    //
    // ARM-SPLIT (2026-08-08). This line used to be `verdict === "USED" ? ... : <complement>`
    // with no arm split at all, so a NO_OFFER turn -- two lines below `offered: none` --
    // printed a verdict about evidence use. The footer has refused to do that since U4 (it
    // returns on the NO_OFFER and NOT_RUN arms before reaching `outcomePhrase`); the
    // expanded view had no such return and said it anyway. Only the OFFERED arm has a use
    // question to answer; the other two report their own verdict verbatim.
    `  outcome:    ${r.verdict === "USED" || r.verdict === "IGNORED" ? outcomePhrase(r) : r.verdict}`,
  ];
  // Outage callout: make an evidence-backend-down NO_OFFER impossible to misread
  // as a merits result in the expanded view too.
  if (r.evidence_layer_down && r.evidence_layer_recovered) {
    lines.push(`  evidence layer was DOWN on this turn (a backend outage, not a merits result); it recovered on turn ${r.turn_index + 1}`);
  } else if (r.evidence_layer_down) {
    lines.push(`  ⚠ evidence layer DOWN: this NO_OFFER is a backend outage, not a merits result`);
  }
  // Enrichment instrumentation (Item 4): only shown when the governed-KB trace
  // rode back, so USED turns and pre-trace lines stay unchanged.
  if (r.retrieved_count != null) {
    lines.push(`  retrieved:  ${r.retrieved_count}`);
    lines.push(`  selected:   ${r.selected_count ?? 0}`);
    // H4. Printed ONLY when known. An absent line reads as "this build did not measure
    // it"; a `delivered: 0` printed from a missing field would read as a total loss.
    // `!= null` covers undefined as well: a recap built by an older caller simply lacks
    // the key, and that is UNMEASURED for the same reason an explicit null is. Printing
    // `delivered: 0` off a missing field is the exact collapse this field exists to stop.
    if (r.delivered_source_ids != null) {
      lines.push(`  delivered:  ${r.delivered_source_ids.length}${r.delivered_source_ids.length < (r.selected_count ?? 0) ? "  (budget dropped the rest)" : ""}`);
    }
    // Same falsifier as the footer. This block prints `class:` two lines below
    // `pulled:`, so without it the expanded view shows a certified correct abstain
    // directly beneath the evidence that it was never verified.
    if (r.abstain_class) lines.push(`  class:      ${r.abstain_class}${unverifiedSuffix(r)}`);
  }
  if (r.trace_id) lines.push(`  trace:      ${r.trace_id}`);
  return lines.join("\n");
}
