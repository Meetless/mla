import { buildInjectPayload } from "../../../src/lib/analytics/evidence";

// TOPIC LABELS MUST ACCRUE ON *EVERY* NEW GAP, NOT ONE CLASS OF THEM.
//
// MEASURED on the live event log 2026-08-07. Since the topic classifier landed,
// `low_confidence_candidates` gaps carry real labels (migration x5, security x6,
// product_decision, api_contract). Every single `candidates_found_not_used` gap,
// including ones minted minutes ago, is `unknown` -- because the OUTCOME-time
// emitter hardcodes it:
//
//     // The correlator cannot recover the original query topic
//     queryTopicCategory: "unknown",
//
// The comment was true when it was written and is not true now: the topic is
// classified at inject time and was simply never written onto the inject event,
// only onto the inject-time gap payload. The correlator reads inject events, so
// the label was one field away the whole time.
//
// This matters because `candidates_found_not_used` is the ranking-failure class --
// evidence WAS surfaced and the agent used none of it -- which is exactly the
// population Phase 3's class-proxy evals want to be able to slice. An unlabelled
// half of the roadmap is not a roadmap.
//
// FORWARD-ONLY. Nothing backfills historical gaps: the label accrues from here.

describe("query_topic_category rides on the inject event", () => {
  const base = {
    turn_index: 1,
    evidence_offered: 1,
    offered_source_ids: ["NT:a"],
    evidence_tokens: 10,
    retrieval_confidence: "high",
    retrieval_latency_ms: 5,
    createdAtMs: Date.parse("2026-08-07T00:00:00.000Z"),
    injectId: "i1",
  };

  it("carries the classified topic so the OUTCOME-time gap can read it back", () => {
    expect(buildInjectPayload({ ...base, queryTopicCategory: "migration" }).query_topic_category).toBe(
      "migration",
    );
  });

  it("defaults to null, not to 'unknown'", () => {
    // Same rule as intent_type: "the classifier said unknown" and "nobody recorded
    // a topic" are different facts, and the correlator coerces null to unknown at
    // the point of use rather than losing the distinction on the way in.
    expect(buildInjectPayload(base).query_topic_category).toBeNull();
  });
});

describe("the correlator labels the outcome-time gap from the inject", () => {
  it("no longer hardcodes unknown", () => {
    const src = require("fs").readFileSync(
      require("path").resolve(__dirname, "../../../src/commands/internal-evidence-correlate.ts"),
      "utf8",
    ) as string;
    const notUsedBlock = src.slice(src.indexOf('coverageGapType: "candidates_found_not_used"'));
    const topicLine = notUsedBlock.slice(0, notUsedBlock.indexOf("retrievalConfidence"));
    expect(topicLine).toContain("query_topic_category");
    expect(topicLine).not.toMatch(/queryTopicCategory:\s*"unknown"/);
  });
});
