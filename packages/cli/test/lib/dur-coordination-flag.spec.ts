import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// DUR (notes/20260603-mla-kb-agent-proxy §5.4 DURING window; §6 #9; §7.2 row "DUR"):
// the PostToolUse hook surfaces a JUST-IN-TIME coordination flag at the moment the
// agent touches a GOVERNED surface ("this surface is governed by X"), not a judgment
// of the edit itself. Three hard constraints from the doc:
//   1. ADVISORY ONLY. PostToolUse never blocks (P6 "never its hands"): the hook emits
//      hookSpecificOutput.additionalContext, NEVER `decision: "block"`.
//   2. Gated on the closed CoordinationTrigger enum (the PE contract, §5.4.1) AND the
//      P5 high-confidence floor. A trigger alone does not promote; low/medium-confidence
//      stays passive, same boundary the BEFORE-turn imperative rung holds.
//   3. Keyed on the SPECIFIC surface being touched: the flag fires only when the edited
//      file path-suffix-matches a governed trigger surface from THIS turn.
//
// The producer (server-side detectors) is mostly unwired, exactly like PE: in prod
// today no coordination state is written, so the rung stays DORMANT. These tests seed
// the state file directly to exercise the render gate in isolation.

const HOOKS_DIR = path.resolve(__dirname, "../../src/hooks-template");
const COMMON = path.join(HOOKS_DIR, "common.sh");
const HOOK = "post-tool-use.sh";

const GOVERNED = "apps/connector/src/intel/intel-client.service.ts";
const GOVERNED_ABS = "/Users/dev/projects/meetless/" + GOVERNED;

interface Trigger {
  type: string;
  surface?: string;
  ref?: string;
}

interface FireResult {
  status: number;
  stdout: string;
  out: any | null;
}

interface Harness {
  home: string;
  queueDir: string;
  logsDir: string;
  fire: (input: object, env?: Record<string, string>) => FireResult;
  seedTurn: (sessionId: string, n: number) => void;
  seedCoordState: (
    sessionId: string,
    state: { turn_index: number; confidence: string; triggers: Trigger[]; trace_id?: string },
  ) => void;
  flagged: (sessionId: string) => string[];
}

function mkHarness(activate = true): { h: Harness; cleanup: () => void } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mla-dur-"));
  fs.copyFileSync(COMMON, path.join(tmp, "common.sh"));
  fs.copyFileSync(path.join(HOOKS_DIR, HOOK), path.join(tmp, HOOK));
  fs.chmodSync(path.join(tmp, HOOK), 0o755);

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

  const queueDir = path.join(home, "queue");
  const logsDir = path.join(home, "logs");

  const h: Harness = {
    home,
    queueDir,
    logsDir,
    fire: (input: object, env: Record<string, string> = {}) => {
      const r = spawnSync("bash", [path.join(tmp, HOOK)], {
        input: JSON.stringify(input),
        encoding: "utf8",
        cwd: workdir,
        env: { ...process.env, MEETLESS_HOME: home, MEETLESS_DEBUG: "0", ...env },
      });
      const stdout = r.stdout ?? "";
      let out: any | null = null;
      const trimmed = stdout.trim();
      if (trimmed.length > 0) {
        try {
          out = JSON.parse(trimmed);
        } catch {
          out = null;
        }
      }
      return { status: r.status ?? -1, stdout, out };
    },
    seedTurn: (sessionId: string, n: number) => {
      fs.mkdirSync(queueDir, { recursive: true });
      fs.writeFileSync(path.join(queueDir, `${sessionId}.turn`), String(n));
    },
    seedCoordState: (sessionId, state) => {
      const dir = path.join(logsDir, "coordination");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, `${sessionId}.json`),
        JSON.stringify({ ts: "2026-06-04T00:00:00Z", trace_id: "t0", ...state }),
      );
    },
    flagged: (sessionId: string) => {
      const p = path.join(logsDir, "coordination", `${sessionId}.flagged`);
      if (!fs.existsSync(p)) return [];
      return fs
        .readFileSync(p, "utf8")
        .split("\n")
        .filter((l) => l.trim().length > 0);
    },
  };
  return { h, cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}

function editInput(opts: { sessionId: string; tool?: string; filePath: string }) {
  const tool = opts.tool ?? "Edit";
  const ti: any =
    tool === "NotebookEdit"
      ? { notebook_path: opts.filePath, new_source: "x" }
      : { file_path: opts.filePath, old_string: "a", new_string: "b" };
  return {
    session_id: opts.sessionId,
    tool_name: tool,
    tool_input: ti,
    tool_response: { success: true },
  };
}

function additionalContext(r: FireResult): string | null {
  return r.out?.hookSpecificOutput?.additionalContext ?? null;
}

describe("post-tool-use.sh: DUR just-in-time coordination flag (§5.4 DURING)", () => {
  beforeAll(() => {
    if (spawnSync("jq", ["--version"]).status !== 0) throw new Error("jq required");
  });

  it("fires an advisory flag when a high-confidence governed surface is edited this turn", () => {
    const { h, cleanup } = mkHarness();
    try {
      h.seedTurn("s1", 2);
      h.seedCoordState("s1", {
        turn_index: 2,
        confidence: "high",
        triggers: [{ type: "GOVERNED_SURFACE_TOUCHED", surface: GOVERNED, ref: "DD:204" }],
      });
      const r = h.fire(editInput({ sessionId: "s1", filePath: GOVERNED_ABS }));
      expect(r.status).toBe(0);
      expect(r.out?.hookSpecificOutput?.hookEventName).toBe("PostToolUse");
      const ctx = additionalContext(r);
      expect(ctx).toBeTruthy();
      expect(ctx).toContain('kind="coordination"');
      expect(ctx).toContain(GOVERNED_ABS);
      expect(ctx).toContain("GOVERNED_SURFACE_TOUCHED");
      expect(ctx).toContain("DD:204");
      // The just-in-time framing distinguishes DURING from the BEFORE-turn imperative.
      expect(ctx).toContain("just-in-time");
    } finally {
      cleanup();
    }
  });

  it("NEVER blocks: no `decision`/`block` in the output, status stays 0 (P6 never its hands)", () => {
    const { h, cleanup } = mkHarness();
    try {
      h.seedTurn("s1", 1);
      h.seedCoordState("s1", {
        turn_index: 1,
        confidence: "high",
        triggers: [{ type: "GOVERNED_SURFACE_TOUCHED", surface: GOVERNED, ref: "DD:9" }],
      });
      const r = h.fire(editInput({ sessionId: "s1", filePath: GOVERNED_ABS }));
      expect(r.status).toBe(0);
      // Reminder, not a block.
      expect(r.stdout).toContain("reminder, not a block");
      expect(r.stdout).not.toContain('"decision"');
      expect(r.stdout).not.toContain('"block"');
      expect(r.out?.decision).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it("stays SILENT when the edited file is not a governed surface (no false positive)", () => {
    const { h, cleanup } = mkHarness();
    try {
      h.seedTurn("s1", 1);
      h.seedCoordState("s1", {
        turn_index: 1,
        confidence: "high",
        triggers: [{ type: "GOVERNED_SURFACE_TOUCHED", surface: GOVERNED, ref: "DD:9" }],
      });
      const r = h.fire(
        editInput({ sessionId: "s1", filePath: "/Users/dev/projects/meetless/apps/other/unrelated.ts" }),
      );
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe("");
    } finally {
      cleanup();
    }
  });

  it("respects the high-confidence floor: a trigger on a MEDIUM-confidence turn stays passive", () => {
    const { h, cleanup } = mkHarness();
    try {
      h.seedTurn("s1", 1);
      h.seedCoordState("s1", {
        turn_index: 1,
        confidence: "medium",
        triggers: [{ type: "GOVERNED_SURFACE_TOUCHED", surface: GOVERNED, ref: "DD:9" }],
      });
      const r = h.fire(editInput({ sessionId: "s1", filePath: GOVERNED_ABS }));
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe("");
    } finally {
      cleanup();
    }
  });

  it("flags a governed surface at most ONCE per session (no spam on repeat edits)", () => {
    const { h, cleanup } = mkHarness();
    try {
      h.seedTurn("s1", 1);
      h.seedCoordState("s1", {
        turn_index: 1,
        confidence: "high",
        triggers: [{ type: "GOVERNED_SURFACE_TOUCHED", surface: GOVERNED, ref: "DD:9" }],
      });
      const r1 = h.fire(editInput({ sessionId: "s1", filePath: GOVERNED_ABS }));
      expect(additionalContext(r1)).toBeTruthy();
      const r2 = h.fire(editInput({ sessionId: "s1", filePath: GOVERNED_ABS }));
      expect(r2.status).toBe(0);
      expect(r2.stdout.trim()).toBe("");
      expect(h.flagged("s1").filter((f) => f === GOVERNED_ABS).length).toBe(1);
    } finally {
      cleanup();
    }
  });

  it("kill switch MEETLESS_COORDINATION_DURING=0 suppresses the flag", () => {
    const { h, cleanup } = mkHarness();
    try {
      h.seedTurn("s1", 1);
      h.seedCoordState("s1", {
        turn_index: 1,
        confidence: "high",
        triggers: [{ type: "GOVERNED_SURFACE_TOUCHED", surface: GOVERNED, ref: "DD:9" }],
      });
      const r = h.fire(editInput({ sessionId: "s1", filePath: GOVERNED_ABS }), {
        MEETLESS_COORDINATION_DURING: "0",
      });
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe("");
    } finally {
      cleanup();
    }
  });

  it("ignores STALE coordination state from a prior turn (turn-index mismatch)", () => {
    const { h, cleanup } = mkHarness();
    try {
      // BEFORE-turn wrote state for turn 1; we are now mid turn 3.
      h.seedTurn("s1", 3);
      h.seedCoordState("s1", {
        turn_index: 1,
        confidence: "high",
        triggers: [{ type: "GOVERNED_SURFACE_TOUCHED", surface: GOVERNED, ref: "DD:9" }],
      });
      const r = h.fire(editInput({ sessionId: "s1", filePath: GOVERNED_ABS }));
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe("");
    } finally {
      cleanup();
    }
  });

  it("is a clean no-op when no coordination state exists (the default prod / dormant case)", () => {
    const { h, cleanup } = mkHarness();
    try {
      h.seedTurn("s1", 1);
      const r = h.fire(editInput({ sessionId: "s1", filePath: GOVERNED_ABS }));
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe("");
    } finally {
      cleanup();
    }
  });

  it("filters unknown trigger types to the closed enum (injection defense, even in state)", () => {
    const { h, cleanup } = mkHarness();
    try {
      h.seedTurn("s1", 1);
      h.seedCoordState("s1", {
        turn_index: 1,
        confidence: "high",
        // A surface that matches the edited file but a type OUTSIDE the closed enum.
        triggers: [{ type: "ARBITRARY_RELEVANCE", surface: GOVERNED, ref: "DD:evil" }],
      });
      const r = h.fire(editInput({ sessionId: "s1", filePath: GOVERNED_ABS }));
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe("");
    } finally {
      cleanup();
    }
  });

  it("extracts the NotebookEdit surface from notebook_path", () => {
    const { h, cleanup } = mkHarness();
    try {
      h.seedTurn("s1", 1);
      const nb = "intel/notebooks/eval.ipynb";
      h.seedCoordState("s1", {
        turn_index: 1,
        confidence: "high",
        triggers: [{ type: "BLAST_RADIUS_EDGE", surface: nb, ref: "NT:20260603-x" }],
      });
      const r = h.fire(
        editInput({ sessionId: "s1", tool: "NotebookEdit", filePath: "/abs/" + nb }),
      );
      expect(r.status).toBe(0);
      expect(additionalContext(r)).toContain("BLAST_RADIUS_EDGE");
      expect(additionalContext(r)).toContain("NT:20260603-x");
    } finally {
      cleanup();
    }
  });

  it("does NOT emit a coordination flag on a Bash tool, and still spools it (no regression)", () => {
    const { h, cleanup } = mkHarness();
    try {
      h.seedTurn("s1", 1);
      h.seedCoordState("s1", {
        turn_index: 1,
        confidence: "high",
        triggers: [{ type: "GOVERNED_SURFACE_TOUCHED", surface: GOVERNED, ref: "DD:9" }],
      });
      const r = h.fire({
        session_id: "s1",
        tool_name: "Bash",
        tool_input: { command: "echo hi" },
        tool_response: { exit_code: 0, stdout: "hi", stderr: "" },
      });
      expect(r.status).toBe(0);
      expect(r.stdout).not.toContain('kind="coordination"');
      const q = path.join(h.queueDir, "s1.jsonl");
      expect(fs.existsSync(q)).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("stays DORMANT (no flag) when the folder is not activated", () => {
    const { h, cleanup } = mkHarness(false);
    try {
      h.seedTurn("s1", 1);
      h.seedCoordState("s1", {
        turn_index: 1,
        confidence: "high",
        triggers: [{ type: "GOVERNED_SURFACE_TOUCHED", surface: GOVERNED, ref: "DD:9" }],
      });
      const r = h.fire(editInput({ sessionId: "s1", filePath: GOVERNED_ABS }));
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe("");
    } finally {
      cleanup();
    }
  });

  it("drift guard: post-tool-use.sh keeps the DUR coordination routing", () => {
    const src = fs.readFileSync(path.join(HOOKS_DIR, HOOK), "utf8");
    expect(src).toContain('kind=\\"coordination\\"');
    expect(src).toContain("MEETLESS_COORDINATION_DURING");
    expect(src).toContain("coordination_state_file");
    // The closed CoordinationTrigger enum is re-applied hook-side via the shared
    // constant, so a tampered trigger type can never fire the flag.
    expect(src).toContain("COORDINATION_TRIGGER_ENUM");
  });

  it("drift guard: common.sh defines the coordination path helpers + closed enum", () => {
    const src = fs.readFileSync(COMMON, "utf8");
    expect(src).toContain("coordination_state_file");
    expect(src).toContain("coordination_flagged_file");
    expect(src).toContain("COORDINATION_TRIGGER_ENUM");
    expect(src).toContain("GOVERNED_SURFACE_TOUCHED");
  });
});
