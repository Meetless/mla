import { renderManualScoutMission, renderAgenticInvitation } from "../../../src/lib/scanner/scout-mission";
import { Directive, ScanInventory, ScanResult } from "../../../src/lib/scanner/types";

// GAP1 Slice 2: the agentic scout mission (step 8 of the design's bootstrap
// sequence, notes/20260611-onboarding-mla.md:1331). The deterministic Tier-1 scan
// extracts high-confidence rules from instruction files and only COUNTS the messy
// Tier-2 docs (decision docs, legacy notes) it cannot parse. The scout mission is
// the prompt that sends the coding agent to read those deep docs and surface the
// implicit decisions, deprecated patterns, and contradictions behind them.
//
// Hard boundary (my lane vs the canonical agent's): the mission is PURE TEXT over
// the existing ScanResult. It must NOT reference the unbuilt `mla seed propose`
// graph-writing path (that relationship/temporal-graph machinery is the canonical
// agent's intel/control lane). The in-lane promotion loop is: the agent surfaces
// candidates with evidence -> the human edits CLAUDE.md/AGENTS.md -> the next
// deterministic scan promotes them. The agent never owns acceptance.

function inv(over: Partial<ScanInventory>): ScanInventory {
  return {
    instructionFiles: over.instructionFiles ?? 0,
    decisionDocs: over.decisionDocs ?? 0,
    legacyNotes: over.legacyNotes ?? 0,
    staleSignals: over.staleSignals ?? 0,
    agentMemoryRules: over.agentMemoryRules ?? 0,
  };
}

function directive(over: Partial<Directive>): Directive {
  return {
    id: over.id ?? "deadbeef0001",
    text: over.text ?? "Some rule text",
    source: over.source ?? "CLAUDE.md",
    kind: "RULE",
    strength: over.strength ?? "MUST_FOLLOW",
    attestation: over.attestation ?? "human_attested",
  };
}

function result(over: Partial<ScanResult>): ScanResult {
  return {
    schemaVersion: 1,
    workspaceId: "ws_demo",
    commitSha: "abc123",
    generatedAt: "2026-06-21T00:00:00Z",
    inventory: over.inventory ?? inv({}),
    directives: over.directives ?? [],
    staleSignals: over.staleSignals ?? [],
    confirmedRulesXml: over.confirmedRulesXml ?? "",
    floorRulesXml: over.floorRulesXml ?? "",
    staleContextXml: over.staleContextXml ?? "",
    advisoryDirectives: over.advisoryDirectives ?? [],
  };
}

describe("renderManualScoutMission", () => {
  it("frames the agent as a scout, not an implementer", () => {
    const out = renderManualScoutMission(result({}));
    expect(out).toMatch(/scout/i);
    // The mission is exploration, not code work.
    expect(out).toMatch(/do not (implement|write) code/i);
  });

  it("forbids the agent from accepting or promoting anything itself", () => {
    const out = renderManualScoutMission(result({}));
    // Never let the coding agent own acceptance (design: step 8 + division of labor).
    expect(out).toMatch(/do not (mark|accept|promote)/i);
  });

  it("names the in-lane promotion loop and does NOT invoke the unbuilt graph path", () => {
    const out = renderManualScoutMission(result({}));
    // Promotion is the human editing an instruction file, picked up by the next scan.
    expect(out).toMatch(/CLAUDE\.md|AGENTS\.md/);
    expect(out).toMatch(/human|review/i);
    // The `mla seed propose` relationship-graph pipeline is the canonical agent's
    // lane and is not built here; the mission must never tell the agent to call it.
    expect(out).not.toMatch(/seed propose/);
  });

  it("requires every candidate to carry line-level evidence", () => {
    const out = renderManualScoutMission(result({}));
    expect(out).toMatch(/evidence/i);
    // A concrete anchor shape so candidates are checkable (path#Lx-Ly).
    expect(out).toMatch(/#L\d|line/i);
  });

  it("tells the agent what to look for: rules, decisions, deprecated patterns, contradictions", () => {
    const out = renderManualScoutMission(result({}));
    expect(out).toMatch(/rule|polic/i);
    expect(out).toMatch(/decision/i);
    expect(out).toMatch(/deprecat|stale/i);
    expect(out).toMatch(/contradict|conflict/i);
  });

  it("points the agent at the deep docs the deterministic pass could only count", () => {
    const out = renderManualScoutMission(
      result({ inventory: inv({ decisionDocs: 12, legacyNotes: 71 }) }),
    );
    expect(out).toContain("12");
    expect(out).toContain("71");
    // Those counts are the WORK SURFACE: decision/spec docs and legacy notes.
    expect(out).toMatch(/decision|spec/i);
    expect(out).toMatch(/note/i);
  });

  it("acknowledges the already-locked high-confidence directives so the agent goes beyond them", () => {
    const out = renderManualScoutMission(
      result({
        directives: [
          directive({ text: "Work directly on main" }),
          directive({ text: "Do not mock internal services" }),
          directive({ text: "Use make test-db" }),
        ],
      }),
    );
    // 3 directives already injected: the mission should say so and push past them.
    expect(out).toContain("3");
    expect(out).toMatch(/already|beyond|deeper|go past/i);
  });

  it("renders a coherent mission even when the deterministic scan found nothing", () => {
    const out = renderManualScoutMission(result({}));
    expect(out.length).toBeGreaterThan(0);
    // No crash, no "undefined", no NaN leaking from empty counts.
    expect(out).not.toMatch(/undefined|NaN/);
  });
});

// The default `fast` tier should INVITE the deeper read rather than hide it behind a
// flag. Phase 2 consolidates onboarding to one public flow, so the nudge now names the
// canonical `/mla onboard` (not the deprecated `--bootstrap agentic`). When there is
// nothing deep to scout, it stays silent (no nagging).
describe("renderAgenticInvitation", () => {
  it("invites /mla onboard when deep docs went unread, naming the command", () => {
    const out = renderAgenticInvitation(
      result({ inventory: inv({ decisionDocs: 12, legacyNotes: 71 }) }),
    );
    expect(out).not.toBeNull();
    expect(out as string).toMatch(/\/mla onboard/);
    // The deprecated flag must not be advertised as the deep path any more.
    expect(out as string).not.toMatch(/--bootstrap agentic/);
    // It quantifies the unread surface so the nudge is concrete.
    expect(out as string).toContain("12");
    expect(out as string).toContain("71");
  });

  it("invites when only legacy notes went unread", () => {
    const out = renderAgenticInvitation(result({ inventory: inv({ legacyNotes: 5 }) }));
    expect(out).not.toBeNull();
    expect(out as string).toMatch(/\/mla onboard/);
  });

  it("stays silent when there is no deep-doc surface to scout", () => {
    const out = renderAgenticInvitation(
      result({ inventory: inv({ instructionFiles: 3, decisionDocs: 0, legacyNotes: 0 }) }),
    );
    expect(out).toBeNull();
  });
});
