import {
  redactEventBatch,
  redactEventValue,
  runInternalRedactEvents,
  STRUCTURAL_KEYS,
} from "../../src/commands/internal-redact-events";
import { REDACTED } from "../../src/lib/redactor";

// Regression suite for the code-review finding that the mla hook pipeline
// spooled and PATCHed nearly everything verbatim: only injected-context blocks
// and the MCP query text ever reached the shared redactor. The user's prompt,
// the assistant's narration, the final message, the whole bash command plus its
// stdout/stderr tails, and the agent-decision Q&A all left the machine raw.
//
// `redact-events` is the mandatory boundary at flush.sh Pass 2. Each `it` below
// pins one previously-leaking field.

const SECRET = "sk-ant-" + "api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";

function payloadOf(events: unknown[], i = 0): Record<string, unknown> {
  return (events[i] as Record<string, unknown>).payload as Record<string, unknown>;
}

describe("redactEventBatch -- previously-leaking capture fields", () => {
  it("redacts the raw user prompt (prompt_submitted)", () => {
    const out = redactEventBatch([
      {
        eventKey: "k1",
        eventType: "prompt_submitted",
        occurredAt: "2026-07-26T00:00:00Z",
        source: "hook",
        payload: {
          prompt: `deploy with ANTHROPIC_API_KEY=${SECRET} please`,
          sessionTitle: "Deploy work",
          turnId: "turn-1",
          turnIndex: 3,
        },
      },
    ]);
    const p = payloadOf(out);
    expect(p.prompt).not.toContain(SECRET);
    expect(p.prompt).toContain(REDACTED);
    // Correlation fields survive untouched.
    expect(p.turnId).toBe("turn-1");
    expect(p.turnIndex).toBe(3);
  });

  it("redacts the full bash command and both output tails (tool_used_bash)", () => {
    const out = redactEventBatch([
      {
        eventKey: "k2",
        eventType: "tool_used_bash",
        payload: {
          command: `curl -H "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abcdefghij.sig" https://api.example.com`,
          stdoutTail: `GH_TOKEN=ghp_ABCDEFGHIJKLMNOPQRSTUVWX`,
          stderrTail: `failed: OPENAI_API_KEY=sk-proj-ZZZZZZZZZZZZZZZZZZZZ`,
          exitCode: 1,
          categoryHint: "test",
          storyCategory: "VERIFY",
        },
      },
    ]);
    const p = payloadOf(out);
    expect(p.command).toContain(REDACTED);
    expect(p.command).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    // The env-var NAME survives as a retrieval key; the VALUE does not.
    expect(p.stdoutTail).toBe(`GH_TOKEN=${REDACTED}`);
    expect(p.stdoutTail).not.toContain("ghp_");
    expect(p.stderrTail).toContain(REDACTED);
    expect(p.stderrTail).not.toContain("sk-proj-");
    // Enums and the exit code are structural.
    expect(p.exitCode).toBe(1);
    expect(p.categoryHint).toBe("test");
    expect(p.storyCategory).toBe("VERIFY");
  });

  it("redacts between-tool assistant narration (assistant_message)", () => {
    const out = redactEventBatch([
      {
        eventKey: "k3",
        eventType: "assistant_message",
        payload: {
          narration: `I'll export AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY now`,
          entryUuid: "0b1f9d4e-2c3a-4b5c-8d7e-9f0a1b2c3d4e",
        },
      },
    ]);
    const p = payloadOf(out);
    expect(p.narration).not.toContain("wJalrXUtnFEMI");
    expect(p.narration).toContain(REDACTED);
    expect(p.entryUuid).toBe("0b1f9d4e-2c3a-4b5c-8d7e-9f0a1b2c3d4e");
  });

  it("redacts the final assistant message (session_stopped)", () => {
    const out = redactEventBatch([
      {
        eventKey: "k4",
        eventType: "session_stopped",
        payload: {
          finalMessage: `Done. Token: ghp_ABCDEFGHIJKLMNOPQRSTUVWX`,
          sessionTitle: "Wire up auth",
        },
      },
    ]);
    const p = payloadOf(out);
    expect(p.finalMessage).toContain(REDACTED);
    expect(p.finalMessage).not.toContain("ghp_");
  });

  it("redacts agent-decision free text but keeps the provider envelope", () => {
    const out = redactEventBatch([
      {
        eventKey: "k5",
        eventType: "agent_decision_captured",
        provider: "claude_code",
        adapter: "askuserquestion",
        payload: {
          provider: "claude_code",
          providerSource: "AskUserQuestion",
          providerToolName: "AskUserQuestion",
          providerEventId: "toolu_01ABCDEFGHIJKLMNOPQRSTUV#0",
          decisionKind: "MULTIPLE_CHOICE",
          prompt: { text: `Which key? ${SECRET}` },
          choices: [`use ${SECRET}`, "rotate it"],
          answer: { raw: `keep ${SECRET}`, choiceId: "opt-1" },
          actorDisplayName: "Alex Rivera",
          multiSelect: false,
          turnIndex: 2,
          traceId: "9f8e7d6c5b4a39281706f5e4d3c2b1a0",
        },
      },
    ]);
    const rec = out[0] as Record<string, unknown>;
    const p = payloadOf(out);
    expect(JSON.stringify(p.prompt)).not.toContain(SECRET);
    expect(JSON.stringify(p.choices)).not.toContain(SECRET);
    expect(JSON.stringify(p.answer)).not.toContain(SECRET);
    expect((p.answer as Record<string, unknown>).choiceId).toBe("opt-1");
    // Envelope + routing fields must survive: control validates provider/adapter
    // agreement and joins on providerEventId.
    expect(rec.provider).toBe("claude_code");
    expect(rec.adapter).toBe("askuserquestion");
    expect(p.providerSource).toBe("AskUserQuestion");
    expect(p.providerEventId).toBe("toolu_01ABCDEFGHIJKLMNOPQRSTUV#0");
    expect(p.traceId).toBe("9f8e7d6c5b4a39281706f5e4d3c2b1a0");
  });

  it("is idempotent over already-redacted injection_trace blocks", () => {
    const events = [
      {
        eventKey: "k6",
        eventType: "injection_trace",
        payload: {
          sourceSurface: "HOOK",
          schemaVersion: 2,
          status: "INJECTED",
          confidence: 0.9,
          blocks: [
            {
              kind: "governing_floor",
              content: `Floor text ${REDACTED} tail`,
              contentStatus: "redacted",
              citations: ["NT:notes/20260726-x.md"],
              charCount: 42,
              itemCount: 3,
            },
          ],
          contextItems: [
            { source_id: "NT:notes/20260726-x.md", injected: true, trust: "GOVERNED", field: "floor" },
          ],
        },
      },
    ];
    const once = redactEventBatch(events);
    const twice = redactEventBatch(once);
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
    const p = payloadOf(once);
    const blocks = p.blocks as Array<Record<string, unknown>>;
    expect(blocks[0].citations).toEqual(["NT:notes/20260726-x.md"]);
    expect(blocks[0].charCount).toBe(42);
    expect(blocks[0].contentStatus).toBe("redacted");
    const items = p.contextItems as Array<Record<string, unknown>>;
    expect(items[0].source_id).toBe("NT:notes/20260726-x.md");
  });
});

describe("redactEventBatch -- structural fields must not be mangled", () => {
  // The redactor's entropy heuristic fires on any 32+ char token with 2+
  // character classes. Session UUIDs, tool_use ids, event keys and content
  // hashes all satisfy that. If they were redacted the batch would land
  // structurally intact but unjoinable, so the allowlist is load-bearing.
  const HIGH_ENTROPY_IDS: Record<string, string> = {
    sessionId: "49d5b142-4768-4dde-9a98-eabb76e933e5",
    eventKey: "49d5b142-4768-4dde-9a98-eabb76e933e5:prompt_submitted:7",
    turnId: "49d5b142-4768-4dde-9a98-eabb76e933e5-t7",
    traceId: "9f8e7d6c5b4a39281706f5e4d3c2b1a0",
    entryUuid: "0b1f9d4e-2c3a-4b5c-8d7e-9f0a1b2c3d4e",
    injectId: "inj_01HZXQ8KJ4M5N6P7Q8R9S0T1U2V3W4X5",
    providerEventId: "toolu_01ABCDEFGHIJKLMNOPQRSTUVWXYZ012345",
    rawPromptHash: "c0ffee1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
    filePath: "/Users/dev/projects/meetless/packages/cli/src/lib/some-very-long-module-name.ts",
  };

  it.each(Object.entries(HIGH_ENTROPY_IDS))(
    "passes %s through byte-for-byte",
    (key, value) => {
      const out = redactEventBatch([{ eventKey: "k", payload: { [key]: value } }]);
      expect(payloadOf(out)[key]).toBe(value);
    },
  );

  it("proves the guard is load-bearing: the same values ARE redacted under a free-text key", () => {
    const mangled = Object.entries(HIGH_ENTROPY_IDS).filter(([, value]) => {
      const out = redactEventBatch([{ eventKey: "k", payload: { prompt: value } }]);
      return payloadOf(out).prompt !== value;
    });
    // At least one of these ids trips the entropy heuristic, so the allowlist is
    // not decorative. If this ever goes empty the heuristic changed; re-derive.
    expect(mangled.length).toBeGreaterThan(0);
  });

  it("keeps citation ids and counters inside nested structures", () => {
    const out = redactEventBatch([
      {
        eventKey: "k",
        payload: {
          sourceIds: ["CC:0198f0a1-1111-4222-8333-444455556666", "NT:notes/20260726-a.md"],
          summary: { blockCount: 3, injectedCharCount: 1234 },
        },
      },
    ]);
    const p = payloadOf(out);
    expect(p.sourceIds).toEqual([
      "CC:0198f0a1-1111-4222-8333-444455556666",
      "NT:notes/20260726-a.md",
    ]);
    expect(p.summary).toEqual({ blockCount: 3, injectedCharCount: 1234 });
  });
});

describe("redactEventValue -- default-redact policy", () => {
  it("redacts an unknown key by default (a future field fails safe)", () => {
    const out = redactEventValue({ someBrandNewField: `x ${SECRET} y` }, null) as Record<
      string,
      unknown
    >;
    expect(out.someBrandNewField).not.toContain(SECRET);
  });

  it("array elements inherit the parent key", () => {
    expect(redactEventValue(["CC:abc", "NT:def"], "sourceIds")).toEqual(["CC:abc", "NT:def"]);
    const free = redactEventValue([`ghp_ABCDEFGHIJKLMNOPQRSTUVWX`], "choices") as string[];
    expect(free[0]).toBe(REDACTED);
  });

  it("preserves non-string leaves exactly", () => {
    const input = { a: 1, b: true, c: null, d: 1.5 };
    expect(redactEventValue(input, null)).toEqual(input);
  });

  it("does not treat a structural key name as structural when it is a VALUE", () => {
    // "status" as a value of a free-text key is still free text.
    const out = redactEventValue({ prompt: "status" }, null) as Record<string, unknown>;
    expect(out.prompt).toBe("status");
    expect(STRUCTURAL_KEYS.has("status")).toBe(true);
  });
});

describe("runInternalRedactEvents -- fail-closed IO shell", () => {
  function harness(stdin: string | (() => Promise<string>)) {
    const written: string[] = [];
    return {
      written,
      run: () =>
        runInternalRedactEvents([], {
          readStdin: typeof stdin === "string" ? async () => stdin : stdin,
          writeOut: (s) => written.push(s),
        }),
    };
  }

  it("exits 0 and emits the redacted array", async () => {
    const h = harness(
      JSON.stringify([{ eventKey: "k", payload: { prompt: `x ${SECRET}` } }]),
    );
    expect(await h.run()).toBe(0);
    expect(h.written.join("")).not.toContain(SECRET);
    expect(JSON.parse(h.written.join(""))).toHaveLength(1);
  });

  it("exits 1 with NO output on malformed JSON", async () => {
    const h = harness("{not json");
    expect(await h.run()).toBe(1);
    expect(h.written).toEqual([]);
  });

  it("exits 1 with NO output when stdin is not an array", async () => {
    const h = harness(JSON.stringify({ events: [] }));
    expect(await h.run()).toBe(1);
    expect(h.written).toEqual([]);
  });

  it("exits 1 with NO output when stdin cannot be read", async () => {
    const h = harness(async () => {
      throw new Error("EPIPE");
    });
    expect(await h.run()).toBe(1);
    expect(h.written).toEqual([]);
  });

  it("exits 1 with NO output when the write itself faults", async () => {
    // A broken pipe mid-write must still be exit 1, so flush.sh defers rather
    // than PATCHing a truncated body it would otherwise read as valid JSON.
    const written: string[] = [];
    const code = await runInternalRedactEvents([], {
      readStdin: async () => JSON.stringify([{ eventKey: "k", payload: { prompt: "hi" } }]),
      writeOut: () => {
        throw new Error("EPIPE on stdout");
      },
    });
    expect(code).toBe(1);
    expect(written).toEqual([]);
  });

  it("passes an empty batch through", async () => {
    const h = harness("[]");
    expect(await h.run()).toBe(0);
    expect(h.written.join("")).toBe("[]");
  });
});
