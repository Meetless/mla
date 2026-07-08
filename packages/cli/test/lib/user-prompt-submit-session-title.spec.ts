import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";

// F3-A rename-on-prompt-submit. A session rename (by Claude Code's auto-titler OR
// the operator) rewrites the transcript `custom-title` line mid-session, usually
// long before the next Stop. The Stop hook already carries the latest title; this
// makes UserPromptSubmit carry it too, so a rename surfaces on the very next turn
// instead of waiting for the turn to end. Control honors `sessionTitle` on ANY
// event payload (last-write-wins, no-clobber on empty), so the only hook contract
// under test is: the latest custom-title rides the prompt_submitted payload.

function seedHome(): { home: string; repo: string } {
  const home = mkdtempSync(join(tmpdir(), "mlhome-"));
  const repo = mkdtempSync(join(tmpdir(), "repo-"));
  writeFileSync(join(repo, ".meetless.json"), "{}");
  mkdirSync(join(home, "logs"), { recursive: true });
  writeFileSync(
    join(home, "cli-config.json"),
    JSON.stringify({ workspaceId: "ws_1", actorUserId: "user_a", intelUrl: "http://127.0.0.1:8100" }),
  );
  return { home, repo };
}

function runHook(home: string, repo: string, sessionId: string, prompt: string, transcript: string) {
  const hook = join(__dirname, "../../src/hooks-template/user-prompt-submit.sh");
  return spawnSync("bash", [hook], {
    input: JSON.stringify({ session_id: sessionId, prompt, cwd: repo, transcript_path: transcript }),
    encoding: "utf8",
    env: { ...process.env, MEETLESS_HOME: home, HOME: home },
    timeout: 8000,
  });
}

function spooledPromptSubmitted(home: string, sessionId: string): any {
  const spool = readFileSync(join(home, "queue", `${sessionId}.jsonl`), "utf8");
  return spool
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l))
    .find((e) => e.event === "prompt_submitted");
}

describe("user-prompt-submit session title capture (F3-A rename-on-prompt-submit)", () => {
  it("carries the LATEST custom-title from the transcript onto the prompt_submitted payload", () => {
    const { home, repo } = seedHome();
    const transcript = join(home, "transcript.jsonl");
    writeFileSync(
      transcript,
      [
        JSON.stringify({ type: "custom-title", customTitle: "Old Name" }),
        JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }),
        JSON.stringify({ type: "custom-title", customTitle: "Renamed Mid Turn" }),
      ].join("\n") + "\n",
    );

    const r = runHook(home, repo, "sess_1", "do the thing", transcript);
    expect(r.status).toBe(0);

    const submitted = spooledPromptSubmitted(home, "sess_1");
    expect(submitted).toBeDefined();
    expect(submitted.payload.sessionTitle).toBe("Renamed Mid Turn");
    expect(submitted.payload.prompt).toBe("do the thing");
  });

  it("emits an empty title when the transcript has no custom-title (control treats empty as no-clobber)", () => {
    const { home, repo } = seedHome();
    const transcript = join(home, "transcript.jsonl");
    writeFileSync(
      transcript,
      JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }) + "\n",
    );

    const r = runHook(home, repo, "sess_2", "no rename", transcript);
    expect(r.status).toBe(0);

    const submitted = spooledPromptSubmitted(home, "sess_2");
    expect(submitted).toBeDefined();
    expect(submitted.payload.sessionTitle).toBe("");
  });

  // Claude Code's auto-titler emits `ai-title` (not custom-title) for sessions
  // the operator never renamed. Carry it so the rename surfaces on the next turn.
  it("carries the LATEST ai-title when there is no custom-title", () => {
    const { home, repo } = seedHome();
    const transcript = join(home, "transcript.jsonl");
    writeFileSync(
      transcript,
      [
        JSON.stringify({ type: "ai-title", aiTitle: "Early Auto Title" }),
        JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }),
        JSON.stringify({ type: "ai-title", aiTitle: "Investigate console UI session naming" }),
      ].join("\n") + "\n",
    );

    const r = runHook(home, repo, "sess_3", "another turn", transcript);
    expect(r.status).toBe(0);

    const submitted = spooledPromptSubmitted(home, "sess_3");
    expect(submitted).toBeDefined();
    expect(submitted.payload.sessionTitle).toBe("Investigate console UI session naming");
  });
});
