import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";

// F3-A rename-on-prompt-submit, SessionStart arm. A RESUMED session (`--resume` /
// `--continue`) starts with a transcript that already carries a `custom-title`, so
// SessionStart is the earliest moment control can learn the session's name. Carry
// the latest custom-title on the session_started payload so a resumed session shows
// its real name immediately instead of as "untitled" until the first Stop. Control
// honors `sessionTitle` on any event payload (last-write-wins, no-clobber on empty).

function seedHome(): { home: string } {
  const home = mkdtempSync(join(tmpdir(), "mlhome-"));
  mkdirSync(join(home, "logs"), { recursive: true });
  writeFileSync(
    join(home, "cli-config.json"),
    JSON.stringify({ workspaceId: "ws_1", actorUserId: "user_a", intelUrl: "http://127.0.0.1:8100" }),
  );
  // The hook gates on meetless_activated, which walks up from the subprocess
  // $PWD for a `.meetless.json` marker. Plant one in HOME and run the hook there
  // so activation resolves on a clean runner (no ambient up-tree marker).
  writeFileSync(join(home, ".meetless.json"), JSON.stringify({ workspaceId: "ws_1" }));
  return { home };
}

function runHook(home: string, sessionId: string, transcript: string) {
  const hook = join(__dirname, "../../src/hooks-template/session-start.sh");
  return spawnSync("bash", [hook], {
    input: JSON.stringify({ session_id: sessionId, transcript_path: transcript }),
    encoding: "utf8",
    cwd: home,
    env: { ...process.env, MEETLESS_HOME: home, HOME: home },
    timeout: 8000,
  });
}

function spooledSessionStarted(home: string, sessionId: string): any {
  const spool = readFileSync(join(home, "queue", `${sessionId}.jsonl`), "utf8");
  return spool
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l))
    .find((e) => e.event === "session_started");
}

describe("session-start session title capture (F3-A, resumed-session arm)", () => {
  it("carries the LATEST custom-title from a resumed transcript onto the session_started payload", () => {
    const { home } = seedHome();
    const transcript = join(home, "transcript.jsonl");
    writeFileSync(
      transcript,
      [
        JSON.stringify({ type: "custom-title", customTitle: "First Title" }),
        JSON.stringify({ type: "assistant", message: { role: "assistant", content: [] } }),
        JSON.stringify({ type: "custom-title", customTitle: "Resumed Session Name" }),
      ].join("\n") + "\n",
    );

    const r = runHook(home, "sess_start_1", transcript);
    expect(r.status).toBe(0);

    const started = spooledSessionStarted(home, "sess_start_1");
    expect(started).toBeDefined();
    expect(started.payload.sessionTitle).toBe("Resumed Session Name");
  });

  it("emits an empty title for a brand-new session whose transcript has no custom-title yet", () => {
    const { home } = seedHome();
    const transcript = join(home, "transcript.jsonl");
    writeFileSync(transcript, "");

    const r = runHook(home, "sess_start_2", transcript);
    expect(r.status).toBe(0);

    const started = spooledSessionStarted(home, "sess_start_2");
    expect(started).toBeDefined();
    expect(started.payload.sessionTitle).toBe("");
  });

  // The common case: Claude Code's AUTO-titler writes `ai-title` lines, not
  // `custom-title` (the operator never ran /title). The picker shows that
  // auto title, so control must too -- otherwise the console falls back to the
  // raw first prompt / "Session <id>" and diverges from what the operator sees.
  it("captures the LATEST ai-title when the transcript has no custom-title", () => {
    const { home } = seedHome();
    const transcript = join(home, "transcript.jsonl");
    writeFileSync(
      transcript,
      [
        JSON.stringify({ type: "ai-title", aiTitle: "First Auto Title" }),
        JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }),
        JSON.stringify({ type: "ai-title", aiTitle: "Design resource tracking for multi-agent pricing" }),
      ].join("\n") + "\n",
    );

    const r = runHook(home, "sess_start_3", transcript);
    expect(r.status).toBe(0);

    const started = spooledSessionStarted(home, "sess_start_3");
    expect(started).toBeDefined();
    expect(started.payload.sessionTitle).toBe("Design resource tracking for multi-agent pricing");
  });

  // A human /title overrides Claude's auto title in the picker, so custom-title
  // must win regardless of which line appears later in the transcript.
  it("prefers a custom-title over any ai-title (human rename wins)", () => {
    const { home } = seedHome();
    const transcript = join(home, "transcript.jsonl");
    writeFileSync(
      transcript,
      [
        JSON.stringify({ type: "ai-title", aiTitle: "Auto Title One" }),
        JSON.stringify({ type: "custom-title", customTitle: "better retrieval - CODING" }),
        JSON.stringify({ type: "ai-title", aiTitle: "Auto Title Two (later)" }),
      ].join("\n") + "\n",
    );

    const r = runHook(home, "sess_start_4", transcript);
    expect(r.status).toBe(0);

    const started = spooledSessionStarted(home, "sess_start_4");
    expect(started).toBeDefined();
    expect(started.payload.sessionTitle).toBe("better retrieval - CODING");
  });
});
