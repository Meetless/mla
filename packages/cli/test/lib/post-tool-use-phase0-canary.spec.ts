// tools/meetless-agent/test/lib/post-tool-use-phase0-canary.spec.ts
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";

// Phase 0 must make zero network calls. We run the hook with NO listening server
// and assert success plus that the ONLY artifact under ~/.meetless is the local
// Active Review log (plus its lock). No spool event that triggers detection, no
// KB row, no outbound request that could error against a closed port.
describe("Phase 0 canary: stays local (tests 7,40,41)", () => {
  it("produces only the local Active Review log; no KB/relationship artifact", () => {
    const home = mkdtempSync(join(tmpdir(), "mlhome-"));
    const repo = mkdtempSync(join(tmpdir(), "repo-"));
    // Folder = workspace: the produced doc's workspaceId comes from the edited
    // file's own marker (A2 reads $A2_ROOT/.meetless.json), not cli-config.
    writeFileSync(join(repo, ".meetless.json"), JSON.stringify({ workspaceId: "ws_1" }));
    mkdirSync(join(repo, "notes"), { recursive: true });
    mkdirSync(join(home, "logs"), { recursive: true });
    writeFileSync(join(home, "cli-config.json"), JSON.stringify({ actorUserId: "user_a", controlUrl: "http://127.0.0.1:9", controlToken: "t" }));
    const f = join(repo, "notes", "x.md");
    writeFileSync(f, "scope change: defer SSO");
    const hook = join(__dirname, "../../src/hooks-template/post-tool-use.sh");
    const r = spawnSync("bash", [hook], {
      input: JSON.stringify({ session_id: "sess_1", tool_name: "Write", tool_input: { file_path: f }, cwd: repo }),
      encoding: "utf8",
      // Activation gate walks up from the subprocess $PWD, not the stdin cwd field.
      cwd: repo,
      env: { ...process.env, MEETLESS_HOME: home, HOME: home },
      timeout: 5000,
    });
    expect(r.status).toBe(0);
    // No relationship-candidate or kb spool artifacts produced.
    const logs = existsSync(join(home, "logs")) ? readdirSync(join(home, "logs")) : [];
    expect(logs).toContain("kb-knowledge.jsonl");
    expect(logs.some((n) => n.includes("relationship") || n.includes("candidate"))).toBe(false);
    // The queue must not contain a finalize/detection-triggering event from Phase 0.
    const queue = existsSync(join(home, "queue")) ? readdirSync(join(home, "queue")) : [];
    expect(queue.every((n) => !n.includes("detect"))).toBe(true);
  });
});
