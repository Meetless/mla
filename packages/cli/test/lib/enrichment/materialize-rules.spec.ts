// test/lib/enrichment/materialize-rules.spec.ts
//
// The accept -> managed-file bridge (memo Phase 1, line 535). These tests pin the authority split
// (durable rules materialize, decisions never do = INV-AUTH-1 / INV-AUTH-2), the exact-bytes
// guarantee for a decision-only batch (a required Phase 1 test), idempotent re-materialize, and
// faithful source provenance.
import {
  MATERIALIZE_SHARE_MESSAGE,
  candidateToManagedRule,
  isDurableRuleKind,
  materializeRules,
} from "../../../src/lib/enrichment/materialize-rules";
import { renderManagedRules, parseManagedRules } from "../../../src/lib/scanner/managed-rules";
import { EnrichmentCandidate, EnrichmentKind } from "../../../src/lib/enrichment/protocol";

function candidate(over: Partial<EnrichmentCandidate> & { kind: EnrichmentKind; statement: string }): EnrichmentCandidate {
  return {
    evidence: [{ type: "file", path: "CLAUDE.md", startLine: 1, endLine: 3 }],
    sourceScout: "documentation",
    ...over,
  };
}

describe("isDurableRuleKind", () => {
  it("treats constraint, convention, and boundary as durable rules", () => {
    expect(isDurableRuleKind("constraint")).toBe(true);
    expect(isDurableRuleKind("convention")).toBe(true);
    expect(isDurableRuleKind("boundary")).toBe(true);
  });

  it("treats decision and deprecation as NOT durable rules", () => {
    expect(isDurableRuleKind("decision")).toBe(false);
    expect(isDurableRuleKind("deprecation")).toBe(false);
  });
});

describe("candidateToManagedRule", () => {
  it("maps a durable candidate to a conservative SHOULD_FOLLOW repo-wide rule with cited sources", () => {
    const rule = candidateToManagedRule(
      candidate({
        kind: "constraint",
        statement: "Use 127.0.0.1, not localhost, on macOS.",
        evidence: [
          { type: "file", path: "docs/macos.md", startLine: 10, endLine: 12 },
          { type: "commit", commit: "abc123", path: "net.ts" },
        ],
      }),
    );
    expect(rule.strength).toBe("SHOULD_FOLLOW"); // only an explicit human MUST earns must-follow
    expect(rule.scope).toEqual([]); // repository-wide
    expect(rule.sources).toEqual(["commit:abc123", "docs/macos.md"]); // sorted + deduped
    expect(rule.statement).toBe("Use 127.0.0.1, not localhost, on macOS.");
  });
});

describe("materializeRules", () => {
  it("materializes a durable rule into a fresh file and reports the change", () => {
    const result = materializeRules("", [
      candidate({ kind: "convention", statement: "Prefer relative imports." }),
    ]);
    expect(result.changed).toBe(true);
    expect(result.materialized).toHaveLength(1);
    expect(result.skipped).toHaveLength(0);
    expect(result.text).toContain("Prefer relative imports.");
    expect(result.text).toContain("# Repository rules");
    // The rendered file round-trips back to exactly the materialized rule.
    expect(parseManagedRules(result.text).map((r) => r.statement)).toEqual(["Prefer relative imports."]);
  });

  // The load-bearing required test (memo line 499): accepting a DECISION must not modify the file.
  it("leaves the file byte-identical when only a decision is accepted (INV-AUTH-2)", () => {
    const existing = renderManagedRules([]);
    const result = materializeRules(existing, [
      candidate({ kind: "decision", statement: "We chose Postgres SKIP LOCKED over SQS." }),
    ]);
    expect(result.changed).toBe(false);
    expect(result.text).toBe(existing); // exact bytes
    expect(result.materialized).toHaveLength(0);
    expect(result.skipped).toEqual([
      { statement: "We chose Postgres SKIP LOCKED over SQS.", kind: "decision", reason: "not_a_durable_rule" },
    ]);
  });

  it("leaves a populated file untouched when only a decision is accepted", () => {
    const existing = materializeRules("", [
      candidate({ kind: "constraint", statement: "Never commit secrets." }),
    ]).text;
    const result = materializeRules(existing, [
      candidate({ kind: "decision", statement: "We picked Cloud Run over a VM." }),
    ]);
    expect(result.changed).toBe(false);
    expect(result.text).toBe(existing);
  });

  it("skips a deprecation candidate (staleness signal, not an injected rule)", () => {
    const result = materializeRules("", [
      candidate({ kind: "deprecation", statement: "apps/api is decommissioned." }),
    ]);
    expect(result.changed).toBe(false);
    expect(result.skipped[0].reason).toBe("not_a_durable_rule");
  });

  it("skips an empty statement with an empty_statement reason", () => {
    const result = materializeRules("", [candidate({ kind: "constraint", statement: "   " })]);
    expect(result.changed).toBe(false);
    expect(result.skipped).toEqual([{ statement: "   ", kind: "constraint", reason: "empty_statement" }]);
  });

  it("materializes the durable rules and skips the decisions from a mixed batch", () => {
    const result = materializeRules("", [
      candidate({ kind: "constraint", statement: "Never log PII." }),
      candidate({ kind: "decision", statement: "We chose a soft gate first." }),
      candidate({ kind: "boundary", statement: "control owns the state machine." }),
      candidate({ kind: "deprecation", statement: "agent/ is superseded by intel." }),
    ]);
    expect(result.materialized.map((r) => r.statement).sort()).toEqual([
      "Never log PII.",
      "control owns the state machine.",
    ]);
    expect(result.skipped.map((s) => s.statement).sort()).toEqual([
      "We chose a soft gate first.",
      "agent/ is superseded by intel.",
    ]);
    // Only the two durable rules are present in the file.
    expect(parseManagedRules(result.text)).toHaveLength(2);
  });

  // Re-accepting the same rule must converge: materialize once, then materialize the same candidate
  // against the produced file, and the file is byte-identical (managed-rules dedupes by content id).
  it("is idempotent: re-materializing the same rule does not change the file", () => {
    const c = candidate({ kind: "convention", statement: "Two spaces, never tabs." });
    const first = materializeRules("", [c]);
    const second = materializeRules(first.text, [c]);
    expect(second.text).toBe(first.text);
    // `changed` reflects whether the bytes moved: the rule was re-upserted but produced no diff.
    expect(second.changed).toBe(false);
  });

  it("merges a new source into an existing rule when the same statement is accepted from a second scout", () => {
    const a = materializeRules("", [
      candidate({
        kind: "constraint",
        statement: "Use pnpm, not npm.",
        evidence: [{ type: "file", path: "CLAUDE.md", startLine: 1, endLine: 1 }],
      }),
    ]);
    const b = materializeRules(a.text, [
      candidate({
        kind: "constraint",
        statement: "Use pnpm, not npm.",
        evidence: [{ type: "commit", commit: "deadbeef" }],
      }),
    ]);
    const rules = parseManagedRules(b.text);
    expect(rules).toHaveLength(1);
    expect(rules[0].sources).toEqual(["CLAUDE.md", "commit:deadbeef"]);
    expect(b.changed).toBe(true); // a new source is a real change
  });

  it("exposes the effective-locally share message for the CLI to print", () => {
    expect(MATERIALIZE_SHARE_MESSAGE).toContain("Effective locally");
    expect(MATERIALIZE_SHARE_MESSAGE).toContain("Commit and push to share");
  });
});
