// test/lib/agent-decision-normalize.spec.ts
//
// T2-T5: the Claude normalize() seam against the REAL verified transcript fixture
// (4a53ce6d), plus constructed fixtures for the edge rules.
//
// The fixture data is ground truth captured verbatim from a real session,
// including a literal em dash in a question and a user typo. Those live in the
// DATA, never in authored prose; do not "fix" them.

import * as fs from "fs";
import * as path from "path";

import {
  normalizeClaudeAskUserQuestion,
  validateCanonicalDecisionPayload,
  type ClaudeAskRaw,
  type ClaudeNormalizeContext,
} from "../../src/lib/agent-decision";

const FIXTURE = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "fixtures", "ask-user-question-claude.json"), "utf8"),
) as {
  tool_use_id: string;
  providerSessionId: string;
  tool_input: { questions: ClaudeAskRaw["questions"] };
  tool_response: { answers: Record<string, unknown> };
};

const Q1 = 'What does "write the mcp" mean here — extend what exists, or start fresh?';
const Q2 = "Which workspace + intel instance for the reingest?";

function ctx(overrides: Partial<ClaudeNormalizeContext> = {}): ClaudeNormalizeContext {
  return {
    providerSessionId: FIXTURE.providerSessionId,
    capturedBy: "post_tool_use",
    turnIndex: 7,
    traceId: "0123456789abcdef0123456789abcdef",
    occurredAt: "2026-06-08T12:00:00-05:00",
    actorDisplayName: "An",
    ...overrides,
  };
}

function normalizeFixture() {
  const raw: ClaudeAskRaw = {
    toolUseId: FIXTURE.tool_use_id,
    questions: FIXTURE.tool_input.questions,
    answers: FIXTURE.tool_response.answers,
  };
  return normalizeClaudeAskUserQuestion(raw, ctx());
}

describe("Claude normalize() against the real fixture (T2)", () => {
  it("decomposes one 2-question call into 2 canonical decisions", () => {
    const decisions = normalizeFixture();
    expect(decisions).toHaveLength(2);
  });

  it("assigns providerEventId '<tool_use_id>#<index>' per question", () => {
    const decisions = normalizeFixture();
    expect(decisions[0].providerEventId).toBe(`${FIXTURE.tool_use_id}#0`);
    expect(decisions[1].providerEventId).toBe(`${FIXTURE.tool_use_id}#1`);
  });

  it("emits payloads that satisfy the canonical contract", () => {
    for (const d of normalizeFixture()) {
      expect(validateCanonicalDecisionPayload(d)).toEqual([]);
    }
  });

  it("carries provider metadata in provider-scoped fields only", () => {
    const d = normalizeFixture()[0];
    expect(d.provider).toBe("claude_code");
    expect(d.providerSource).toBe("claude_hook");
    expect(d.providerToolName).toBe("AskUserQuestion");
    expect(d.providerSessionId).toBe(FIXTURE.providerSessionId);
  });

  it("maps prompt.title to header and prompt.body to the question text", () => {
    const d = normalizeFixture()[0];
    expect(d.prompt.title).toBe("MCP scope");
    expect(d.prompt.body).toBe(Q1);
  });

  it("preserves the raw provider question+answer for audit", () => {
    const d = normalizeFixture()[0];
    expect(d.rawProviderPayload).toMatchObject({ answer: "Verify existing MCP works" });
  });
});

describe("choice-id + answer mapping (T3)", () => {
  it("builds positional choice ids choice_0..choice_N (never slugs)", () => {
    const d = normalizeFixture()[0];
    expect(d.choices.map((c) => c.id)).toEqual(["choice_0", "choice_1", "choice_2"]);
    expect(d.choices[0].label).toBe("Verify existing MCP works");
  });

  it("resolves an exact-unique single-select answer to its choiceId", () => {
    const d = normalizeFixture()[0];
    expect(d.decisionKind).toBe("choice");
    expect(d.answer.type).toBe("choice_label");
    expect(d.answer.choiceMatchStatus).toBe("exact_unique");
    expect(d.answer.choiceId).toBe("choice_0");
    expect(d.answer.value).toBe("Verify existing MCP works");
  });

  it("flags exact_ambiguous and resolves to the first match when two labels collide", () => {
    const raw: ClaudeAskRaw = {
      toolUseId: "toolu_dup",
      questions: [
        {
          question: "Pick one",
          header: "Dup",
          multiSelect: false,
          options: [{ label: "Same" }, { label: "Same" }, { label: "Other" }],
        },
      ],
      answers: { "Pick one": "Same" },
    };
    const d = normalizeClaudeAskUserQuestion(raw, ctx())[0];
    expect(d.answer.choiceMatchStatus).toBe("exact_ambiguous");
    expect(d.answer.choiceId).toBe("choice_0");
    expect(validateCanonicalDecisionPayload(d)).toEqual([]);
  });
});

describe("free-text handling (T4)", () => {
  it("represents a non-matching single answer as free_text with no choiceId", () => {
    const d = normalizeFixture()[1];
    expect(d.prompt.body).toBe(Q2);
    expect(d.decisionKind).toBe("free_text");
    expect(d.answer.type).toBe("free_text");
    expect(d.answer.choiceMatchStatus).toBe("no_match");
    expect(d.answer.choiceId).toBeUndefined();
    expect(typeof d.answer.value).toBe("string");
    expect(d.answer.value).toContain("local envs");
  });

  it("known limitation: free text equal to a label is recorded as a selection", () => {
    const raw: ClaudeAskRaw = {
      toolUseId: "toolu_other",
      questions: [
        { question: "Q", header: "H", multiSelect: false, options: [{ label: "Yes" }, { label: "No" }] },
      ],
      // user typed "Other" text that happens to equal an offered label
      answers: { Q: "Yes" },
    };
    const d = normalizeClaudeAskUserQuestion(raw, ctx())[0];
    expect(d.answer.type).toBe("choice_label");
    expect(d.answer.choiceMatchStatus).toBe("exact_unique");
    expect(d.answer.raw).toBe("Yes");
  });
});

describe("multi-select handling (T5; real serialization VERIFIED 2026-06-10: comma-space delimited string, see live-capture test below)", () => {
  const multiQuestions: ClaudeAskRaw["questions"] = [
    {
      question: "Which surfaces?",
      header: "Surfaces",
      multiSelect: true,
      options: [{ label: "Slack" }, { label: "Jira" }, { label: "Console" }],
    },
  ];

  it("tolerates an array answer", () => {
    const raw: ClaudeAskRaw = { toolUseId: "toolu_m1", questions: multiQuestions, answers: { "Which surfaces?": ["Slack", "Console"] } };
    const d = normalizeClaudeAskUserQuestion(raw, ctx())[0];
    expect(d.decisionKind).toBe("multi_choice");
    expect(d.multiSelect).toBe(true);
    expect(d.answer.type).toBe("multi_choice_labels");
    expect(d.answer.value).toEqual(["Slack", "Console"]);
    expect(d.answer.choiceIds).toEqual(["choice_0", "choice_2"]);
    expect(validateCanonicalDecisionPayload(d)).toEqual([]);
  });

  it("tolerates a delimited-string answer", () => {
    const raw: ClaudeAskRaw = { toolUseId: "toolu_m2", questions: multiQuestions, answers: { "Which surfaces?": "Slack, Jira" } };
    const d = normalizeClaudeAskUserQuestion(raw, ctx())[0];
    expect(d.answer.value).toEqual(["Slack", "Jira"]);
    expect(d.answer.choiceIds).toEqual(["choice_0", "choice_1"]);
    expect(validateCanonicalDecisionPayload(d)).toEqual([]);
  });

  it("multi-select with no matching labels stays multi_choice with no_match", () => {
    const raw: ClaudeAskRaw = { toolUseId: "toolu_m3", questions: multiQuestions, answers: { "Which surfaces?": ["Email"] } };
    const d = normalizeClaudeAskUserQuestion(raw, ctx())[0];
    expect(d.decisionKind).toBe("multi_choice");
    expect(d.answer.choiceMatchStatus).toBe("no_match");
    expect(d.answer.choiceIds).toBeUndefined();
    expect(validateCanonicalDecisionPayload(d)).toEqual([]);
  });

  it("recovers an offered label that itself contains a delimiter from a delimited string", () => {
    // A naive split on "," would shred "Slack, with a comma" into two non-matching
    // tokens and silently misreport the selection. The label-aware decomposition
    // must keep it whole and still resolve the trailing "Jira".
    const commaLabelQuestions: ClaudeAskRaw["questions"] = [
      {
        question: "Which surfaces?",
        header: "Surfaces",
        multiSelect: true,
        options: [{ label: "Slack, with a comma" }, { label: "Jira" }, { label: "Console" }],
      },
    ];
    const raw: ClaudeAskRaw = {
      toolUseId: "toolu_m4",
      questions: commaLabelQuestions,
      answers: { "Which surfaces?": "Slack, with a comma, Jira" },
    };
    const d = normalizeClaudeAskUserQuestion(raw, ctx())[0];
    expect(d.answer.value).toEqual(["Slack, with a comma", "Jira"]);
    expect(d.answer.choiceIds).toEqual(["choice_0", "choice_1"]);
    expect(d.answer.choiceMatchStatus).toBe("exact_unique");
    expect(validateCanonicalDecisionPayload(d)).toEqual([]);
  });

  it("REAL serialization (live capture 2026-06-10, toolu_012Ki3MLfSziMJLwFR495kmG#1): Claude joins multi-select labels into one comma-space delimited string", () => {
    // Verbatim from a real interactive AskUserQuestion round-trip (T22 dogfood).
    // Claude serialized a 3-pick multiSelect answer as a single ", "-joined string,
    // NOT an array. The array shape tested above remains tolerated but has never
    // been observed. The offered set also contains a delimiter-bearing label
    // ("None, hold residuals"), so this pins the label-aware decomposition against
    // real provider output.
    const realQuestions: ClaudeAskRaw["questions"] = [
      {
        question:
          "Phase 0 of the trust-band work is closed; residuals R2-R4 remain unscheduled. Which should I queue next? (Pick 2+ if you back more than one; this answer also verifies multi-select capture serialization.)",
        header: "Residuals",
        multiSelect: true,
        options: [
          { label: "R2 revision backfill" },
          { label: "R3 lazy schema fail-safe" },
          { label: "R4 two-gate consolidation" },
          { label: "None, hold residuals" },
        ],
      },
    ];
    const raw: ClaudeAskRaw = {
      toolUseId: "toolu_012Ki3MLfSziMJLwFR495kmG",
      questions: realQuestions,
      answers: {
        "Phase 0 of the trust-band work is closed; residuals R2-R4 remain unscheduled. Which should I queue next? (Pick 2+ if you back more than one; this answer also verifies multi-select capture serialization.)":
          "R2 revision backfill, R3 lazy schema fail-safe, R4 two-gate consolidation",
      },
    };
    const d = normalizeClaudeAskUserQuestion(raw, ctx())[0];
    expect(d.decisionKind).toBe("multi_choice");
    expect(d.answer.type).toBe("multi_choice_labels");
    expect(d.answer.value).toEqual([
      "R2 revision backfill",
      "R3 lazy schema fail-safe",
      "R4 two-gate consolidation",
    ]);
    expect(d.answer.choiceIds).toEqual(["choice_0", "choice_1", "choice_2"]);
    expect(d.answer.choiceMatchStatus).toBe("exact_unique");
    expect(validateCanonicalDecisionPayload(d)).toEqual([]);
  });
});

describe("normalizer robustness", () => {
  it("skips questions with no answer entry (not a captured decision)", () => {
    const raw: ClaudeAskRaw = {
      toolUseId: "toolu_partial",
      questions: [
        { question: "Answered", header: "A", multiSelect: false, options: [{ label: "X" }] },
        { question: "Unanswered", header: "B", multiSelect: false, options: [{ label: "Y" }] },
      ],
      answers: { Answered: "X" },
    };
    const decisions = normalizeClaudeAskUserQuestion(raw, ctx());
    expect(decisions).toHaveLength(1);
    expect(decisions[0].prompt.body).toBe("Answered");
  });

  it("propagates capturedBy and trace/turn context onto every decision", () => {
    const decisions = normalizeFixture();
    for (const d of decisions) {
      expect(d.capturedBy).toBe("post_tool_use");
      expect(d.turnIndex).toBe(7);
      expect(d.traceId).toBe("0123456789abcdef0123456789abcdef");
      expect(d.actorDisplayName).toBe("An");
    }
  });
});
