import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Behavioral lock for hook stdin-parse tolerance (Wedge v6 Epoch 29).
//
// Pre-fix every Claude Code hook (session-start, user-prompt-submit,
// post-tool-use, stop) opened with the pattern:
//
//   INPUT="$(cat)"
//   SESSION_ID="$(echo "$INPUT" | jq -r '.session_id // empty')"
//   [[ -z "$SESSION_ID" ]] && exit 0
//
// under `set -euo pipefail` (inherited from common.sh). The `$()` substitution
// propagates jq's non-zero exit on EMPTY stdin or MALFORMED JSON; the hook
// aborts BEFORE the empty-session-id guard can fire. Two failure modes:
//
//   1. Claude Code sees a non-zero hook exit and may interpret it as a hook
//      failure (potentially blocking the prompt or surfacing an error).
//   2. The Stop hook is the critical path: if stop.sh crashes, no
//      session_stopped + finalize_requested events get spooled, no flush is
//      spawned, the review packet is never produced. Silent total loss.
//
// Post-fix each hook validates stdin parses as JSON FIRST and exits 0 cleanly
// on empty/malformed input.

const HOOKS_DIR = path.resolve(__dirname, "../../src/hooks-template");
const HOOK_FILES = [
  "session-start.sh",
  "user-prompt-submit.sh",
  "post-tool-use.sh",
  "stop.sh",
];

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
  queueFiles: string[];
}

function runHook(hookFile: string, stdin: string): RunResult {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mla-hook-input-"));
  // Stage common.sh + the hook under test into a working dir so `source
  // "$(dirname "$0")/common.sh"` resolves. Skipping the .jq filter is fine;
  // none of these hooks read it.
  fs.copyFileSync(
    path.join(HOOKS_DIR, "common.sh"),
    path.join(tmp, "common.sh"),
  );
  fs.copyFileSync(path.join(HOOKS_DIR, hookFile), path.join(tmp, hookFile));
  fs.chmodSync(path.join(tmp, hookFile), 0o755);

  // Minimal cli-config.json so common.sh's jq reads don't trip on missing
  // file (it tolerates missing, but the explicit config matches production).
  const meetlessHome = path.join(tmp, "home");
  fs.mkdirSync(meetlessHome);
  fs.writeFileSync(
    path.join(meetlessHome, "cli-config.json"),
    JSON.stringify({
      controlUrl: "http://127.0.0.1:1",
      controlToken: "x",
      workspaceId: "ws_test",
      mlaPath: "/bin/true",
    }),
  );

  const r = spawnSync("bash", [path.join(tmp, hookFile)], {
    input: stdin,
    encoding: "utf8",
    env: { ...process.env, MEETLESS_HOME: meetlessHome },
  });

  const queueDir = path.join(meetlessHome, "queue");
  const queueFiles = fs.existsSync(queueDir) ? fs.readdirSync(queueDir) : [];
  fs.rmSync(tmp, { recursive: true, force: true });
  return {
    status: r.status ?? -1,
    stdout: r.stdout,
    stderr: r.stderr,
    queueFiles,
  };
}

describe("hook stdin-parse tolerance", () => {
  beforeAll(() => {
    const jq = spawnSync("jq", ["--version"], { encoding: "utf8" });
    if (jq.status !== 0) {
      throw new Error("jq must be installed to run hook-input-tolerance specs");
    }
  });

  describe.each(HOOK_FILES)("%s", (hook) => {
    it("exits 0 cleanly on EMPTY stdin (no crash, no spool write)", () => {
      const r = runHook(hook, "");
      expect(r.status).toBe(0);
      // No session_id => no .jsonl spool file (lock files are fine).
      const jsonlFiles = r.queueFiles.filter((f) => f.endsWith(".jsonl"));
      expect(jsonlFiles).toEqual([]);
    });

    it("exits 0 cleanly on MALFORMED JSON stdin (no crash, no spool write)", () => {
      const r = runHook(hook, "{not valid json at all");
      expect(r.status).toBe(0);
      const jsonlFiles = r.queueFiles.filter((f) => f.endsWith(".jsonl"));
      expect(jsonlFiles).toEqual([]);
    });

    it("exits 0 cleanly on VALID JSON missing session_id (no spool write)", () => {
      const r = runHook(hook, '{"unrelated":"field"}');
      expect(r.status).toBe(0);
      const jsonlFiles = r.queueFiles.filter((f) => f.endsWith(".jsonl"));
      expect(jsonlFiles).toEqual([]);
    });
  });

  // Drift guard: if a future refactor drops the validation block from any
  // hook, this fails so we never silently re-introduce the crash.
  it.each(HOOK_FILES)("%s KEEPS the stdin-validation guard (drift guard)", (hook) => {
    const src = fs.readFileSync(path.join(HOOKS_DIR, hook), "utf8");
    expect(src).toMatch(/if \[\[ -z "\$INPUT" \]\] \|\| ! printf '%s' "\$INPUT" \| jq -e \. >\/dev\/null 2>&1; then/);
  });
});
