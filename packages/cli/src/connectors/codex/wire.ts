// connectors/codex/wire.ts: install/uninstall mechanics for the Codex connector's
// global hook file, `$CODEX_HOME/hooks.json`. This is the Codex sibling of the
// Claude wiring in lib/wire.ts. It deliberately does NOT touch the Claude path.
//
// The hook file schema is identical to Claude's settings.json, so the merge
// itself is the shared engine in lib/hook-reconcile.ts. Codex differs only in:
//   - WHERE it writes: $CODEX_HOME/hooks.json (config.codexHooksPath), not
//     ~/.claude/settings.json.
//   - WHAT it registers: mla SUBCOMMANDS, not hook-script paths, so identity is
//     the subcommand token run (hook-contract.codexManagedEventOf), not a
//     basename under hooks/.
//   - MALFORMED policy: it refuses to overwrite a corrupt/hand-edited hooks.json
//     (onParseError: "throw"), where Claude resets it. This is the §7 test-4
//     contract: a bad file fails visibly instead of being clobbered.
//
// MCP is NOT wired here: the static Codex plugin package ships `mla mcp`
// declaratively (plugin.json -> .mcp.json), so there is no ~/.claude.json-style
// registration for Codex. This module owns hooks only.

import * as fs from "fs";
import * as path from "path";

import { codexHooksPath, HomeResolutionDeps } from "../../lib/config";
import { resolveMlaPath, backupAndPruneSettings } from "../../lib/wire";
import {
  reconcileHookFile,
  removeManagedHookEntries,
  ReconcileResult,
} from "../../lib/hook-reconcile";
import {
  CODEX_MANAGED_HOOKS,
  buildCodexWantedHooks,
  codexManagedEventOf,
  isCodexManagedCommand,
} from "./hook-contract";

// Quote the mla executable path for a shell-run hook command, matching the
// forward-slash + double-quote convention lib/wire.ts uses for Claude hook
// commands: forward slashes so Git Bash on Windows does not eat backslashes,
// quotes so a home dir containing a space survives. On POSIX this is a plain
// quoted absolute path.
export function quoteMlaCommand(mlaPath: string): string {
  const p = mlaPath.split(path.sep).join("/");
  return `"${p}"`;
}

/**
 * Reconcile `$CODEX_HOME/hooks.json` so it registers exactly the Meetless-managed
 * Codex hooks (PreToolUse -> pretool-observe, UserPromptSubmit -> the codex-hook
 * wrapper), preserving every user/third-party hook. Idempotent. A malformed
 * hooks.json is NOT overwritten: it throws so the operator can inspect it.
 *
 * @param opts.hooksPathOverride  target file (tests point this at a temp dir)
 * @param opts.mlaPath            mla executable to register (defaults to resolveMlaPath)
 */
export function ensureCodexHooks(opts: {
  hooksPathOverride?: string;
  mlaPath?: string;
  homeDeps?: HomeResolutionDeps;
} = {}): ReconcileResult {
  const hooksPath = opts.hooksPathOverride ?? codexHooksPath(opts.homeDeps);
  const mlaPath = opts.mlaPath ?? resolveMlaPath();
  const wanted = buildCodexWantedHooks(quoteMlaCommand(mlaPath));

  return reconcileHookFile(hooksPath, wanted, isCodexManagedCommand, {
    onParseError: "throw",
    backup: backupAndPruneSettings,
  });
}

/**
 * Connector-scoped uninstall: strip only the Meetless-managed entries from
 * `$CODEX_HOME/hooks.json`, leaving every user/third-party hook intact. Like the
 * Claude `removeMeetlessHooks`, it edits ONLY the file; it never unlinks the
 * shared `~/.meetless/hooks/*.sh` scripts (so removing the Codex connector cannot
 * break Claude grounding, and vice versa).
 */
export function removeCodexHooks(opts: {
  hooksPathOverride?: string;
  homeDeps?: HomeResolutionDeps;
} = {}): { changed: boolean; filePath: string } {
  const hooksPath = opts.hooksPathOverride ?? codexHooksPath(opts.homeDeps);
  return removeManagedHookEntries(hooksPath, isCodexManagedCommand, {
    backup: backupAndPruneSettings,
  });
}

/** True when a Codex hooks.json currently registers every managed hook. */
export function codexHooksInstalled(opts: {
  hooksPathOverride?: string;
  homeDeps?: HomeResolutionDeps;
} = {}): boolean {
  const hooksPath = opts.hooksPathOverride ?? codexHooksPath(opts.homeDeps);
  if (!fs.existsSync(hooksPath)) return false;
  let doc: any;
  try {
    doc = JSON.parse(fs.readFileSync(hooksPath, "utf8"));
  } catch {
    return false;
  }
  const events = doc?.hooks;
  if (!events || typeof events !== "object") return false;
  const installed = new Set<string>();
  for (const event of Object.keys(events)) {
    const list = events[event];
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      const hooks = Array.isArray(entry?.hooks) ? entry.hooks : [];
      for (const h of hooks) {
        if (
          h?.type === "command" &&
          typeof h?.command === "string" &&
          codexManagedEventOf(h.command) === event
        ) {
          installed.add(event);
        }
      }
    }
  }
  return CODEX_MANAGED_HOOKS.every((hook) => installed.has(hook.event));
}
