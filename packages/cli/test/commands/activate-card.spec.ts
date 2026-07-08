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
    expect(card).toContain("high-confidence project instructions");
  });

  it("uses singular nouns at count 1", () => {
    const card = renderActivationCard({ instructionFiles: 1, decisionDocs: 1, legacyNotes: 1, staleSignals: 1, agentMemoryRules: 0 });
    expect(card).toContain("1 agent-instruction file ");
    expect(card).toContain("1 decision/spec doc ");
  });
});
