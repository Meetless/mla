// tools/meetless-agent/test/lib/post-tool-use-active-memory.spec.ts
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";

function harness() {
  const home = mkdtempSync(join(tmpdir(), "mlhome-"));
  const repo = mkdtempSync(join(tmpdir(), "repo-"));
  // Folder = workspace: the produced doc's workspaceId comes from the edited
  // file's own marker (A2 reads $A2_ROOT/.meetless.json), not cli-config.
  writeFileSync(join(repo, ".meetless.json"), JSON.stringify({ workspaceId: "ws_1" }));
  mkdirSync(join(repo, "notes"), { recursive: true });
  // cli-config.json drives ownerUserId; the marker drives workspaceId.
  mkdirSync(join(home, "logs"), { recursive: true });
  writeFileSync(join(home, "cli-config.json"), JSON.stringify({ actorUserId: "user_a", controlUrl: "http://127.0.0.1:9", controlToken: "t" }));
  return { home, repo };
}

function runHook(input: { cwd?: string; [k: string]: unknown }, env: Record<string, string>) {
  const hook = join(__dirname, "../../src/hooks-template/post-tool-use.sh");
  // Activation gate walks up from the subprocess $PWD, not the stdin cwd field;
  // run the hook in the edited file's repo so its marker resolves on a clean runner.
  return spawnSync("bash", [hook], { input: JSON.stringify(input), encoding: "utf8", cwd: input.cwd, env: { ...process.env, ...env } });
}

describe("post-tool-use A2 capture (Phase 0)", () => {
  it("Write to a .md prose file records one Active Review entry and no KB row (tests 1,7,40)", () => {
    const { home, repo } = harness();
    const f = join(repo, "notes", "x.md");
    writeFileSync(f, "decided to defer SSO to Q4");
    const r = runHook(
      { session_id: "sess_1", tool_name: "Write", tool_input: { file_path: f }, cwd: repo },
      { MEETLESS_HOME: home, HOME: home },
    );
    expect(r.status).toBe(0);
    const log = join(home, "logs", "kb-knowledge.jsonl");
    expect(existsSync(log)).toBe(true);
    const rows = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ event: "active_memory_record", canonicalPath: "notes/x.md", ownerUserId: "user_a", workspaceId: "ws_1", sourceProduct: "claude_code" });
    expect(rows[0].repoRootHash).toMatch(/^[0-9a-f]{64}$/);
    // The record carries the absolute repo root so the Zone 2 auto-index can
    // resolve the doc on disk (absPath = join(repoRoot, canonicalPath)). LOCAL-only.
    expect(rows[0].repoRoot).toBe(repo);
  });

  it("Write to a code file records nothing (test 1)", () => {
    const { home, repo } = harness();
    const f = join(repo, "src.ts");
    writeFileSync(f, "export const x = 1");
    runHook({ session_id: "sess_1", tool_name: "Write", tool_input: { file_path: f }, cwd: repo }, { MEETLESS_HOME: home, HOME: home });
    expect(existsSync(join(home, "logs", "kb-knowledge.jsonl"))).toBe(false);
  });

  it("Phase 0 canary stays local (test 41): token never leaves via network; only the local log holds it", () => {
    const { home, repo } = harness();
    const f = join(repo, "notes", "secret.md");
    writeFileSync(f, "PHASE0_SHOULD_NOT_LEAVE_LOCAL");
    // controlUrl/intelUrl point at a closed port; a network attempt would error.
    const r = runHook(
      { session_id: "sess_1", tool_name: "Write", tool_input: { file_path: f }, cwd: repo },
      { MEETLESS_HOME: home, HOME: home, MEETLESS_INTEL_URL: "http://127.0.0.1:9" },
    );
    expect(r.status).toBe(0);
    // The content hash is stored, never the prose; the canary token is not in the log.
    const log = readFileSync(join(home, "logs", "kb-knowledge.jsonl"), "utf8");
    expect(log).not.toContain("PHASE0_SHOULD_NOT_LEAVE_LOCAL");
  });
});
