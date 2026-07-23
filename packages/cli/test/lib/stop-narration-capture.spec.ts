import { spawn, spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Slice B3 of the full-prose replay (note 20260610 §4 P3 step 11, capture-scope
// option B). The Stop hook already captures the agent's LAST assistant message
// as session_stopped.finalMessage (the closing summary). This adds the missing
// INTRA-turn narration: the agent's own visible text emitted BETWEEN tool calls,
// spooled once per turn as an `assistant_message` event so the timeline replay
// reads as a real back-and-forth instead of prompt -> tool -> tool -> summary.
//
// The narration is turn-bounded: only assistant text AFTER the last real user
// prompt is captured (tool_result entries are user-role too, so we must exclude
// them or we would pull prior-turn prose), and the closing summary is dropped so
// it is never double-counted against session_stopped.finalMessage.

const HOOKS_DIR = path.resolve(__dirname, "../../src/hooks-template");
const COMMON = path.join(HOOKS_DIR, "common.sh");
const HOOK = "stop.sh";

interface Harness {
  fire: (input: object, extraEnv?: Record<string, string>) => number;
  events: (sessionId: string) => any[];
  writeTranscript: (lines: object[]) => string;
  seedTurn: (sessionId: string, n: number) => void;
  tmp: string;
}

function mkHarness(activate = true): { h: Harness; cleanup: () => void } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mla-narrcap-"));
  fs.copyFileSync(COMMON, path.join(tmp, "common.sh"));
  fs.copyFileSync(path.join(HOOKS_DIR, HOOK), path.join(tmp, HOOK));
  fs.chmodSync(path.join(tmp, HOOK), 0o755);

  const home = path.join(tmp, "home");
  fs.mkdirSync(home);
  fs.writeFileSync(
    path.join(home, "cli-config.json"),
    JSON.stringify({
      controlUrl: "http://127.0.0.1:1",
      controlToken: "x",
      workspaceId: "ws_test",
      mlaPath: "/bin/true",
    }),
  );
  const workdir = path.join(tmp, "workdir");
  fs.mkdirSync(workdir);
  if (activate) fs.writeFileSync(path.join(workdir, ".meetless.json"), "{}\n");

  const queueDir = path.join(home, "queue");

  const h: Harness = {
    tmp,
    fire: (input: object, extraEnv: Record<string, string> = {}) => {
      const r = spawnSync("bash", [path.join(tmp, HOOK)], {
        input: JSON.stringify(input),
        encoding: "utf8",
        cwd: workdir,
        env: {
          ...process.env,
          MEETLESS_HOME: home,
          MEETLESS_DEBUG: "0",
          ...extraEnv,
        },
      });
      return r.status ?? -1;
    },
    events: (sessionId: string) => {
      const p = path.join(queueDir, `${sessionId}.jsonl`);
      if (!fs.existsSync(p)) return [];
      return fs
        .readFileSync(p, "utf8")
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l));
    },
    writeTranscript: (lines: object[]) => {
      const p = path.join(tmp, "transcript.jsonl");
      fs.writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
      return p;
    },
    seedTurn: (sessionId: string, n: number) => {
      fs.mkdirSync(queueDir, { recursive: true });
      fs.writeFileSync(path.join(queueDir, `${sessionId}.turn`), String(n));
    },
  };
  return { h, cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}

// modern-transcript builders ------------------------------------------------
function userPrompt(text: string) {
  return { type: "user", message: { content: [{ type: "text", text }] } };
}
function toolResult(text: string) {
  return {
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "t1", content: text }] },
  };
}
function assistantTurn(text: string, withTool = false) {
  const content: any[] = [{ type: "text", text }];
  if (withTool) content.push({ type: "tool_use", id: "t1", name: "Bash", input: {} });
  return { type: "assistant", message: { content } };
}

// Background writer that simulates Claude Code flushing the closing assistant
// message a beat AFTER Stop fires. It keeps the transcript GROWING across
// stop.sh's poll intervals (system filler lines the text-extraction ignores),
// then appends the TRUE closing summary as the final line and goes quiet, so a
// settle-wait that polls for "file stopped growing" lands on the real summary
// while a no-retry single read grabs the stale second-to-last block.
function launchGrowingTranscript(transcriptPath: string, summaryLine: object) {
  const script = `
t="$1"
summary="$2"
for i in $(seq 1 15); do
  printf '%s\\n' '{"type":"system","content":"keepalive"}' >> "$t"
  sleep 0.03
done
printf '%s\\n' "$summary" >> "$t"
`;
  return spawn("bash", ["-c", script, "appender", transcriptPath, JSON.stringify(summaryLine)], {
    stdio: "ignore",
  });
}

describe("stop.sh: intra-turn narration capture (note 20260610 §4 P3 step 11, slice B3)", () => {
  beforeAll(() => {
    if (spawnSync("jq", ["--version"]).status !== 0) throw new Error("jq required");
  });

  it("spools an assistant_message with all narration but NOT the closing summary, turn-bounded", () => {
    const { h, cleanup } = mkHarness();
    try {
      h.seedTurn("narr-1", 3);
      const transcript = h.writeTranscript([
        // prior turn: must be excluded by turn-bounding (before the last prompt)
        assistantTurn("PRIOR_SENTINEL prior-turn prose"),
        userPrompt("please move the auth token check into a single guard"),
        assistantTurn("Let me read the middleware first. NARR_ONE_SENTINEL", true),
        toolResult("file contents..."),
        assistantTurn("Now I will move the guard and add a test. NARR_TWO_SENTINEL", true),
        toolResult("ok"),
        assistantTurn("Done. I moved the token check into one guard. CLOSING_SENTINEL"),
      ]);
      const status = h.fire({ session_id: "narr-1", transcript_path: transcript });
      expect(status).toBe(0);

      const events = h.events("narr-1");
      const narration = events.find((e) => e.event === "assistant_message");
      expect(narration).toBeDefined();
      expect(narration.payload.narration).toContain("NARR_ONE_SENTINEL");
      expect(narration.payload.narration).toContain("NARR_TWO_SENTINEL");
      // closing summary belongs to session_stopped, never narration
      expect(narration.payload.narration).not.toContain("CLOSING_SENTINEL");
      // turn-bounded: prior-turn prose is excluded
      expect(narration.payload.narration).not.toContain("PRIOR_SENTINEL");

      // and the closing summary still lands on session_stopped (no regression)
      const stopped = events.find((e) => e.event === "session_stopped");
      expect(stopped.payload.finalMessage).toContain("CLOSING_SENTINEL");
      expect(stopped.payload.finalMessage).not.toContain("NARR_ONE_SENTINEL");

      // narration is spooled BEFORE session_stopped so it renders ahead of
      // "Session ended" in the occurredAt/id-ordered timeline
      const idxNarr = events.findIndex((e) => e.event === "assistant_message");
      const idxStop = events.findIndex((e) => e.event === "session_stopped");
      expect(idxNarr).toBeLessThan(idxStop);
    } finally {
      cleanup();
    }
  });

  it("emits NO assistant_message when the turn has only a closing summary (nothing to narrate)", () => {
    const { h, cleanup } = mkHarness();
    try {
      h.seedTurn("narr-2", 1);
      const transcript = h.writeTranscript([
        userPrompt("what is 2 + 2"),
        assistantTurn("It is 4. CLOSING_ONLY_SENTINEL"),
      ]);
      h.fire({ session_id: "narr-2", transcript_path: transcript });
      const events = h.events("narr-2");
      expect(events.find((e) => e.event === "assistant_message")).toBeUndefined();
      // the single message is still captured as the closing summary
      expect(
        events.find((e) => e.event === "session_stopped").payload.finalMessage,
      ).toContain("CLOSING_ONLY_SENTINEL");
    } finally {
      cleanup();
    }
  });

  it("captures narration unconditionally: the removed MEETLESS_CAPTURE_NARRATION=0 no longer suppresses the assistant_message", () => {
    const { h, cleanup } = mkHarness();
    try {
      h.seedTurn("narr-3", 2);
      const transcript = h.writeTranscript([
        userPrompt("do the thing"),
        assistantTurn("Working on it. NARR_SENTINEL", true),
        toolResult("ok"),
        assistantTurn("Finished. CLOSING_SENTINEL"),
      ]);
      // The legacy kill switch was removed (narration is the default now), so
      // setting it has no effect: capture still happens.
      h.fire({ session_id: "narr-3", transcript_path: transcript }, {
        MEETLESS_CAPTURE_NARRATION: "0",
      });
      const events = h.events("narr-3");
      const narration = events.find((e) => e.event === "assistant_message");
      expect(narration).toBeDefined();
      expect(narration.payload.narration).toContain("NARR_SENTINEL");
      // the rest of the pipeline is unaffected
      expect(events.find((e) => e.event === "session_stopped")).toBeDefined();
    } finally {
      cleanup();
    }
  });

  it("drift guard: stop.sh emits assistant_message unconditionally, with no narration kill switch", () => {
    const src = fs.readFileSync(path.join(HOOKS_DIR, HOOK), "utf8");
    expect(src).toContain("assistant_message");
    expect(src).not.toMatch(/capture_narration_enabled/);
    expect(src).not.toMatch(/MEETLESS_CAPTURE_NARRATION/);
  });
});

// Dogfood-audit 2026-06-12 (Bug B). The Stop hook read the transcript "best-effort,
// no retry" (stop.sh:30). Claude Code can fire Stop a beat BEFORE the turn's closing
// assistant message is flushed to the transcript file, so the no-retry read grabbed
// the SECOND-to-last text block as finalMessage (observed live: stored "Now let me
// verify it typechecks cleanly." while the transcript's true final was "Done.
// Typecheck passes clean."). The narration slice (which drops the last block)
// inherits the same wrong boundary. The fix is a bounded settle-wait that polls the
// transcript byte-size until it stops growing before extracting, so the flush can
// land first. Tunable via MEETLESS_FINALMSG_POLL_SEC / MEETLESS_FINALMSG_MAX_ATTEMPTS.
describe("stop.sh: transcript-flush settle (Bug B: Q6 closing-summary race)", () => {
  beforeAll(() => {
    if (spawnSync("jq", ["--version"]).status !== 0) throw new Error("jq required");
  });

  it("captures the TRUE closing summary even when it flushes to the transcript after Stop fires", () => {
    const { h, cleanup } = mkHarness();
    let appender: ReturnType<typeof spawn> | undefined;
    try {
      h.seedTurn("settle-1", 4);
      // Seeded transcript ENDS at the second-to-last assistant text; the real
      // closing summary has not been flushed yet (the race window). The background
      // writer appends it ~0.45s later, after stop.sh's settle-wait has begun.
      const transcript = h.writeTranscript([
        userPrompt("run the typecheck and confirm it is clean"),
        assistantTurn("Let me read the file. NARR_SENTINEL", true),
        toolResult("file contents..."),
        assistantTurn("Now let me verify it typechecks cleanly. SECONDLAST_SENTINEL", true),
        toolResult("ok"),
      ]);
      const summary = assistantTurn("Done. Typecheck passes clean. CLOSING_SENTINEL");
      appender = launchGrowingTranscript(transcript, summary);

      const status = h.fire(
        { session_id: "settle-1", transcript_path: transcript },
        { MEETLESS_FINALMSG_POLL_SEC: "0.08", MEETLESS_FINALMSG_MAX_ATTEMPTS: "40" },
      );
      expect(status).toBe(0);

      const events = h.events("settle-1");
      const stopped = events.find((e) => e.event === "session_stopped");
      expect(stopped).toBeDefined();
      // The fix: finalMessage is the TRUE closing summary, not the stale
      // second-to-last block the no-retry read would have grabbed.
      expect(stopped.payload.finalMessage).toContain("CLOSING_SENTINEL");
      expect(stopped.payload.finalMessage).not.toContain("SECONDLAST_SENTINEL");

      // and the narration boundary shifts with it: the second-to-last block is now
      // narration (no longer the headline) and the summary is never double-counted.
      const narration = events.find((e) => e.event === "assistant_message");
      expect(narration).toBeDefined();
      expect(narration.payload.narration).toContain("SECONDLAST_SENTINEL");
      expect(narration.payload.narration).not.toContain("CLOSING_SENTINEL");
    } finally {
      if (appender && !appender.killed) appender.kill("SIGKILL");
      cleanup();
    }
  });
});

// Modern Claude Code transcripts stamp every assistant entry with a stop_reason:
// mid-turn blocks that precede a tool call carry "tool_use"; the turn's CLOSING
// message carries "end_turn". An assistant turn WITH that marker.
function assistantTurnWithStop(text: string, stopReason: string, withTool = false) {
  const content: any[] = [{ type: "text", text }];
  if (withTool) content.push({ type: "tool_use", id: "t1", name: "Bash", input: {} });
  return { type: "assistant", message: { content, stop_reason: stopReason } };
}

// Writer that simulates the WORST race: the transcript is left at a mid-turn
// tool_use block and then goes QUIET (byte-stable) for a gap LONGER than one poll
// interval before the closing end_turn message lands as a single append. A
// byte-size-stability settle sees "stopped growing" during the quiet gap and
// breaks early, grabbing the stale block; only a settle that waits for the
// SEMANTIC end_turn marker survives this.
function launchAfterStableGap(transcriptPath: string, closingLine: object, gapSec = 0.5) {
  const script = `
t="$1"
closing="$2"
gap="$3"
sleep "$gap"
printf '%s\\n' "$closing" >> "$t"
`;
  return spawn(
    "bash",
    ["-c", script, "appender", transcriptPath, JSON.stringify(closingLine), String(gapSec)],
    { stdio: "ignore" },
  );
}

// Dogfood-audit 2026-06-13 (session 5d428e3e). Validating that session's console
// timeline against reality showed the stored finalMessage was a MID-TURN block
// ("Control owns it (graph service)... Let me read the actual def...", stop_reason
// "tool_use") instead of the turn's true closing answer ("Pulled the canonical
// model and the actual code path...", stop_reason "end_turn"). a6b36c66 added a
// byte-size settle, but byte-size stability cannot tell "the turn finished" from
// "the single closing append has not landed yet": if the file is quiet for one
// poll interval before that append, the settle breaks early and the extractor
// still grabs the stale tool_use block. The fix gates BOTH the settle and the
// extraction on the semantic turn boundary (stop_reason "end_turn"), falling back
// to byte-stability + last-text only for legacy transcripts that carry no
// stop_reason at all.
describe("stop.sh: end_turn-gated closing message (Bug: stale mid-turn block on a quiet pre-flush gap)", () => {
  beforeAll(() => {
    if (spawnSync("jq", ["--version"]).status !== 0) throw new Error("jq required");
  });

  it("waits through a byte-STABLE gap for the end_turn closing message, then extracts IT (not the stale tool_use block)", () => {
    const { h, cleanup } = mkHarness();
    let appender: ReturnType<typeof spawn> | undefined;
    try {
      h.seedTurn("endturn-1", 5);
      // Modern transcript that ENDS at a mid-turn tool_use block, then goes quiet.
      // The real end_turn closing message has not been flushed yet (the race).
      const transcript = h.writeTranscript([
        userPrompt("validate the artifacts page ownership"),
        assistantTurnWithStop("This is an architecture question. NARR_SENTINEL", "tool_use", true),
        toolResult("graph.service.ts contents..."),
        assistantTurnWithStop(
          "Control owns it (graph service). Let me read the actual def. SECONDLAST_SENTINEL",
          "tool_use",
          true,
        ),
        toolResult("ok"),
      ]);
      // The closing message lands as a single append AFTER a byte-stable gap.
      const closing = assistantTurnWithStop(
        "Pulled the canonical model and the actual code path. Here is my read. CLOSING_SENTINEL",
        "end_turn",
        false,
      );
      appender = launchAfterStableGap(transcript, closing, 0.5);

      const status = h.fire(
        { session_id: "endturn-1", transcript_path: transcript },
        { MEETLESS_FINALMSG_POLL_SEC: "0.05", MEETLESS_FINALMSG_MAX_ATTEMPTS: "60" },
      );
      expect(status).toBe(0);

      const events = h.events("endturn-1");
      const stopped = events.find((e) => e.event === "session_stopped");
      expect(stopped).toBeDefined();
      // The fix: finalMessage is the TRUE end_turn closing message, never the
      // stale tool_use "let me read the def" block a byte-only settle would grab.
      expect(stopped.payload.finalMessage).toContain("CLOSING_SENTINEL");
      expect(stopped.payload.finalMessage).not.toContain("SECONDLAST_SENTINEL");

      // and the narration boundary shifts with it: the mid-turn blocks are
      // narration, the closing message is never double-counted there.
      const narration = events.find((e) => e.event === "assistant_message");
      expect(narration).toBeDefined();
      expect(narration.payload.narration).toContain("SECONDLAST_SENTINEL");
      expect(narration.payload.narration).not.toContain("CLOSING_SENTINEL");
    } finally {
      if (appender && !appender.killed) appender.kill("SIGKILL");
      cleanup();
    }
  });

  it("prefers the end_turn block even when a later assistant text block (no end_turn) follows it in the file", () => {
    const { h, cleanup } = mkHarness();
    try {
      h.seedTurn("endturn-2", 2);
      // end_turn closing, THEN a stray tool_use text block appended after it
      // (e.g. a trailing system/continuation artifact). "last text block" would
      // wrongly pick the stray; the end_turn gate pins the real closing message.
      const transcript = h.writeTranscript([
        userPrompt("summarize"),
        assistantTurnWithStop("Working on it. NARR_SENTINEL", "tool_use", true),
        toolResult("ok"),
        assistantTurnWithStop("Final answer here. CLOSING_SENTINEL", "end_turn", false),
        assistantTurnWithStop("stray trailing block. STRAY_SENTINEL", "tool_use", true),
      ]);

      const status = h.fire({ session_id: "endturn-2", transcript_path: transcript });
      expect(status).toBe(0);

      const stopped = h.events("endturn-2").find((e) => e.event === "session_stopped");
      expect(stopped).toBeDefined();
      expect(stopped.payload.finalMessage).toContain("CLOSING_SENTINEL");
      expect(stopped.payload.finalMessage).not.toContain("STRAY_SENTINEL");
    } finally {
      cleanup();
    }
  });

  it("falls back to last-text for a LEGACY transcript that carries no stop_reason at all", () => {
    const { h, cleanup } = mkHarness();
    try {
      h.seedTurn("legacy-1", 3);
      // No assistant entry has stop_reason -> the settle uses byte-stability and
      // the extractor uses last-assistant-text (a6b36c66's behavior preserved).
      const transcript = h.writeTranscript([
        userPrompt("do the thing"),
        assistantTurn("Mid-turn note. NARR_SENTINEL", true),
        toolResult("ok"),
        assistantTurn("All done. CLOSING_SENTINEL", false),
      ]);

      const status = h.fire({ session_id: "legacy-1", transcript_path: transcript });
      expect(status).toBe(0);

      const stopped = h.events("legacy-1").find((e) => e.event === "session_stopped");
      expect(stopped).toBeDefined();
      expect(stopped.payload.finalMessage).toContain("CLOSING_SENTINEL");
    } finally {
      cleanup();
    }
  });

  it("uses Codex last_assistant_message without parsing its unstable transcript format", () => {
    const { h, cleanup } = mkHarness();
    try {
      h.seedTurn("codex-stop-1", 1);
      const transcript = h.writeTranscript([
        userPrompt("old prompt"),
        assistantTurn("WRONG_TRANSCRIPT_MESSAGE", false),
      ]);

      const status = h.fire(
        {
          session_id: "codex-stop-1",
          transcript_path: transcript,
          last_assistant_message: "Codex supplied final answer",
        },
        { MEETLESS_CONNECTOR: "codex" },
      );
      expect(status).toBe(0);

      const events = h.events("codex-stop-1");
      const stopped = events.find((event) => event.event === "session_stopped");
      expect(stopped.payload.finalMessage).toBe("Codex supplied final answer");
      expect(events.some((event) => event.event === "assistant_message")).toBe(false);
    } finally {
      cleanup();
    }
  });
});
