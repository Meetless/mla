import { Directive, FloorRuleEntry, StaleSignal, directiveId } from "./types";

const STOP_CARD_CAP = 5;

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// A managed rule is a single-line imperative. Collapse any stray internal newline (and
// the surrounding whitespace) to one space so the rule stays exactly one `- ` bullet and
// cannot break the compact block structure. Mirrors the floor-projection body collapse.
function oneLine(s: string): string {
  return s.trim().replace(/\s*\n\s*/g, " ");
}

// Strongest authority wins when the same rule is attested by several files:
// human attestation outranks machine inference, and within that MUST outranks
// SHOULD. Mirrors the must-follow derivation in renderConfirmedRulesXml.
function authorityRank(d: Directive): number {
  return (d.attestation === "human_attested" ? 2 : 0) + (d.strength === "MUST_FOLLOW" ? 1 : 0);
}

// Each per-service CLAUDE.md repeats the same boilerplate (e.g. "Never log
// sensitive data"), so the raw directive list carries one copy per file. The
// grounding pack only needs the rule once: extra copies waste the inline
// additionalContext budget the first-run block competes for and dilute signal.
// Collapse by rule text, keeping the strongest authority and unioning the
// source paths so provenance survives. Singletons pass through untouched, and
// first-occurrence order is preserved for a stable, diffable pack.
export function dedupeDirectives(dirs: Directive[]): Directive[] {
  const groups = new Map<string, Directive[]>();
  const order: string[] = [];
  for (const d of dirs) {
    const g = groups.get(d.text);
    if (g) {
      g.push(d);
    } else {
      groups.set(d.text, [d]);
      order.push(d.text);
    }
  }
  return order.map((text) => {
    const group = groups.get(text)!;
    if (group.length === 1) return group[0];
    const strongest = group.reduce((best, d) => (authorityRank(d) > authorityRank(best) ? d : best));
    const source = [...new Set(group.map((d) => d.source))].sort().join(",");
    return { ...strongest, source, id: directiveId(source, text) };
  });
}

export function renderConfirmedRulesXml(dirs: Directive[]): string {
  if (!dirs.length) return "";
  const lines = dirs.map((d) => {
    const authority =
      d.attestation === "human_attested" && d.strength === "MUST_FOLLOW" ? "must-follow" : "should-follow";
    return `  <rule source="${esc(d.source)}" authority="${authority}">${esc(d.text)}</rule>`;
  });
  return `<confirmed-rules>\n${lines.join("\n")}\n</confirmed-rules>`;
}

// A directive is a FLOOR rule iff it is (1) must-follow (human_attested + MUST) AND
// (2) a workspace-global rule from the backend rule bundle (`rule-bundle`, curated by
// a human via `mla rules`). Per-subsystem CLAUDE.md MUSTs are deliberately excluded:
// they are "repo-wide" today only because nobody has scoped them, and promoting all
// ~40 of them would blow the inline budget. They stay in the once-per-session pack
// until they carry real globs. dedupe may union sources (comma-joined), so membership
// is a token test, not string equality.
//
// D1 (targeted-rule-injection §4.2): the old text-prefix gate `!CONDITIONAL_PREAMBLE`
// is RETIRED. Classification is a total function over (strength, scope, tool-only)
// only; it never parses rule prose. A global MUST that opens with "When…"/"If…" is a
// self-contained imperative whose condition the model self-evaluates, so it belongs on
// the always-on floor, not a prose-sniffed tail. Path scoping is expressed by real
// globs (Tier 1 scoped), never by an English preamble.
export function isFloorRule(d: Directive): boolean {
  const mustFollow = d.attestation === "human_attested" && d.strength === "MUST_FOLLOW";
  const global = d.source
    .split(",")
    .map((s) => s.trim())
    .includes("rule-bundle");
  return mustFollow && global;
}

// The always-on FLOOR block: the tiny set of workspace-global MUST rules that must
// ride in EVERY turn's ~2KB inline window (measured harness cap), emitted right after
// the static floor and BEFORE the variable evidence/context blocks. Kept deliberately
// small (see isFloorRule) so `LAYER1 + floorRules` stays under the cap; a budget gate
// in the hot-path hook alarms if it ever grows past it. Returns the complete
// meetless-context block ready to print verbatim, or "" when there are no floor rules.
// The temporal-precedence contract (matrix doc, correction #4). This VISIBLE line
// (not an HTML comment, which Claude Code strips before injecting instructions) tells
// the model the hook block is authoritative and outranks the static `.claude/rules`
// projection a subagent-capable session may also be holding. "Complete" means a rule
// omitted from this block is no longer part of the current floor.
export const FLOOR_PRECEDENCE_SENTENCE =
  "This block is the complete current MLA floor snapshot and supersedes all earlier " +
  "MLA floor snapshots and generated projections.";

// The compact floor block (targeted-rule-injection §4.8 wire format). Block-level
// `trust="must-follow"` carries the authority, so per-rule attributes are dropped and
// each rule is one imperative `- ` bullet. Global SHOULD rules (the Tier-0 droppable
// tail, best-effort) self-downgrade with an explicit `[SHOULD]` label; unlabeled lines
// inherit the block's must-follow trust. Text is XML-escaped so a rule payload cannot
// close the envelope early. Returns "" when there is nothing to render.
function floorContextBlock(mustTexts: string[], shouldTexts: string[]): string {
  const lines = [
    ...mustTexts.map((t) => `- ${esc(oneLine(t))}`),
    ...shouldTexts.map((t) => `- [SHOULD] ${esc(oneLine(t))}`),
  ];
  if (!lines.length) return "";
  return `<meetless-context kind="floor-rules" trust="must-follow">\n${FLOOR_PRECEDENCE_SENTENCE}\n${lines.join("\n")}\n</meetless-context>`;
}

// Entry-based floor renderer for the byte-budgeted assembler. `must` are the always-on
// global MUST rules (Tier 0, required); `should` are the global SHOULD tail (best-effort,
// re-rendered as the assembler greedily fits them). Rule identities are cache/audit-only
// and never reach the wire, so only the text is rendered.
export function renderFloorBlock(must: FloorRuleEntry[], should: FloorRuleEntry[] = []): string {
  return floorContextBlock(
    must.map((e) => e.text),
    should.map((e) => e.text),
  );
}

// The compact floor block the bash-fallback hot path emits (schemaVersion-1 caches, or
// when the assembler subcommand is unavailable). MUST-only by construction: `isFloorRule`
// admits only human-attested MUST bundle rules, so the fallback never carries a SHOULD tail.
export function renderFloorRulesXml(dirs: Directive[]): string {
  return floorContextBlock(
    dirs.filter(isFloorRule).map((d) => d.text),
    [],
  );
}

// One rendered scoped line: the imperative plus its explicit strength label. Scoped rules
// mix MUST (required when explicit-path matched) and SHOULD (best-effort) in the same block,
// so unlike the floor block the strength is carried per line, not implied by the wrapper.
export interface ScopedLine {
  text: string;
  strength: "MUST" | "SHOULD";
}

// The compact scoped block (targeted-rule-injection §4.8). Path-scoped rules matched for
// this prompt, each as `- [MUST]/[SHOULD] text`. No block-level trust: the per-line label
// is the authority. Text is XML-escaped. Returns "" when no scoped rule matched.
export function renderScopedBlock(lines: ScopedLine[]): string {
  if (!lines.length) return "";
  const body = lines.map((l) => `- [${l.strength}] ${esc(oneLine(l.text))}`).join("\n");
  return `<meetless-context kind="scoped-rules">\n${body}\n</meetless-context>`;
}

// The base-preserving fail-loud marker (targeted-rule-injection §4.4). Emitted in place of
// the scoped block when the required explicit-path scoped MUST set will not fit alongside
// the universal base. INSTRUCTIVE (tells the model what to do), not a bare count; the exact
// ruleIds + paths go to out-of-band audit and never consume the byte budget. The template is
// fixed so its size is a compile-time constant the base invariant reserves room for.
export const OVERFLOW_MARKER_TEXT =
  "Required scoped rules could not be delivered for this multi-path request. " +
  "Do not make file changes. Narrow the task to fewer explicit paths.";
export function renderOverflowMarker(): string {
  return `<meetless-context kind="delivery-overflow" trust="must-follow">\n${OVERFLOW_MARKER_TEXT}\n</meetless-context>`;
}

// Cache-state degradation markers (targeted-rule-injection §6). These make a degraded
// delivery VISIBLE to the model rather than passing off floor-only as a normal success:
// after activation, a cache that cannot deliver scoped rules must SAY SO, so the model does
// not assume the absence of a scoped rule means the rule does not exist.
//
// `scoped delivery unavailable`: the installed cache predates scoped delivery (old schema)
// but the bulk compat path is already gone. Floor still rides; scoped rules exist in the
// governed set but this cache cannot surface them until it is rescanned to the current schema.
export const SCOPED_UNAVAILABLE_MARKER_TEXT =
  "Scoped (path-specific) rules are not available this turn: the local rule cache is stale " +
  "and must be rescanned (mla scan). Treat path-specific guidance as possibly missing; do not " +
  "assume a rule is absent because it was not surfaced here.";
export function renderScopedUnavailableMarker(): string {
  return `<meetless-context kind="scoped-unavailable" trust="must-follow">\n${SCOPED_UNAVAILABLE_MARKER_TEXT}\n</meetless-context>`;
}

// `incomplete delivery`: the local rule cache is missing or unreadable and there is no usable
// last-known-good, so neither floor nor scoped delivery can be trusted this turn.
export const INCOMPLETE_DELIVERY_MARKER_TEXT =
  "Rule delivery is incomplete this turn: the local rule cache is missing or unreadable " +
  "(run mla scan). Some MUST/should rules may not be surfaced here; do not assume a rule is " +
  "absent because it was not shown.";
export function renderIncompleteDeliveryMarker(): string {
  return `<meetless-context kind="delivery-incomplete" trust="must-follow">\n${INCOMPLETE_DELIVERY_MARKER_TEXT}\n</meetless-context>`;
}

export function renderStaleContextXml(signals: StaleSignal[]): string {
  if (!signals.length) return "";
  const lines = signals.map((s) => `  <item source="${esc(s.source)}">${esc(s.detail)}</item>`);
  return `<possible-stale-context>\n${lines.join("\n")}\n</possible-stale-context>`;
}

// Reference renderer for the stop-hook review card. Kept for a future TypeScript
// stop path and intentionally not wired into stop.sh: the hot path stays jq-only
// to honor INV-1 (no Node spawn on the prompt-path hooks).
export function renderStopCard(signals: StaleSignal[]): string {
  if (!signals.length) return "Meetless observed this run. No new review items.";
  const shown = signals.slice(0, STOP_CARD_CAP);
  const rows = shown.map((s) => `  [Review] ${s.detail}\n           accept: mla context accept ${s.id}`);
  const extra = signals.length - shown.length;
  const tail = extra > 0 ? `\n  ...and ${extra} more (mla context list).` : "";
  return `Meetless observed this run.\n${rows.join("\n")}${tail}`;
}
