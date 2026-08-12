// test/commands/activate-card.spec.ts
import { renderActivationCard } from "../../src/commands/activate";

describe("renderActivationCard", () => {
  it("renders the inventory line from a scan result", () => {
    const card = renderActivationCard({
      instructionFiles: 3, decisionDocs: 8, legacyNotes: 71, staleSignals: 4, agentMemoryRules: 0,
    });
    expect(card).toContain("3 agent-instruction files");
    expect(card).toContain("8 decision/spec docs");
    expect(card).toContain("71 legacy notes");
    expect(card).toContain("4 likely-stale");
    // The second line used to promise Meetless "will use high-confidence project instructions".
    // It does not use them: the delivery path carries no plain CLAUDE.md rule, and the agent
    // already loads the file itself. It INDEXES them, which is what makes retrieval answer.
    expect(card).not.toMatch(/will use/i);
    expect(card).toMatch(/index/i);
  });

  it("uses singular nouns at count 1", () => {
    const card = renderActivationCard({ instructionFiles: 1, decisionDocs: 1, legacyNotes: 1, staleSignals: 1, agentMemoryRules: 0 });
    expect(card).toContain("1 agent-instruction file ");
    expect(card).toContain("1 decision/spec doc ");
  });
});
