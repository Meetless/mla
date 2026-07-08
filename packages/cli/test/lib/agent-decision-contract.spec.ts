// test/lib/agent-decision-contract.spec.ts
//
// T1: the canonical contract has teeth. These pin the field rules and cross-field
// invariants the spec spells out (sections 6/7, INV-CHOICE-ID, INV-RAW-PRESERVATION,
// decisionKind/multiSelect coherence). The Claude normalizer (T2) must produce
// payloads that pass this validator; control mirrors it as a DTO.

import {
  buildClaudeProviderEventId,
  buildEventKey,
  validateCanonicalDecisionPayload,
  type CanonicalDecisionPayload,
} from "../../src/lib/agent-decision";

function validChoice(): CanonicalDecisionPayload {
  return {
    provider: "claude_code",
    providerSource: "claude_hook",
    providerToolName: "AskUserQuestion",
    providerEventId: "toolu_abc#0",
    providerSessionId: "sess-1",
    decisionKind: "choice",
    prompt: { title: "MCP scope", body: "What does this mean?" },
    choices: [
      { id: "choice_0", label: "Verify existing MCP works", description: "..." },
      { id: "choice_1", label: "Extend existing MCP" },
    ],
    answer: {
      type: "choice_label",
      value: "Verify existing MCP works",
      choiceId: "choice_0",
      choiceMatchStatus: "exact_unique",
      raw: "Verify existing MCP works",
    },
    multiSelect: false,
    turnIndex: 7,
    traceId: "0123456789abcdef0123456789abcdef",
    capturedBy: "post_tool_use",
    actorDisplayName: "An",
    rawProviderPayload: { question: {}, answer: "Verify existing MCP works" },
    occurredAt: "2026-06-08T12:00:00-05:00",
  };
}

describe("canonical decision contract (T1)", () => {
  it("accepts a well-formed single-choice payload", () => {
    expect(validateCanonicalDecisionPayload(validChoice())).toEqual([]);
  });

  it("accepts a minimal free_text payload with no choiceId", () => {
    const p = validChoice();
    p.decisionKind = "free_text";
    p.answer = { type: "free_text", value: "some typed answer", choiceMatchStatus: "no_match", raw: "some typed answer" };
    delete (p as { providerToolName?: unknown }).providerToolName;
    delete (p as { occurredAt?: unknown }).occurredAt;
    expect(validateCanonicalDecisionPayload(p)).toEqual([]);
  });

  it("accepts a multi_choice payload with an array value", () => {
    const p = validChoice();
    p.decisionKind = "multi_choice";
    p.multiSelect = true;
    p.answer = {
      type: "multi_choice_labels",
      value: ["Verify existing MCP works", "Extend existing MCP"],
      choiceIds: ["choice_0", "choice_1"],
      choiceMatchStatus: "exact_unique",
      raw: ["Verify existing MCP works", "Extend existing MCP"],
    };
    expect(validateCanonicalDecisionPayload(p)).toEqual([]);
  });

  it("rejects a slugified (non-positional) choice id (INV-CHOICE-ID)", () => {
    const p = validChoice();
    p.choices[0].id = "verify-existing-mcp-works";
    const errs = validateCanonicalDecisionPayload(p);
    expect(errs.some((e) => e.includes("choices[0].id"))).toBe(true);
  });

  it("rejects an answer.choiceId not present in choices", () => {
    const p = validChoice();
    p.answer.choiceId = "choice_9";
    const errs = validateCanonicalDecisionPayload(p);
    expect(errs.some((e) => e.includes("not one of the offered choices"))).toBe(true);
  });

  it("rejects no_match on a singular choice_label claim", () => {
    const p = validChoice();
    p.answer.choiceMatchStatus = "no_match";
    const errs = validateCanonicalDecisionPayload(p);
    expect(errs.some((e) => e.includes("choice_label cannot have choiceMatchStatus no_match"))).toBe(true);
  });

  it("rejects free_text carrying a choiceId", () => {
    const p = validChoice();
    p.decisionKind = "free_text";
    p.answer = { type: "free_text", value: "x", choiceId: "choice_0", choiceMatchStatus: "no_match", raw: "x" };
    const errs = validateCanonicalDecisionPayload(p);
    expect(errs.some((e) => e.includes("free_text must not carry a choiceId"))).toBe(true);
  });

  it("rejects multiSelect/decisionKind incoherence", () => {
    const p = validChoice();
    p.multiSelect = true; // but decisionKind stays "choice"
    const errs = validateCanonicalDecisionPayload(p);
    expect(errs.some((e) => e.includes("must be multi_choice when multiSelect is true"))).toBe(true);
  });

  it("rejects a missing rawProviderPayload (INV-RAW-PRESERVATION)", () => {
    const p = validChoice();
    delete (p as { rawProviderPayload?: unknown }).rawProviderPayload;
    const errs = validateCanonicalDecisionPayload(p);
    expect(errs.some((e) => e.includes("rawProviderPayload"))).toBe(true);
  });

  it("rejects an unknown decisionKind", () => {
    const p = validChoice() as unknown as Record<string, unknown>;
    p.decisionKind = "approval_request";
    const errs = validateCanonicalDecisionPayload(p);
    expect(errs.some((e) => e.includes("decisionKind"))).toBe(true);
  });

  it("rejects empty provider identity fields", () => {
    const p = validChoice();
    p.provider = "";
    p.providerEventId = "";
    const errs = validateCanonicalDecisionPayload(p);
    expect(errs.some((e) => e.includes("provider:"))).toBe(true);
    expect(errs.some((e) => e.includes("providerEventId:"))).toBe(true);
  });

  it("builds provider-scoped event keys (not hardcoded to claude)", () => {
    expect(buildEventKey("claude_code", "toolu_abc#0")).toBe(
      "agent_decision_captured:claude_code:toolu_abc#0",
    );
    expect(buildEventKey("synthetic_test", "x#0")).toBe("agent_decision_captured:synthetic_test:x#0");
  });

  it("builds claude per-question provider event ids", () => {
    expect(buildClaudeProviderEventId("toolu_abc", 0)).toBe("toolu_abc#0");
    expect(buildClaudeProviderEventId("toolu_abc", 3)).toBe("toolu_abc#3");
  });
});
