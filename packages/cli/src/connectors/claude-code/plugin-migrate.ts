// plugin-migrate.ts: reconcile the legacy home-dir wiring (settings.json hooks +
// ~/.claude.json MCP + ~/.claude/skills + ~/.claude/agents) against an installed
// plugin. The plugin, once installed and enabled at USER/MANAGED scope, provides the
// hooks, MCP server, skills, and agents itself, so keeping the legacy entries around
// would double-fire hooks, register the MCP twice, and shadow the plugin's namespaced
// skills/agents. But we must never leave capture silently dead, so the decision keys
// off TWO axes (design §6):
//
//   - ownership (4 states from plugin-detect): owned | non-global | unknown | absent
//   - an 8-field LegacyWiringInspection of the home-dir surfaces, from which three
//     derived flags drive the planner:
//       anySurface          = hooksAny || mcpAny || skillsAny || agentsAny
//       captureComplete     = hooksComplete && globalMcpPresent   (capture can run)
//       fullSurfaceComplete = captureComplete && skillsComplete && agentsComplete
//     hooksComplete is a present/total count over EVERY MANAGED_HOOK_SCRIPTS entry, not
//     a first-match: a half-wired hook set is a half-dead capture path, not "present".
//     skillsComplete/agentsComplete are the same present/total idea over the two managed
//     skills / two scout agents. The MCP fact is split in two: mcpAny (top-level OR
//     project-scoped) drives REMOVAL, so a project-only remnant is still torn out under
//     `owned`; globalMcpPresent (TOP-LEVEL ~/.claude.json only) drives CAPTURE HEALTH,
//     since a project-scoped MCP entry does not prove global capture runs everywhere.
//
//   ownership    mode      condition                action          why
//   ----------   -------   ----------------------   -------------   ----------------------
//   owned        (both)    anySurface               remove-legacy   plugin owns wiring; tear
//                                                                   out EVERY legacy surface
//                                                                   (incl. a lone skill/agent
//                                                                   leftover). Mode-invariant.
//   owned        (both)    no surface               noop            already migrated
//   non-global   (both)    (any)                    noop + warn     project/local-scope plugin
//                                                                   adds NO global wiring; do
//                                                                   not install or remove
//                                                                   legacy; advise reinstall
//                                                                   at user scope
//   absent       (both)    fullSurfaceComplete      noop            legacy IS the active,
//                                                                   complete capture path
//   absent       repair    anySurface && !full      restore-legacy  complete an EXISTING
//                                                                   degraded legacy install
//   absent       repair    !anySurface              noop + hint     no evidence of a legacy
//                                                                   install; `mla rewire` is
//                                                                   the create-from-zero path
//   absent       activate  anySurface && !full      noop + hint     an existing legacy surface
//                                                                   is degraded; activate will
//                                                                   NOT restore it, only advise
//   unknown      (both)    captureComplete          noop + warn     cannot confirm plugin;
//                                                                   capture can run, never rip
//   unknown      repair    anySurface &&            restore-legacy  complete an EXISTING
//                          !captureComplete         + warn          degraded legacy install
//   unknown      repair    !anySurface              noop + warn     nothing to repair; rewire
//                                                                   installs
//   unknown      activate  anySurface &&            noop + warn     an existing legacy surface
//                          !captureComplete                         is degraded; activate will
//                                                                   NOT restore it, only advise
//   (guard)      activate  !anySurface              noop (QUIET)    Review Blocker 2: no legacy
//   owned/                 (NOT non-global)                         Claude surface => nothing to
//   absent/                                                         migrate; connector-neutral,
//   unknown                                                         NO warn. A non-Claude user
//                                                                   (Cursor/Codex-only) is never
//                                                                   told to doctor --fix / rewire
//
// The mode gate is the review's minimum patch #1: `mla activate` is connector-neutral and
// must never install or restore a coding-agent connector, so `restore-legacy` is
// UNREACHABLE in `activate` mode (the only mutation activate can plan is remove-legacy).
// `repair` (mla doctor --fix) restores ONLY an EXISTING degraded install (evidence =
// anySurface), never create-from-zero; `mla rewire` is the explicit installer.
// Deliberate absent/unknown asymmetry (repair mode): `absent` requires the FULL surface
// (skills + agents too) before trusting legacy, because with no plugin those surfaces
// should exist; `unknown` only requires captureComplete, because a maybe-present plugin
// may legitimately own the skills/agents and we must not thrash them.
//
// planLegacyReconcile is a pure function of (ownership, inspection), unit-tested across
// the table. applyLegacyReconcile is a pure DISPATCHER over an injected ReconcileIO: it
// never reaches the real home dir itself. defaultReconcileIO composes the real removers
// (path-injectable) + restoreLegacyWiring (NOT path-injectable; see its note). Any
// settings.json hook change needs a fresh Claude Code session, so remove-legacy and
// restore-legacy both flag restartRequired.
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  MANAGED_HOOK_SCRIPTS,
  isManagedHookCommand,
  MCP_SERVER_KEY,
  HOOKS_DIR,
  runWire,
} from "../../lib/wire";
import {
  MANAGED_SKILL_DIRS,
  SCOUT_AGENT_FILES,
  removeMeetlessHooks,
  removeMeetlessMcp,
  removeMeetlessSkills,
  removeMeetlessAgents,
} from "../../lib/unwire";
import type { PluginOwnership } from "./plugin-detect";
import { userHomeDir } from "../../lib/config";

// --- Inspection ------------------------------------------------------------------

export interface LegacyWiringInspection {
  hooksAny: boolean;
  hooksComplete: boolean;
  // TWO distinct MCP facts (Blocker 2). mcpAny = ANY managed MCP entry, top-level OR
  // project-scoped (what the REMOVAL side must see, so a project-only remnant is still
  // torn out under `owned`). globalMcpPresent = TOP-LEVEL only (what CAPTURE HEALTH
  // needs, since only the global fallback proves capture runs everywhere). A project-
  // only entry has mcpAny=true, globalMcpPresent=false.
  mcpAny: boolean;
  globalMcpPresent: boolean;
  skillsAny: boolean;
  // skillsComplete/agentsComplete: BOTH managed skills / BOTH scout agents present.
  // A partial surface (one of two) is `*Any`-not-`*Complete`, so it can never read as
  // whole and pass the `absent` fullSurfaceComplete gate.
  skillsComplete: boolean;
  agentsAny: boolean;
  agentsComplete: boolean;
}

// Count how many of the MANAGED_HOOK_SCRIPTS are wired in settings.json. Returns a
// present/total pair so the caller can distinguish "some" (hooksAny) from "all"
// (hooksComplete). A malformed/unreadable settings.json reads as zero present.
function countManagedHooks(settingsPath: string): { present: number; total: number } {
  const total = MANAGED_HOOK_SCRIPTS.length;
  let parsed: any;
  try {
    parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  } catch {
    return { present: 0, total };
  }
  const hooks = parsed?.hooks;
  if (!hooks || typeof hooks !== "object") return { present: 0, total };
  let present = 0;
  for (const w of MANAGED_HOOK_SCRIPTS) {
    const list = Array.isArray(hooks[w.event]) ? hooks[w.event] : [];
    const cmd = path.join(HOOKS_DIR, w.script);
    const wired = list.some((entry: any) => {
      const hookList = Array.isArray(entry?.hooks) ? entry.hooks : [];
      return hookList.some(
        (h: any) =>
          h?.type === "command" &&
          typeof h?.command === "string" &&
          isManagedHookCommand(h.command, w.script, cmd),
      );
    });
    if (wired) present += 1;
  }
  return { present, total };
}

// Read the two MCP facts in one parse. `global` = TOP-LEVEL ~/.claude.json
// mcpServers[MCP_SERVER_KEY] (capture health). `any` = that OR any project-scoped
// entry (parsed.projects[*].mcpServers[MCP_SERVER_KEY]); MIRRORS removeMeetlessMcp
// (unwire.ts:158), which drops from BOTH the top level and every projects[*] map, so
// `owned` removal of a project-only remnant is a real change, not a no-op that loops.
function readLegacyMcp(claudeJsonPath: string): { any: boolean; global: boolean } {
  let parsed: any;
  try {
    parsed = JSON.parse(fs.readFileSync(claudeJsonPath, "utf8"));
  } catch {
    return { any: false, global: false };
  }
  const global = Boolean(parsed?.mcpServers?.[MCP_SERVER_KEY]);
  let projectAny = false;
  const projects = parsed?.projects;
  if (projects && typeof projects === "object") {
    for (const key of Object.keys(projects)) {
      if (projects[key]?.mcpServers?.[MCP_SERVER_KEY]) {
        projectAny = true;
        break;
      }
    }
  }
  return { any: global || projectAny, global };
}

// Present/total over the two MANAGED_SKILL_DIRS, so the caller distinguishes "some"
// (skillsAny) from "both" (skillsComplete), mirroring the hooks present/total shape.
function countLegacySkills(skillsDir: string): { present: number; total: number } {
  const total = MANAGED_SKILL_DIRS.length;
  const present = MANAGED_SKILL_DIRS.filter((name) =>
    fs.existsSync(path.join(skillsDir, name, "SKILL.md")),
  ).length;
  return { present, total };
}

// Present/total over the two SCOUT_AGENT_FILES (agentsAny vs agentsComplete).
function countLegacyAgents(agentsDir: string): { present: number; total: number } {
  const total = SCOUT_AGENT_FILES.length;
  const present = SCOUT_AGENT_FILES.filter((file) =>
    fs.existsSync(path.join(agentsDir, file)),
  ).length;
  return { present, total };
}

export function inspectLegacyWiring(paths: LegacyWiringPaths): LegacyWiringInspection {
  const hooks = countManagedHooks(paths.settingsPath);
  const mcp = readLegacyMcp(paths.claudeJsonPath);
  const skills = countLegacySkills(paths.skillsDir);
  const agents = countLegacyAgents(paths.agentsDir);
  return {
    hooksAny: hooks.present > 0,
    hooksComplete: hooks.total > 0 && hooks.present === hooks.total,
    mcpAny: mcp.any,
    globalMcpPresent: mcp.global,
    skillsAny: skills.present > 0,
    skillsComplete: skills.total > 0 && skills.present === skills.total,
    agentsAny: agents.present > 0,
    agentsComplete: agents.total > 0 && agents.present === agents.total,
  };
}

// --- Planner ---------------------------------------------------------------------

export type ReconcileAction = "remove-legacy" | "restore-legacy" | "noop";

export interface ReconcilePlan {
  action: ReconcileAction;
  restartRequired: boolean;
  reason: string;
  warn?: string;
}

// Blocker 2: a project/local-scope plugin provides NO global wiring. We must NOT
// auto-install global legacy wiring (the user chose a project-scoped plugin) and must
// NOT remove any existing global legacy wiring (it may be their only capture). Every
// non-global state is therefore a noop that tells the user how to get global wiring.
const NONGLOBAL_WARN =
  "mla is installed only at project/local scope. Reinstall it at user scope before removing legacy wiring.";

// Advisory for the absent/incomplete-legacy noop arms. Neither activation nor doctor
// --fix creates wiring from zero: `mla rewire` is the explicit installer, doctor --fix
// completes an EXISTING partial install. Honest for both "no surface at all" and "a
// degraded surface during activate" (which does not repair).
const LEGACY_REPAIR_HINT =
  "Global mla wiring is missing or incomplete. Run `mla doctor --fix` to repair an existing install, or `mla rewire` to (re)install.";

export type ReconcileMode = "activate" | "repair";

export function planLegacyReconcile(input: {
  ownership: PluginOwnership["status"];
  inspection: LegacyWiringInspection;
  mode: ReconcileMode;
}): ReconcilePlan {
  const {
    hooksAny,
    hooksComplete,
    mcpAny,
    globalMcpPresent,
    skillsAny,
    skillsComplete,
    agentsAny,
    agentsComplete,
  } = input.inspection;
  const mode = input.mode;
  // anySurface (removal trigger AND the "existing legacy install" evidence gate for a
  // repair-mode restore) uses mcpAny so a project-only MCP remnant still counts.
  // captureComplete (health) uses globalMcpPresent, since only the top-level fallback
  // proves capture runs. fullSurfaceComplete demands BOTH skills and BOTH agents.
  const anySurface = hooksAny || mcpAny || skillsAny || agentsAny;
  const captureComplete = hooksComplete && globalMcpPresent;
  const fullSurfaceComplete = captureComplete && skillsComplete && agentsComplete;

  // Connector-neutral quiet guard (Review Blocker 2). In `activate` mode, if there
  // is NO legacy Claude surface on disk (`!anySurface`), activation has nothing to
  // migrate: return a silent no-op with no `warn`. This is what keeps `mla activate`
  // connector-neutral for a Cursor-only or Codex-only user who never installed the
  // Claude connector: they must NEVER be told to run `mla doctor --fix` or
  // `mla rewire`, because `claude` merely being absent (detection `unknown`) or the
  // plugin being `absent` is not evidence of a broken Claude install to repair.
  // `non-global` is the deliberate exception and is intentionally NOT short-circuited
  // here: it warns even with zero legacy surface because an exact MLA plugin
  // installation WAS positively observed (just at project/local scope), so the
  // "reinstall at user scope" advisory is always warranted.
  if (mode === "activate" && !anySurface && input.ownership !== "non-global") {
    return {
      action: "noop",
      restartRequired: false,
      reason: "no Claude connector migration is required",
    };
  }

  switch (input.ownership) {
    case "owned":
      // Mode-invariant: the plugin owns hooks + MCP + skills + agents, so ANY legacy
      // surface still on disk shadows/double-fires against it; tear out all four. This
      // is the ONLY mutation `mla activate` (activate mode) may plan.
      return anySurface
        ? {
            action: "remove-legacy",
            restartRequired: true,
            reason:
              "the mla plugin owns global wiring now; removing every legacy home-dir surface (hooks, MCP, skills, agents) so nothing shadows or double-fires against it",
          }
        : {
            action: "noop",
            restartRequired: false,
            reason:
              "the mla plugin owns global wiring and no legacy home-dir surface remains; already migrated",
          };
    case "non-global":
      // Mode-invariant Blocker 2: never install and never remove; only advise. Same for
      // complete, partial, or absent legacy.
      return {
        action: "noop",
        restartRequired: false,
        reason:
          "the mla plugin is installed only at project/local scope, so it provides no global wiring; leaving legacy home-dir wiring exactly as-is",
        warn: NONGLOBAL_WARN,
      };
    case "absent":
      // No plugin. A complete legacy surface is the active capture path; leave it.
      if (fullSurfaceComplete) {
        return {
          action: "noop",
          restartRequired: false,
          reason:
            "plugin not installed; the full legacy home-dir surface (hooks, MCP, skills, agents) is complete and is the active capture path",
        };
      }
      // Incomplete legacy. Review minimum patch #1: activation NEVER installs or restores
      // Claude wiring, and neither mode creates wiring from zero. So restore fires ONLY in
      // repair mode AND only when an existing legacy install is present (anySurface).
      if (mode === "repair" && anySurface) {
        return {
          action: "restore-legacy",
          restartRequired: true,
          reason:
            "plugin not installed and an existing legacy home-dir surface is incomplete; completing it so capture is not silently half-dead",
        };
      }
      return {
        action: "noop",
        restartRequired: false,
        reason:
          mode === "activate"
            ? "plugin not installed; activation is connector-neutral and does not install or restore Claude wiring"
            : "plugin not installed and no existing legacy home-dir surface to repair",
        warn: LEGACY_REPAIR_HINT,
      };
    case "unknown":
    default:
      // Cannot confirm the plugin. A maybe-present plugin may legitimately own the
      // skills/agents, so captureComplete (hooks + global MCP) is enough to leave legacy
      // alone; below that, restore is again repair-only AND evidence-gated (anySurface).
      if (captureComplete) {
        return {
          action: "noop",
          restartRequired: false,
          reason: "leaving the complete legacy capture (hooks + global MCP) in place",
          warn: "could not confirm the plugin install state; not touching the complete legacy capture",
        };
      }
      if (mode === "repair" && anySurface) {
        return {
          action: "restore-legacy",
          restartRequired: true,
          reason:
            "restoring legacy home-dir capture because the plugin is unconfirmed and an existing legacy install is incomplete",
          warn: "could not confirm the plugin install state, and an existing legacy capture is incomplete; completing it so it is not silently dead",
        };
      }
      return {
        action: "noop",
        restartRequired: false,
        reason:
          mode === "activate"
            ? "plugin unconfirmed; activation is connector-neutral and does not install or restore Claude wiring"
            : "plugin unconfirmed and no existing legacy home-dir surface to repair",
        warn:
          "could not confirm the plugin install state" +
          (mode === "activate"
            ? "; activation does not install Claude wiring. Run `mla doctor --fix` to repair an existing install, or `mla rewire` to install."
            : "; no legacy capture to repair. Run `mla rewire` to install."),
      };
  }
}

// --- Paths + executor ------------------------------------------------------------

// The four legacy home-dir surfaces, from one source so the inspector and the executor
// cannot drift. `home` defaults to os.homedir(); tests pass a temp dir.
export interface LegacyWiringPaths {
  settingsPath: string;
  claudeJsonPath: string;
  skillsDir: string;
  agentsDir: string;
}

export function legacyWiringPaths(home: string = userHomeDir()): LegacyWiringPaths {
  const claudeDir = path.join(home, ".claude");
  return {
    settingsPath: path.join(claudeDir, "settings.json"),
    claudeJsonPath: path.join(home, ".claude.json"),
    skillsDir: path.join(claudeDir, "skills"),
    agentsDir: path.join(claudeDir, "agents"),
  };
}

// The smallest "restore full global legacy capture" primitive. It re-runs the home-dir
// wiring for the GLOBAL surfaces (hooks + settings + skills + agents + MCP + flock) but
// NOT per-repo project rules (those are `mla activate`'s job, not the fail-safe's).
//
// IMPORTANT ASYMMETRY (Blocker 4): this targets os.homedir() and is NOT path-injectable.
// runWire resolves the home dir internally (verified against wire.ts: WireOpts is
// { noPostToolUse?, noInstallFlock?, noProjectRules?, noMcp?, projectRoot?, skillOnly? }
// with NO home/destination field). So a restore cannot be redirected by a `paths`
// argument the way removal can. Tests that need an isolated restore must override
// process.env.HOME so os.homedir() resolves into a temp dir (see the HOME-isolated
// integration test); they must NOT expect defaultReconcileIO(paths) to redirect it.
export function restoreLegacyWiring(): void {
  runWire({ noProjectRules: true });
}

// The side-effecting primitives applyLegacyReconcile drives, injected so the dispatcher
// itself is pure. removeLegacy tears out ALL FOUR legacy surfaces (hooks, MCP, skills,
// agents) so a migrated home leaves nothing to shadow the plugin; restoreLegacy re-runs
// the global home-dir wiring.
export interface ReconcileIO {
  removeLegacy(): { changed: boolean };
  restoreLegacy(): void;
}

// `paths` governs REMOVAL only (the removers take explicit dirs). Restoration is NOT
// path-injectable: restoreLegacy -> restoreLegacyWiring -> runWire always targets
// os.homedir() (see restoreLegacyWiring's note). This asymmetry is deliberate and
// honest; do not add a `paths` knob to restore that runWire cannot honor.
export function defaultReconcileIO(
  paths: LegacyWiringPaths = legacyWiringPaths(),
): ReconcileIO {
  return {
    removeLegacy() {
      const h = removeMeetlessHooks(paths.settingsPath);
      const m = removeMeetlessMcp(paths.claudeJsonPath);
      const s = removeMeetlessSkills(paths.skillsDir);
      const a = removeMeetlessAgents(paths.agentsDir);
      return { changed: h.changed || m.changed || s.changed || a.changed };
    },
    restoreLegacy() {
      restoreLegacyWiring();
    },
  };
}

export function applyLegacyReconcile(
  plan: ReconcilePlan,
  io: ReconcileIO,
): { changed: boolean } {
  switch (plan.action) {
    case "noop":
      return { changed: false };
    case "remove-legacy":
      return { changed: io.removeLegacy().changed };
    case "restore-legacy":
      io.restoreLegacy();
      return { changed: true };
  }
}
