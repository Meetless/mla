import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Behavioral lock for the per-folder activation gate (opt-in capture).
//
// Capture hooks are wired machine-globally in ~/.claude/settings.json, so
// WITHOUT a gate every Claude Code session on the machine would be spooled.
// The gate (`meetless_activated` in common.sh) walks UP from the hook's $PWD
// looking for the nearest `.meetless.json` marker, CLAUDE.md-style. A session
// is captured ONLY when a marker is found; otherwise the hook exits 0 before
// touching the spool. This spec proves both halves of that contract for all
// four capture hooks: dormant when unmarked, spooling when marked.

const HOOKS_DIR = path.resolve(__dirname, "../../src/hooks-template");
const COMMON = path.join(HOOKS_DIR, "common.sh");
const HOOK_FILES = [
  "session-start.sh",
  "user-prompt-submit.sh",
  "post-tool-use.sh",
  "stop.sh",
];

// Valid stdin per hook: each carries a session_id (and whatever else the hook
// needs to reach spool_append) so the ONLY thing that can suppress the spool
// is the activation gate.
const VALID_INPUT: Record<string, string> = {
  "session-start.sh": JSON.stringify({ session_id: "sess-gate", transcript_path: "" }),
  "user-prompt-submit.sh": JSON.stringify({ session_id: "sess-gate", prompt: "hello" }),
  "post-tool-use.sh": JSON.stringify({
    session_id: "sess-gate",
    tool_name: "Bash",
    tool_input: { command: "echo hi" },
    tool_response: { exit_code: 0, stdout: "hi", stderr: "" },
  }),
  "stop.sh": JSON.stringify({ session_id: "sess-gate", transcript_path: "" }),
};

interface RunResult {
  status: number;
  jsonlFiles: string[];
}

// Run a hook with cwd set to an isolated workdir under os.tmpdir() so the
// walk-up cannot reach any ambient marker (e.g. the repo's own .meetless.json).
// When `activate` is true, drop a marker into the workdir so the folder gate
// passes. When `deactivate` is true, also drop a `<sid>.off` sentinel into the
// session-gate dir so the per-session OFF override fires even with the marker
// present (the sid is the one carried by every VALID_INPUT: "sess-gate").
function runHook(hookFile: string, activate: boolean, deactivate = false): RunResult {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mla-gate-"));
  try {
    fs.copyFileSync(COMMON, path.join(tmp, "common.sh"));
    fs.copyFileSync(path.join(HOOKS_DIR, hookFile), path.join(tmp, hookFile));
    fs.chmodSync(path.join(tmp, hookFile), 0o755);

    const home = path.join(tmp, "home");
    fs.mkdirSync(home);
    fs.writeFileSync(
      path.join(home, "cli-config.json"),
      JSON.stringify({
        controlUrl: "http://127.0.0.1:1",
        controlToken: "x",
        workspaceId: "ws_test",
        mlaPath: "/bin/true",
      }),
    );

    const workdir = path.join(tmp, "workdir");
    fs.mkdirSync(workdir);
    if (activate) fs.writeFileSync(path.join(workdir, ".meetless.json"), "{}\n");

    if (deactivate) {
      const gateDir = path.join(home, "session-gate");
      fs.mkdirSync(gateDir, { recursive: true });
      fs.writeFileSync(path.join(gateDir, "sess-gate.off"), "2026-05-28T00:00:00Z\n");
    }

    const r = spawnSync("bash", [path.join(tmp, hookFile)], {
      input: VALID_INPUT[hookFile],
      encoding: "utf8",
      cwd: workdir,
      // This spec is about the CAPTURE gate only. Push interception
      // (user-prompt-submit.sh) would otherwise fire curls at intel; suppress
      // enrich so the test stays hermetic and fast regardless of what's listening.
      env: { ...process.env, MEETLESS_HOME: home, MEETLESS_SUPPRESS_ENRICH: "1" },
    });

    const queueDir = path.join(home, "queue");
    const files = fs.existsSync(queueDir) ? fs.readdirSync(queueDir) : [];
    return {
      status: r.status ?? -1,
      jsonlFiles: files.filter((f) => f.endsWith(".jsonl")),
    };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

describe("per-folder activation gate", () => {
  beforeAll(() => {
    const jq = spawnSync("jq", ["--version"], { encoding: "utf8" });
    if (jq.status !== 0) {
      throw new Error("jq must be installed to run activation-gate specs");
    }
  });

  describe.each(HOOK_FILES)("%s", (hook) => {
    it("stays DORMANT (exit 0, no spool) when no .meetless.json marker is found", () => {
      const r = runHook(hook, false);
      expect(r.status).toBe(0);
      expect(r.jsonlFiles).toEqual([]);
    });

    it("CAPTURES (exit 0, spool written) when a .meetless.json marker is present", () => {
      const r = runHook(hook, true);
      expect(r.status).toBe(0);
      expect(r.jsonlFiles).toEqual(["sess-gate.jsonl"]);
    });
  });

  // Drift guard: if a future refactor drops the gate from any capture hook,
  // that hook silently re-captures every machine-global session. Fail loudly.
  // session-start.sh is the one exception to the `meetless_activated || exit 0`
  // one-liner: an unactivated repo no longer exits silently. It hands off to
  // `mla _internal session-nudge` (a one-line "installed but inactive here"
  // explanation) and THEN exits 0 inside a `if ! meetless_activated; then ... fi`
  // block, so the capture gate is intact (no spool without a marker; proved by
  // the DORMANT behavioral tests above) while the inactive nudge can still fire.
  it.each(HOOK_FILES.filter((h) => h !== "session-start.sh"))(
    "%s KEEPS the activation gate (drift guard)",
    (hook) => {
      const src = fs.readFileSync(path.join(HOOKS_DIR, hook), "utf8");
      expect(src).toMatch(/meetless_activated \|\| exit 0/);
    },
  );

  it("session-start.sh KEEPS the activation gate as a guarded block that still exits 0 unactivated (drift guard)", () => {
    const src = fs.readFileSync(path.join(HOOKS_DIR, "session-start.sh"), "utf8");
    // Still gates on meetless_activated, and the unactivated branch exits 0
    // before any spool_append (so capture stays opt-in).
    expect(src).toMatch(/if ! meetless_activated; then/);
    expect(src).toMatch(/_internal session-nudge/);
    const gateIdx = src.indexOf("if ! meetless_activated; then");
    const spoolIdx = src.indexOf("spool_append");
    expect(gateIdx).toBeGreaterThanOrEqual(0);
    expect(spoolIdx).toBeGreaterThan(gateIdx);
  });

  it("common.sh KEEPS the meetless_activated walk-up (drift guard)", () => {
    const src = fs.readFileSync(COMMON, "utf8");
    expect(src).toMatch(/meetless_activated\(\) \{/);
    expect(src).toMatch(/\.meetless\.json/);
  });
});

// Per-session OFF override (`mla deactivate`). A `<sid>.off` sentinel must
// silence the session in EVERY capture hook, even when the folder is activated,
// so the dogfooding A/B (pipeline on in one session, off in another, same repo)
// holds. The check sits AFTER the folder gate and the empty-sid guard in each
// hook, so it only fires for a real, parsed session id.
describe("per-session OFF override", () => {
  beforeAll(() => {
    const jq = spawnSync("jq", ["--version"], { encoding: "utf8" });
    if (jq.status !== 0) {
      throw new Error("jq must be installed to run activation-gate specs");
    }
  });

  it.each(HOOK_FILES)(
    "%s stays DORMANT (exit 0, no spool) with a .off sentinel even in an activated folder",
    (hook) => {
      const r = runHook(hook, true, true);
      expect(r.status).toBe(0);
      expect(r.jsonlFiles).toEqual([]);
    },
  );

  it("common.sh KEEPS the meetless_session_disabled helper (drift guard)", () => {
    const src = fs.readFileSync(COMMON, "utf8");
    expect(src).toMatch(/meetless_session_disabled\(\) \{/);
    expect(src).toMatch(/SESSION_GATE_DIR/);
  });

  // Drift guard: if a future refactor drops the session-OFF check from any
  // capture hook, `mla deactivate` silently stops working for it. Fail loudly.
  // Tolerant of two shapes: the bare one-liner most hooks use
  // (`meetless_session_disabled "$SESSION_ID" && exit 0`) AND user-prompt-submit.sh's
  // richer `if meetless_session_disabled ...; then write_not_run_trace; exit 0; fi`
  // form, which writes a minimal NOT_RUN/muted liveness line before exiting. Both
  // satisfy the invariant the guard protects: the mute check is present and the
  // muted branch exits 0 (silences capture). The bounded [\s\S]{0,160} window keeps
  // the `exit 0` tied to THIS check, not some unrelated later one.
  it.each(HOOK_FILES)("%s KEEPS the session-OFF check (drift guard)", (hook) => {
    const src = fs.readFileSync(path.join(HOOKS_DIR, hook), "utf8");
    expect(src).toMatch(/meetless_session_disabled "\$SESSION_ID"[\s\S]{0,160}exit 0/);
  });

  // Drift guard (user-prompt-submit.sh only): muting must still record ONE minimal
  // liveness line so the per-turn recap (`mla turn N`) can say "muted this turn"
  // instead of showing an unexplained gap. If a refactor drops the
  // write_not_run_trace call from the muted branch, that liveness signal vanishes
  // silently -- catch it here, alongside the behavioral coverage in
  // intercept-hook.spec.ts. The other hooks deliberately do NOT write this line
  // (only the prompt-submit hook owns the turn counter via next_turn_index).
  it("user-prompt-submit.sh records a NOT_RUN/muted liveness line on the muted branch", () => {
    const src = fs.readFileSync(path.join(HOOKS_DIR, "user-prompt-submit.sh"), "utf8");
    expect(src).toMatch(/write_not_run_trace "\$SESSION_ID" "muted"/);
  });

  // Drift guard: write_not_run_trace lives in common.sh (shared, testable) and the
  // muted line it emits must stay LOCAL -- it writes the inject-side ask-traces.jsonl
  // trail, never the spool/queue, so muting never forwards anything to control/intel.
  it("common.sh KEEPS write_not_run_trace writing only the local ask-traces trail (drift guard)", () => {
    const src = fs.readFileSync(COMMON, "utf8");
    expect(src).toMatch(/write_not_run_trace\(\) \{/);
    expect(src).toMatch(/ask-traces\.jsonl/);
  });
});
