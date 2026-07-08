import { renderPacket, type ReviewPacketView } from "../../src/lib/render";

// Phase 1 (RCA 20260531) redesigned `mla review` from a verdict-bearing "review
// packet" into a no-verdict "capture ledger". INV-T3 / §5.3 / §5.4: the CLI
// renders NO approve/reject/recommendation and NO verification/risks/summary
// verdict sections for an agent-session capture. These tests LOCK that removal:
// even when the wire still carries the old fields (a packet written by an older
// control build, or a not-yet-migrated row), the renderer must refuse to surface
// them. The reviewable artifacts live in the Console queues; this surface is a
// deterministic capture snapshot, never a sign-off.

function basePacket(): ReviewPacketView {
  return {
    id: "pkt_1",
    workspaceId: "ws_an_local",
    runId: "run_1",
    status: "ready",
    synthesisStatus: null,
    synthesisCompletedAt: null,
    facts: { branch: "main", changedFiles: ["src/a.ts", "src/b.ts"] },
    bashEvents: [],
    missingEvidence: [],
    agentClaimsRaw: null,
    recommendation: null,
    recommendedNextPrompt: null,
    summary: null,
    agentClaimsParsed: null,
    verification: null,
    risks: null,
    intelTraceId: null,
    intelTraceError: null,
    warnings: [],
  };
}

describe("renderPacket capture-ledger framing (INV-T3 / §5.4)", () => {
  it("renders a Capture Ledger header that is explicitly not a verdict", () => {
    const out = renderPacket(basePacket());
    expect(out).toContain("Meetless Capture Ledger");
    expect(out).toContain("No verdict is rendered here");
    expect(out).not.toContain("Review Packet");
  });

  it("renders NO recommendation line even when the wire carries one (INV-T3)", () => {
    const p = basePacket();
    p.recommendation = "approve";
    const out = renderPacket(p);
    expect(out).not.toMatch(/recommendation/i);
    expect(out).not.toMatch(/\bapprove\b/i);
    expect(out).not.toMatch(/\breject\b/i);
  });

  // Mission deletion (PR1, Correction 5): the "Recommended next prompt" steering
  // block is the lone surviving review-steering output. Its template embeds
  // "Continue mission <X>", so it both nags the operator and hard-codes the
  // Mission concept we are deleting. The renderer must drop the block entirely,
  // even when an older control build still carries the field on the wire (the
  // producer side -- ledger, handler, schema -- stops emitting it in this same
  // phase; the renderer stays tolerant of legacy/unmigrated rows).
  it("renders NO steering / next-prompt block even when the wire carries one (Correction 5)", () => {
    const p = basePacket();
    p.recommendedNextPrompt =
      'Continue mission ML-ALPHA: "Mission alpha".\nMarker: ml:local:ML-ALPHA:tok';
    const out = renderPacket(p);
    expect(out).not.toContain("Recommended next prompt");
    expect(out).not.toContain("Continue mission");
    expect(out).not.toContain("ml:local:ML-ALPHA:tok");
  });

  it("renders NO verification / risks / summary verdict sections even when present", () => {
    const p = basePacket();
    p.summary = "LLM thinks this looks fine.";
    p.verification = [{ claim: "Bumped TIMEOUT", status: "verified", evidence: ["file:src/a.ts"] }];
    p.risks = [{ category: "cli_or_tooling", severity: "high", title: "No typecheck", evidence: [] }];
    const out = renderPacket(p);
    expect(out).not.toContain("Verification");
    expect(out).not.toContain("Risks");
    expect(out).not.toContain("Summary (LLM)");
    // The actual verdict content must not leak through some other section either.
    expect(out).not.toContain("Bumped TIMEOUT");
    expect(out).not.toContain("No typecheck");
    expect(out).not.toContain("LLM thinks this looks fine.");
  });

  it("renders NO LLM trace footer even on a synthesized packet (synthesis path is dead)", () => {
    const p = basePacket();
    p.synthesisStatus = "ready";
    p.langfuseTraceId = "0123456789abcdef0123456789abcdef";
    p.langfuseTraceUrl =
      "https://cloud.langfuse.com/project/proj_test/traces/0123456789abcdef0123456789abcdef";
    const out = renderPacket(p);
    expect(out).not.toContain("LLM trace");
    expect(out).not.toContain("cloud.langfuse.com");
    expect(out).not.toContain("trace id:");
  });
});

describe("renderPacket capture summary (§10 Phase 1 'print capture counts')", () => {
  it("prints deterministic capture counts", () => {
    const p = basePacket();
    p.facts = { branch: "main", changedFiles: ["src/a.ts", "src/b.ts", "src/c.ts"] };
    p.bashEvents = [{ category: "test", command: "npm test", exitCode: 0 }, { category: "git" }];
    p.missingEvidence = ["no test run observed"];
    const out = renderPacket(p);
    expect(out).toContain("Capture summary");
    expect(out).toMatch(/changed files:\s+3/);
    expect(out).toMatch(/observed bash events:\s+2/);
    expect(out).toMatch(/missing-evidence flags:\s+1/);
  });

  it("falls back to diffStat.filesChanged when changedFiles is absent", () => {
    const p = basePacket();
    p.facts = { branch: "main", diffStat: { filesChanged: 7, insertions: 10, deletions: 2 } };
    const out = renderPacket(p);
    expect(out).toMatch(/changed files:\s+7/);
  });

  it("reports agent self-report as captured-but-unverified, never as a verdict", () => {
    const p = basePacket();
    p.agentClaimsRaw = "I refactored the handler and all tests pass.";
    const out = renderPacket(p);
    expect(out).toMatch(/agent self-report:\s+captured \(unverified\)/);
    expect(out).toContain("Agent self-report (verbatim final message; NOT verified)");
    expect(out).toContain("I refactored the handler and all tests pass.");
  });

  it("reports 'none' for self-report when the agent left no final message", () => {
    const p = basePacket();
    p.agentClaimsRaw = null;
    const out = renderPacket(p);
    expect(out).toMatch(/agent self-report:\s+none/);
    expect(out).not.toContain("Agent self-report (verbatim");
  });
});

describe("renderPacket E2 run-end review directive", () => {
  it("emits a no-verdict directive that points back at the session-scoped command", () => {
    const out = renderPacket(basePacket());
    expect(out).toContain("Review pending items");
    expect(out).toContain("This ledger carries no verdict.");
    expect(out).toContain("Re-run for this session: mla review");
  });
});

// Stale-ledger guard (P0 2026-05-31, carried into Phase 1): a long-lived /
// continued Claude Code session keeps ONE agent_run alive; the ledger is built at
// finalize from that snapshot while the session keeps generating events. The
// renderer must flag a stale ledger, but in the Phase 1 model there is no verdict
// to qualify, so the banner warns about the FACTS, not a recommendation.
describe("renderPacket stale-ledger guard (no verdict to qualify)", () => {
  it("prints a STALE banner naming the count + watermark when staleEventCount > 0", () => {
    const p = basePacket();
    p.staleEventCount = 168;
    p.staleSince = "2026-05-31T18:25:46Z";
    const out = renderPacket(p);
    expect(out).toContain("STALE LEDGER");
    expect(out).toContain("168");
    expect(out).toContain("2026-05-31T18:25:46Z");
  });

  it("emits an honest remedy directive when stale (regenerate / inspect raw turns)", () => {
    const p = basePacket();
    p.staleEventCount = 5;
    p.staleSince = "2026-05-31T18:25:46Z";
    const out = renderPacket(p);
    expect(out).toContain("mla session show");
    expect(out.toLowerCase()).toContain("regenerate");
  });

  it("never qualifies a recommendation, because no recommendation is ever rendered", () => {
    const p = basePacket();
    p.recommendation = "approve";
    p.staleEventCount = 168;
    p.staleSince = "2026-05-31T18:25:46Z";
    const out = renderPacket(p);
    expect(out).not.toMatch(/recommendation/i);
    expect(out).not.toMatch(/\bapprove\b/i);
  });

  it("does NOT show the banner when not stale", () => {
    const p = basePacket();
    p.staleEventCount = 0;
    const out = renderPacket(p);
    expect(out).not.toContain("STALE LEDGER");
  });

  it("treats an absent staleEventCount (older control build) as not stale", () => {
    const out = renderPacket(basePacket());
    expect(out).not.toContain("STALE LEDGER");
  });
});
