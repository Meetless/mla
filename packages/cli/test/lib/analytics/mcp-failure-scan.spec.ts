import {
  scanTranscriptForFailedMcpPulls,
  sliceCurrentTurn,
  type FailedPullRow,
} from "../../../src/lib/analytics/mcp-failure-scan";
import { computePullSummary } from "../../../src/lib/analytics/pull";
import { parseMcpCalls } from "../../../src/lib/analytics/followthrough";

// D3 (session be3cbc73, 2026-08-08): a REFUSED evidence pull is invisible to every
// measurement surface mla has.
//
// THE MECHANISM, as measured rather than as proposed. The audit note filed this as
// "the mcp-calls row has no outcome field", and the fix it recommended was to write
// the already-computed `classify_mcp_outcome` verdict onto that row. That fix would
// have changed nothing, because the row does not exist:
//
//   Claude Code does NOT fire PostToolUse at all when a tool result carries
//   is_error:true.
//
// Verified live on 2026-08-09 against the running harness: `mcp-calls.jsonl` held
// 1773 rows, a deliberately-invalid retrieve_knowledge was issued and refused, and
// the file still held 1773 rows. Session be3cbc73 is the same shape from the other
// end -- its transcript carries TWO `retrieve_knowledge` results with is_error:true
// ("intel is unreachable"), and the ledger carries exactly ONE row for that whole
// session: the turn-3 pull that SUCCEEDED.
//
// So `classify_mcp_outcome`'s "error" arm is unreachable in production. The write
// site never runs for the case it was written to describe.
//
// THE FIX follows the backstop pattern stop.sh already uses twice (the
// AskUserQuestion decision scan and the enforcement-outcome correlator): what the
// live hook could not see, the Stop hook recovers from the transcript, which IS the
// ground truth and is already read there. This module is that scan.
//
// It appends ONLY refusals. A successful pull still gets its row from PostToolUse in
// real time, so the two writers cannot collide, and a legacy row (written before
// `tool_use_id` existed) is never a dedup target because a legacy row is by
// construction a success.

const TURN = 7;
const SESSION = "be3cbc73-301a-4cec-b265-c5aea9a67543";

function assistantToolUse(id: string, name: string, input: unknown): object {
  return {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
  };
}

function toolResult(toolUseId: string, isError: boolean, content: string): object {
  return {
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, is_error: isError, content }],
    },
  };
}

// The two real refusals from be3cbc73 turn 1, verbatim tool_use ids and error body.
const REFUSAL_BODY = JSON.stringify({
  tool: "meetless__retrieve_knowledge",
  error:
    "retrieval temporarily unavailable: intel is unreachable (the connection failed); retry shortly",
  category: "unavailable",
});

describe("D3: a refused governed pull leaves a countable row", () => {
  it("emits a row for an MCP evidence pull whose result was is_error (the case PostToolUse never sees)", () => {
    const transcript = [
      assistantToolUse("toolu_01Rj9HW8jLBPPYTzQq7mq1uF", "mcp__meetless__meetless__retrieve_knowledge", {
        query: "MLA durable product doctrine",
      }),
      toolResult("toolu_01Rj9HW8jLBPPYTzQq7mq1uF", true, REFUSAL_BODY),
    ];

    const rows = scanTranscriptForFailedMcpPulls(transcript, {
      sessionId: SESSION,
      turnIndex: TURN,
      known: new Set<string>(),
      ts: "2026-08-08T02:12:11Z",
    });

    expect(rows).toHaveLength(1);
    const row = rows[0] as FailedPullRow;
    expect(row.event).toBe("tool_used_mcp");
    expect(row.session_id).toBe(SESSION);
    expect(row.turn_index).toBe(TURN);
    expect(row.tool).toBe("retrieve_knowledge");
    expect(row.evidence_tool).toBe(true);
    expect(row.outcome).toBe("error");
    expect(row.tool_use_id).toBe("toolu_01Rj9HW8jLBPPYTzQq7mq1uF");
    // The refusal returned no evidence, and the row must say so with an EMPTY list
    // rather than by omitting the field: "returned nothing" is now readable only
    // alongside `outcome`, and a missing field would be a fact about us.
    expect(row.source_ids).toEqual([]);
  });

  it("does not re-emit a refusal already in the ledger (idempotent across repeated Stops)", () => {
    const transcript = [
      assistantToolUse("toolu_A", "mcp__meetless__meetless__retrieve_knowledge", { query: "q" }),
      toolResult("toolu_A", true, REFUSAL_BODY),
    ];
    const rows = scanTranscriptForFailedMcpPulls(transcript, {
      sessionId: SESSION,
      turnIndex: TURN,
      known: new Set(["toolu_A"]),
      ts: "2026-08-08T02:12:11Z",
    });
    expect(rows).toEqual([]);
  });

  it("ignores a SUCCESSFUL pull: PostToolUse already wrote that row in real time", () => {
    const transcript = [
      assistantToolUse("toolu_B", "mcp__meetless__meetless__retrieve_knowledge", { query: "q" }),
      toolResult("toolu_B", false, JSON.stringify({ candidates: [] })),
    ];
    expect(
      scanTranscriptForFailedMcpPulls(transcript, {
        sessionId: SESSION,
        turnIndex: TURN,
        known: new Set<string>(),
        ts: "2026-08-08T02:12:11Z",
      }),
    ).toEqual([]);
  });

  it("ignores a failed NON-meetless tool: a Bash exit 1 is not a governed pull", () => {
    const transcript = [
      assistantToolUse("toolu_C", "Bash", { command: "false" }),
      toolResult("toolu_C", true, "Exit code 1"),
    ];
    expect(
      scanTranscriptForFailedMcpPulls(transcript, {
        sessionId: SESSION,
        turnIndex: TURN,
        known: new Set<string>(),
        ts: "2026-08-08T02:12:11Z",
      }),
    ).toEqual([]);
  });

  it("marks relationship_verdict evidence_tool=false: an ACTION that failed is not a refused pull", () => {
    const transcript = [
      assistantToolUse("toolu_D", "mcp__meetless__meetless__relationship_verdict", { id: "x" }),
      toolResult("toolu_D", true, JSON.stringify({ error: "nope" })),
    ];
    const rows = scanTranscriptForFailedMcpPulls(transcript, {
      sessionId: SESSION,
      turnIndex: TURN,
      known: new Set<string>(),
      ts: "2026-08-08T02:12:11Z",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].evidence_tool).toBe(false);
  });

  it("recovers BOTH refusals of be3cbc73 turn 1, which is the whole finding", () => {
    const transcript = [
      assistantToolUse("toolu_01Rj9HW8jLBPPYTzQq7mq1uF", "mcp__meetless__meetless__retrieve_knowledge", {
        query: "enrich trace observability plane privacy",
      }),
      assistantToolUse("toolu_01M9SKhqEpd7saTLdJob2Lkd", "mcp__meetless__meetless__retrieve_knowledge", {
        query: "enrich trace privacy posture",
      }),
      toolResult("toolu_01Rj9HW8jLBPPYTzQq7mq1uF", true, REFUSAL_BODY),
      toolResult("toolu_01M9SKhqEpd7saTLdJob2Lkd", true, REFUSAL_BODY),
    ];
    const rows = scanTranscriptForFailedMcpPulls(transcript, {
      sessionId: SESSION,
      turnIndex: 1,
      known: new Set<string>(),
      ts: "2026-08-08T02:12:11Z",
    });
    expect(rows.map((r) => r.tool_use_id)).toEqual([
      "toolu_01Rj9HW8jLBPPYTzQq7mq1uF",
      "toolu_01M9SKhqEpd7saTLdJob2Lkd",
    ]);
    expect(rows.every((r) => r.outcome === "error")).toBe(true);
  });

  it("carries the query so a refusal is as diagnosable as a success", () => {
    const transcript = [
      assistantToolUse("toolu_E", "mcp__meetless__meetless__retrieve_knowledge", {
        query: "MLA durable product doctrine",
      }),
      toolResult("toolu_E", true, REFUSAL_BODY),
    ];
    const rows = scanTranscriptForFailedMcpPulls(transcript, {
      sessionId: SESSION,
      turnIndex: TURN,
      known: new Set<string>(),
      ts: "2026-08-08T02:12:11Z",
    });
    expect(rows[0].query).toBe("MLA durable product doctrine");
  });

  it("survives a malformed transcript entry rather than losing the whole scan", () => {
    const transcript = [
      { type: "assistant", message: null },
      "not-an-object" as unknown as object,
      { type: "user", message: { content: "a plain string, not an array" } },
      assistantToolUse("toolu_F", "mcp__meetless__meetless__query", { question: "q" }),
      toolResult("toolu_F", true, REFUSAL_BODY),
    ];
    const rows = scanTranscriptForFailedMcpPulls(transcript as object[], {
      sessionId: SESSION,
      turnIndex: TURN,
      known: new Set<string>(),
      ts: "2026-08-08T02:12:11Z",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].tool).toBe("query");
  });
});

function userPrompt(text: string): object {
  return { type: "user", message: { role: "user", content: [{ type: "text", text }] } };
}

// Bounding the scan to the turn is what makes the turn stamp honest AND what stops a
// long session from re-emitting an old refusal once the ledger tail has scrolled past
// its row. Both failure modes are silent, so they get their own tests.
describe("D3: the scan is bounded to the turn Stop is closing", () => {
  it("drops a PRIOR turn's refusal, so the stamp is never a turn late by construction", () => {
    const transcript = [
      userPrompt("turn 1: audit the thing"),
      assistantToolUse("toolu_OLD", "mcp__meetless__meetless__retrieve_knowledge", { query: "old" }),
      toolResult("toolu_OLD", true, REFUSAL_BODY),
      userPrompt("turn 2: now do something else"),
      assistantToolUse("toolu_NEW", "mcp__meetless__meetless__retrieve_knowledge", { query: "new" }),
      toolResult("toolu_NEW", true, REFUSAL_BODY),
    ];
    const rows = scanTranscriptForFailedMcpPulls(sliceCurrentTurn(transcript), {
      sessionId: SESSION,
      turnIndex: 2,
      known: new Set<string>(),
      ts: "2026-08-08T02:12:11Z",
    });
    expect(rows.map((r) => r.tool_use_id)).toEqual(["toolu_NEW"]);
  });

  it("does not treat a tool_result entry as a new prompt: those are user-role too", () => {
    // The exact trap the intra-turn narration capture had to solve. If a tool_result
    // counted as a turn boundary, every refusal would be sliced away from the tool_use
    // that names it and the scan would silently return nothing forever.
    const transcript = [
      userPrompt("one prompt, several tools"),
      assistantToolUse("toolu_1", "Bash", { command: "ls" }),
      toolResult("toolu_1", false, "ok"),
      assistantToolUse("toolu_2", "mcp__meetless__meetless__retrieve_knowledge", { query: "q" }),
      toolResult("toolu_2", true, REFUSAL_BODY),
    ];
    const rows = scanTranscriptForFailedMcpPulls(sliceCurrentTurn(transcript), {
      sessionId: SESSION,
      turnIndex: 4,
      known: new Set<string>(),
      ts: "2026-08-08T02:12:11Z",
    });
    expect(rows.map((r) => r.tool_use_id)).toEqual(["toolu_2"]);
  });

  it("returns the whole transcript when no user prompt has been seen yet", () => {
    const transcript = [
      assistantToolUse("toolu_X", "mcp__meetless__meetless__query", { question: "q" }),
      toolResult("toolu_X", true, REFUSAL_BODY),
    ];
    expect(sliceCurrentTurn(transcript)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// The consumer half of D3. The note named this cost explicitly: once refusals land
// in the ledger, `source_ids: []` has TWO meanings (found nothing / never ran), and
// every read site needs the outcome in its filter or a refusal silently reads as a
// pull that came back empty.
// ---------------------------------------------------------------------------

describe("D3 consumers: a refusal must not read as a pull that found nothing", () => {
  it("parseMcpCalls surfaces outcome, and treats a legacy row as unknown rather than inventing success", () => {
    const parsed = parseMcpCalls([
      { session_id: "s", turn_index: 1, evidence_tool: true, source_ids: [], query: "q", tool: "retrieve_knowledge", outcome: "error" },
      // A row written before the field existed. 1773 of these are on disk today.
      { session_id: "s", turn_index: 2, evidence_tool: true, source_ids: ["NT:a.md"], query: "q", tool: "retrieve_knowledge" },
    ]);
    expect(parsed[0].outcome).toBe("error");
    expect(parsed[1].outcome).toBe("unknown");
  });

  it("computePullSummary excludes a refusal from the pull denominator, so the historical rate stays comparable", () => {
    const succeeded = { session_id: "s", turn_index: 1, evidence_tool: true, source_ids: ["NT:a.md"], query: "q", tool: "retrieve_knowledge", outcome: "success" as const };
    const refused = { session_id: "s", turn_index: 1, evidence_tool: true, source_ids: [], query: "q", tool: "retrieve_knowledge", outcome: "error" as const };

    const withoutRefusal = computePullSummary([succeeded], []);
    const withRefusal = computePullSummary([succeeded, refused], []);

    // Adding a refusal must not change what the pull rate says about pulls that RAN.
    // `empty_pull_calls` is "a retrieval miss, in the open" -- a refusal is not a miss,
    // it is an absence of retrieval, and conflating them is precisely D3.
    expect(withRefusal.pull_calls).toBe(withoutRefusal.pull_calls);
    expect(withRefusal.empty_pull_calls).toBe(withoutRefusal.empty_pull_calls);
    expect(withRefusal.pull_reference_followthrough).toBe(
      withoutRefusal.pull_reference_followthrough,
    );
    // ... and it must be countable on its own arm, which is the entire point of D3.
    expect(withRefusal.refused_pull_calls).toBe(1);
    expect(withoutRefusal.refused_pull_calls).toBe(0);
  });
});
