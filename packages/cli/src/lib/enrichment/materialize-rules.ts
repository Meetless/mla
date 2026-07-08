// src/lib/enrichment/materialize-rules.ts
//
// The bridge from an accepted onboarding candidate to the mla-managed rule file
// (.meetless/rules.md). Memo Phase 1, line 535: "accepted DURABLE rules materialize into the
// managed file; accepted decisions enter governed knowledge and do NOT silently become rules."
// This is the one place that enforces that split (INV-AUTH-1 / INV-AUTH-2):
//   - constraint / convention / boundary  -> a durable RULE, materialized into the file.
//   - decision                            -> governed knowledge only; NEVER touches the file.
//   - deprecation                         -> a staleness signal, not an injected rule; skipped.
// The function is pure (text in, text out) so the required invariant test "accepting a decision
// does not modify the managed rules file" is a byte-equality assertion, and re-materializing the
// same accepted rule is idempotent (managed-rules upsert dedupes by content-derived id).
//
// Layering: enrichment depends on the scanner's managed-rules engine, never the reverse. The
// managed file stays dependency-light (it knows only ./types); this module owns the mapping.
import {
  ManagedRule,
  makeManagedRule,
  parseManagedRules,
  renderManagedRules,
  upsertManagedRule,
} from "../scanner/managed-rules";
import { EnrichmentCandidate, EnrichmentKind } from "./protocol";

// The CLI prints this verbatim after a materialize so the operator knows the rule is live in
// their own session immediately and that sharing it is an explicit, un-automated git step (the
// memo forbids mla from auto-committing or auto-pushing).
export const MATERIALIZE_SHARE_MESSAGE = "Effective locally. Commit and push to share with teammates.";

// The candidate kinds that are DURABLE repository rules (normative, always-on policy). A decision
// is a point-in-time choice that enters governed knowledge but is not an always-on rule
// (INV-AUTH-2); a deprecation is a staleness signal. Neither materializes into the rule file.
const DURABLE_RULE_KINDS: ReadonlySet<EnrichmentKind> = new Set(["constraint", "convention", "boundary"]);

export function isDurableRuleKind(kind: EnrichmentKind): boolean {
  return DURABLE_RULE_KINDS.has(kind);
}

// Why a candidate was NOT materialized, so the caller can report it honestly rather than dropping
// it silently. A decision/deprecation is "not_a_durable_rule"; an empty statement is "empty".
export type SkipReason = "not_a_durable_rule" | "empty_statement";

export interface MaterializeSkip {
  statement: string;
  kind: EnrichmentKind;
  reason: SkipReason;
}

export interface MaterializeResult {
  // The full new contents of the managed file. Byte-identical to the input when nothing durable
  // was accepted (the decision-only required test relies on this exact-equality property).
  text: string;
  // The managed rules that were added or updated by this materialize (post-upsert form).
  materialized: ManagedRule[];
  // Accepted candidates that were intentionally not materialized, each with its reason.
  skipped: MaterializeSkip[];
  // True iff `text` differs from the input text (the caller writes only when this is true).
  changed: boolean;
}

// Pull the rule's provenance out of its evidence so the materialized rule keeps a citation back to
// the source the scout grounded it in. File evidence contributes its path; commit evidence
// contributes `commit:<sha>`. Deduped + sorted downstream by makeManagedRule.
function candidateSources(candidate: EnrichmentCandidate): string[] {
  return candidate.evidence.map((ev) => (ev.type === "file" ? ev.path : `commit:${ev.commit}`));
}

// Map one durable-rule candidate to a ManagedRule. Strength defaults to the conservative
// SHOULD_FOLLOW: an onboarding candidate carries no explicit MUST signal, and only an explicit
// human escalation should earn must-follow injection (memo: "only an explicit MUST"). Scope is
// repository-wide (candidates carry no glob today); a future scoped-rule signal slots in here.
export function candidateToManagedRule(candidate: EnrichmentCandidate): ManagedRule {
  return makeManagedRule({
    statement: candidate.statement,
    strength: "SHOULD_FOLLOW",
    sources: candidateSources(candidate),
  });
}

// Materialize the accepted candidates into the managed file content. `existingText` is the current
// file (pass "" when it does not exist yet). The result is a full re-render, so ordering is
// deterministic and the write is idempotent regardless of how many times the same rule is accepted.
export function materializeRules(
  existingText: string,
  accepted: readonly EnrichmentCandidate[],
): MaterializeResult {
  let rules = parseManagedRules(existingText);
  const materialized: ManagedRule[] = [];
  const skipped: MaterializeSkip[] = [];

  for (const c of accepted) {
    if (!c.statement || c.statement.trim().length === 0) {
      skipped.push({ statement: c.statement ?? "", kind: c.kind, reason: "empty_statement" });
      continue;
    }
    if (!isDurableRuleKind(c.kind)) {
      // A decision or deprecation: governed knowledge / staleness, never an always-on rule.
      skipped.push({ statement: c.statement, kind: c.kind, reason: "not_a_durable_rule" });
      continue;
    }
    const rule = candidateToManagedRule(c);
    rules = upsertManagedRule(rules, rule);
    materialized.push(rule);
  }

  // Re-render from the (possibly unchanged) rule set. When nothing durable was accepted, parsing
  // then re-rendering the original could differ from the raw input only by formatting; to make the
  // "decision does not modify the file" guarantee exact, short-circuit to the original bytes when
  // no rule was materialized.
  if (materialized.length === 0) {
    return { text: existingText, materialized, skipped, changed: false };
  }
  const text = renderManagedRules(rules);
  return { text, materialized, skipped, changed: text !== existingText };
}
