import * as fs from "fs";
import * as path from "path";

import {
  parseArgs,
  normalizePostToolUseInput,
  scanTranscriptForDecisions,
  toSpoolEvents,
  runCaptureDecisions,
  type CaptureDeps,
} from "../../src/commands/internal-capture-decisions";
import {
  buildEventKey,
  type AgentDecisionSpoolEvent,
  type CanonicalDecisionPayload,
} from "../../src/lib/agent-decision";

// T12: `mla _internal capture-decisions`. The command is a pure transform with a
// thin IO shell; the pure functions are exercised exhaustively here and the IO
// wrapper is driven through injected deps (no real stdin / fs / clock).

const TOOL_USE_ID = "toolu_01KG96HLwsRri14JnaKPN33i";
const FIXTURE_DIR = path.join(__dirname, "..", "fixtures");

const POST_FIXTURE = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, "ask-user-question-claude.json"), "utf8"),
) as {
  tool_use_id: string;
  providerSessionId: string;
  tool_input: { questions: unknown[] };
  tool_response: { answers: Record<string, unknown> };
};

// A real PostToolUse hook payload: the fixture's tool_input/tool_response plus the
// hook envelope fields the command keys on (tool_name + tool_use_id).
function hookPayload(): Record<string, unknown> {
  return {
    session_id: POST_FIXTURE.providerSessionId,
    hook_event_name: "PostToolUse",
    tool_name: "AskUserQuestion",
    tool_use_id: POST_FIXTURE.tool_use_id,
    tool_input: POST_FIXTURE.tool_input,
    tool_response: POST_FIXTURE.tool_response,
  };
}

const TRANSCRIPT = fs.readFileSync(path.join(FIXTURE_DIR, "transcript-with-ask.jsonl"), "utf8");

function makeDeps(over: Partial<CaptureDeps> & { stdin?: string; files?: Record<string, string> } = {}): {
  deps: CaptureDeps;
  out: string[];
  errs: string[];
} {
  const out: string[] = [];
  const errs: string[] = [];
  const files = over.files ?? {};
  const deps: CaptureDeps = {
    readStdin: over.readStdin ?? (async () => over.stdin ?? ""),
    readFile:
      over.readFile ??
      ((p: string) => {
        if (!(p in files)) throw new Error(`ENOENT: ${p}`);
        return files[p];
      }),
    now: over.now ?? (() => "2026-06-09T00:00:00.000Z"),
    writeLine: over.writeLine ?? ((l: string) => out.push(l)),
    logError: over.logError ?? ((m: string) => errs.push(m)),
  };
  return { deps, out, errs };
}

describe("parseArgs", () => {
  it("parses a post_tool_use invocation", () => {
    expect(parseArgs(["--source", "post_tool_use", "--session", "s1"])).toEqual({
      source: "post_tool_use",
      session: "s1",
    });
  });

  it("parses a stop_transcript_scan invocation with transcript + spool", () => {
    expect(
      parseArgs([
        "--source",
        "stop_transcript_scan",
        "--session",
        "s1",
        "--transcript",
        "/t.jsonl",
        "--spool",
        "/q.jsonl",
      ]),
    ).toEqual({
      source: "stop_transcript_scan",
      session: "s1",
      transcript: "/t.jsonl",
      spool: "/q.jsonl",
    });
  });

  it("throws on an unknown argument rather than silently binding it", () => {
    expect(() => parseArgs(["--source", "post_tool_use", "--session", "s1", "--nope"])).toThrow(
      /Unknown argument/,
    );
  });

  it("throws on a missing or invalid --source", () => {
    expect(() => parseArgs(["--session", "s1"])).toThrow(/--source/);
    expect(() => parseArgs(["--source", "bogus", "--session", "s1"])).toThrow(/--source/);
  });

  it("throws when --session is absent", () => {
    expect(() => parseArgs(["--source", "post_tool_use"])).toThrow(/--session/);
  });

  it("requires --transcript for a transcript scan", () => {
    expect(() => parseArgs(["--source", "stop_transcript_scan", "--session", "s1"])).toThrow(
      /--transcript/,
    );
  });
});

describe("normalizePostToolUseInput", () => {
  it("decomposes one 2-question call into 2 post_tool_use decisions", () => {
    const decisions = normalizePostToolUseInput(hookPayload(), {
      providerSessionId: "sess",
      occurredAt: "2026-06-09T00:00:00.000Z",
    });
    expect(decisions).toHaveLength(2);
    expect(decisions.map((d) => d.providerEventId)).toEqual([`${TOOL_USE_ID}#0`, `${TOOL_USE_ID}#1`]);
    expect(decisions.every((d) => d.capturedBy === "post_tool_use")).toBe(true);
    expect(decisions[0].decisionKind).toBe("choice");
    // The second answer is free text that matches no offered label.
    expect(decisions[1].decisionKind).toBe("free_text");
    expect(decisions[0].occurredAt).toBe("2026-06-09T00:00:00.000Z");
  });

  it("returns [] for a non-AskUserQuestion tool", () => {
    expect(
      normalizePostToolUseInput(
        { ...hookPayload(), tool_name: "Bash" },
        { providerSessionId: "sess", occurredAt: "t" },
      ),
    ).toEqual([]);
  });

  it("returns [] when the payload is structurally unusable (no tool_use_id)", () => {
    const bad = hookPayload();
    delete bad.tool_use_id;
    expect(normalizePostToolUseInput(bad, { providerSessionId: "sess", occurredAt: "t" })).toEqual([]);
  });

  it("returns [] when answers are missing", () => {
    const bad = hookPayload();
    bad.tool_response = { questions: [] };
    expect(normalizePostToolUseInput(bad, { providerSessionId: "sess", occurredAt: "t" })).toEqual([]);
  });

  it("normalizes a Codex request_user_input answer keyed by question id", () => {
    const decisions = normalizePostToolUseInput(
      {
        session_id: "codex-session",
        hook_event_name: "PostToolUse",
        tool_name: "request_user_input",
        tool_use_id: "request-1",
        tool_input: {
          questions: [
            {
              id: "rollout",
              header: "Rollout",
              question: "How should we ship this?",
              options: [
                { label: "Canary", description: "Start small." },
                { label: "All at once", description: "Ship everywhere." },
              ],
            },
          ],
        },
        tool_response: { answers: { rollout: "Canary" } },
      },
      { providerSessionId: "codex-session", occurredAt: "2026-07-21T00:00:00.000Z" },
    );

    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toEqual(
      expect.objectContaining({
        provider: "codex",
        providerSource: "codex_hook",
        providerToolName: "request_user_input",
        providerEventId: "request-1#0",
        providerSessionId: "codex-session",
        decisionKind: "choice",
        capturedBy: "post_tool_use",
      }),
    );
    expect(decisions[0].answer).toEqual(
      expect.objectContaining({
        type: "choice_label",
        value: "Canary",
        choiceId: "choice_0",
        choiceMatchStatus: "exact_unique",
      }),
    );
  });

  it("accepts Codex's JSON-string response and preserves an Other answer as free text", () => {
    const decisions = normalizePostToolUseInput(
      {
        tool_name: "request_user_input",
        tool_use_id: "request-2",
        tool_input: {
          questions: [
            {
              id: "target",
              header: "Target",
              question: "Where should this go?",
              options: [{ label: "Console", description: "Use the Console." }],
            },
          ],
        },
        tool_response: JSON.stringify({ answers: { target: "A new surface" } }),
      },
      { providerSessionId: "codex-session", occurredAt: "t" },
    );

    expect(decisions).toHaveLength(1);
    expect(decisions[0].decisionKind).toBe("free_text");
    expect(decisions[0].answer).toEqual(
      expect.objectContaining({
        type: "free_text",
        value: "A new surface",
        choiceMatchStatus: "no_match",
      }),
    );
  });
});

describe("scanTranscriptForDecisions", () => {
  const decisions = scanTranscriptForDecisions(TRANSCRIPT.split("\n"), { providerSessionId: "sess" });

  it("recovers both AskUserQuestion decisions from the transcript", () => {
    expect(decisions).toHaveLength(2);
    expect(decisions.every((d) => d.capturedBy === "stop_transcript_scan")).toBe(true);
  });

  it("derives the SAME providerEventId as the PostToolUse path (cross-path dedup key)", () => {
    const post = normalizePostToolUseInput(hookPayload(), {
      providerSessionId: "sess",
      occurredAt: "t",
    });
    expect(decisions.map((d) => d.providerEventId)).toEqual(post.map((d) => d.providerEventId));
    expect(decisions.map((d) => d.providerEventId)).toEqual([`${TOOL_USE_ID}#0`, `${TOOL_USE_ID}#1`]);
  });

  it("ignores a Bash tool_result (different sidecar) and tolerates a non-JSON line", () => {
    // The fixture contains a Bash tool_result and a garbage line between the
    // AskUserQuestion tool_use and its result; neither produces a decision.
    expect(decisions).toHaveLength(2);
  });

  it("sets occurredAt from the user line timestamp", () => {
    expect(decisions[0].occurredAt).toBe("2026-06-08T12:00:00.000Z");
  });

  it("returns [] for a transcript with no AskUserQuestion", () => {
    const lines = [
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } }),
    ];
    expect(scanTranscriptForDecisions(lines, { providerSessionId: "sess" })).toEqual([]);
  });
});

describe("toSpoolEvents", () => {
  const payloads = normalizePostToolUseInput(hookPayload(), {
    providerSessionId: "sess",
    occurredAt: "t",
  });

  it("wraps each payload in the canonical spool envelope", () => {
    const events = toSpoolEvents(payloads, { sessionId: "sess", ts: "2026-06-09T00:00:00.000Z" });
    expect(events).toHaveLength(2);
    const e = events[0];
    expect(e.event).toBe("agent_decision_captured");
    expect(e.sessionId).toBe("sess");
    expect(e.ts).toBe("2026-06-09T00:00:00.000Z");
    expect(e.eventKey).toBe(buildEventKey(e.payload.provider, e.payload.providerEventId));
    expect(e.eventKey).toBe(`agent_decision_captured:claude_code:${TOOL_USE_ID}#0`);
  });

  it("skips eventKeys already present in the spool (backstop dedup)", () => {
    const existing = new Set([`agent_decision_captured:claude_code:${TOOL_USE_ID}#0`]);
    const events = toSpoolEvents(payloads, {
      sessionId: "sess",
      ts: "t",
      existingEventKeys: existing,
    });
    expect(events).toHaveLength(1);
    expect(events[0].payload.providerEventId).toBe(`${TOOL_USE_ID}#1`);
  });

  it("dedups within a single batch", () => {
    const dup = [...payloads, payloads[0]];
    const events = toSpoolEvents(dup, { sessionId: "sess", ts: "t" });
    expect(events).toHaveLength(2);
  });

  it("fail-soft skips an invalid payload and logs it", () => {
    const errs: string[] = [];
    const broken = { ...payloads[0], decisionKind: "garbage" } as unknown as CanonicalDecisionPayload;
    const events = toSpoolEvents([broken, payloads[1]], {
      sessionId: "sess",
      ts: "t",
      logError: (m) => errs.push(m),
    });
    expect(events).toHaveLength(1);
    expect(events[0].payload.providerEventId).toBe(`${TOOL_USE_ID}#1`);
    expect(errs.join("\n")).toMatch(/skipping invalid decision/);
  });
});

describe("runCaptureDecisions (IO wrapper)", () => {
  function parseLines(out: string[]): AgentDecisionSpoolEvent[] {
    return out.map((l) => JSON.parse(l) as AgentDecisionSpoolEvent);
  }

  it("post_tool_use: reads stdin and emits one spool line per decision", async () => {
    const { deps, out } = makeDeps({ stdin: JSON.stringify(hookPayload()) });
    const code = await runCaptureDecisions(["--source", "post_tool_use", "--session", "sess"], deps);
    expect(code).toBe(0);
    const events = parseLines(out);
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.payload.providerEventId)).toEqual([`${TOOL_USE_ID}#0`, `${TOOL_USE_ID}#1`]);
    expect(events.every((e) => e.payload.capturedBy === "post_tool_use")).toBe(true);
  });

  it("post_tool_use: emits a provider-scoped Codex decision spool event", async () => {
    const { deps, out } = makeDeps({
      stdin: JSON.stringify({
        tool_name: "request_user_input",
        tool_use_id: "request-io-1",
        tool_input: {
          questions: [
            {
              id: "choice",
              header: "Choice",
              question: "Choose one",
              options: [{ label: "First", description: "The first option." }],
            },
          ],
        },
        tool_response: { answers: { choice: "First" } },
      }),
    });
    const code = await runCaptureDecisions(
      ["--source", "post_tool_use", "--session", "codex-session"],
      deps,
    );
    expect(code).toBe(0);
    const events = parseLines(out);
    expect(events).toHaveLength(1);
    expect(events[0].eventKey).toBe("agent_decision_captured:codex:request-io-1#0");
    expect(events[0].payload.providerSource).toBe("codex_hook");
  });

  it("stop_transcript_scan: reads the transcript file and emits decisions", async () => {
    const { deps, out } = makeDeps({ files: { "/t.jsonl": TRANSCRIPT } });
    const code = await runCaptureDecisions(
      ["--source", "stop_transcript_scan", "--session", "sess", "--transcript", "/t.jsonl"],
      deps,
    );
    expect(code).toBe(0);
    const events = parseLines(out);
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.payload.capturedBy === "stop_transcript_scan")).toBe(true);
  });

  it("stop_transcript_scan: skips decisions already in the spool", async () => {
    const spoolLine = JSON.stringify({
      eventKey: `agent_decision_captured:claude_code:${TOOL_USE_ID}#0`,
    });
    const { deps, out } = makeDeps({
      files: { "/t.jsonl": TRANSCRIPT, "/q.jsonl": spoolLine + "\n" },
    });
    const code = await runCaptureDecisions(
      [
        "--source",
        "stop_transcript_scan",
        "--session",
        "sess",
        "--transcript",
        "/t.jsonl",
        "--spool",
        "/q.jsonl",
      ],
      deps,
    );
    expect(code).toBe(0);
    const events = parseLines(out);
    expect(events).toHaveLength(1);
    expect(events[0].payload.providerEventId).toBe(`${TOOL_USE_ID}#1`);
  });

  it("returns 2 on a parse error", async () => {
    const { deps, errs } = makeDeps();
    const code = await runCaptureDecisions(["--source", "bogus", "--session", "s"], deps);
    expect(code).toBe(2);
    expect(errs.join("\n")).toMatch(/--source/);
  });

  it("empty stdin is a clean no-op", async () => {
    const { deps, out } = makeDeps({ stdin: "   " });
    const code = await runCaptureDecisions(["--source", "post_tool_use", "--session", "sess"], deps);
    expect(code).toBe(0);
    expect(out).toEqual([]);
  });

  it("malformed stdin JSON does not crash the hook (returns 0, logs)", async () => {
    const { deps, out, errs } = makeDeps({ stdin: "{not json" });
    const code = await runCaptureDecisions(["--source", "post_tool_use", "--session", "sess"], deps);
    expect(code).toBe(0);
    expect(out).toEqual([]);
    expect(errs.join("\n")).toMatch(/not valid JSON/);
  });

  it("a missing transcript file does not crash the hook (returns 0, logs)", async () => {
    const { deps, out, errs } = makeDeps();
    const code = await runCaptureDecisions(
      ["--source", "stop_transcript_scan", "--session", "sess", "--transcript", "/missing.jsonl"],
      deps,
    );
    expect(code).toBe(0);
    expect(out).toEqual([]);
    expect(errs.join("\n")).toMatch(/cannot read transcript/);
  });
});
