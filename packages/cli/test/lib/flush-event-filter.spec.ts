import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Behavioral lock for the Pass 2 batch filter (Wedge v6 Epoch 25).
//
// Pre-fix flush.sh ran `jq -s '...'` on the raw queue snapshot. `-s` (slurp)
// parses the whole file as a JSON-value stream; ONE malformed line caused jq
// to exit non-zero and the shell substitution fallback `|| echo "[]"`
// returned an empty array. flush.sh then PATCHed an empty events list and
// considered the batch shipped. Every valid event in the same batch was
// silently lost.
//
// Post-fix the filter reads `-R -s` (raw + slurp), splits on newlines, runs
// `fromjson?` per line so malformed lines are skipped instead of aborting
// the pipeline. This spec pins the contract by exec'ing jq against the
// SAME filter file flush.sh references at runtime.

const FILTER_PATH = path.resolve(
  __dirname,
  "../../src/hooks-template/event-batch-filter.jq",
);

function runFilter(input: string): unknown[] {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mla-jq-"));
  const tmpFile = path.join(tmp, "events.jsonl");
  fs.writeFileSync(tmpFile, input);
  const r = spawnSync("jq", ["-c", "-R", "-s", "-f", FILTER_PATH], {
    input: "",
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
    // Feed the file via shell redirection equivalent using `<`.
    // spawnSync doesn't do shell redirection, so pipe the file contents on stdin.
  });
  if (r.status !== 0) {
    throw new Error(
      `jq exited ${r.status}: ${r.stderr}\nstdout: ${r.stdout}\ninput was:\n${input}`,
    );
  }
  const parsed = JSON.parse(r.stdout);
  if (!Array.isArray(parsed)) {
    throw new Error(`expected array, got: ${r.stdout}`);
  }
  return parsed as unknown[];
}

function runFilterViaStdin(input: string): unknown[] {
  const r = spawnSync("jq", ["-c", "-R", "-s", "-f", FILTER_PATH], {
    input,
    encoding: "utf8",
  });
  if (r.status !== 0) {
    throw new Error(
      `jq exited ${r.status}: ${r.stderr}\nstdout: ${r.stdout}\ninput was:\n${input}`,
    );
  }
  const parsed = JSON.parse(r.stdout);
  if (!Array.isArray(parsed)) {
    throw new Error(`expected array, got: ${r.stdout}`);
  }
  return parsed as unknown[];
}

describe("event-batch-filter.jq", () => {
  beforeAll(() => {
    expect(fs.existsSync(FILTER_PATH)).toBe(true);
    const jq = spawnSync("jq", ["--version"], { encoding: "utf8" });
    if (jq.status !== 0) {
      throw new Error("jq must be installed to run flush-event-filter specs");
    }
  });

  it("passes through valid prompt_submitted + tool_used_bash + session_stopped lines", () => {
    const input = [
      '{"ts":"2026-05-27T00:00:00.000Z","event":"prompt_submitted","eventKey":"k1","sessionId":"s","payload":{"text":"go"}}',
      '{"ts":"2026-05-27T00:00:01.000Z","event":"tool_used_bash","eventKey":"k2","sessionId":"s","payload":{"command":"pnpm test","exitCode":0}}',
      '{"ts":"2026-05-27T00:00:02.000Z","event":"session_stopped","eventKey":"k3","sessionId":"s","payload":{"finalMessage":"done"}}',
      "",
    ].join("\n");
    const out = runFilterViaStdin(input);
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({
      eventKey: "k1",
      eventType: "prompt_submitted",
      occurredAt: "2026-05-27T00:00:00.000Z",
      source: "claude_hook",
      payload: { text: "go" },
    });
    expect(out[1]).toMatchObject({
      eventKey: "k2",
      eventType: "tool_used_bash",
      payload: { command: "pnpm test", exitCode: 0 },
    });
    expect(out[2]).toMatchObject({
      eventKey: "k3",
      eventType: "session_stopped",
    });
  });

  // Dogfood-audit 2026-06-10 issue 3: tool capture was bash-only. The hook now
  // spools tool_used_file for Write/Edit/MultiEdit/NotebookEdit; the whitelist
  // MUST pass it through or code-only sessions stay invisible to control.
  it("whitelists tool_used_file with the generic claude_hook envelope", () => {
    const input =
      '{"ts":"2026-06-10T18:00:00.000Z","event":"tool_used_file","eventKey":"kf1","sessionId":"s","payload":{"tool":"Edit","filePath":"/repo/src/service.ts"}}';
    const out = runFilterViaStdin(input);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      eventKey: "kf1",
      eventType: "tool_used_file",
      occurredAt: "2026-06-10T18:00:00.000Z",
      source: "claude_hook",
      payload: { tool: "Edit", filePath: "/repo/src/service.ts" },
    });
    const ev = out[0] as Record<string, unknown>;
    expect(ev.provider).toBeUndefined();
    expect(ev.adapter).toBeUndefined();
  });

  // InjectionTrace keystone (§7.2 / §7.5 slice 2a, TEST 2): the hook spools an
  // injection_trace line whose payload control diverts to the InjectionTrace
  // projection. The whitelist MUST pass it through under the generic claude_hook
  // envelope, payload intact, or the Injected lane stays permanently empty.
  it("whitelists injection_trace with the generic claude_hook envelope, payload intact", () => {
    const input = JSON.stringify({
      ts: "2026-06-10T18:00:00.000Z",
      event: "injection_trace",
      eventKey: "inj-1",
      sessionId: "s",
      payload: {
        sourceSurface: "HOOK",
        turnIndex: 2,
        injectId: "inj-1",
        traceId: "0123456789abcdef0123456789abcdef",
        deliveryStatus: "INJECTED",
        schemaVersion: 1,
        status: "ok",
        confidence: 0.7,
        contextItems: [{ citation: "DD:9", injected: true }],
      },
    });
    const out = runFilterViaStdin(input);
    expect(out).toHaveLength(1);
    const ev = out[0] as Record<string, unknown>;
    expect(ev.eventKey).toBe("inj-1");
    expect(ev.eventType).toBe("injection_trace");
    expect(ev.occurredAt).toBe("2026-06-10T18:00:00.000Z");
    expect(ev.source).toBe("claude_hook");
    expect(ev.provider).toBeUndefined();
    expect(ev.adapter).toBeUndefined();
    const payload = ev.payload as Record<string, unknown>;
    expect(payload.sourceSurface).toBe("HOOK");
    expect(payload.deliveryStatus).toBe("INJECTED");
    expect((payload.contextItems as unknown[])).toHaveLength(1);
  });

  // Timeline-replay gap (Bug A, 2026-06-12): stop.sh spools an `assistant_message`
  // event carrying the turn's intra-turn narration, but the forward whitelist
  // never listed it, so every session's prose was silently dropped between the
  // spool and control (0 assistant_message rows across all sessions). The
  // whitelist MUST pass it through under the generic claude_hook envelope, the
  // `{narration}` payload intact, or the timeline can never replay agent prose.
  it("whitelists assistant_message with the generic claude_hook envelope, narration payload intact", () => {
    const input = JSON.stringify({
      ts: "2026-06-12T20:17:49.000Z",
      event: "assistant_message",
      eventKey: "am-1",
      sessionId: "s",
      payload: { narration: "I'll find the button.\n\nThe button is shared." },
    });
    const out = runFilterViaStdin(input);
    expect(out).toHaveLength(1);
    const ev = out[0] as Record<string, unknown>;
    expect(ev.eventKey).toBe("am-1");
    expect(ev.eventType).toBe("assistant_message");
    expect(ev.occurredAt).toBe("2026-06-12T20:17:49.000Z");
    expect(ev.source).toBe("claude_hook");
    expect(ev.provider).toBeUndefined();
    expect(ev.adapter).toBeUndefined();
    const payload = ev.payload as Record<string, unknown>;
    expect(payload.narration).toBe(
      "I'll find the button.\n\nThe button is shared.",
    );
  });

  // Governed-story §3.1 / T10: the forwarded MCP action rides the EXISTING
  // AgentRunEvent transport (same generic claude_hook envelope as
  // tool_used_bash / tool_used_file). The whitelist MUST pass tool_used_mcp
  // through with its structured payload intact, or the session-detail "what did
  // mla do" lane reads empty for every governed-memory call. It is NOT a
  // captured decision, so it carries NO provider/adapter envelope fields.
  it("whitelists tool_used_mcp with the generic claude_hook envelope, structured payload intact", () => {
    const input = JSON.stringify({
      ts: "2026-06-27T12:00:00.000Z",
      event: "tool_used_mcp",
      eventKey: "mcp:231a83a5-b2d4-4cae-94c6-5be4638890c0:t_abc",
      sessionId: "231a83a5-b2d4-4cae-94c6-5be4638890c0",
      payload: {
        turnId: "231a83a5-b2d4-4cae-94c6-5be4638890c0:7",
        turnIndex: 7,
        toolName: "mcp__meetless__meetless__retrieve_knowledge",
        operation: "retrieve_knowledge",
        outcome: "success",
        query: "[REDACTED]",
        sourceIds: ["DD:9", "NT:notes/x.md"],
      },
    });
    const out = runFilterViaStdin(input);
    expect(out).toHaveLength(1);
    const ev = out[0] as Record<string, unknown>;
    expect(ev.eventKey).toBe("mcp:231a83a5-b2d4-4cae-94c6-5be4638890c0:t_abc");
    expect(ev.eventType).toBe("tool_used_mcp");
    expect(ev.occurredAt).toBe("2026-06-27T12:00:00.000Z");
    expect(ev.source).toBe("claude_hook");
    expect(ev.provider).toBeUndefined();
    expect(ev.adapter).toBeUndefined();
    const payload = ev.payload as Record<string, unknown>;
    expect(payload.turnId).toBe("231a83a5-b2d4-4cae-94c6-5be4638890c0:7");
    expect(payload.turnIndex).toBe(7);
    expect(payload.operation).toBe("retrieve_knowledge");
    expect(payload.outcome).toBe("success");
    expect(payload.query).toBe("[REDACTED]");
    expect(payload.sourceIds).toEqual(["DD:9", "NT:notes/x.md"]);
  });

  // Governed-story §4.3 / T10: the HOOK producer's v2 InjectionTrace carries the
  // structured story fields (schemaVersion 2, blocks[], summary{}, turnId). The
  // whitelist is type-keyed (injection_trace), schema-agnostic, so the SAME gate
  // must pass the richer v2 payload through byte-intact (no field stripping) or
  // the colored per-block timeline can never render.
  it("whitelists a v2 injection_trace (blocks/summary/turnId) payload intact", () => {
    const input = JSON.stringify({
      ts: "2026-06-27T12:00:01.000Z",
      event: "injection_trace",
      eventKey: "inj-v2-1",
      sessionId: "231a83a5-b2d4-4cae-94c6-5be4638890c0",
      payload: {
        sourceSurface: "HOOK",
        turnIndex: 7,
        turnId: "231a83a5-b2d4-4cae-94c6-5be4638890c0:7",
        injectId: "inj-v2-1",
        traceId: "0123456789abcdef0123456789abcdef",
        deliveryStatus: "INJECTED",
        schemaVersion: 2,
        status: "ok",
        confidence: "high",
        contextItems: [{ source_id: "DD:9", injected: true }],
        blocks: [
          {
            kind: "static",
            content: "floor text",
            contentStatus: "available",
            citations: [],
            charCount: 10,
            itemCount: 0,
          },
          {
            kind: "evidence",
            content: null,
            contentStatus: "redaction_failed",
            citations: ["DD:9"],
            charCount: 0,
            itemCount: 1,
          },
        ],
        summary: {
          blockCount: 2,
          injectedCharCount: 10,
          ruleCount: 0,
          evidenceCount: 1,
          layer2Injected: true,
        },
        capturedAt: "2026-06-27T12:00:01.000Z",
      },
    });
    const out = runFilterViaStdin(input);
    expect(out).toHaveLength(1);
    const ev = out[0] as Record<string, unknown>;
    expect(ev.eventType).toBe("injection_trace");
    expect(ev.source).toBe("claude_hook");
    const payload = ev.payload as Record<string, unknown>;
    expect(payload.sourceSurface).toBe("HOOK");
    expect(payload.schemaVersion).toBe(2);
    expect(payload.turnId).toBe("231a83a5-b2d4-4cae-94c6-5be4638890c0:7");
    const blocks = payload.blocks as Record<string, unknown>[];
    expect(blocks).toHaveLength(2);
    expect(blocks[0].kind).toBe("static");
    expect(blocks[0].contentStatus).toBe("available");
    expect(blocks[1].contentStatus).toBe("redaction_failed");
    expect(blocks[1].content).toBeNull();
    const summary = payload.summary as Record<string, unknown>;
    expect(summary.blockCount).toBe(2);
    expect(summary.evidenceCount).toBe(1);
    expect(summary.layer2Injected).toBe(true);
  });

  it("filters OUT session_started (Pass 1 handles those line-by-line)", () => {
    const input = [
      '{"ts":"t","event":"session_started","eventKey":"k0","sessionId":"s","payload":{"adapter":"claude_code"}}',
      '{"ts":"t","event":"prompt_submitted","eventKey":"k1","sessionId":"s","payload":{}}',
    ].join("\n");
    const out = runFilterViaStdin(input);
    expect(out).toHaveLength(1);
    expect((out[0] as { eventKey: string }).eventKey).toBe("k1");
  });

  it("filters OUT finalize_requested (control signal, not an event)", () => {
    const input = [
      '{"ts":"t","event":"finalize_requested","eventKey":"kf","sessionId":"s","payload":{}}',
      '{"ts":"t","event":"prompt_submitted","eventKey":"k1","sessionId":"s","payload":{}}',
    ].join("\n");
    const out = runFilterViaStdin(input);
    expect(out).toHaveLength(1);
    expect((out[0] as { eventKey: string }).eventKey).toBe("k1");
  });

  // T15/T16 (notes/20260608-agent-decision-capture-design.md sections 5/6):
  // the whitelist MUST include agent_decision_captured or every captured
  // agent-human decision is silently dropped between the spool and control.
  it("whitelists agent_decision_captured and stamps the agent_adapter transport envelope", () => {
    const decision = {
      ts: "2026-06-08T12:00:00-05:00",
      event: "agent_decision_captured",
      eventKey: "agent_decision_captured:claude_code:toolu_x#0",
      sessionId: "s",
      payload: {
        provider: "claude_code",
        providerSource: "claude_hook",
        providerToolName: "AskUserQuestion",
        providerEventId: "toolu_x#0",
        decisionKind: "choice",
        prompt: { title: "MCP scope" },
        choices: [{ id: "choice_0", label: "a" }],
        answer: { type: "choice_label", value: "a", choiceId: "choice_0" },
        multiSelect: false,
        capturedBy: "post_tool_use",
        rawProviderPayload: {},
      },
    };
    const out = runFilterViaStdin(JSON.stringify(decision));
    expect(out).toHaveLength(1);
    const ev = out[0] as Record<string, unknown>;
    // Stronger transport source model so future providers do not overload `source`.
    expect(ev.source).toBe("agent_adapter");
    // provider/adapter are lifted from the payload (provider / providerSource) to
    // the top level so control can validate INV-ENVELOPE-PAYLOAD-CONSISTENCY: the
    // envelope must AGREE with the canonical payload before a row is written.
    expect(ev.provider).toBe("claude_code");
    expect(ev.adapter).toBe("claude_hook");
    expect(ev.eventType).toBe("agent_decision_captured");
    expect(ev.occurredAt).toBe("2026-06-08T12:00:00-05:00");
    // The canonical payload survives intact (it is the materialization source).
    const payload = ev.payload as Record<string, unknown>;
    expect(payload.providerEventId).toBe("toolu_x#0");
    expect(payload.decisionKind).toBe("choice");
    expect((payload.answer as Record<string, unknown>).choiceId).toBe("choice_0");
  });

  // Whitelist regression: a brand-new/unknown event type must be dropped, NOT
  // passed through. The whitelist is the only gate; an unlisted type silently
  // vanishes (no error), so this pins the closed set.
  it("drops an event type that is not on the whitelist", () => {
    const input = [
      '{"ts":"t","event":"agent_decision_captured","eventKey":"kd","sessionId":"s","payload":{"provider":"claude_code","providerSource":"claude_hook"}}',
      '{"ts":"t","event":"some_future_event","eventKey":"kx","sessionId":"s","payload":{}}',
      '{"ts":"t","event":"tool_used_bash","eventKey":"k2","sessionId":"s","payload":{}}',
    ].join("\n");
    const out = runFilterViaStdin(input);
    const keys = out.map((e) => (e as { eventKey: string }).eventKey).sort();
    expect(keys).toEqual(["k2", "kd"]);
  });

  // A non-decision event keeps the generic claude_hook source and carries NO
  // provider/adapter envelope fields (they are decision-only transport metadata).
  it("non-decision events keep source:claude_hook with no provider/adapter fields", () => {
    const out = runFilterViaStdin(
      '{"ts":"t","event":"tool_used_bash","eventKey":"k2","sessionId":"s","payload":{"command":"x"}}',
    );
    expect(out).toHaveLength(1);
    const ev = out[0] as Record<string, unknown>;
    expect(ev.source).toBe("claude_hook");
    expect(ev).not.toHaveProperty("provider");
    expect(ev).not.toHaveProperty("adapter");
  });

  // THE TRAP THIS EPOCH CLOSED. Pre-fix the whole pipeline collapsed to
  // [] on a single bad line; post-fix the bad line is skipped and the
  // rest of the batch survives.
  it("regression: ONE malformed line does NOT poison the whole batch", () => {
    const input = [
      '{"ts":"t","event":"prompt_submitted","eventKey":"k1","sessionId":"s","payload":{}}',
      "{this is not json,",
      '{"ts":"t","event":"tool_used_bash","eventKey":"k2","sessionId":"s","payload":{"command":"x"}}',
      "garbage 12345",
      '{"ts":"t","event":"session_stopped","eventKey":"k3","sessionId":"s","payload":{}}',
    ].join("\n");
    const out = runFilterViaStdin(input);
    const keys = out.map((e) => (e as { eventKey: string }).eventKey);
    expect(keys.sort()).toEqual(["k1", "k2", "k3"]);
  });

  it("tolerates a trailing newline + empty lines without producing nulls", () => {
    const input = [
      '{"ts":"t","event":"prompt_submitted","eventKey":"k1","sessionId":"s","payload":{}}',
      "",
      "",
      '{"ts":"t","event":"tool_used_bash","eventKey":"k2","sessionId":"s","payload":{}}',
      "",
    ].join("\n");
    const out = runFilterViaStdin(input);
    expect(out).toHaveLength(2);
    for (const ev of out) {
      expect(ev).not.toBeNull();
    }
  });

  it("returns an empty array on an entirely empty batch", () => {
    expect(runFilterViaStdin("")).toEqual([]);
    expect(runFilterViaStdin("\n\n\n")).toEqual([]);
  });

  it("returns an empty array on an entirely corrupt batch (no exit-1 cliff)", () => {
    const input = ["{not_json", "also bad", "still bad"].join("\n");
    const out = runFilterViaStdin(input);
    expect(out).toEqual([]);
  });

  it("missing payload defaults to {} (matches control DTO expectation)", () => {
    const input = '{"ts":"t","event":"prompt_submitted","eventKey":"k1","sessionId":"s"}';
    const out = runFilterViaStdin(input);
    expect(out).toHaveLength(1);
    expect((out[0] as { payload: unknown }).payload).toEqual({});
  });

  it("preserves multibyte UTF-8 in payload (Vietnamese, emoji)", () => {
    const vi = "Lỗi: kiểm tra thất bại";
    const emoji = "🚨 fail";
    const line = JSON.stringify({
      ts: "2026-05-27T00:00:00.000Z",
      event: "tool_used_bash",
      eventKey: "k1",
      sessionId: "s",
      payload: { command: "pnpm test", stdoutTail: vi, stderrTail: emoji },
    });
    const out = runFilterViaStdin(line);
    expect(out).toHaveLength(1);
    const ev = out[0] as { payload: { stdoutTail: string; stderrTail: string } };
    expect(ev.payload.stdoutTail).toBe(vi);
    expect(ev.payload.stderrTail).toBe(emoji);
  });

  it("flush.sh references the filter at the SAME relative path the test reads", () => {
    // Drift guard: if flush.sh stops referencing event-batch-filter.jq, this
    // test passes a stale contract. The grep below pins the lookup.
    const flushSh = fs.readFileSync(
      path.resolve(__dirname, "../../src/hooks-template/flush.sh"),
      "utf8",
    );
    expect(flushSh).toContain("event-batch-filter.jq");
    expect(flushSh).toMatch(/jq\s+-c\s+-R\s+-s\s+-f/);
  });

  // Suppress unused warning; keep runFilter for possible file-input variant.
  void runFilter;
});
