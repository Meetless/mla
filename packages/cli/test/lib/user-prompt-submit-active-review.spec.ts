import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";

describe("user-prompt-submit Active Review (Phase 1)", () => {
  it("injects an advisory and never blocks", () => {
    const home = mkdtempSync(join(tmpdir(), "mlhome-"));
    const repo = mkdtempSync(join(tmpdir(), "repo-"));
    writeFileSync(join(repo, ".meetless.json"), "{}");
    mkdirSync(join(home, "logs"), { recursive: true });
    writeFileSync(join(home, "cli-config.json"), JSON.stringify({ workspaceId: "ws_1", actorUserId: "user_a", intelUrl: "http://127.0.0.1:8100" }));
    writeFileSync(join(home, "logs", "kb-knowledge.jsonl"), JSON.stringify({ event: "active_memory_record", workspaceId: "ws_1", ownerUserId: "user_a", repoRootHash: "repoA", canonicalPath: "notes/x.md", contentHash: "h1", sessionId: "sess_1", turnIndex: 1, sourceProduct: "claude_code", kind: "produced_doc", createdAt: new Date().toISOString() }) + "\n");
    const hook = join(__dirname, "../../src/hooks-template/user-prompt-submit.sh");
    const r = spawnSync("bash", [hook], {
      input: JSON.stringify({ session_id: "sess_1", prompt: "continue", cwd: repo }),
      encoding: "utf8",
      env: { ...process.env, MEETLESS_HOME: home, HOME: home, MEETLESS_ACTIVE_REVIEW: "1", MEETLESS_ACTIVE_REVIEW_STUB_DETECT: JSON.stringify({ detections: [{ relationType: "CONTRADICTS", citedKbId: "DD:7", confidence: 0.8, citedQuote: "q", candidatePath: "notes/x.md", posture: "LIVE", status: "ACCEPTED" }], persisted: false }) },
      timeout: 8000,
    });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(JSON.stringify(out)).toContain("DD:7");
    expect(out.decision).not.toBe("block");
  });
});
