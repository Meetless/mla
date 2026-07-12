import { mkdtempSync, mkdirSync, writeFileSync, existsSync, statSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { spawnSync, execSync } from "child_process";

// The Layer-3 Active Review block shells out to the REAL `mla _internal
// active-review` subcommand (user-prompt-submit.sh gates it on a resolvable
// $MLA_PATH). On an operator box `mla` is on PATH so the block fires; on a clean
// CI runner it is not, MLA_PATH resolves empty, and the block is silently skipped.
// Point mlaPath at the built binary so the subcommand runs on any runner, exactly
// as assemble-head-injection.spec.ts does for the assemble-context head.
const CLI_ROOT = resolve(__dirname, "../..");
const SRC_DIR = join(CLI_ROOT, "src");
const DIST_CLI = join(CLI_ROOT, "dist", "cli.js");

// Newest mtime (ms) of any file under `dir`, recursively: detect a stale build so
// the shelled-out binary never exercises pre-edit code.
function newestMtimeMs(dir: string): number {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestMtimeMs(full) : statSync(full).mtimeMs);
  }
  return newest;
}

describe("user-prompt-submit Active Review (Phase 1)", () => {
  beforeAll(() => {
    // The block needs jq (the whole hook does) and a fresh dist/cli.js. On CI the
    // release gate already ran `pnpm -r run build`, so this rebuild is a no-op;
    // locally it self-heals a stale binary.
    if (spawnSync("jq", ["--version"], { encoding: "utf8" }).status !== 0)
      throw new Error("jq required for the Active Review hook integration spec");
    const distStale =
      !existsSync(DIST_CLI) || newestMtimeMs(SRC_DIR) > statSync(DIST_CLI).mtimeMs;
    if (distStale) {
      execSync("npm run build", { cwd: CLI_ROOT, stdio: "ignore" });
    }
  }, 180000);

  it("injects an advisory and never blocks", () => {
    const home = mkdtempSync(join(tmpdir(), "mlhome-"));
    const repo = mkdtempSync(join(tmpdir(), "repo-"));
    writeFileSync(join(repo, ".meetless.json"), JSON.stringify({ workspaceId: "ws_1" }));
    mkdirSync(join(home, "logs"), { recursive: true });
    // mlaPath makes common.sh resolve MLA_PATH to the real binary on a clean runner
    // (no `mla` on PATH); the subcommand then runs with MEETLESS_ACTIVE_REVIEW_STUB_DETECT
    // for a hermetic detect (no intel round-trip).
    writeFileSync(join(home, "cli-config.json"), JSON.stringify({ workspaceId: "ws_1", actorUserId: "user_a", intelUrl: "http://127.0.0.1:8100", mlaPath: DIST_CLI }));
    writeFileSync(join(home, "logs", "kb-knowledge.jsonl"), JSON.stringify({ event: "active_memory_record", workspaceId: "ws_1", ownerUserId: "user_a", repoRootHash: "repoA", canonicalPath: "notes/x.md", contentHash: "h1", sessionId: "sess_1", turnIndex: 1, sourceProduct: "claude_code", kind: "produced_doc", createdAt: new Date().toISOString() }) + "\n");
    const hook = join(__dirname, "../../src/hooks-template/user-prompt-submit.sh");
    const r = spawnSync("bash", [hook], {
      input: JSON.stringify({ session_id: "sess_1", prompt: "continue", cwd: repo }),
      encoding: "utf8",
      // Activation gate walks up from the subprocess $PWD, not the stdin cwd field.
      cwd: repo,
      env: { ...process.env, MEETLESS_HOME: home, HOME: home, MEETLESS_ACTIVE_REVIEW: "1", MEETLESS_ACTIVE_REVIEW_STUB_DETECT: JSON.stringify({ detections: [{ relationType: "CONTRADICTS", citedKbId: "DD:7", confidence: 0.8, citedQuote: "q", candidatePath: "notes/x.md", posture: "LIVE", status: "ACCEPTED" }], persisted: false }) },
      timeout: 30000,
    });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(JSON.stringify(out)).toContain("DD:7");
    expect(out.decision).not.toBe("block");
  });
});
