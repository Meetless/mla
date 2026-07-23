import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const SESSION_START = path.resolve(
  __dirname,
  "../../src/hooks-template/session-start.sh",
);

describe("Codex session bootstrap", () => {
  it("spools one Codex session_started event across repeated prompts", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mla-codex-bootstrap-"));
    const home = path.join(root, "home");
    const repo = path.join(root, "repo");
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(repo, { recursive: true });
    fs.writeFileSync(
      path.join(home, "cli-config.json"),
      JSON.stringify({ workspaceId: "ws_codex", actorUserId: "user_codex" }),
    );
    fs.writeFileSync(
      path.join(repo, ".meetless.json"),
      JSON.stringify({ workspaceId: "ws_codex" }),
    );

    const sessionId = "codex-session-1";
    const input = JSON.stringify({
      session_id: sessionId,
      hook_event_name: "UserPromptSubmit",
      prompt: "show this session",
    });
    const run = () =>
      spawnSync("bash", [SESSION_START], {
        input,
        encoding: "utf8",
        cwd: repo,
        env: {
          ...process.env,
          HOME: home,
          MEETLESS_HOME: home,
          MEETLESS_CONNECTOR: "codex",
          MEETLESS_DEBUG: "0",
        },
        timeout: 8000,
      });

    try {
      const first = run();
      expect(first.status).toBe(0);
      expect(first.stderr).toBe("");

      const second = run();
      expect(second.status).toBe(0);
      expect(second.stderr).toBe("");

      const queueDir = path.join(home, "queue");
      const lines = fs
        .readFileSync(path.join(queueDir, `${sessionId}.jsonl`), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toEqual(
        expect.objectContaining({
          event: "session_started",
          sessionId,
          payload: expect.objectContaining({
            adapter: "codex",
            repoPath: expect.any(String),
            branch: expect.any(String),
          }),
        }),
      );
      expect(fs.realpathSync(lines[0].payload.repoPath)).toBe(
        fs.realpathSync(repo),
      );
      expect(
        fs.existsSync(path.join(queueDir, `${sessionId}.codexStarted`)),
      ).toBe(true);
      expect(
        fs.readFileSync(
          path.join(queueDir, `${sessionId}.workspaceId`),
          "utf8",
        ),
      ).toBe("ws_codex");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not let the prompt fallback suppress a real Codex SessionStart resume", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mla-codex-resume-"));
    const home = path.join(root, "home");
    const repo = path.join(root, "repo");
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(repo, { recursive: true });
    fs.writeFileSync(
      path.join(home, "cli-config.json"),
      JSON.stringify({ workspaceId: "ws_codex", actorUserId: "user_codex" }),
    );
    fs.writeFileSync(
      path.join(repo, ".meetless.json"),
      JSON.stringify({ workspaceId: "ws_codex" }),
    );

    const sessionId = "codex-session-resume";
    const fire = (hookEventName: string, source?: string) =>
      spawnSync("bash", [SESSION_START], {
        input: JSON.stringify({
          session_id: sessionId,
          hook_event_name: hookEventName,
          source,
        }),
        encoding: "utf8",
        cwd: repo,
        env: {
          ...process.env,
          HOME: home,
          MEETLESS_HOME: home,
          MEETLESS_CONNECTOR: "codex",
          MEETLESS_DEBUG: "0",
        },
        timeout: 8000,
      });

    try {
      expect(fire("SessionStart", "startup").status).toBe(0);
      expect(fire("UserPromptSubmit").status).toBe(0);
      expect(fire("SessionStart", "resume").status).toBe(0);

      const events = fs
        .readFileSync(path.join(home, "queue", `${sessionId}.jsonl`), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      expect(events.filter((event) => event.event === "session_started")).toHaveLength(2);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
