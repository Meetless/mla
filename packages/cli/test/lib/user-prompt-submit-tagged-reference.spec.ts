import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";

describe("user-prompt-submit tagged_reference capture (Phase 2, A3)", () => {
  it("captures a referenced doc path as a tagged_reference Active Memory record; never blocks", () => {
    const home = mkdtempSync(join(tmpdir(), "mlhome-"));
    const repo = mkdtempSync(join(tmpdir(), "repo-"));
    writeFileSync(join(repo, ".meetless.json"), JSON.stringify({ workspaceId: "ws_1" }));
    mkdirSync(join(home, "logs"), { recursive: true });
    writeFileSync(
      join(home, "cli-config.json"),
      JSON.stringify({ workspaceId: "ws_1", actorUserId: "user_a", intelUrl: "http://127.0.0.1:8100" }),
    );
    const hook = join(__dirname, "../../src/hooks-template/user-prompt-submit.sh");
    const r = spawnSync("bash", [hook], {
      input: JSON.stringify({ session_id: "sess_1", prompt: "please review old.md before we continue", cwd: repo }),
      encoding: "utf8",
      // Activation gate walks up from the subprocess $PWD, not the stdin cwd field.
      cwd: repo,
      env: { ...process.env, MEETLESS_HOME: home, HOME: home },
      timeout: 8000,
    });
    expect(r.status).toBe(0);

    const store = readFileSync(join(home, "logs", "kb-knowledge.jsonl"), "utf8");
    const records = store
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l));
    const tagged = records.filter((rec) => rec.kind === "tagged_reference");
    expect(tagged.length).toBeGreaterThan(0);
    expect(tagged.some((rec) => String(rec.canonicalPath).includes("old.md"))).toBe(true);
    expect(tagged[0].sessionId).toBe("sess_1");
  });
});
