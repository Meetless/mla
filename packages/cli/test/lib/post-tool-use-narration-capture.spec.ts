import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Intra-turn narration capture, LIVE, at PostToolUse.
//
// Dogfood-audit 2026-06-12: a code-heavy session (f16d5e9a) rendered in the
// console timeline as a wall of commands with NONE of the agent's visible prose
// between them. The DB had 88 tool events but a single assistant_message -- one
// blob the Stop hook lumped at turn-end. Two root causes:
//
//   1. Stop captures narration as ONE trailing blob stamped at Stop-time, so it
//      never interleaves with the commands it explains.
//   2. A mid-turn auto-compaction rewrites/shortens the transcript, destroying
//      the earlier prose BEFORE the Stop hook ever reads it.
//
// Fix: PostToolUse fires LIVE after every tool, so it records each assistant
// text entry at its OWN transcript timestamp (correct interleave) and BEFORE a
// later compaction can drop it (compaction-robust). Each entry is keyed by its
// transcript uuid (assistant_message:<uuid>) so a re-fired hook and the Stop
// backstop are idempotent against control's (runId, eventKey) dedup. A
// per-session ts cursor stops us re-spooling prose we already captured. The
// turn's CLOSING message (stop_reason end_turn) is EXCLUDED -- that is the Stop
// hook's finalMessage, never narration.

const HOOKS_DIR = path.resolve(__dirname, "../../src/hooks-template");
const HOOK = "post-tool-use.sh";

interface FireResult {
  status: number;
  stdout: string;
  stderr: string;
}

interface Harness {
  home: string;
  queueDir: string;
  workdir: string;
  fire: (input: object, extraEnv?: Record<string, string>) => FireResult;
  queueLines: (sessionId: string) => Record<string, unknown>[];
}

function mkHarness(): { h: Harness; cleanup: () => void } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mla-narr-"));
  fs.copyFileSync(
    path.join(HOOKS_DIR, "common.sh"),
    path.join(tmp, "common.sh"),
  );
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
      actorUserId: "user_a",
      mlaPath: "/bin/true",
    }),
  );
  const workdir = path.join(tmp, "workdir");
  fs.mkdirSync(workdir);
  fs.writeFileSync(
    path.join(workdir, ".meetless.json"),
    JSON.stringify({ workspaceId: "ws_test" }),
  );

  const queueDir = path.join(home, "queue");
  const h: Harness = {
    home,
    queueDir,
    workdir,
    fire: (input: object, extraEnv?: Record<string, string>) => {
      const r = spawnSync("bash", [path.join(tmp, HOOK)], {
        input: JSON.stringify(input),
        encoding: "utf8",
        cwd: workdir,
        env: {
          ...process.env,
          MEETLESS_HOME: home,
          MEETLESS_DEBUG: "0",
          ...(extraEnv ?? {}),
        },
        timeout: 5000,
      });
      return {
        status: r.status ?? -1,
        stdout: r.stdout ?? "",
        stderr: r.stderr ?? "",
      };
    },
    queueLines: (sessionId: string) => {
      const q = path.join(queueDir, `${sessionId}.jsonl`);
      if (!fs.existsSync(q)) return [];
      return fs
        .readFileSync(q, "utf8")
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l) as Record<string, unknown>);
    },
  };
  return { h, cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}

// ---- transcript entry builders (Claude Code JSONL shape) -------------------

function asstText(
  uuid: string,
  ts: string,
  text: string,
  stopReason = "tool_use",
): object {
  return {
    type: "assistant",
    uuid,
    timestamp: ts,
    message: { stop_reason: stopReason, content: [{ type: "text", text }] },
  };
}

function asstToolUse(uuid: string, ts: string): object {
  return {
    type: "assistant",
    uuid,
    timestamp: ts,
    message: {
      stop_reason: "tool_use",
      content: [
        { type: "tool_use", id: "t_" + uuid, name: "Bash", input: {} },
      ],
    },
  };
}

function asstThinking(uuid: string, ts: string, thinking: string): object {
  return {
    type: "assistant",
    uuid,
    timestamp: ts,
    message: {
      stop_reason: "tool_use",
      content: [{ type: "thinking", thinking }],
    },
  };
}

function userPrompt(text: string): object {
  return { type: "user", message: { content: text } };
}

function toolResult(): object {
  return {
    type: "user",
    message: { content: [{ type: "tool_result", content: "ok" }] },
  };
}

function writeTranscript(p: string, entries: object[]): void {
  fs.writeFileSync(p, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

function appendTranscript(p: string, entries: object[]): void {
  fs.appendFileSync(p, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

function bashInput(sessionId: string, transcriptPath?: string): object {
  return {
    session_id: sessionId,
    tool_name: "Bash",
    tool_input: { command: "echo hi" },
    tool_response: { exit_code: 0, stdout: "hi", stderr: "" },
    ...(transcriptPath ? { transcript_path: transcriptPath } : {}),
  };
}

function narrationEvents(h: Harness, sessionId: string) {
  return h.queueLines(sessionId).filter((l) => l.event === "assistant_message");
}

describe("post-tool-use.sh: live intra-turn narration capture", () => {
  beforeAll(() => {
    const jq = spawnSync("jq", ["--version"], { encoding: "utf8" });
    if (jq.status !== 0) {
      throw new Error("jq must be installed to run narration-capture specs");
    }
  });

  it("spools one assistant_message per narration entry, keyed by uuid, stamped at the entry timestamp", () => {
    const { h, cleanup } = mkHarness();
    try {
      const t1 = "2026-06-12T10:00:01.000Z";
      const t2 = "2026-06-12T10:00:03.000Z";
      const tp = path.join(h.workdir, "t.jsonl");
      writeTranscript(tp, [
        userPrompt("do the thing"),
        asstText("u1", t1, "First, I will inspect the config NARR_ONE"),
        asstToolUse("a1", "2026-06-12T10:00:01.500Z"),
        toolResult(),
        asstText("u2", t2, "Now I will patch the bug NARR_TWO"),
        asstToolUse("a2", "2026-06-12T10:00:03.500Z"),
        toolResult(),
      ]);

      const r = h.fire(bashInput("sN", tp));
      expect(r.status).toBe(0);

      const narr = narrationEvents(h, "sN");
      expect(narr).toHaveLength(2);
      const byKey = Object.fromEntries(narr.map((n) => [n.eventKey, n])) as Record<
        string,
        Record<string, unknown>
      >;

      const n1 = byKey["assistant_message:u1"];
      expect(n1).toBeTruthy();
      expect(n1.ts).toBe(t1);
      expect(n1.sessionId).toBe("sN");
      const p1 = n1.payload as Record<string, unknown>;
      expect(p1.narration).toContain("NARR_ONE");
      expect(p1.entryUuid).toBe("u1");

      const n2 = byKey["assistant_message:u2"];
      expect(n2).toBeTruthy();
      expect(n2.ts).toBe(t2);
      expect((n2.payload as Record<string, unknown>).narration).toContain(
        "NARR_TWO",
      );

      // The Bash spool is undisturbed by the narration capture above it.
      expect(
        h.queueLines("sN").filter((l) => l.event === "tool_used_bash"),
      ).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  it("excludes the turn's closing end_turn message (Stop owns it as finalMessage)", () => {
    const { h, cleanup } = mkHarness();
    try {
      const tp = path.join(h.workdir, "t.jsonl");
      writeTranscript(tp, [
        userPrompt("go"),
        asstText("u1", "2026-06-12T10:00:01.000Z", "mid-turn prose NARR_MID"),
        asstToolUse("a1", "2026-06-12T10:00:01.500Z"),
        toolResult(),
        asstText(
          "uClose",
          "2026-06-12T10:00:05.000Z",
          "All done, here is the summary CLOSING_PROSE",
          "end_turn",
        ),
      ]);

      const r = h.fire(bashInput("sE", tp));
      expect(r.status).toBe(0);

      const keys = narrationEvents(h, "sE").map((n) => n.eventKey);
      expect(keys).toContain("assistant_message:u1");
      expect(keys).not.toContain("assistant_message:uClose");

      const raw = fs.readFileSync(path.join(h.queueDir, "sE.jsonl"), "utf8");
      expect(raw).not.toContain("CLOSING_PROSE");
    } finally {
      cleanup();
    }
  });

  it("never captures private thinking blocks as narration", () => {
    const { h, cleanup } = mkHarness();
    try {
      const tp = path.join(h.workdir, "t.jsonl");
      writeTranscript(tp, [
        userPrompt("go"),
        asstThinking(
          "uth",
          "2026-06-12T10:00:00.500Z",
          "PRIVATE_THOUGHT the user must never see",
        ),
        asstText("u1", "2026-06-12T10:00:01.000Z", "visible prose NARR_VIS"),
        asstToolUse("a1", "2026-06-12T10:00:01.500Z"),
        toolResult(),
      ]);

      h.fire(bashInput("sT", tp));

      const keys = narrationEvents(h, "sT").map((n) => n.eventKey);
      expect(keys).toContain("assistant_message:u1");
      expect(keys).not.toContain("assistant_message:uth");
      const raw = fs.readFileSync(path.join(h.queueDir, "sT.jsonl"), "utf8");
      expect(raw).not.toContain("PRIVATE_THOUGHT");
    } finally {
      cleanup();
    }
  });

  it("does not re-spool already-captured narration on a later tool, and captures new prose (ts cursor)", () => {
    const { h, cleanup } = mkHarness();
    try {
      const tp = path.join(h.workdir, "t.jsonl");
      // First tool fires while only u1 exists.
      writeTranscript(tp, [
        userPrompt("go"),
        asstText("u1", "2026-06-12T10:00:01.000Z", "first NARR_ONE"),
        asstToolUse("a1", "2026-06-12T10:00:01.500Z"),
        toolResult(),
      ]);
      h.fire(bashInput("sC", tp));

      // Transcript grows; the second tool fires.
      appendTranscript(tp, [
        asstText("u2", "2026-06-12T10:00:04.000Z", "second NARR_TWO"),
        asstToolUse("a2", "2026-06-12T10:00:04.500Z"),
        toolResult(),
      ]);
      h.fire(bashInput("sC", tp));

      const keys = narrationEvents(h, "sC").map((n) => n.eventKey);
      // u1 captured exactly once (NOT re-spooled on the 2nd fire); u2 once.
      expect(keys.filter((k) => k === "assistant_message:u1")).toHaveLength(1);
      expect(keys.filter((k) => k === "assistant_message:u2")).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  it("narration captured live survives a later compaction that rewrites the transcript (core fix)", () => {
    const { h, cleanup } = mkHarness();
    try {
      const tp = path.join(h.workdir, "t.jsonl");
      // Pre-compaction transcript: u1 prose present.
      writeTranscript(tp, [
        userPrompt("go"),
        asstText("u1", "2026-06-12T10:00:01.000Z", "early prose EARLY_NARR"),
        asstToolUse("a1", "2026-06-12T10:00:01.500Z"),
        toolResult(),
      ]);
      h.fire(bashInput("sK", tp)); // captures u1 BEFORE compaction

      // Compaction REWRITES the transcript: u1 is gone, replaced by a summary
      // plus fresh post-compaction prose u2.
      writeTranscript(tp, [
        userPrompt("[compacted conversation summary]"),
        asstText("u2", "2026-06-12T10:05:00.000Z", "post-compaction LATE_NARR"),
        asstToolUse("a2", "2026-06-12T10:05:00.500Z"),
        toolResult(),
      ]);
      h.fire(bashInput("sK", tp));

      const keys = narrationEvents(h, "sK").map((n) => n.eventKey);
      // u1, captured live, is STILL in the queue though the transcript dropped it.
      expect(keys).toContain("assistant_message:u1");
      // and the post-compaction prose is captured too.
      expect(keys).toContain("assistant_message:u2");
    } finally {
      cleanup();
    }
  });

  it("captures narration unconditionally: the removed MEETLESS_CAPTURE_NARRATION=0 no longer suppresses it", () => {
    const { h, cleanup } = mkHarness();
    try {
      const tp = path.join(h.workdir, "t.jsonl");
      writeTranscript(tp, [
        userPrompt("go"),
        asstText("u1", "2026-06-12T10:00:01.000Z", "prose NARR_ON"),
        asstToolUse("a1", "2026-06-12T10:00:01.500Z"),
        toolResult(),
      ]);

      // The legacy kill switch was removed (narration is the default now), so
      // setting it has no effect: capture still happens.
      const r = h.fire(bashInput("sOff", tp), {
        MEETLESS_CAPTURE_NARRATION: "0",
      });
      expect(r.status).toBe(0);

      const narr = narrationEvents(h, "sOff");
      expect(narr).toHaveLength(1);
      expect((narr[0].payload as Record<string, unknown>).narration).toContain(
        "NARR_ON",
      );
      expect(
        h.queueLines("sOff").filter((l) => l.event === "tool_used_bash"),
      ).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  it("fail-soft: a fire with NO transcript_path spools the Bash event, zero narration, exit 0", () => {
    const { h, cleanup } = mkHarness();
    try {
      const r = h.fire(bashInput("sNoTp"));
      expect(r.status).toBe(0);
      const lines = h.queueLines("sNoTp");
      expect(lines.filter((l) => l.event === "tool_used_bash")).toHaveLength(1);
      expect(lines.filter((l) => l.event === "assistant_message")).toHaveLength(
        0,
      );
    } finally {
      cleanup();
    }
  });

  it("fail-soft: a transcript_path that does not exist spools zero narration and exits 0", () => {
    const { h, cleanup } = mkHarness();
    try {
      const r = h.fire(
        bashInput("sGhost", path.join(h.workdir, "nope.jsonl")),
      );
      expect(r.status).toBe(0);
      expect(narrationEvents(h, "sGhost")).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it("captures narration even for a non-spooling tool (Read) so prose is not lost on read-only turns", () => {
    const { h, cleanup } = mkHarness();
    try {
      const tp = path.join(h.workdir, "t.jsonl");
      writeTranscript(tp, [
        userPrompt("go"),
        asstText("u1", "2026-06-12T10:00:01.000Z", "reasoning before a read NARR_R"),
        asstToolUse("a1", "2026-06-12T10:00:01.500Z"),
        toolResult(),
      ]);

      const r = h.fire({
        session_id: "sRead",
        tool_name: "Read",
        tool_input: { file_path: path.join(h.workdir, "a.ts") },
        tool_response: { success: true },
        transcript_path: tp,
      });
      expect(r.status).toBe(0);

      const keys = narrationEvents(h, "sRead").map((n) => n.eventKey);
      expect(keys).toContain("assistant_message:u1");
      // Read still spools no tool event (capture sits above the tool routes).
      expect(
        h.queueLines("sRead").filter((l) => l.event === "tool_used_bash"),
      ).toHaveLength(0);
    } finally {
      cleanup();
    }
  });
});
