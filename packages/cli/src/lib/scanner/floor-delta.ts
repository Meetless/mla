// M6: a rule leaving the floor is invisible to the only party who has to obey it.
//
// Measured in session 4caa06b9: the duplicate Mermaid rule was in the turn-1 floor
// and gone by turn 3. The dedup was almost certainly correct; the defect is that the
// agent simply stopped being told, mid-task, with no notice. An obligation that
// appears without announcement is a surprise; one that DISAPPEARS without
// announcement is worse, because the agent keeps paying its cost and may keep citing
// it as the reason for a decision.
//
// WHAT THIS REUSES, AND WHAT IT DELIBERATELY DOES NOT ADD. The proposal claimed the
// hook already had this diff. It did not: the ask-traces line records `injected_floor`
// as a BOOLEAN with no rule identities. What does exist is `assemble-audit.json`, the
// assembler's own per-turn delivery receipt, already written and read by TypeScript
// and already carrying `delivered` with each rule's stable `ruleId`. So the previous
// turn's floor is on disk before this turn's assembler overwrites it, and the delta is
// a pure function over two lists of ids the system already mints. No new identifier
// system, no new telemetry pipeline, no new state file.
//
// The recap quotes the rule's own TEXT rather than its 12-hex id, because the id
// answers "which row changed" and the agent needs "which obligation changed".

/** A floor rule as the delta speaks about it: its stable id and its own statement. */
export interface FloorRuleRef {
  ruleId: string;
  text: string;
}

export interface FloorDelta {
  added: FloorRuleRef[];
  removed: FloorRuleRef[];
}

/**
 * The DELIVERED SNAPSHOT on each side of the diff: every ruleId the agent was handed that
 * turn, in ANY block, floor and scoped alike.
 *
 * F3, and the reason this parameter exists at all. Floor membership answers "which set is
 * this rule in"; it does not answer "is the agent still being told". A rule RECLASSIFIED
 * from the always-on floor to the turn-scoped set (`mla rules edit --turn-when-*`, a
 * supported operator action) leaves the floor while remaining in front of the agent in the
 * `<meetless-context kind="scoped-rules">` block, and a floor-only diff calls that a
 * withdrawal. Five recorded instances of that false alarm before the parameter was added;
 * the sixth named the Mermaid design-doc rule as evicted in session ae6411e4 while the rule
 * was visibly delivered.
 *
 * Either side may be omitted, and omission means "no better information than the floor
 * itself": the side falls back to its own floor ids, which is exactly the pre-F3 behaviour.
 * That keeps the function honest for callers that genuinely only know the floor, rather than
 * making them invent a scoped set they cannot observe.
 *
 * I3, AND THE THIRD STATE OF ABSENCE. `prevOmitted`/`currOmitted` are the ids that turn's
 * assembler CONSIDERED and did not emit, today exactly the best-effort SHOULD rules that
 * lost a byte-budget contest (assemble.ts, the one `omitted.push` in the tree). They are
 * absent from the delivered snapshot and they were NOT withdrawn: the floor block's own
 * precedence sentence tells the agent so on the same turn, `mla context list` still shows
 * them, and they ride again on the next shorter prompt.
 *
 * Measured in session bb182a52: the recap said `-2 removed` about two rules the SAME
 * process's receipt had recorded seconds earlier as "best-effort:did-not-fit". Because
 * omission is driven by prompt length, that fires on every budget flip, on a line whose
 * whole value is that it is "absent almost always".
 *
 * MEMBERSHIP, NEVER THE REASON. The proposal's sketch was to skip any rule whose omission
 * reason starts with `best-effort:`. That pins today's reason vocabulary as a contract and
 * a rename re-opens the defect silently. So no reason string crosses this boundary: the
 * caller hands over ids and this function unions them into presence. If a future omission
 * reason ever means "withdrawn" rather than "withheld", it is the CALLER that must stop
 * putting the id in this set, which is where that knowledge already lives.
 *
 * Both sides again, because the alarm is symmetric: a rule that was squeezed out last turn
 * and fits this turn is not an ADDITION either. Nothing was granted; the budget moved.
 */
export interface DeliveredSnapshots {
  /** every ruleId delivered on the PREVIOUS turn */
  prev?: ReadonlySet<string>;
  /** every ruleId delivered on THIS turn */
  curr?: ReadonlySet<string>;
  /** every ruleId the PREVIOUS turn's assembler considered and withheld (see below) */
  prevOmitted?: ReadonlySet<string>;
  /** every ruleId THIS turn's assembler considered and withheld (see below) */
  currOmitted?: ReadonlySet<string>;
}

/**
 * What moved on or off the delivered floor since the previous assembly.
 *
 * IDENTITY IS THE ruleId, never the text. `ruleId` is content-derived and stable
 * across re-attest (see managed-rules.ts), so a reworded rule keeps its id and does
 * not read as a removal plus an addition. Without that, every copy-edit to a rule
 * statement would announce itself as a governance change and the line would be noise
 * within a week.
 *
 * A NULL prior is NOT "everything was added". The first turn of a session has nothing
 * to diff against, and announcing the entire floor as new on every session start is
 * exactly the false alarm that teaches an agent to skip the line.
 *
 * F3: MEMBERSHIP IS THE SUBJECT, DELIVERY IS THE TEST. `prev`/`curr` name the floor on each
 * side, because a change of floor membership is what this line reports. Whether to report it
 * is decided against `delivered`, the whole snapshot: a rule is REMOVED only when it is
 * absent from this turn's delivered set, and ADDED only when it was absent from the previous
 * turn's. A rule that merely crossed between the floor and the scoped set satisfies neither
 * and the line stays silent, which is correct -- the agent read the same obligation both
 * turns and nothing about its authority changed.
 */
export function floorDelta(
  prev: readonly FloorRuleRef[] | null | undefined,
  curr: readonly FloorRuleRef[],
  delivered: DeliveredSnapshots = {},
): FloorDelta {
  if (!prev) return { added: [], removed: [] };
  // ACCOUNTED FOR, which is delivered OR knowingly withheld. Absence from this union is the
  // only thing that reads as a governance change; see DeliveredSnapshots for why the third
  // state exists and why no reason string reaches here.
  const accountedFor = (
    snapshot: ReadonlySet<string> | undefined,
    fallback: readonly FloorRuleRef[],
    omitted: ReadonlySet<string> | undefined,
  ): ReadonlySet<string> => {
    const base = snapshot ?? new Set(fallback.map((r) => r.ruleId));
    if (!omitted || omitted.size === 0) return base;
    return new Set([...base, ...omitted]);
  };
  const prevIds = accountedFor(delivered.prev, prev, delivered.prevOmitted);
  const currIds = accountedFor(delivered.curr, curr, delivered.currOmitted);
  return {
    added: curr.filter((r) => !prevIds.has(r.ruleId)),
    removed: prev.filter((r) => !currIds.has(r.ruleId)),
  };
}

// How much of a rule's statement to quote.
//
// Sized against the case that motivated M6, not against a guess. The rule that left
// the floor was one of two Mermaid variants sharing the preamble "When authoring a
// design doc, proposal, plan, RFC, or architecture spec, include a complete...". A
// 60-character quote of that is "When authoring a design doc, proposal, plan, RFC,
// or archite...", which identifies nothing and is IDENTICAL for the variant that
// stayed. The word that distinguishes the obligation sits ~90 characters in, so the
// quote has to reach it or the line is decoration.
const QUOTE_CHARS = 120;
// How many rules to quote per direction. One, because the quote had to grow to be
// identifying and this still has to be ONE line. The count beside it is always exact
// and an "+N more" suffix carries the rest, so nothing is hidden, only unquoted.
export const MAX_QUOTED = 1;

/**
 * A rule quoted at identifying length.
 *
 * EXPORTED for the floor block's budget-omission line (M1, session d779aeaa), which is
 * the sibling absence: this module speaks about rules that LEFT, that one about rules
 * that were WITHHELD. Two omission vocabularies on two blocks the agent reads in the
 * same turn is how they come to disagree, so they share the helper and the 120-character
 * measurement behind it rather than each picking a number.
 */
export function quoteRule(r: FloorRuleRef): string {
  const flat = r.text.replace(/\s+/g, " ").trim();
  const cut = flat.length > QUOTE_CHARS ? `${flat.slice(0, QUOTE_CHARS).trimEnd()}...` : flat;
  return `"${cut}"`;
}

/**
 * A bounded sample plus an EXACT count: `"first rule..." +3 more`, or "" for none.
 *
 * The count is always exact even when the sample is not, which is the invariant both
 * callers depend on: a reader must never be able to mistake "one shown" for "one
 * changed". Exported for the same reason as `quoteRule`.
 */
export function sampleWithCount(rules: readonly FloorRuleRef[]): string {
  if (rules.length === 0) return "";
  const shown = rules.slice(0, MAX_QUOTED).map(quoteRule).join(", ");
  const more = rules.length > MAX_QUOTED ? ` +${rules.length - MAX_QUOTED} more` : "";
  return `${shown}${more}`;
}

function side(label: string, sign: string, rules: FloorRuleRef[]): string | null {
  if (rules.length === 0) return null;
  return `${sign}${rules.length} ${label} ${sampleWithCount(rules)}`;
}

/**
 * The one-line recap fragment, or null on a turn where the floor did not move.
 *
 * Null on no-change is the load-bearing half: this line rides a footer the agent sees
 * every turn, so it has to be absent almost always for its presence to mean anything.
 *
 * States the DIRECTION in words. A bare `-1` next to the recap's other numbers reads
 * like a score; "removed" cannot.
 */
export function renderFloorDelta(d: FloorDelta): string | null {
  const parts = [side("added", "+", d.added), side("removed", "-", d.removed)].filter(
    (p): p is string => p !== null,
  );
  if (parts.length === 0) return null;
  return `floor changed since your last turn: ${parts.join("; ")}`;
}
