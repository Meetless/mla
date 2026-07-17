// The byte-budgeted context assembler (targeted-rule-injection §4.1-§4.4). This is the
// SINGLE owner of the model-facing UserPromptSubmit envelope: it takes the required
// non-rule context, the structured floor + scoped rules, and the per-prompt path signals,
// and returns the exact-byte envelope plus an audit of what was delivered vs dropped.
//
// PURE: no I/O, no clock, no persistence. The subcommand (P2) feeds it a rendered `base`,
// the scan-cache arrays, the extracted explicit paths, and the working set; it renders the
// blocks, budgets the best-effort tail, and never lets a best-effort rule push a required
// one out. The one glob matcher is shared with Plane B enforcement (§4.7), so a rule surfaced
// in the prompt and a rule enforced at the tool boundary agree on what its globs match.
//
// Design invariants (all enforced here, not by harness truncation or rule ordering):
//   - REQUIRED content is ALWAYS delivered whole: the non-rule BASE + the global MUST floor +
//     every applicable scoped MUST (matched by explicit path, turn trigger, OR working set,
//     ordered ahead of every SHOULD across ALL tiers, §7.1). There is NO harness inline cap to
//     truncate it (measured: additionalContext is forwarded verbatim), so the byte budget for
//     the best-effort tail EXPANDS to whatever the required set needs: budget = max(SAFE_TOTAL,
//     requiredBytes). A required MUST is never withheld, degraded, or replaced by a marker
//     because the floor outgrew a self-imposed number.
//   - Only SHOULD rules are BEST-EFFORT: they fill the remaining capacity ABOVE the required
//     floor (up to `budget`) in a fixed rank order, and every dropped SHOULD is logged with its
//     ruleId + reason. On a turn where the required set already meets or exceeds SAFE_TOTAL there
//     is no slack, so every SHOULD is dropped and only the required set rides.

import { FloorRuleEntry, ScopedRuleEntry } from "./types";
import type { TurnTrigger } from "../rules/types";
import { matchesGlob } from "../rules/glob-match";
import { ScopedLine, renderFloorBlock, renderScopedBlock } from "./render";

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

// The per-turn cost meter (audit 6.G / 7.10). PURE NUMBERS, no rule ids, no text, no paths:
// this is the one struct that crosses the analytics boundary, so it is built to satisfy the
// PostHog projector's fail-closed allowlist by construction (numbers and booleans only).
//
// It exists because the always-on floor is a TAX. Every rule on it is re-billed to every user
// on every turn forever, and until now nobody could say how large that tax was, which meant
// nobody could say whether scoping (the whole point of Tier 1) was actually buying anything.
// `ambientBytes` is the recurring cost; `avoidedBytes` is the counterfactual saving, i.e. what
// the SAME rules would have cost this turn had they all been ambient instead of scoped. The
// ratio of the two is the scoping ROI, and it is the number the pricing model needs.
export interface AssembleMeter {
  // The non-rule preamble (LAYER1). Not a rule cost; the denominator's floor.
  baseBytes: number;
  // THE TAX: the rendered floor block (global MUSTs + any accepted global SHOULD tail),
  // including its wrapper. Injected on EVERY turn regardless of what the user asked.
  ambientBytes: number;
  // How many rules that block carried (MUST + accepted SHOULD).
  ambientRules: number;
  // The scoped block actually delivered this turn, including its wrapper (0 when nothing matched).
  scopedBytes: number;
  scopedRules: number;
  // How many scoped rules are CONFIGURED in the cache (the pool scoping selects from). The gap
  // between this and scopedRules is what scoping suppressed.
  scopedConfigured: number;
  // The counterfactual: bytes of configured scoped rules that did NOT ride this turn, measured in
  // the scoped block's own wire format. This is the saving scoping bought: a rule that did not
  // match its globs did not ride, so its bytes are what ambient delivery would have cost. (It is
  // never a loss now that every applicable MUST is always delivered; `overflow` is permanently
  // false, so a savings tile no longer has to exclude any turn.)
  avoidedBytes: number;
  // Best-effort SHOULD rules dropped because they did not fit the remaining budget above the
  // required floor. A required MUST is never counted here; it always rides.
  omittedRules: number;
  // The final head, base + floor + scoped. Always <= budget = max(safeTotal, requiredBytes), which
  // means it MAY exceed safeTotal when the required set alone does (there is no harness cap to hit).
  headBytes: number;
}

export interface AssembleOutput {
  // The complete envelope to emit as UserPromptSubmit additionalContext.
  text: string;
  // UTF-8 byte length of `text` (always <= budget = max(safeTotal, requiredBytes)).
  bytes: number;
  // Retired, permanently false. It once signalled the §7.5 fail-loud path, where a required
  // scoped set that overran SAFE_TOTAL was replaced by a marker and the turn was blocked. That
  // path is gone: required content is never withheld, so a required MUST can no longer overflow.
  // The field is kept so the downstream meter/audit/hook plumbing stays a dormant, typed safety
  // net rather than being ripped out (it never fires, but it is still valid if it ever did).
  overflow: boolean;
  delivered: DeliveredRule[];
  omitted: OmittedRule[];
  // Per-turn rule-cost meter (6.G). Numbers only; safe to ship to analytics verbatim.
  meter: AssembleMeter;
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

  const mandatoryLines: ScopedLine[] = mandatoryScoped.map((s) => ({ text: s.text, strength: "MUST" }));

  // The counterfactual for the scoping meter (6.G): what EVERY configured scoped rule would cost
  // if it all rode this turn. Rendered through the SAME block renderer as the delivered set, so
  // the block wrapper is counted identically on both sides and the subtraction below is exact
  // (renderScopedBlock returns "" for an empty list, so a zero-scoped turn subtracts 0 - 0 = 0).
  const baseBytes = byteLength(base);
  const allScopedBytes = byteLength(
    renderScopedBlock(scopedRules.map((s) => ({ text: s.text, strength: s.strength }))),
  );

  const withMandatory = joinSegments([base, floorBlock, renderScopedBlock(mandatoryLines)]);
  // The budget for the best-effort SHOULD tail. REQUIRED content (base + global MUST floor + every
  // applicable scoped MUST) is delivered whole no matter its size: there is no harness inline cap to
  // truncate it (additionalContext is forwarded verbatim), so when the required set alone meets or
  // exceeds SAFE_TOTAL the budget expands to exactly the required bytes and the SHOULD tail gets no
  // slack. Below that, the budget is SAFE_TOTAL and the tail fills the room the required set left.
  // This replaced the old §7.5 fail-loud path: a required MUST is never withheld, degraded, or
  // replaced by a marker, so `overflow` can never fire and the turn is never blocked for budget.
  const requiredBytes = byteLength(withMandatory);
  const budget = Math.max(safeTotal, requiredBytes);

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

  // Greedy fill: try each SHOULD candidate against the FULL re-rendered envelope; keep it iff the
  // whole thing still fits the budget, else log the omission and continue (a smaller later candidate
  // may still fit). Mandatory content is never revisited, so nothing can push it out; and since the
  // budget already covers the required set, the first trial is `requiredBytes + one SHOULD line`,
  // never a comparison that could evict a MUST.
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
    if (byteLength(trial) <= budget) {
      if (c.channel === "floor-should") acceptedFloorShould.push(c.entry);
      else acceptedScopedLines.push(c.line);
      delivered.push({ ruleId: c.ruleId, tier: "best-effort" });
    } else {
      omitted.push({ ruleId: c.ruleId, reason: "best-effort:did-not-fit" });
    }
  }

  const finalFloorBlock = renderFloorBlock(floorMust, acceptedFloorShould);
  const finalScopedBlock = renderScopedBlock(acceptedScopedLines);
  const text = joinSegments([base, finalFloorBlock, finalScopedBlock]);
  const scopedBytes = byteLength(finalScopedBlock);
  return {
    text,
    bytes: byteLength(text),
    overflow: false,
    delivered,
    omitted,
    meter: {
      baseBytes,
      ambientBytes: byteLength(finalFloorBlock),
      ambientRules: floorMust.length + acceptedFloorShould.length,
      scopedBytes,
      scopedRules: acceptedScopedLines.length,
      scopedConfigured: scopedRules.length,
      // What scoping SAVED this turn: the configured scoped rules that did not match. Clamped at
      // 0 because the delivered set is a subset of the configured set, so the difference cannot go
      // negative unless a future caller feeds the assembler a delivered rule it never configured.
      avoidedBytes: Math.max(0, allScopedBytes - scopedBytes),
      omittedRules: omitted.length,
      headBytes: byteLength(text),
    },
  };
}
