import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  backfillSessionPrompts,
  buildBackfillPromptLine,
  parseUserPromptsFromTranscript,
  selectPreActivationPrompts,
} from "../../src/lib/transcript-prompts";

// Behavioral lock for the pre-activation prompt back-fill (dogfood 2026-07-03:
// a session activated mid-flight via `mla activate` showed the run + its
// session_stopped but NOT the opening user turn). The capture hooks gate on the
// `.meetless.json` marker (meetless_activated || exit 0), so every user prompt
// submitted BEFORE activation is silently dropped. bootstrapCurrentSession used
// to back-fill only session_started, never the lost prompts. This module reads
// the live Claude Code transcript, isolates the genuine human turns that
// predate activation, and re-emits them as prompt_submitted spool lines the
// flush picks up. Idempotency rides on a deterministic eventKey (backfill-<uuid>)
// so a repeated activate collapses server-side on (runId, eventKey).

// One JSONL transcript entry, minimal shape the parser reads.
function line(rec: unknown): string {
  return JSON.stringify(rec);
}

function userPrompt(opts: {
  uuid: string;
  ts: string;
  content: unknown;
  isMeta?: boolean;
  isSidechain?: boolean;
}): string {
  return line({
    type: "user",
    uuid: opts.uuid,
    timestamp: opts.ts,
    isMeta: opts.isMeta,
    isSidechain: opts.isSidechain,
    message: { role: "user", content: opts.content },
  });
}

describe("parseUserPromptsFromTranscript", () => {
  it("keeps a genuine string-content user prompt with its text/ts/uuid", () => {
    const jsonl = userPrompt({
      uuid: "u1",
      ts: "2026-07-03T10:00:00.000Z",
      content: "activate mla in this folder",
    });
    expect(parseUserPromptsFromTranscript(jsonl)).toEqual([
      { text: "activate mla in this folder", ts: "2026-07-03T10:00:00.000Z", uuid: "u1" },
    ]);
  });

  it("keeps an array-content prompt, concatenating its text blocks", () => {
    const jsonl = userPrompt({
      uuid: "u2",
      ts: "2026-07-03T10:01:00.000Z",
      content: [
        { type: "text", text: "first" },
        { type: "text", text: "second" },
      ],
    });
    expect(parseUserPromptsFromTranscript(jsonl)).toEqual([
      { text: "first\nsecond", ts: "2026-07-03T10:01:00.000Z", uuid: "u2" },
    ]);
  });

  it("drops a tool_result-bearing user turn (agent output re-entering the user channel)", () => {
    const jsonl = userPrompt({
      uuid: "u3",
      ts: "2026-07-03T10:02:00.000Z",
      content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
    });
    expect(parseUserPromptsFromTranscript(jsonl)).toEqual([]);
  });

  it("drops isMeta and isSidechain turns", () => {
    const jsonl = [
      userPrompt({ uuid: "m", ts: "2026-07-03T10:03:00.000Z", content: "meta", isMeta: true }),
      userPrompt({ uuid: "s", ts: "2026-07-03T10:04:00.000Z", content: "side", isSidechain: true }),
    ].join("\n");
    expect(parseUserPromptsFromTranscript(jsonl)).toEqual([]);
  });

  it("drops a <task-notification> synthetic wake-up", () => {
    const jsonl = userPrompt({
      uuid: "syn",
      ts: "2026-07-03T10:05:00.000Z",
      content: "<task-notification>background job done</task-notification>",
    });
    expect(parseUserPromptsFromTranscript(jsonl)).toEqual([]);
  });

  it("drops empty / whitespace-only prompts", () => {
    const jsonl = [
      userPrompt({ uuid: "e1", ts: "2026-07-03T10:06:00.000Z", content: "   " }),
      userPrompt({ uuid: "e2", ts: "2026-07-03T10:07:00.000Z", content: [] }),
    ].join("\n");
    expect(parseUserPromptsFromTranscript(jsonl)).toEqual([]);
  });

  it("skips non-user, malformed, and id/ts-less lines without throwing", () => {
    const jsonl = [
      line({ type: "assistant", uuid: "a1", timestamp: "2026-07-03T10:08:00.000Z", message: {} }),
      "{ this is not json",
      "",
      line({ type: "user", timestamp: "2026-07-03T10:09:00.000Z", message: { content: "no uuid" } }),
      line({ type: "user", uuid: "nouts", message: { content: "no ts" } }),
      userPrompt({ uuid: "ok", ts: "2026-07-03T10:10:00.000Z", content: "real one" }),
    ].join("\n");
    expect(parseUserPromptsFromTranscript(jsonl)).toEqual([
      { text: "real one", ts: "2026-07-03T10:10:00.000Z", uuid: "ok" },
    ]);
  });

  it("preserves transcript order", () => {
    const jsonl = [
      userPrompt({ uuid: "b", ts: "2026-07-03T10:11:00.000Z", content: "one" }),
      userPrompt({ uuid: "c", ts: "2026-07-03T10:12:00.000Z", content: "two" }),
    ].join("\n");
    expect(parseUserPromptsFromTranscript(jsonl).map((p) => p.uuid)).toEqual(["b", "c"]);
  });
});

describe("selectPreActivationPrompts", () => {
  const prompts = [
    { text: "before", ts: "2026-07-03T10:00:00.000Z", uuid: "a" },
    { text: "at", ts: "2026-07-03T10:05:00.000Z", uuid: "b" },
    { text: "after", ts: "2026-07-03T10:10:00.000Z", uuid: "c" },
  ];

  it("keeps only prompts strictly before the activation instant", () => {
    const kept = selectPreActivationPrompts(prompts, "2026-07-03T10:05:00.000Z");
    expect(kept.map((p) => p.uuid)).toEqual(["a"]);
  });

  it("returns all prompts when the cutoff is unparseable", () => {
    expect(selectPreActivationPrompts(prompts, "not-a-date")).toEqual(prompts);
  });
});

describe("buildBackfillPromptLine", () => {
  it("emits a prompt_submitted envelope the flush Pass-2 filter reads", () => {
    const parsed = JSON.parse(
      buildBackfillPromptLine(
        { text: "hello", ts: "2026-07-03T10:00:00.000Z", uuid: "u1" },
        "sess-1",
      ),
    );
    expect(parsed.event).toBe("prompt_submitted");
    expect(parsed.eventKey).toBe("backfill-u1");
    expect(parsed.ts).toBe("2026-07-03T10:00:00.000Z");
    expect(parsed.sessionId).toBe("sess-1");
    expect(parsed.payload.prompt).toBe("hello");
  });

  it("is deterministic across calls (idempotent server-side dedup key)", () => {
    const p = { text: "x", ts: "2026-07-03T10:00:00.000Z", uuid: "same" };
    expect(buildBackfillPromptLine(p, "s")).toBe(buildBackfillPromptLine(p, "s"));
  });
});

describe("backfillSessionPrompts", () => {
  let tmp: string;
  let projectsRoot: string;
  let queueDir: string;
  const sid = "sess-backfill";

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mla-tp-"));
    projectsRoot = path.join(tmp, "claude", "projects");
    queueDir = path.join(tmp, "meetless", "queue");
    fs.mkdirSync(path.join(projectsRoot, "-Users-me-repo"), { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function writeTranscript(rows: string[]): void {
    fs.writeFileSync(
      path.join(projectsRoot, "-Users-me-repo", `${sid}.jsonl`),
      rows.join("\n") + "\n",
    );
  }

  it("spools only the genuine pre-activation prompts, with deterministic keys", () => {
    writeTranscript([
      userPrompt({ uuid: "p1", ts: "2026-07-03T10:00:00.000Z", content: "turn one" }),
      userPrompt({ uuid: "p2", ts: "2026-07-03T10:01:00.000Z", content: "turn two" }),
      userPrompt({
        uuid: "syn",
        ts: "2026-07-03T10:01:30.000Z",
        content: "<task-notification>done</task-notification>",
      }),
      userPrompt({ uuid: "post", ts: "2026-07-03T10:30:00.000Z", content: "after activation" }),
    ]);

    const res = backfillSessionPrompts(sid, {
      projectsRoot,
      queueDir,
      activatedAt: "2026-07-03T10:05:00.000Z",
    });

    expect(res).toEqual({ transcriptFound: true, spooled: 2 });
    const spool = fs.readFileSync(path.join(queueDir, `${sid}.jsonl`), "utf8");
    const lines = spool.trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((l) => l.eventKey)).toEqual(["backfill-p1", "backfill-p2"]);
    expect(lines.map((l) => l.payload.prompt)).toEqual(["turn one", "turn two"]);
    expect(lines.every((l) => l.event === "prompt_submitted")).toBe(true);
  });

  it("reports transcriptFound=false and writes nothing when no transcript exists", () => {
    const res = backfillSessionPrompts(sid, {
      projectsRoot,
      queueDir,
      activatedAt: "2026-07-03T10:05:00.000Z",
    });
    expect(res).toEqual({ transcriptFound: false, spooled: 0 });
    expect(fs.existsSync(path.join(queueDir, `${sid}.jsonl`))).toBe(false);
  });

  it("finds the transcript under any project dir (encoding-drift tolerant)", () => {
    // Claude Code's project-dir encoding may diverge from ours; the scan matches
    // the session file wherever it lives.
    fs.mkdirSync(path.join(projectsRoot, "-private-var-other"), { recursive: true });
    fs.writeFileSync(
      path.join(projectsRoot, "-private-var-other", `${sid}.jsonl`),
      userPrompt({ uuid: "x", ts: "2026-07-03T10:00:00.000Z", content: "found me" }) + "\n",
    );
    const res = backfillSessionPrompts(sid, {
      projectsRoot,
      queueDir,
      activatedAt: "2026-07-03T10:05:00.000Z",
    });
    expect(res.transcriptFound).toBe(true);
    expect(res.spooled).toBe(1);
  });
});
