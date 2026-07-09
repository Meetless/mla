import * as fs from "fs";
import * as path from "path";
import { HOOKS_DIR } from "./config";
import { isManagedHookCommand, MANAGED_HOOK_SCRIPTS, MCP_SERVER_KEY } from "./wire";
import { SCOUT_NAMES } from "./enrichment/protocol";
import { SCOUT_AGENT_NAME } from "./enrichment/scout-brief";

// Inverse primitives of lib/wire.ts. Pure-ish and best-effort: a step that
// cannot complete returns a structured result rather than throwing, so the
// orchestrator can report every outcome and never abort halfway.

// Copy `p` to `p.bak.<now>` and return the backup path. Caller writes the new
// content only after this returns, so a botched edit is always recoverable.
export function backupFile(p: string): string {
  const backupPath = `${p}.bak.${Date.now()}`;
  fs.copyFileSync(p, backupPath);
  return backupPath;
}

// rm -rf one directory. removed=false (no error) means "was not there"; an
// error string means it existed but could not be removed.
export function removeDir(dir: string): { removed: boolean; error?: string } {
  try {
    if (!fs.existsSync(dir)) return { removed: false };
    fs.rmSync(dir, { recursive: true, force: true });
    return { removed: true };
  } catch (e) {
    return { removed: false, error: (e as Error).message };
  }
}

// Number of capture sessions with a queue file: one `<sid>.jsonl` per session
// (`.lock` / `.turn` sidecars do not count). A flush drains and truncates the
// events it sent, so a counted file may hold only a small un-flushed tail (or
// none) rather than a whole un-flushed session. Missing dir -> 0.
export function countQueuedSessions(queueDir: string): number {
  try {
    return fs.readdirSync(queueDir).filter((f) => f.endsWith(".jsonl")).length;
  } catch {
    return 0;
  }
}

// Total un-flushed events still sitting in the queue: the sum of event lines
// across every `<sid>.jsonl` (one JSON object per line; blank lines and `.lock`
// / `.turn` sidecars do not count). This is the honest measure of what an
// uninstall discards, since most session files hold only a short tail of events
// and the file count alone overstates the magnitude. Missing dir -> 0.
export function countQueuedEvents(queueDir: string): number {
  try {
    let total = 0;
    for (const f of fs.readdirSync(queueDir)) {
      if (!f.endsWith(".jsonl")) continue;
      const content = fs.readFileSync(path.join(queueDir, f), "utf8");
      total += content.split("\n").filter((line) => line.trim().length > 0).length;
    }
    return total;
  } catch {
    return 0;
  }
}

// Best-effort PATH search for the `mla` launcher. Returns the on-PATH path and
// its resolved realpath (the symlink target, when it is one). Pure over `env`
// so a test can hand it a synthetic PATH.
export function resolveMlaBinary(
  env: NodeJS.ProcessEnv = process.env,
): { binPath: string | null; realPath: string | null } {
  const PATH = env.PATH || "";
  for (const dir of PATH.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, "mla");
    try {
      const st = fs.lstatSync(candidate);
      if (st.isFile() || st.isSymbolicLink()) {
        let realPath: string | null = null;
        try {
          realPath = fs.realpathSync(candidate);
        } catch {
          realPath = null;
        }
        return { binPath: candidate, realPath };
      }
    } catch {
      // not in this dir
    }
  }
  return { binPath: null, realPath: null };
}

export interface RemoveHooksResult {
  removed: string[]; // event names we removed a meetless entry from
  changed: boolean;
  backupPath: string | null;
  settingsPath: string;
}

// Inverse of ensureClaudeSettings. For each managed event, drop entries that are
// EXCLUSIVELY ours (exactly one hook whose command isManagedHookCommand for that
// event's script). Operator hooks, and multi-hook entries an operator merged our
// command into, are never touched (same conservatism install uses). Emptied
// event arrays are deleted; an emptied `hooks` object is dropped. Best-effort:
// a missing or unparseable file is a no-op, not an error.
export function removeMeetlessHooks(settingsPath: string): RemoveHooksResult {
  const noop: RemoveHooksResult = { removed: [], changed: false, backupPath: null, settingsPath };
  if (!fs.existsSync(settingsPath)) return noop;
  const current = fs.readFileSync(settingsPath, "utf8");
  let parsed: any;
  try {
    parsed = JSON.parse(current);
  } catch {
    return noop;
  }
  if (!parsed || typeof parsed.hooks !== "object" || parsed.hooks === null) return noop;

  const removed: string[] = [];
  for (const { event, script } of MANAGED_HOOK_SCRIPTS) {
    const list = parsed.hooks[event];
    if (!Array.isArray(list)) continue;
    const cmd = path.join(HOOKS_DIR, script);
    const isOurs = (entry: any): boolean => {
      const hooks = Array.isArray(entry?.hooks) ? entry.hooks : [];
      if (hooks.length !== 1) return false;
      const c = hooks[0];
      return (
        c?.type === "command" &&
        typeof c?.command === "string" &&
        isManagedHookCommand(c.command, script, cmd)
      );
    };
    const kept = list.filter((e: any) => !isOurs(e));
    if (kept.length !== list.length) {
      removed.push(event);
      if (kept.length === 0) delete parsed.hooks[event];
      else parsed.hooks[event] = kept;
    }
  }

  if (removed.length === 0) return noop;
  if (Object.keys(parsed.hooks).length === 0) delete parsed.hooks;

  const next = JSON.stringify(parsed, null, 2) + "\n";
  const backupPath = backupFile(settingsPath);
  fs.writeFileSync(settingsPath, next, "utf8");
  return { removed, changed: true, backupPath, settingsPath };
}

export interface RemoveMcpResult {
  removedFrom: string[]; // labels: "(top level)" and/or "projects/<path>"
  changed: boolean;
  backupPath: string | null;
  claudeJsonPath: string;
}

// Delete the single `meetless` server from ~/.claude.json: the top-level
// mcpServers map plus every projects[*].mcpServers map. Other servers are kept;
// an emptied mcpServers object is dropped. Best-effort over a missing/unparseable
// file. The file is re-serialized with 2-space indent (it may have been
// minified); the timestamped backup preserves the byte-exact original.
export function removeMeetlessMcp(claudeJsonPath: string): RemoveMcpResult {
  const noop: RemoveMcpResult = { removedFrom: [], changed: false, backupPath: null, claudeJsonPath };
  if (!fs.existsSync(claudeJsonPath)) return noop;
  const current = fs.readFileSync(claudeJsonPath, "utf8");
  let parsed: any;
  try {
    parsed = JSON.parse(current);
  } catch {
    return noop;
  }

  const removedFrom: string[] = [];
  const dropFrom = (container: any, label: string): void => {
    const servers = container?.mcpServers;
    if (servers && typeof servers === "object" && MCP_SERVER_KEY in servers) {
      delete servers[MCP_SERVER_KEY];
      removedFrom.push(label);
      if (Object.keys(servers).length === 0) delete container.mcpServers;
    }
  };

  dropFrom(parsed, "(top level)");
  if (parsed && typeof parsed.projects === "object" && parsed.projects !== null) {
    for (const projPath of Object.keys(parsed.projects)) {
      dropFrom(parsed.projects[projPath], `projects/${projPath}`);
    }
  }

  if (removedFrom.length === 0) return noop;
  const next = JSON.stringify(parsed, null, 2) + "\n";
  const backupPath = backupFile(claudeJsonPath);
  fs.writeFileSync(claudeJsonPath, next, "utf8");
  return { removedFrom, changed: true, backupPath, claudeJsonPath };
}

// The two legacy skill directories the home-dir wiring installs under
// ~/.claude/skills. Mirrors installSkill ("mla") + installOnboardSkill
// ("mla-onboard") in wire.ts; keep in lockstep if those targets ever change.
// Exported so plugin-migrate's inspectLegacyWiring enumerates the SAME set it removes.
export const MANAGED_SKILL_DIRS = ["mla", "mla-onboard"] as const;

// The legacy scout agent filenames the home-dir wiring installs under ~/.claude/agents.
// Derived from SCOUT_AGENT_NAME so it cannot drift from what installScoutAgents wrote;
// exported for the same reason as MANAGED_SKILL_DIRS.
export const SCOUT_AGENT_FILES: readonly string[] = SCOUT_NAMES.map(
  (role) => `${SCOUT_AGENT_NAME[role]}.md`,
);

// Remove the legacy per-skill SKILL.md files. We delete ONLY the SKILL.md we
// installed, then rmdir the directory if (and only if) it is now empty, so any
// memory.md / events.jsonl written under it by the skill-memory protocol survives.
export function removeMeetlessSkills(skillsDir: string): { changed: boolean } {
  let changed = false;
  for (const name of MANAGED_SKILL_DIRS) {
    const dir = path.join(skillsDir, name);
    const skillFile = path.join(dir, "SKILL.md");
    if (fs.existsSync(skillFile)) {
      fs.rmSync(skillFile);
      changed = true;
    }
    try {
      if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
        fs.rmdirSync(dir);
      }
    } catch {
      /* best effort: a non-empty dir (memory.md/events.jsonl) is left intact */
    }
  }
  return { changed };
}

// Remove the legacy scout agent files. These are fully generated (no user data),
// so removal is unconditional. Filenames come from SCOUT_AGENT_FILES so this cannot
// drift from what installScoutAgents wrote.
export function removeMeetlessAgents(agentsDir: string): { changed: boolean } {
  let changed = false;
  for (const file of SCOUT_AGENT_FILES) {
    const p = path.join(agentsDir, file);
    if (fs.existsSync(p)) {
      fs.rmSync(p);
      changed = true;
    }
  }
  return { changed };
}

// Map (binPath, realPath) to the human removal instruction. Classifies by the
// realpath shape, no shelling out. Four distinct install shapes, four distinct
// instructions -- the previous version collapsed the last three into a single
// "a dev symlink" line, which was wrong for the two most common install paths
// (Homebrew cask, curl one-liner) and sent those users hunting for a source
// checkout that does not exist:
//   1. realpath under node_modules/@meetless/mla  -> package-manager global
//      (pnpm if the path mentions pnpm, else npm); uninstall, never rm.
//   2. realpath (or launcher) under a Homebrew Caskroom -> a cask; uninstall via
//      brew. rm-ing the symlink leaves brew thinking mla is installed and a
//      `brew upgrade` would resurrect it, so the launcher rm is actively wrong.
//   3. realpath resolves into the monorepo at packages/cli -> a genuine dev
//      symlink; rm the launcher and name the repo root so the clone can go too.
//   4. anything else -> a real binary the curl one-liner copied (a Mach-O, not a
//      symlink) or a manual drop-in; rm is correct, but it is NOT a dev symlink.
export function detectBinaryRemovalHint(
  binPath: string | null,
  realPath: string | null,
): string[] {
  if (!binPath) {
    return ["Could not find `mla` on your PATH. If a copy remains, remove it manually."];
  }
  const probe = realPath ?? "";

  // 1. Package-manager global.
  const pkgMarker = `${path.sep}node_modules${path.sep}@meetless${path.sep}mla`;
  if (probe.includes(pkgMarker)) {
    const isPnpm = /pnpm/.test(probe) || /pnpm/.test(binPath);
    return [
      "Remove the globally-installed package:",
      isPnpm ? "  pnpm rm -g @meetless/mla" : "  npm uninstall -g @meetless/mla",
    ];
  }

  // 2. Homebrew cask. brew stages the binary under <prefix>/Caskroom/mla/... and
  //    symlinks it onto PATH from <prefix>/bin. Match on either the symlink
  //    target (the usual signal) or the launcher path itself.
  const caskMarker = `${path.sep}Caskroom${path.sep}`;
  if (probe.includes(caskMarker) || binPath.includes(caskMarker)) {
    return [
      "Remove the Homebrew cask (do NOT `rm` the launcher -- brew would resurrect it):",
      "  brew uninstall --cask mla",
    ];
  }

  // 3. Dev symlink into a source checkout.
  const devMarker = `${path.sep}packages${path.sep}cli${path.sep}`;
  if (realPath && realPath.includes(devMarker)) {
    const lines = ["Remove the `mla` launcher (a dev symlink):", `  rm ${binPath}`];
    const idx = realPath.indexOf(devMarker);
    if (idx > 0) {
      lines.push(`If you no longer need the source, delete the checkout at ${realPath.slice(0, idx)}`);
    }
    return lines;
  }

  // 4. Real installed binary (curl one-liner copy or manual drop-in).
  return ["Remove the `mla` binary:", `  rm ${binPath}`];
}
