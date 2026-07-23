/**
 * Pure DecisionRecord -> Markdown serializer (ADR
 * notes/20260717-adr-decision-record-projection-and-reconciliation.md, Phase 4 / T12).
 *
 * ONE function, not a `format` switch inside a renderer and not per-consumer rendering.
 * It takes the canonical `DecisionRecordDto` that control's single assembler produces
 * and returns a string. No I/O, no clock, no network: given the same DTO it returns the
 * same bytes, which is what makes it testable and what lets a caller diff two exports.
 *
 * Two honesty constraints from the ADR, both load-bearing:
 *
 * 1. NO FIELD REMAPPING (§3.4, INV-2). The decision entity has no native rationale,
 *    impact or consequence fields. Those live only on a linked SCOPE_CHANGE case, and
 *    many decisions have none. `case.whatChanged` is NOT a Nygard "Context" and is never
 *    printed under one. Each field surfaces under its OWN name or not at all.
 *
 * 2. ABSENCE IS PRINTED, NEVER SYNTHESIZED. A section with no native source renders the
 *    literal "Not captured"; a decision accepted on the finalization path renders
 *    "Not recorded" for its stamp. The renderer owns those strings precisely so the DTO
 *    can stay native-nullable (an agent tests `acceptance === null`, not a label).
 *
 * The consequence is that most exports legitimately read mostly "Not captured". That is
 * the true state of the graph, not a serializer defect, and the trailing note says so
 * rather than letting the shape of an ADR imply a richness the record does not have.
 */

export interface DecisionRecordCommitmentRef {
  id: string;
  title: string | null;
}

export interface DecisionRecordAcceptance {
  by: string | null;
  at: string | null;
}

export interface DecisionRecordEvidenceRef {
  citation: string;
  sourceType: string | null;
  url: string | null;
  provenanceBand: string | null;
  withheld: boolean;
}

export interface DecisionRecordLinkedCase {
  whatChanged: string | null;
  rationale: string | null;
  impact: string | null;
}

export interface DecisionRecordFindingRef {
  id: string;
  supersedingCommitmentId: string;
  supersededCommitmentId: string;
  disposition: string;
  artifactSnapshotId: string | null;
  evaluatedDigest: string | null;
}

export interface DecisionRecord {
  id: string;
  status: "ACCEPTED" | "SUPERSEDED" | string;
  title: string;
  scope: string | null;
  supersedes: DecisionRecordCommitmentRef[];
  supersededBy: DecisionRecordCommitmentRef[];
  acceptance: DecisionRecordAcceptance | null;
  evidence: DecisionRecordEvidenceRef[];
  linkedCase: DecisionRecordLinkedCase | null;
  reconciliation: { findings: DecisionRecordFindingRef[] } | null;
}

/** The two absence markers. Verbatim, never a synthesized stand-in. */
export const NOT_CAPTURED = "Not captured";
export const NOT_RECORDED = "Not recorded";

function text(value: string | null | undefined): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length > 0 ? trimmed : NOT_CAPTURED;
}

function refLine(ref: DecisionRecordCommitmentRef): string {
  // A null title means the neighbor row is unresolvable (purged), not that it was
  // never titled; say so instead of printing an empty bullet.
  const title = ref.title && ref.title.trim() ? ref.title.trim() : NOT_CAPTURED;
  return `- ${title} (\`${ref.id}\`)`;
}

function acceptanceLine(acceptance: DecisionRecordAcceptance | null): string {
  if (!acceptance) return NOT_RECORDED;
  const by = acceptance.by && acceptance.by.trim() ? acceptance.by.trim() : null;
  const at = acceptance.at && acceptance.at.trim() ? acceptance.at.trim() : null;
  if (!by && !at) return NOT_RECORDED;
  if (by && at) return `${by} on ${at}`;
  return by ? `${by} (time ${NOT_RECORDED.toLowerCase()})` : `${at} (accepter ${NOT_RECORDED.toLowerCase()})`;
}

function evidenceLine(ref: DecisionRecordEvidenceRef): string {
  const band = ref.provenanceBand ? ` [${ref.provenanceBand}]` : "";
  if (ref.withheld) {
    // §4.5: the evidence EXISTS, its identity does not belong to this reader. Say the
    // source is private. Never offer a link, and never let the entry vanish, which
    // would make a governed decision read as unsourced.
    return `- ${ref.citation}${band} (private to its author; identity withheld from you)`;
  }
  const url = ref.url && ref.url.trim() ? ` ${ref.url.trim()}` : "";
  const kind = ref.sourceType ? ` (${ref.sourceType})` : "";
  return `- \`${ref.citation}\`${kind}${band}${url}`;
}

function findingLine(f: DecisionRecordFindingRef): string {
  const digest = f.evaluatedDigest ? f.evaluatedDigest.slice(0, 12) : NOT_CAPTURED;
  const artifact = f.artifactSnapshotId ?? NOT_CAPTURED;
  return `- **${f.disposition}** \`${f.id}\` (artifact snapshot ${artifact}, evaluated at digest ${digest})`;
}

function section(heading: string, body: string): string[] {
  return [`## ${heading}`, "", body, ""];
}

function list(heading: string, lines: string[], empty: string): string[] {
  return section(heading, lines.length > 0 ? lines.join("\n") : empty);
}

/**
 * Serialize a DecisionRecord to Markdown. Pure: same DTO in, same bytes out.
 */
export function renderDecisionRecordMarkdown(record: DecisionRecord): string {
  const out: string[] = [];

  out.push(`# ${record.title.trim() || NOT_CAPTURED}`, "");
  out.push(`- **Status:** ${record.status}`);
  out.push(`- **Scope:** ${record.scope ?? NOT_CAPTURED}`);
  out.push(`- **Accepted:** ${acceptanceLine(record.acceptance)}`);
  out.push(`- **Record:** \`${record.id}\``, "");

  out.push(
    ...list("Supersedes", record.supersedes.map(refLine), "None"),
    ...list("Superseded by", record.supersededBy.map(refLine), "None"),
  );

  // The linked SCOPE_CHANGE case's own fields under their OWN names. When no case is
  // linked, all three are absent at the source, so all three print the marker; the
  // headings still appear so the reader can tell "asked and absent" from "not asked".
  out.push(
    ...section("What changed", text(record.linkedCase?.whatChanged)),
    ...section("Rationale", text(record.linkedCase?.rationale)),
    ...section("Impact", text(record.linkedCase?.impact)),
  );

  out.push(...list("Evidence", record.evidence.map(evidenceLine), NOT_CAPTURED));

  const findings = record.reconciliation?.findings ?? [];
  out.push(
    ...list(
      "Reconciliation",
      findings.map(findingLine),
      record.reconciliation
        ? "No findings."
        : "Not applicable (this record is not the superseding decision).",
    ),
  );

  out.push("---", "");
  out.push(
    `"${NOT_CAPTURED}" means the governed graph holds no native value for that field, ` +
      "not that the value was lost. A decision carries rationale, impact and " +
      "what-changed only when a SCOPE_CHANGE case is linked to it; nothing here is " +
      "inferred, summarized or remapped from a neighboring field.",
  );

  return `${out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}
