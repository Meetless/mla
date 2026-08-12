import { computePullSummary } from "../../../src/lib/analytics/pull";
import { McpCall, ReportCitation } from "../../../src/lib/analytics/followthrough";

// THE PULL PATH, MEASURED.
//
// The dashboard reports only the PUSH path: what the hook injected and whether the
// agent referenced it. Measured over one real session, every unit of value came
// from the other channel -- two agent-initiated `retrieve_knowledge` calls, both of
// which changed the implementation -- and Injection Utilization is structurally
// blind to it, because it counts pushes.
//
// WHAT THIS DOES NOT CLAIM. A pull that RETURNED RESULTS is not evidence that the
// pull helped. Over this machine's real trace files, 1567 of 1677 evidence-tool
// calls came back non-empty, and 67 of 4308 session-unique returned references were
// ever cited afterwards. If "returned something" counted as helpful the number
// would read 93%; the observable one reads 1.6%. So the only follow-through
// statement here is the mechanical one: a returned reference that the agent's own
// report later CITED, in the same session, at the same turn or after.
//
// No new telemetry: mcp-calls.jsonl (tool, evidence_tool, source_ids) and
// report-citations.jsonl (source_ids) are already written by the hooks and already
// parsed by parseMcpCalls / parseReportCitations. This module only joins them.

function call(p: Partial<McpCall> & { session_id: string; turn_index: number }): McpCall {
  return {
    evidence_tool: true,
    source_ids: [],
    query: "",
    tool: "retrieve_knowledge",
    ...p,
  };
}

function cite(session_id: string, turn_index: number, source_ids: string[]): ReportCitation {
  return { session_id, turn_index, source_ids };
}

describe("computePullSummary", () => {
  it("counts calls, splits empty from non-empty, and counts documents both ways", () => {
    const s = computePullSummary(
      [
        call({ session_id: "a", turn_index: 1, source_ids: ["NT:x.md", "NT:y.md"] }),
        call({ session_id: "a", turn_index: 2, source_ids: ["NT:x.md"] }), // dup doc
        call({ session_id: "a", turn_index: 3, source_ids: [] }), // empty
      ],
      [],
    );
    expect(s.pull_calls).toBe(3);
    expect(s.non_empty_pull_calls).toBe(2);
    expect(s.empty_pull_calls).toBe(1);
    expect(s.documents_returned).toBe(3); // with duplicates
    expect(s.unique_documents_returned).toBe(2); // NT:x.md counted once
  });

  it("counts a returned reference as followed through only when the report later CITES it", () => {
    const s = computePullSummary(
      [
        call({ session_id: "a", turn_index: 1, source_ids: ["NT:used.md", "NT:ignored.md"] }),
      ],
      [cite("a", 2, ["NT:used.md"])],
    );
    expect(s.returned_references).toBe(2);
    expect(s.returned_references_cited).toBe(1);
    expect(s.pull_reference_followthrough).toBeCloseTo(0.5);
  });

  it("does NOT count a citation that PRECEDES the pull", () => {
    // A citation on an earlier turn cannot have come from this pull. Counting it
    // would let a document the agent already knew inflate the pull's follow-through.
    const s = computePullSummary(
      [call({ session_id: "a", turn_index: 5, source_ids: ["NT:x.md"] })],
      [cite("a", 3, ["NT:x.md"])],
    );
    expect(s.returned_references_cited).toBe(0);
    expect(s.pull_reference_followthrough).toBe(0);
  });

  it("counts a citation on the SAME turn as the pull", () => {
    const s = computePullSummary(
      [call({ session_id: "a", turn_index: 4, source_ids: ["NT:x.md"] })],
      [cite("a", 4, ["NT:x.md"])],
    );
    expect(s.returned_references_cited).toBe(1);
  });

  it("never joins across sessions", () => {
    const s = computePullSummary(
      [call({ session_id: "a", turn_index: 1, source_ids: ["NT:x.md"] })],
      [cite("b", 2, ["NT:x.md"])],
    );
    expect(s.returned_references_cited).toBe(0);
  });

  it("normalizes ids the same way the push join does, so NT:foo.md and NT:foo collapse", () => {
    const s = computePullSummary(
      [call({ session_id: "a", turn_index: 1, source_ids: ["NT:notes/Foo.md"] })],
      [cite("a", 2, ["nt:notes/foo"])],
    );
    expect(s.unique_documents_returned).toBe(1);
    expect(s.returned_references_cited).toBe(1);
  });

  it("ignores non-evidence tools: an adjudication is an ACTION, not a retrieval", () => {
    // relationship_verdict / dismiss_conflict / decision_record are already counted
    // as governed catches. Letting them into the pull denominator would double-count
    // them and would misdescribe an action as a document lookup.
    const s = computePullSummary(
      [
        call({ session_id: "a", turn_index: 1, evidence_tool: false, tool: "relationship_verdict" }),
        call({ session_id: "a", turn_index: 1, source_ids: ["NT:x.md"] }),
      ],
      [],
    );
    expect(s.pull_calls).toBe(1);
  });

  it("breaks calls down by tool, so retrieve_knowledge is not conflated with query", () => {
    const s = computePullSummary(
      [
        call({ session_id: "a", turn_index: 1, tool: "retrieve_knowledge", source_ids: ["NT:x"] }),
        call({ session_id: "a", turn_index: 2, tool: "kb_doc_detail", source_ids: ["NT:x"] }),
        call({ session_id: "a", turn_index: 3, tool: "query", source_ids: [] }),
      ],
      [],
    );
    // Descending by count, then alphabetical, so a tie renders identically twice.
    expect(s.by_tool).toEqual([
      { tool: "kb_doc_detail", count: 1 },
      { tool: "query", count: 1 },
      { tool: "retrieve_knowledge", count: 1 },
    ]);
    const ranked = computePullSummary(
      [
        call({ session_id: "a", turn_index: 1, tool: "query", source_ids: ["NT:x"] }),
        call({ session_id: "a", turn_index: 2, tool: "retrieve_knowledge", source_ids: ["NT:x"] }),
        call({ session_id: "a", turn_index: 3, tool: "retrieve_knowledge", source_ids: ["NT:y"] }),
      ],
      [],
    );
    expect(ranked.by_tool[0]).toEqual({ tool: "retrieve_knowledge", count: 2 });
  });

  it("reports null (not 0%) when nothing was pulled, so an empty window is not a failure", () => {
    const s = computePullSummary([], []);
    expect(s.pull_calls).toBe(0);
    expect(s.pull_reference_followthrough).toBeNull();
  });

  it("returns a whole-number follow-through only from OBSERVED citations, never from result counts", () => {
    // 100 non-empty calls, 100 returned refs, zero citations: follow-through is 0,
    // not 100%. This is the assertion that keeps "it returned results" out of the
    // helpfulness claim.
    const calls = Array.from({ length: 100 }, (_, i) =>
      call({ session_id: "a", turn_index: i + 1, source_ids: [`NT:doc-${i}.md`] }),
    );
    const s = computePullSummary(calls, []);
    expect(s.non_empty_pull_calls).toBe(100);
    expect(s.returned_references).toBe(100);
    expect(s.returned_references_cited).toBe(0);
    expect(s.pull_reference_followthrough).toBe(0);
  });
});
