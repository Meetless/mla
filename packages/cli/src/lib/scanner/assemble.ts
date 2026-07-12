// The byte-budgeted context assembler (targeted-rule-injection §4.1-§4.4). This is the
// SINGLE owner of the model-facing UserPromptSubmit envelope: it takes the required
// non-rule context, the structured floor + scoped rules, and the per-prompt path signals,
// and returns the exact-byte envelope plus an audit of what was delivered vs dropped.
//
// PURE: no I/O, no clock, no persistence. The subcommand (P2) feeds it a rendered `base`,
// the scan-cache arrays, the extracted explicit paths, and the working set; it renders the
// blocks, budgets them against SAFE_TOTAL, and never lets a best-effort rule push a required
// one out. The one glob matcher is shared with Plane B enforcement (§4.7), so a rule surfaced
// in the prompt and a rule enforced at the tool boundary agree on what its globs match.
//
// Design invariants (all enforced here, not by harness truncation or rule ordering):
//   - The BASE (non-rule context + global MUST floor + reserved marker room) fits every turn.
//     If it cannot, that is an impossible/misconfigured state (SAFE_TOTAL too small or the
//     floor grew past it) -> throw BaseInvariantError; the caller falls back to last-known-good.
//   - EVERY applicable scoped MUST is MANDATORY (matched by explicit path, turn trigger, OR
//     working set), ordered ahead of every SHOULD across ALL tiers (§7.1). The whole mandatory
//     set fits, or we fail LOUD (§7.5) while PRESERVING the base (never replace the whole
//     envelope with only a marker, never silently drop a MUST).
//   - Only SHOULD rules are BEST-EFFORT: they fill the remaining exact capacity in a fixed rank
//     order, and every dropped SHOULD is logged with its ruleId + reason.

import { FloorRuleEntry, ScopedRuleEntry } from "./types";
import type { TurnTrigger } from "../rules/types";
import { matchesGlob } from "../rules/glob-match";
import { ScopedLine, renderFloorBlock, renderOverflowMarker, renderScopedBlock } from "./render";

export interface AssembleInput {
  // The required non-rule context (static preamble + any co-emitted mandatory block),
  // already rendered by the caller. Counted as part of the base that must always fit.
  base: string;
  // The raw user prompt for this turn. The ONLY consumer of the unparsed prompt: it feeds the
  // turn-trigger `promptAny` substring predicate (normalized, case-insensitive). Explicit-path
  // extraction already ran in the caller and arrives separately as `explicitPaths`.
  prompt: string;
  // Structured floor rules from the scan cache: global rules with no applicability globs.
  // MUST entries are the always-on required floor; SHOULD entries are the droppable tail.
  floorRules: FloorRuleEntry[];
  // Structured scoped rules from the scan cache: rules carrying applicability globs.
  scopedRules: ScopedRuleEntry[];
  // Normalized, repo-relative paths named explicitly in the prompt (§4.7 extraction).
  // A scoped MUST matched by one of these is REQUIRED this turn.
  explicitPaths: string[];
  // Normalized, repo-relative git working-set paths. A relevance HINT only (§4.3): it may
  // match several subsystems at once and is empty pre-first-edit, so it never gates a
  // must-fit guarantee. Scoped rules matched only via the working set are best-effort.
  workingSetPaths: string[];
  // The connector-owned byte ceiling, strictly below the Phase-0-measured harness limit.
  safeTotal: number;
}

export type DeliveredTier = "floor-must" | "scoped-required" | "best-effort";

export interface DeliveredRule {
  ruleId: string;
  tier: DeliveredTier;
}

export interface OmittedRule {
  ruleId: string;
  reason: string;
}

export interface AssembleOutput {
  // The complete envelope to emit as UserPromptSubmit additionalContext.
  text: string;
  // UTF-8 byte length of `text` (always <= safeTotal).
  bytes: number;
  // True iff the required scoped set overflowed and the fail-loud marker was emitted in
  // place of the scoped block (base preserved). Out-of-band audit carries the dropped IDs.
  overflow: boolean;
  delivered: DeliveredRule[];
  omitted: OmittedRule[];
}

// Thrown when the base itself (non-rule context + global MUST floor + reserved marker room)
// exceeds SAFE_TOTAL. This is not a normal-operation overflow (that is handled per §4.4 by
// preserving the base and dropping scoped); it means the universal floor no longer fits the
// budget at all. The caller must degrade to last-known-good compiled output, never invent a
// partial floor.
export class BaseInvariantError extends Error {
  constructor(
    readonly baseBytes: number,
    readonly safeTotal: number,
  ) {
    super(
      `base envelope (${baseBytes}B) + overflow marker exceeds SAFE_TOTAL (${safeTotal}B): ` +
        `the global MUST floor no longer fits the inline budget`,
    );
    this.name = "BaseInvariantError";
  }
}

function byteLength(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

// Join non-empty envelope segments with a single newline. Empty segments (e.g. no floor
// rules, no scoped match) drop out so we never emit a stray blank line or separator.
function joinSegments(parts: string[]): string {
  return parts.filter((p) => p.length > 0).join("\n");
}

// A scoped rule applies to a path set iff any of its globs matches any path. The matcher
// is the shared §4.7 function; both sides are assumed already normalized to repo-relative.
function matchesAnyPath(globs: string[], paths: string[]): boolean {
  return paths.some((p) => globs.some((g) => matchesGlob(p, g)));
}

// Normalize prompt text for the turn-trigger substring predicate: lowercase, collapse runs of
// whitespace to a single space, trim. Applied to BOTH the prompt and each needle so a match is
// case- and whitespace-insensitive. This is a closed substring predicate, never a regex or token
// parse; the struct is not a DSL.
function normalizePromptText(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

// The deterministic, LLM-free turn predicate (§5.5, change 2). A trigger fires iff ANY `promptAny`
// needle is a normalized substring of the prompt, OR ANY `explicitPathAny` glob matches one of the
// prompt's explicit paths. It reads ONLY the prompt and the already-extracted explicit paths,
// NEVER the git working set: a keyword rule rides on what the user SAID this turn, not on which
// files happen to be dirty. OR semantics across the two lists; an empty list contributes nothing.
function matchesTrigger(trigger: TurnTrigger, ctx: { prompt: string; explicitPaths: string[] }): boolean {
  const promptAny = trigger.promptAny ?? [];
  if (promptAny.length > 0) {
    const norm = normalizePromptText(ctx.prompt);
    // Guard the `includes("")` coercion: a needle that normalizes to "" would make
    // `norm.includes("")` true for EVERY prompt, silently re-taxing every turn (§5.5). The grammar
    // owner (applicability.ts parseTriggerList) already rejects blank needles, so a well-formed
    // trigger never reaches here with one; this is defense-in-depth for a trigger sourced from a
    // cache written by an older/foreign build, where an empty-normalized needle is dropped, never
    // matched.
    if (promptAny.some((needle) => {
      const n = normalizePromptText(needle);
      return n.length > 0 && norm.includes(n);
    })) return true;
  }
  const explicitPathAny = trigger.explicitPathAny ?? [];
  if (explicitPathAny.length > 0) {
    if (ctx.explicitPaths.some((p) => explicitPathAny.some((g) => matchesGlob(p, g)))) return true;
  }
  return false;
}

// Within-tier order for turn-matched best-effort candidates (§5.5, change 4): MUST before SHOULD,
// then a stable ruleId tiebreak. There is deliberately NO byte-size term. Size-first packing
// maximizes rule COUNT, which is not a proxy for importance: it could deliver three minor
// reminders and drop the one consequential rule. Semantic priority drives the greedy fill.
function turnTierOrder(a: ScopedRuleEntry, b: ScopedRuleEntry): number {
  if (a.strength !== b.strength) return a.strength === "MUST" ? -1 : 1;
  return a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0;
}

// A best-effort candidate, tagged with the block it renders into. Floor-should candidates
// re-render the floor block (as a labeled tail); scoped candidates append to the scoped block.
type Candidate =
  | { channel: "floor-should"; ruleId: string; entry: FloorRuleEntry }
  | { channel: "scoped"; ruleId: string; line: ScopedLine };

export function assembleContext(input: AssembleInput): AssembleOutput {
  const { base, prompt, floorRules, scopedRules, explicitPaths, workingSetPaths, safeTotal } = input;

  const floorMust = floorRules.filter((f) => f.strength === "MUST");
  const floorShould = floorRules.filter((f) => f.strength === "SHOULD");

  const floorBlock = renderFloorBlock(floorMust);
  const marker = renderOverflowMarker();

  // MANDATORY: every scoped MUST that is applicable this turn, by ANY signal (§7.1/§7.2). The
  // ratified contract inverts the old droppable-MUST behavior: an applicable MUST matched by a
  // turn trigger or the working set is no longer best-effort. It is ordered ahead of every SHOULD
  // across ALL tiers, and if the mandatory set cannot be delivered we fail LOUD (never audit-drop
  // a MUST as `best-effort:did-not-fit`). Deduped by ruleId, ordered by match-signal strength:
  // explicit prompt path first (the user named the file), then turn trigger (the user's words),
  // then working set (dirty files, weakest signal). turnTierOrder is a stable id tiebreak here
  // since every member is a MUST.
  const explicitScopedMust = scopedRules.filter(
    (s) => s.strength === "MUST" && matchesAnyPath(s.globs, explicitPaths),
  );
  const turnMatchedMust = scopedRules
    .filter(
      (s) =>
        s.strength === "MUST" &&
        s.trigger !== undefined &&
        matchesTrigger(s.trigger, { prompt, explicitPaths }),
    )
    .sort(turnTierOrder);
  const workingSetMust = scopedRules.filter(
    (s) => s.strength === "MUST" && matchesAnyPath(s.globs, workingSetPaths),
  );
  const mandatoryScoped: ScopedRuleEntry[] = [];
  const mandatorySeen = new Set<string>();
  const pushMandatory = (arr: ScopedRuleEntry[]) => {
    for (const s of arr) {
      if (mandatorySeen.has(s.ruleId)) continue;
      mandatorySeen.add(s.ruleId);
      mandatoryScoped.push(s);
    }
  };
  pushMandatory(explicitScopedMust);
  pushMandatory(turnMatchedMust);
  pushMandatory(workingSetMust);

  // Base invariant: the non-rule context + global MUST floor must always fit, plus room for the
  // fail-loud overflow marker WHEN that marker is reachable. The marker is emitted only in the
  // §7.5 mandatory-overflow branch below, which is reachable iff at least one applicable scoped
  // MUST exists this turn. With none (a turn that only has SHOULD rules configured), reserving the
  // marker's bytes would be dead weight AND would wrongly force the whole turn to the bash
  // fallback; so a floor that fits base+floor but not base+floor+marker is delivered whole. With a
  // mandatory rule present we reserve conservatively, since it may overflow into the marker. SHOULD
  // rules are best-effort: they are packed only if they fit and audit-dropped otherwise, so they
  // never reserve marker capacity just by being configured.
  const reserveMarker = mandatoryScoped.length > 0;
  const invariantHead = reserveMarker
    ? joinSegments([base, floorBlock, marker])
    : joinSegments([base, floorBlock]);
  if (byteLength(invariantHead) > safeTotal) {
    throw new BaseInvariantError(byteLength(joinSegments([base, floorBlock])), safeTotal);
  }

  const mandatoryLines: ScopedLine[] = mandatoryScoped.map((s) => ({ text: s.text, strength: "MUST" }));

  const withMandatory = joinSegments([base, floorBlock, renderScopedBlock(mandatoryLines)]);
  if (byteLength(withMandatory) > safeTotal) {
    // §7.5 base-preserving fail-loud: emit base + global MUST floor + instructive marker, route the
    // exact mandatory IDs to out-of-band audit, never emit an arbitrary subset. This is the signal
    // the subcommand turns into a non-zero exit so the hook blocks (INV-DELIVERY): a run can never
    // report INJECTED while an applicable MUST went undelivered.
    const text = joinSegments([base, floorBlock, marker]);
    return {
      text,
      bytes: byteLength(text),
      overflow: true,
      delivered: floorMust.map((f) => ({ ruleId: f.ruleId, tier: "floor-must" as const })),
      omitted: mandatoryScoped.map((s) => ({
        ruleId: s.ruleId,
        reason: "overflow:required-scoped-did-not-fit",
      })),
    };
  }

  // BEST-EFFORT ladder (§4.3), SHOULD-ONLY now that every applicable MUST is mandatory above. In
  // fixed rank order; a rule appearing in several tiers is taken at its earliest (deduped by
  // ruleId). No MUST can reach this ladder.
  const explicitScopedShould = scopedRules.filter(
    (s) => s.strength === "SHOULD" && matchesAnyPath(s.globs, explicitPaths),
  );
  // Turn-matched SHOULD: rules whose TurnTrigger fired on this prompt / explicit paths, ranked
  // ABOVE working-set (the user's words beat dirty files) and BELOW explicit-path SHOULD. Stable
  // id order via turnTierOrder (all SHOULD here, so it degenerates to the id tiebreak).
  const turnMatchedShould = scopedRules
    .filter(
      (s) =>
        s.strength === "SHOULD" &&
        s.trigger !== undefined &&
        matchesTrigger(s.trigger, { prompt, explicitPaths }),
    )
    .sort(turnTierOrder);
  const workingSetScopedShould = scopedRules.filter(
    (s) => s.strength === "SHOULD" && matchesAnyPath(s.globs, workingSetPaths),
  );

  const seen = new Set(mandatorySeen);
  const candidates: Candidate[] = [];
  const pushScoped = (arr: ScopedRuleEntry[], strength: "MUST" | "SHOULD") => {
    for (const s of arr) {
      if (seen.has(s.ruleId)) continue;
      seen.add(s.ruleId);
      candidates.push({ channel: "scoped", ruleId: s.ruleId, line: { text: s.text, strength } });
    }
  };
  // 1. Explicit-path scoped SHOULD (a user-named path is a stronger signal than a keyword).
  pushScoped(explicitScopedShould, "SHOULD");
  // 2. Turn-matched SHOULD, above ALL working-set tiers.
  pushScoped(turnMatchedShould, "SHOULD");
  // 3. Global SHOULD (the Tier-0 droppable tail).
  for (const f of floorShould) {
    if (seen.has(f.ruleId)) continue;
    seen.add(f.ruleId);
    candidates.push({ channel: "floor-should", ruleId: f.ruleId, entry: f });
  }
  // 4. Working-set-only scoped SHOULD.
  pushScoped(workingSetScopedShould, "SHOULD");

  // Greedy fill: try each candidate against the FULL re-rendered envelope; keep it iff the
  // whole thing still fits, else log the omission and continue (a smaller later candidate may
  // still fit). Mandatory content is never revisited, so nothing can push it out.
  const acceptedFloorShould: FloorRuleEntry[] = [];
  const acceptedScopedLines: ScopedLine[] = [...mandatoryLines];
  const delivered: DeliveredRule[] = [
    ...floorMust.map((f) => ({ ruleId: f.ruleId, tier: "floor-must" as const })),
    ...mandatoryScoped.map((s) => ({ ruleId: s.ruleId, tier: "scoped-required" as const })),
  ];
  const omitted: OmittedRule[] = [];

  for (const c of candidates) {
    const trialFloorShould =
      c.channel === "floor-should" ? [...acceptedFloorShould, c.entry] : acceptedFloorShould;
    const trialScoped =
      c.channel === "scoped" ? [...acceptedScopedLines, c.line] : acceptedScopedLines;
    const trial = joinSegments([
      base,
      renderFloorBlock(floorMust, trialFloorShould),
      renderScopedBlock(trialScoped),
    ]);
    if (byteLength(trial) <= safeTotal) {
      if (c.channel === "floor-should") acceptedFloorShould.push(c.entry);
      else acceptedScopedLines.push(c.line);
      delivered.push({ ruleId: c.ruleId, tier: "best-effort" });
    } else {
      omitted.push({ ruleId: c.ruleId, reason: "best-effort:did-not-fit" });
    }
  }

  const text = joinSegments([
    base,
    renderFloorBlock(floorMust, acceptedFloorShould),
    renderScopedBlock(acceptedScopedLines),
  ]);
  return { text, bytes: byteLength(text), overflow: false, delivered, omitted };
}
