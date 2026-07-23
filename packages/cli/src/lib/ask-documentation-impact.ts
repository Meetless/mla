// "Documentation impact" for `mla ask` (ADR §3.5 T11d,
// notes/20260717-adr-decision-record-projection-and-reconciliation.md).
//
// You asked a question. The answer cited a governed decision. This repo contains an instruction
// file that still contradicts that exact decision. That is worth one line, because you are about to
// act on the answer while an agent reading the file will act on the opposite.
//
// The join is deliberately NARROW: a finding surfaces only when the answer actually cited the case
// the finding came from. The alternative (print every live finding on every ask) was rejected on
// §7's own kill criterion: this rides an always-on surface with no feature flag, so noise is the
// thing that gets the whole feature reverted. A user who wants the full set has `mla context list`.
//
// The join key is the `[CC:<id>]` coordination-case citation intel emits inline in the answer
// prose, matched against each finding's `sourceCaseId`. It is prose-scraped rather than read off a
// structured field because ask-core's response normalizer drops citation IDs (it maps citations to
// path/title/docType/...), and widening that contract would change what the MCP sees too, for one
// optional line in one CLI command.
import type { ReconciliationFinding } from "./scanner/types";

// What the ask surface prints, and what rides in `--json` under `documentationImpact`.
//
// Deliberately three fields. `currentSummary` (the stale text the file still asserts) and
// `detectorExplanation` (a probabilistic read) are the untrusted-data and advisory bands: the hook's
// injection block can carry them because it labels each band, but plain CLI stdout has no band
// mechanism and is routinely piped straight into an agent. So this surface carries only the
// GOVERNED band plus the file to open. The stale text is in that file, where the reader can judge
// it in context.
export interface DocumentationImpactItem {
  // Repo-relative instruction file that still contradicts the cited decision.
  path: string;
  // The coordination case the decision was made in; always one the answer cited.
  sourceCaseId: string;
  // The decision's current statement, as served by control. The truth to act on.
  acceptedStatement: string;
}

// Coordination-case citations as they appear inline in answer prose: `[CC:<id>]`. The prefix match
// is case-insensitive (a model may lowercase it) but the captured id is compared verbatim, because
// case ids are case-sensitive.
const CASE_CITATION = /\[CC:([^\]\s]+)\]/gi;

/**
 * The set of coordination-case ids the answer prose cites. Empty for a non-prose mode (`search`),
 * an abstention, or an answer that grounded on notes alone.
 */
export function citedCaseIds(answer: unknown): Set<string> {
  const out = new Set<string>();
  if (typeof answer !== "string" || !answer) return out;
  for (const m of answer.matchAll(CASE_CITATION)) {
    const id = m[1]?.trim();
    if (id) out.add(id);
  }
  return out;
}

/**
 * Intersect this repo's live reconciliation findings with the cases the answer cited.
 *
 * Pure. Input order is preserved, and a (path, case) pair appears at most once so a case cited
 * three times in one answer still yields one line per file. A finding with no `sourceCaseId` cannot
 * be joined to anything and is silently skipped; so is one with no `acceptedStatement`, which is the
 * same rule the injection renderer applies (no governed band, nothing to assert).
 */
export function documentationImpact(
  answer: unknown,
  findings: ReconciliationFinding[],
): DocumentationImpactItem[] {
  const cited = citedCaseIds(answer);
  if (cited.size === 0) return [];
  const seen = new Set<string>();
  const out: DocumentationImpactItem[] = [];
  for (const f of findings) {
    const caseId = f.sourceCaseId?.trim();
    const statement = f.acceptedStatement?.trim();
    if (!caseId || !statement || !cited.has(caseId)) continue;
    const key = `${f.path}\u0000${caseId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ path: f.path, sourceCaseId: caseId, acceptedStatement: statement });
  }
  return out;
}
