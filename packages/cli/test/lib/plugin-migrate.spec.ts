import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  applyLegacyReconcile,
  inspectLegacyWiring,
  legacyWiringPaths,
  planLegacyReconcile,
  LegacyWiringInspection,
} from "../../src/connectors/claude-code/plugin-migrate";
import { MANAGED_HOOK_SCRIPTS, HOOKS_DIR, MCP_SERVER_KEY } from "../../src/lib/wire";
import type { PluginOwnership } from "../../src/connectors/claude-code/plugin-detect";

// --- inspectLegacyWiring: build real home-dir surfaces in a temp dir --------------
const mkHome = () => fs.mkdtempSync(path.join(os.tmpdir(), "mla-inspect-"));

// Build a settings.json hooks object wiring exactly `subset` of the managed hooks,
// using the same absolute command path countManagedHooks/isManagedHookCommand match.
function settingsWithHooks(subset: { event: string; script: string }[]): string {
  const hooks: Record<string, any[]> = {};
  for (const w of subset) {
    const command = path.join(HOOKS_DIR, w.script);
    (hooks[w.event] ??= []).push({ matcher: "*", hooks: [{ type: "command", command }] });
  }
  return JSON.stringify({ hooks }, null, 2);
}
function writeSettings(home: string, json: string) {
  const p = legacyWiringPaths(home);
  fs.mkdirSync(path.dirname(p.settingsPath), { recursive: true });
  fs.writeFileSync(p.settingsPath, json);
}
function writeClaudeJson(home: string, obj: any) {
  fs.writeFileSync(legacyWiringPaths(home).claudeJsonPath, JSON.stringify(obj, null, 2));
}

describe("inspectLegacyWiring (8-field surface view)", () => {
  it("hooksComplete demands EVERY managed hook; one wired hook is hooksAny-not-complete", () => {
    const tmp = mkHome();
    try {
      writeSettings(tmp, settingsWithHooks([MANAGED_HOOK_SCRIPTS[0]]));
      const insp = inspectLegacyWiring(legacyWiringPaths(tmp));
      expect(insp.hooksAny).toBe(true);
      expect(insp.hooksComplete).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("hooksComplete is true only when all managed hooks are wired", () => {
    const tmp = mkHome();
    try {
      writeSettings(tmp, settingsWithHooks([...MANAGED_HOOK_SCRIPTS]));
      const insp = inspectLegacyWiring(legacyWiringPaths(tmp));
      expect(insp.hooksAny).toBe(true);
      expect(insp.hooksComplete).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("globalMcpPresent counts a TOP-LEVEL entry only, never a project-scoped one", () => {
    const tmp = mkHome();
    try {
      writeClaudeJson(tmp, {
        projects: { "/some/repo": { mcpServers: { [MCP_SERVER_KEY]: {} } } },
      });
      expect(inspectLegacyWiring(legacyWiringPaths(tmp)).globalMcpPresent).toBe(false);
      writeClaudeJson(tmp, { mcpServers: { [MCP_SERVER_KEY]: {} } });
      expect(inspectLegacyWiring(legacyWiringPaths(tmp)).globalMcpPresent).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // Blocker 2: a PROJECT-scoped MCP entry must set mcpAny=true (so removal sees it)
  // while globalMcpPresent stays false (it is not global capture health).
  it("mcpAny sees a project-scoped entry that globalMcpPresent ignores", () => {
    const tmp = mkHome();
    try {
      writeClaudeJson(tmp, {
        projects: { "/some/repo": { mcpServers: { [MCP_SERVER_KEY]: {} } } },
      });
      const insp = inspectLegacyWiring(legacyWiringPaths(tmp));
      expect(insp.mcpAny).toBe(true);
      expect(insp.globalMcpPresent).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("mcpAny is true for a top-level entry too; false when no entry anywhere", () => {
    const tmp = mkHome();
    try {
      writeClaudeJson(tmp, { mcpServers: { [MCP_SERVER_KEY]: {} } });
      expect(inspectLegacyWiring(legacyWiringPaths(tmp)).mcpAny).toBe(true);
      writeClaudeJson(tmp, { projects: { "/repo": { mcpServers: {} } } });
      expect(inspectLegacyWiring(legacyWiringPaths(tmp)).mcpAny).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("skillsAny/skillsComplete: one-of-two skills is Any-not-Complete, both is Complete", () => {
    const tmp = mkHome();
    try {
      const paths = legacyWiringPaths(tmp);
      expect(inspectLegacyWiring(paths).skillsAny).toBe(false);
      // Seed ONLY the "mla" skill (one of the two MANAGED_SKILL_DIRS).
      fs.mkdirSync(path.join(paths.skillsDir, "mla"), { recursive: true });
      fs.writeFileSync(path.join(paths.skillsDir, "mla", "SKILL.md"), "# s\n");
      let insp = inspectLegacyWiring(paths);
      expect(insp.skillsAny).toBe(true);
      expect(insp.skillsComplete).toBe(false);
      // Seed the second ("mla-onboard") -> now Complete.
      fs.mkdirSync(path.join(paths.skillsDir, "mla-onboard"), { recursive: true });
      fs.writeFileSync(path.join(paths.skillsDir, "mla-onboard", "SKILL.md"), "# o\n");
      insp = inspectLegacyWiring(paths);
      expect(insp.skillsComplete).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("agentsAny/agentsComplete: one-of-two agents is Any-not-Complete, both is Complete", () => {
    const tmp = mkHome();
    try {
      const paths = legacyWiringPaths(tmp);
      fs.mkdirSync(paths.agentsDir, { recursive: true });
      expect(inspectLegacyWiring(paths).agentsAny).toBe(false);
      // Seed ONLY the doc scout (one of the two SCOUT_AGENT_FILES).
      fs.writeFileSync(path.join(paths.agentsDir, "meetless-doc-scout.md"), "---\n");
      let insp = inspectLegacyWiring(paths);
      expect(insp.agentsAny).toBe(true);
      expect(insp.agentsComplete).toBe(false);
      // Seed the history scout too -> now Complete.
      fs.writeFileSync(path.join(paths.agentsDir, "meetless-history-scout.md"), "---\n");
      insp = inspectLegacyWiring(paths);
      expect(insp.agentsComplete).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// --- planLegacyReconcile: pure function of (ownership, inspection) -----------------
const insp = (o: Partial<LegacyWiringInspection> = {}): LegacyWiringInspection => ({
  hooksAny: false,
  hooksComplete: false,
  mcpAny: false,
  globalMcpPresent: false,
  skillsAny: false,
  skillsComplete: false,
  agentsAny: false,
  agentsComplete: false,
  ...o,
});
// Named inspection fixtures spanning the derived-flag space.
// CAPTURE_COMPLETE: hooks + a GLOBAL mcp entry make captureComplete true; skills/agents
// are absent, so fullSurfaceComplete is false. (globalMcpPresent implies mcpAny.)
const CAPTURE_COMPLETE = insp({
  hooksAny: true,
  hooksComplete: true,
  mcpAny: true,
  globalMcpPresent: true,
});
// FULL_SURFACE: every managed surface present and complete -> fullSurfaceComplete true.
const FULL_SURFACE = insp({
  hooksAny: true,
  hooksComplete: true,
  mcpAny: true,
  globalMcpPresent: true,
  skillsAny: true,
  skillsComplete: true,
  agentsAny: true,
  agentsComplete: true,
});
const NONE = insp();
// Default mode is "repair" (doctor --fix): these ownership tables assert the repair-mode
// semantics (restore an EXISTING degraded install, evidence-gated on anySurface). The
// activate-mode describe block below asserts restore-legacy is unreachable in activate.
const plan = (
  ownership: any,
  inspection: LegacyWiringInspection = NONE,
  mode: "activate" | "repair" = "repair",
) => planLegacyReconcile({ ownership, inspection, mode });

// Blocker 2: EVERY non-global state is noop + this EXACT warning; never remove/restore.
const NONGLOBAL_WARN =
  "mla is installed only at project/local scope. Reinstall it at user scope before removing legacy wiring.";

describe("planLegacyReconcile: owned removes ANY legacy surface", () => {
  it("owned + full surface -> remove-legacy, restart required", () => {
    const p = plan("owned", FULL_SURFACE);
    expect(p.action).toBe("remove-legacy");
    expect(p.restartRequired).toBe(true);
  });

  // anySurface = hooksAny OR mcpAny OR skillsAny OR agentsAny: each single surface triggers
  // removal, including a lone skill/agent leftover that the two-boolean model would have missed.
  it.each([
    ["hooks only", insp({ hooksAny: true })],
    ["global mcp only", insp({ mcpAny: true, globalMcpPresent: true })],
    ["skills only", insp({ skillsAny: true })],
    ["agents only", insp({ agentsAny: true })],
  ])("owned + %s -> remove-legacy", (_label, inspection) => {
    expect(plan("owned", inspection).action).toBe("remove-legacy");
  });

  // Blocker 2: a PROJECT-scoped MCP remnant (mcpAny=true, globalMcpPresent=false) is still a
  // legacy surface removeMeetlessMcp will strip. anySurface must key off mcpAny, NOT
  // globalMcpPresent, or an owned install would leave the project entry orphaned forever.
  it("owned + project-only mcp (mcpAny, not global) -> remove-legacy", () => {
    const p = plan("owned", insp({ mcpAny: true, globalMcpPresent: false }));
    expect(p.action).toBe("remove-legacy");
    expect(p.restartRequired).toBe(true);
  });

  it("owned + no surface -> noop (already migrated)", () => {
    const p = plan("owned", NONE);
    expect(p.action).toBe("noop");
    expect(p.restartRequired).toBe(false);
  });
});

describe("planLegacyReconcile: non-global is ALWAYS noop + the reinstall warning", () => {
  it.each([
    ["full surface", FULL_SURFACE],
    ["capture only", CAPTURE_COMPLETE],
    ["partial", insp({ hooksAny: true })],
    ["none", NONE],
  ])("non-global + %s -> noop + reinstall warning, never remove/restore", (_l, inspection) => {
    const p = plan("non-global", inspection);
    expect(p.action).toBe("noop");
    expect(p.restartRequired).toBe(false);
    expect(p.warn).toBe(NONGLOBAL_WARN);
  });
});

describe("planLegacyReconcile: absent (repair mode) keys off fullSurfaceComplete", () => {
  it("absent + full surface complete -> noop (legacy is the active capture path)", () => {
    expect(plan("absent", FULL_SURFACE).action).toBe("noop");
  });

  // HINGE CASE: capture is complete but skills/agents are missing -> NOT fullSurfaceComplete
  // -> restore. (Contrast the identical inspection under `unknown` below, which no-ops.)
  it("absent + capture complete but skills/agents missing -> restore-legacy", () => {
    const p = plan("absent", CAPTURE_COMPLETE);
    expect(p.action).toBe("restore-legacy");
    expect(p.restartRequired).toBe(true);
  });

  // Blocker 2: skillsComplete (not just skillsAny) gates fullSurfaceComplete. Capture +
  // agents complete but skills only PARTIALLY present (one of two on disk) is NOT a full
  // surface, so restore must re-lay the missing skill rather than declare victory.
  it("absent + one-of-two skills missing -> restore-legacy", () => {
    const partial = insp({
      hooksAny: true,
      hooksComplete: true,
      mcpAny: true,
      globalMcpPresent: true,
      skillsAny: true,
      skillsComplete: false,
      agentsAny: true,
      agentsComplete: true,
    });
    const p = plan("absent", partial);
    expect(p.action).toBe("restore-legacy");
    expect(p.restartRequired).toBe(true);
  });

  // Review minimum patch #1: repair NEVER creates wiring from zero. With NO legacy
  // surface (no evidence of an existing install) there is nothing to repair, so even
  // doctor --fix no-ops and points the user at `mla rewire`. (`mla rewire` is the
  // create-from-zero installer.)
  it("absent + no surface -> noop (nothing to repair; rewire installs, not doctor --fix)", () => {
    const p = plan("absent", NONE);
    expect(p.action).toBe("noop");
    expect(p.warn).toMatch(/rewire/i);
  });

  // anySurface=true (an existing but incomplete install) IS evidence, so repair restores.
  it("absent + hooks present but incomplete -> restore-legacy (existing install, repair)", () => {
    expect(plan("absent", insp({ hooksAny: true, globalMcpPresent: true })).action).toBe(
      "restore-legacy",
    );
  });
});

describe("planLegacyReconcile: unknown (repair mode) keys off captureComplete, always warns", () => {
  it("unknown + capture complete -> noop with a warning (never rip working capture)", () => {
    const p = plan("unknown", CAPTURE_COMPLETE);
    expect(p.action).toBe("noop");
    expect(p.warn).toMatch(/could not confirm/i);
  });

  it("unknown + full surface -> noop with a warning", () => {
    expect(plan("unknown", FULL_SURFACE).action).toBe("noop");
  });

  // hooksAny but NOT hooksComplete => captureComplete is false, but anySurface is true
  // (an existing degraded install), so repair restores. Proves hooksComplete, not a
  // first-match, gates capture health.
  it("unknown + mcp + partial hooks -> restore-legacy with a warning", () => {
    const p = plan("unknown", insp({ hooksAny: true, hooksComplete: false, globalMcpPresent: true }));
    expect(p.action).toBe("restore-legacy");
    expect(p.warn).toMatch(/could not confirm/i);
  });

  // Review minimum patch #1: no legacy surface => no existing install to repair => noop
  // even under doctor --fix (rewire is the installer), still warned since the plugin is
  // unconfirmed.
  it("unknown + no surface -> noop with a warning (nothing to repair; rewire installs)", () => {
    const p = plan("unknown", NONE);
    expect(p.action).toBe("noop");
    expect(p.warn).toMatch(/could not confirm/i);
    expect(p.warn).toMatch(/rewire/i);
  });
});

// Review minimum patch #1, the behavioral lock: `mla activate` is connector-neutral and
// must NEVER install or restore Claude wiring. In activate mode, restore-legacy is
// unreachable for EVERY ownership/inspection; the only mutation the planner may emit is
// remove-legacy (owned + a legacy remnant to tear out).
describe("planLegacyReconcile: activate mode NEVER restores Claude wiring", () => {
  it.each([
    ["absent + no surface", "absent", NONE],
    ["absent + capture complete, skills/agents missing", "absent", CAPTURE_COMPLETE],
    ["absent + hooks incomplete", "absent", insp({ hooksAny: true, globalMcpPresent: true })],
    ["unknown + no surface", "unknown", NONE],
    ["unknown + partial hooks", "unknown", insp({ hooksAny: true, globalMcpPresent: true })],
  ])("activate mode: %s -> noop, never restore-legacy", (_l, ownership, inspection) => {
    const p = plan(ownership, inspection as LegacyWiringInspection, "activate");
    expect(p.action).not.toBe("restore-legacy");
    expect(p.action).toBe("noop");
  });

  it("activate mode still removes legacy under owned (the one allowed mutation)", () => {
    expect(plan("owned", FULL_SURFACE, "activate").action).toBe("remove-legacy");
  });

  // Contrast: the SAME degraded install restores under repair mode. This is exactly the
  // activate/repair split the minimum patch requires.
  it("repair mode DOES restore the same existing degraded install", () => {
    expect(plan("absent", CAPTURE_COMPLETE, "repair").action).toBe("restore-legacy");
    expect(plan("absent", CAPTURE_COMPLETE, "activate").action).toBe("noop");
  });
});

// Review Blocker 2, the connector-neutral quiet lock: a non-Claude user (Cursor- or
// Codex-only) running `mla activate` with NO legacy Claude surface on disk must get a
// SILENT no-op: no `warn`, no "run doctor --fix / rewire" advisory. `claude` merely
// being absent (detection => unknown) or the plugin being absent is NOT evidence of a
// broken Claude install to repair. non-global is the single exception: it warns even
// with zero surface because an exact plugin install WAS positively observed.
describe("planLegacyReconcile: activate is quiet when there is no Claude surface", () => {
  it.each([["owned", "owned"], ["absent", "absent"], ["unknown", "unknown"]])(
    "activate + %s + no surface -> quiet noop, NO warn",
    (_l, ownership) => {
      const p = plan(ownership as PluginOwnership["status"], NONE, "activate");
      expect(p.action).toBe("noop");
      expect(p.restartRequired).toBe(false);
      expect(p.warn).toBeUndefined();
    },
  );

  it("non-global is the exception: activate + non-global + no surface still warns", () => {
    const p = plan("non-global", NONE, "activate");
    expect(p.action).toBe("noop");
    expect(p.warn).toBe(NONGLOBAL_WARN);
  });

  it("but activate DOES warn when a degraded legacy surface actually exists", () => {
    // absent + an incomplete surface: activate will not restore it, but it is real
    // evidence of a half-dead Claude capture, so the repair hint IS warranted. Match
    // the hint text by phrase (LEGACY_REPAIR_HINT is module-private in plugin-migrate),
    // consistent with the unknown-mode warn assertions above.
    const p = plan("absent", insp({ hooksAny: true, globalMcpPresent: true }), "activate");
    expect(p.action).toBe("noop");
    expect(p.warn).toMatch(/doctor --fix/);
    expect(p.warn).toMatch(/rewire/);
  });
});

describe("applyLegacyReconcile (pure dispatcher over injected IO)", () => {
  const spyIO = () => {
    const calls = { remove: 0, restore: 0 };
    return {
      calls,
      io: {
        removeLegacy: () => {
          calls.remove++;
          return { changed: true };
        },
        restoreLegacy: () => {
          calls.restore++;
        },
      },
    };
  };

  it("noop calls neither thunk", () => {
    const { calls, io } = spyIO();
    const r = applyLegacyReconcile({ action: "noop", restartRequired: false, reason: "" }, io);
    expect(calls).toEqual({ remove: 0, restore: 0 });
    expect(r.changed).toBe(false);
  });

  it("remove-legacy calls removeLegacy and reports its changed result", () => {
    const { calls, io } = spyIO();
    const r = applyLegacyReconcile(
      { action: "remove-legacy", restartRequired: true, reason: "" },
      io,
    );
    expect(calls).toEqual({ remove: 1, restore: 0 });
    expect(r.changed).toBe(true);
  });

  it("restore-legacy calls restoreLegacy (NOT removeLegacy)", () => {
    const { calls, io } = spyIO();
    const r = applyLegacyReconcile(
      { action: "restore-legacy", restartRequired: true, reason: "" },
      io,
    );
    expect(calls).toEqual({ remove: 0, restore: 1 });
    expect(r.changed).toBe(true);
  });
});
