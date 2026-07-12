import { createHash } from "node:crypto";
import type { TurnTrigger } from "../rules/types";

export type DirectiveKind = "RULE"; // P0A only mints RULE; POLICY/CONSTRAINT/PROCEDURE land with the scout (P1)
export type Strength = "MUST_FOLLOW" | "SHOULD_FOLLOW";
export type Attestation = "human_attested" | "machine_inferred";

export interface Directive {
  id: string;
  text: string;
  source: string; // repo-relative path
  kind: DirectiveKind;
  strength: Strength;
  attestation: Attestation;
  globs?: string[]; // populated for .claude/rules entries (T3)
  // A turn trigger, threaded from a governed `turn`-mode bundle rule (targeted-rule-injection
  // §5.4). Present iff this directive is a turn rule; it routes the directive to `scopedRules`
  // (never the always-on floor) and drives the assembler's per-turn best-effort match. Absent
  // on ambient and file-sourced directives.
  trigger?: TurnTrigger;
  // Governed rule identities, threaded from the backend bundle entry so the scan cache,
  // shared matcher, overflow audit, and best-effort omission log can name a rule by its
  // durable identity rather than a content hash. Absent on file-sourced directives
  // (.claude/rules, per-service CLAUDE.md), which fall back to the content-hash `id`.
  ruleNodeId?: string;
  ruleVersionId?: string;
  // The `ruleVersionId`s of other directives that were folded into THIS one during dedup
  // under exact canonical identity (targeted-rule-injection §7.3). When two directives carry
  // identical injected authority (same NFC text + strength + resolved applicability), the
  // dedup keeps one survivor and records the losers' versions here, so the delivery audit can
  // honestly report an absorbed MUST as REPRESENTED_BY_RULE_VERSION(survivor) rather than lost.
  // Absent when nothing was absorbed.
  representedVersionIds?: string[];
}

export type StaleReason = "adr_superseded" | "frontmatter_deprecated" | "frontmatter_superseded";

export interface StaleSignal {
  id: string;
  source: string;
  reason: StaleReason;
  detail: string; // human-readable one-liner
  supersededBy?: string;
}

export interface ScanInventory {
  instructionFiles: number;
  decisionDocs: number;
  legacyNotes: number;
  staleSignals: number;
  agentMemoryRules: number; // advisory rules discovered in the untracked agent auto-memory. A fresh scan always sets it; readers of a pre-M1 on-disk cache must guard with `?? 0`.
}

// Currency + provenance of the floor block, surfaced INTO the scan cache so the
// zero-Node hot-path hook (jq only) can stamp a delivery receipt without re-reading
// the principal-bound bundle. `freshness` is the currency axis (matrix doc): a floor
// sourced from a stale-but-usable bundle is still delivered and still MUST_FOLLOW, so
// `stale` is a valid emitting state, distinct from `missing` (no usable bundle -> no
// floor emitted). `bundleHash` is the floor BODY hash (identical to the projection's
// payloadHash by construction), the shared identity the hook receipt and the on-disk
// projection key on. Optional: absent in caches written before this landed.
export interface FloorMeta {
  bundleId: string; // "rev-<n>" | "unavailable" (provenance only)
  bundleHash: string | null; // sha256 of the floor body; null when no floor rules
  freshness: "fresh" | "stale" | "missing";
}

// The scan-cache schema version. The targeted-rule-injection assembler branches on this
// (the cache-state degradation table): a cache written by the pre-scoped scanner reports an
// older version and lacks the structured floor/scoped arrays, so the assembler chooses a
// degraded, VISIBLE delivery state rather than silently dropping required rules. Bump this
// whenever the assembler-facing shape of ScanResult changes.
//  1: pre-scoped (confirmedRulesXml + floorRulesXml only)
//  2: adds structured floorRules[] + scopedRules[] with rule identities
export const SCAN_SCHEMA_VERSION = 2;

// A structured floor rule: a workspace-global rule the assembler renders into the always-on
// floor block. MUST entries are REQUIRED (must fit every turn); SHOULD entries are the
// droppable global tail (best-effort). Identities are cache/audit-only; the wire render omits
// them. `strength` is the short wire form (MUST/SHOULD), mapped from Directive.strength once.
export interface FloorRuleEntry {
  ruleId: string;
  versionId: string;
  text: string;
  strength: "MUST" | "SHOULD";
  // Versions of other rules this entry canonically represents (§7.3), threaded from the
  // deduped directive. Cache/audit-only; never rendered. Absent when nothing was absorbed.
  representedVersionIds?: string[];
}

// A structured scoped rule: a rule matched per-turn rather than delivered on the always-on
// floor. Two match signals, one struct: `globs` (matched against explicit prompt paths, required
// when a MUST matches, and the working set, best-effort) and `trigger` (a turn trigger matched
// against this turn's prompt + explicit paths, always best-effort). A pure glob rule has an empty
// `trigger`; a pure turn rule has empty `globs`. Both may be present (the rule matches on either).
export interface ScopedRuleEntry {
  ruleId: string;
  versionId: string;
  text: string;
  strength: "MUST" | "SHOULD";
  globs: string[];
  trigger?: TurnTrigger;
  // Versions of other rules this entry canonically represents (§7.3), threaded from the
  // deduped directive. Cache/audit-only; never rendered. Absent when nothing was absorbed.
  representedVersionIds?: string[];
}

export interface ScanResult {
  // Widened from the `1` literal to `number` so old on-disk caches (which carry
  // schemaVersion: 1 and no structured arrays) parse into this type and the assembler can
  // branch on the value. Fresh scans stamp SCAN_SCHEMA_VERSION.
  schemaVersion: number;
  workspaceId: string;
  commitSha: string;
  generatedAt: string;
  inventory: ScanInventory;
  directives: Directive[];
  staleSignals: StaleSignal[];
  confirmedRulesXml: string; // pre-rendered, ready for the hot path
  // The always-on FLOOR block: workspace-global MUST rules the hot-path hook emits on
  // EVERY turn (not once-per-session), sized to fit the harness inline cap. Empty when
  // there are no eligible floor rules. Readers of a pre-floor on-disk cache must guard
  // with `?? ""` (the field is absent in caches written before this landed).
  floorRulesXml: string;
  // Structured floor + scoped rules for the byte-budgeted assembler (targeted rule injection).
  // `floorRulesXml` remains the compact pre-rendered floor block the bash fallback emits when
  // the assembler subcommand is unavailable; these arrays are what the assembler consumes to
  // compute the exact-byte envelope (matching, required/best-effort budgeting, audit). Optional:
  // absent in a pre-v2 on-disk cache; readers guard with `?? []`.
  floorRules?: FloorRuleEntry[];
  scopedRules?: ScopedRuleEntry[];
  // Currency + provenance for the floor block (see FloorMeta). Optional: absent in a
  // pre-floorMeta on-disk cache, so the hook guards with `.floorMeta.freshness // "fresh"`.
  floorMeta?: FloorMeta;
  staleContextXml: string;
  // Advisory rules distilled from the untracked agent auto-memory (machine_inferred).
  // Surfaced for human review; deliberately kept OUT of confirmedRulesXml (never auto-injected
  // as must-follow). A fresh scan always sets it; readers of a pre-M1 on-disk cache must guard with `?? []`.
  advisoryDirectives: Directive[];
}

export interface Verdicts {
  schemaVersion: 1;
  accepted: string[]; // StaleSignal ids the user confirmed
  dismissed: string[]; // StaleSignal ids the user rejected
}

export function directiveId(source: string, text: string): string {
  return createHash("sha256").update(`${source} ${text}`).digest("hex").slice(0, 12);
}
