import {
  NOT_CAPTURED,
  NOT_RECORDED,
  renderDecisionRecordMarkdown,
  type DecisionRecord,
} from "../../src/lib/decision-record-markdown";

/**
 * ADR notes/20260717-adr-decision-record-projection-and-reconciliation.md, Phase 4 / T12.
 * The serializer's whole job is honesty about absence, so that is what these assert.
 */

function baseRecord(overrides: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    id: "cmt_1",
    status: "ACCEPTED",
    title: "Ship SSO in Q2 as the primary login",
    scope: "WORKSPACE",
    supersedes: [],
    supersededBy: [],
    acceptance: null,
    evidence: [],
    linkedCase: null,
    reconciliation: null,
    ...overrides,
  };
}

describe("renderDecisionRecordMarkdown", () => {
  it("is pure: the same DTO renders byte-identical output", () => {
    const record = baseRecord({
      acceptance: { by: "an@meetless.ai", at: "2026-07-22T10:00:00.000Z" },
    });
    expect(renderDecisionRecordMarkdown(record)).toBe(
      renderDecisionRecordMarkdown(record),
    );
  });

  it("prints the title, status, scope and record id from native values", () => {
    const md = renderDecisionRecordMarkdown(baseRecord());
    expect(md).toContain("# Ship SSO in Q2 as the primary login");
    expect(md).toContain("- **Status:** ACCEPTED");
    expect(md).toContain("- **Scope:** WORKSPACE");
    expect(md).toContain("- **Record:** `cmt_1`");
  });

  it("renders 'Not recorded' for a null acceptance (the finalization path)", () => {
    const md = renderDecisionRecordMarkdown(baseRecord({ acceptance: null }));
    expect(md).toContain(`- **Accepted:** ${NOT_RECORDED}`);
  });

  it("renders both halves of a complete acceptance stamp", () => {
    const md = renderDecisionRecordMarkdown(
      baseRecord({
        acceptance: { by: "an@meetless.ai", at: "2026-07-22T10:00:00.000Z" },
      }),
    );
    expect(md).toContain(
      "- **Accepted:** an@meetless.ai on 2026-07-22T10:00:00.000Z",
    );
  });

  it("renders 'Not captured' for every absent linked-case field", () => {
    const md = renderDecisionRecordMarkdown(baseRecord({ linkedCase: null }));
    for (const heading of ["What changed", "Rationale", "Impact"]) {
      expect(md).toContain(`## ${heading}\n\n${NOT_CAPTURED}`);
    }
  });

  it("surfaces linked-case fields under their OWN names and never remaps them (INV-2)", () => {
    const md = renderDecisionRecordMarkdown(
      baseRecord({
        linkedCase: {
          whatChanged: "SSO moved from Q3 to Q2.",
          rationale: null,
          impact: null,
        },
      }),
    );
    // whatChanged appears under "What changed"...
    expect(md).toContain("## What changed\n\nSSO moved from Q3 to Q2.");
    // ...and NOWHERE else. A Nygard "Context"/"Consequences" slot has no native
    // source, so it must not exist at all rather than borrow a neighbouring field.
    expect(md).not.toContain("## Context");
    expect(md).not.toContain("## Consequences");
    expect(md).not.toContain("## Decision\n");
    expect(md.match(/SSO moved from Q3 to Q2\./g)).toHaveLength(1);
    // The unset siblings stay honestly empty rather than inheriting whatChanged.
    expect(md).toContain(`## Rationale\n\n${NOT_CAPTURED}`);
    expect(md).toContain(`## Impact\n\n${NOT_CAPTURED}`);
  });

  it("treats a whitespace-only field as absent, not as content", () => {
    const md = renderDecisionRecordMarkdown(
      baseRecord({
        linkedCase: { whatChanged: "   ", rationale: "\n", impact: "" },
      }),
    );
    expect(md).toContain(`## What changed\n\n${NOT_CAPTURED}`);
    expect(md).toContain(`## Rationale\n\n${NOT_CAPTURED}`);
    expect(md).toContain(`## Impact\n\n${NOT_CAPTURED}`);
  });

  it("says a withheld evidence source is private and never offers a link (§4.5)", () => {
    const md = renderDecisionRecordMarkdown(
      baseRecord({
        evidence: [
          {
            citation: "ask_turn",
            sourceType: "ask_turn",
            url: null,
            provenanceBand: "origin",
            withheld: true,
          },
        ],
      }),
    );
    // The entry still exists, so the decision never reads as unsourced...
    expect(md).toContain("ask_turn");
    // ...but it is named as private, with no dereferenceable link.
    expect(md).toContain("private to its author; identity withheld from you");
    expect(md).not.toContain("http");
  });

  it("renders a disclosed evidence entry with its citation and url", () => {
    const md = renderDecisionRecordMarkdown(
      baseRecord({
        evidence: [
          {
            citation: "CC:case_9",
            sourceType: "coordination_case",
            url: "https://app.meetless.ai/cases/case_9",
            provenanceBand: "linked_case",
            withheld: false,
          },
        ],
      }),
    );
    expect(md).toContain("`CC:case_9`");
    expect(md).toContain("https://app.meetless.ai/cases/case_9");
    expect(md).not.toContain("withheld");
  });

  it("renders 'Not captured' when a decision has no evidence at all", () => {
    const md = renderDecisionRecordMarkdown(baseRecord({ evidence: [] }));
    expect(md).toContain(`## Evidence\n\n${NOT_CAPTURED}`);
  });

  it("renders supersession edges on both sides, and 'None' when there are none", () => {
    const md = renderDecisionRecordMarkdown(
      baseRecord({
        supersedes: [{ id: "cmt_0", title: "Defer SSO to Q3" }],
        supersededBy: [],
      }),
    );
    expect(md).toContain("## Supersedes\n\n- Defer SSO to Q3 (`cmt_0`)");
    expect(md).toContain("## Superseded by\n\nNone");
  });

  it("marks an unresolvable neighbour as 'Not captured', not as an empty bullet", () => {
    const md = renderDecisionRecordMarkdown(
      baseRecord({ supersedes: [{ id: "cmt_gone", title: null }] }),
    );
    expect(md).toContain(`- ${NOT_CAPTURED} (\`cmt_gone\`)`);
  });

  it("distinguishes 'no findings' from 'not the superseding decision'", () => {
    const withView = renderDecisionRecordMarkdown(
      baseRecord({ reconciliation: { findings: [] } }),
    );
    expect(withView).toContain("## Reconciliation\n\nNo findings.");

    const withoutView = renderDecisionRecordMarkdown(
      baseRecord({ reconciliation: null }),
    );
    expect(withoutView).toContain(
      "Not applicable (this record is not the superseding decision).",
    );
  });

  it("renders a reconciliation finding with its disposition and evaluated digest", () => {
    const md = renderDecisionRecordMarkdown(
      baseRecord({
        reconciliation: {
          findings: [
            {
              id: "ri_1",
              supersedingCommitmentId: "cmt_1",
              supersededCommitmentId: "cmt_0",
              disposition: "ACTIVE",
              artifactSnapshotId: "snap_1",
              evaluatedDigest: "abcdef0123456789",
            },
          ],
        },
      }),
    );
    expect(md).toContain("**ACTIVE** `ri_1`");
    expect(md).toContain("snap_1");
    expect(md).toContain("abcdef012345");
  });

  it("closes with the note that absence is native, so the skin is not oversold", () => {
    const md = renderDecisionRecordMarkdown(baseRecord());
    expect(md).toContain("the governed graph holds no native value");
    expect(md).toContain("nothing here is inferred, summarized or remapped");
    expect(md.endsWith("\n")).toBe(true);
  });
});
