import * as os from "os";
import * as path from "path";
import * as readline from "readline";
import * as fs from "fs";
import { HOME, QUEUE_DIR, codexHooksPath, userHomeDir } from "../lib/config";
import {
  RemoveHooksResult,
  RemoveMcpResult,
  countQueuedEvents,
  countQueuedSessions,
  detectBinaryRemovalHint,
  removeDir as removeDirImpl,
  removeMeetlessHooks,
  removeMeetlessMcp,
  resolveMlaBinary,
} from "../lib/unwire";
import { removeCodexHooks } from "../connectors/codex/wire";
import { runFlush } from "./flush";

// `mla uninstall`: remove the entire local Meetless footprint. Scope is
// local-only and minimal (no server-side deletion, no cross-repo marker hunt).
// Wiring (settings.json hooks, ~/.claude.json mcp, skill dir) is stripped BEFORE
// ~/.meetless is deleted so the settings file never points at hook scripts that
// are already gone.

type UnflushedChoice = "flush" | "delete" | "cancel";

export interface UninstallDeps {
  home?: string;
  settingsPath?: string;
  claudeJsonPath?: string;
  codexHooksPath?: string;
  skillDir?: string;
  queueDir?: string;
  log?: (msg: string) => void;
  errlog?: (msg: string) => void;
  isTTY?: boolean;
  env?: NodeJS.ProcessEnv;
  countQueued?: (queueDir: string) => number;
  countEvents?: (queueDir: string) => number;
  homeExists?: (home: string) => boolean;
  skillExists?: (dir: string) => boolean;
  resolveBinary?: (env: NodeJS.ProcessEnv) => { binPath: string | null; realPath: string | null };
  removeHooks?: (settingsPath: string) => RemoveHooksResult;
  removeMcp?: (claudeJsonPath: string) => RemoveMcpResult;
  removeCodexHooks?: (opts: { hooksPathOverride?: string }) => { changed: boolean; filePath: string };
  removeDir?: (dir: string) => { removed: boolean; error?: string };
  confirm?: (prompt: string) => Promise<boolean>;
  choose?: (prompt: string) => Promise<UnflushedChoice>;
  flush?: (argv: string[]) => Promise<number>;
}

function defaultConfirm(prompt: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise<boolean>((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      const n = answer.trim().toLowerCase();
      resolve(n === "y" || n === "yes");
    });
  });
}

function defaultChoose(prompt: string): Promise<UnflushedChoice> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise<UnflushedChoice>((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      const n = answer.trim().toLowerCase();
      if (n === "f" || n === "flush") resolve("flush");
      else if (n === "d" || n === "delete") resolve("delete");
      else resolve("cancel");
    });
  });
}

export async function runUninstall(argv: string[], deps: UninstallDeps = {}): Promise<number> {
  const log = deps.log ?? ((m: string) => console.log(m));
  const errlog = deps.errlog ?? ((m: string) => console.error(m));

  let dryRun = false;
  let yes = false;
  for (const a of argv) {
    if (a === "--dry-run") dryRun = true;
    else if (a === "--yes" || a === "-y") yes = true;
    else {
      errlog(`Unknown flag for \`mla uninstall\`: ${a}. Usage: mla uninstall [--dry-run] [--yes]`);
      return 2;
    }
  }

  const home = deps.home ?? HOME;
  const settingsPath = deps.settingsPath ?? path.join(userHomeDir(), ".claude", "settings.json");
  const claudeJsonPath = deps.claudeJsonPath ?? path.join(userHomeDir(), ".claude.json");
  const codexHooksFile = deps.codexHooksPath ?? codexHooksPath();
  const skillDir = deps.skillDir ?? path.join(userHomeDir(), ".claude", "skills", "mla");
  const queueDir = deps.queueDir ?? QUEUE_DIR;
  const isTTY = deps.isTTY ?? Boolean(process.stdin.isTTY);
  const env = deps.env ?? process.env;

  const countQueued = deps.countQueued ?? countQueuedSessions;
  const countEvents = deps.countEvents ?? countQueuedEvents;
  const homeExists = deps.homeExists ?? ((p: string) => fs.existsSync(p));
  const skillExists = deps.skillExists ?? ((p: string) => fs.existsSync(p));
  const resolveBinary = deps.resolveBinary ?? resolveMlaBinary;
  const removeHooks = deps.removeHooks ?? removeMeetlessHooks;
  const removeMcp = deps.removeMcp ?? removeMeetlessMcp;
  const removeCodex = deps.removeCodexHooks ?? removeCodexHooks;
  const removeDir = deps.removeDir ?? removeDirImpl;
  const confirm = deps.confirm ?? defaultConfirm;
  const choose = deps.choose ?? defaultChoose;
  const flush = deps.flush ?? runFlush;

  const queued = countQueued(queueDir);
  const events = countEvents(queueDir);
  const { binPath, realPath } = resolveBinary(env);

  // 1. Render the plan.
  log("mla uninstall will remove the local Meetless footprint:");
  log(`  - ${home}  (config, credentials, queue, hooks, logs, telemetry)`);
  log(`  - the Meetless hook entries in ${settingsPath}`);
  log(`  - the "meetless" MCP server in ${claudeJsonPath}`);
  log(`  - the Meetless Codex hook entries in ${codexHooksFile}`);
  if (skillExists(skillDir)) log(`  - ${skillDir}  (the /mla skill)`);
  log("");
  log("Left in place on purpose:");
  log("  - any of your own hooks or MCP servers (only Meetless's entries are removed)");
  log("  - .meetless.json + the CLAUDE.md rule block in other repos (non-secret).");
  log("    Remove those per repo with: rm .meetless.json  (and delete the");
  log("    `BEGIN MEETLESS RULES` ... `END MEETLESS RULES` block from CLAUDE.md)");
  log("");

  if (dryRun) {
    // Disclose un-flushed captured events the real run would put at risk, so the
    // preview names what is lost by its honest magnitude (event count, not file
    // count). Stay silent when no un-flushed events remain: a counted session
    // file can be fully drained and hold nothing to lose.
    if (events > 0) {
      log(`Note: the local queue holds ${events} captured event(s) across ${queued} session(s) not yet flushed to the server.`);
      log("The real run will offer to flush, delete, or cancel before anything is removed.");
      log("");
    }
    // Preview the one manual step uninstall leaves behind, so --dry-run shows
    // the complete footprint and never undersells what stays on disk.
    log("After removal, one manual step remains: remove the `mla` binary yourself:");
    for (const line of detectBinaryRemovalHint(binPath, realPath)) log(line);
    log("");
    log("(dry run: nothing was changed.)");
    return 0;
  }

  // 2. Gate. Non-interactive requires --yes.
  if (!yes && !isTTY) {
    errlog("Refusing to uninstall non-interactively. Re-run with --yes to proceed (or --dry-run to preview).");
    return 2;
  }

  // 3. Un-flushed-event safety (interactive only; --yes warns and proceeds).
  // Gate on the event count, not the file count: drained-but-lingering session
  // files carry nothing to lose, so they must not trigger a data-loss prompt.
  if (events > 0) {
    log(`Warning: the local queue holds ${events} captured event(s) across ${queued} session(s) not yet flushed to the server.`);
    if (yes) {
      log("Proceeding under --yes; this unflushed data will be deleted.");
    } else {
      const choice = await choose("[f]lush now, [d]elete anyway, or [c]ancel? ");
      if (choice === "cancel") {
        log("Cancelled. Nothing was changed.");
        return 0;
      }
      if (choice === "flush") {
        log("Flushing queued sessions...");
        const rc = await flush([]);
        if (rc !== 0) {
          errlog("Flush did not complete cleanly. Cancelling uninstall so no data is lost. Resolve the flush, then re-run.");
          return 1;
        }
      }
    }
  }

  // 4. Final confirmation (skipped under --yes).
  if (!yes) {
    const ok = await confirm("Remove the Meetless local install? [y/N] ");
    if (!ok) {
      log("Cancelled. Nothing was changed.");
      return 0;
    }
  }

  // 5. Execute. Strip wiring BEFORE deleting HOME. Each step best-effort.
  let hadError = false;

  const hooksRes = removeHooks(settingsPath);
  if (hooksRes.changed) {
    log(
      `Removed Meetless hooks (${hooksRes.removed.join(", ")}) from ${settingsPath}` +
        (hooksRes.backupPath ? ` (backup: ${hooksRes.backupPath})` : ""),
    );
  } else {
    log(`No Meetless hooks found in ${settingsPath}.`);
  }

  const mcpRes = removeMcp(claudeJsonPath);
  if (mcpRes.changed) {
    log(
      `Removed the "meetless" MCP server from ${claudeJsonPath}` +
        (mcpRes.backupPath ? ` (backup: ${mcpRes.backupPath})` : ""),
    );
  } else {
    log(`No "meetless" MCP server found in ${claudeJsonPath}.`);
  }

  // Strip the Codex connector's registration too, so whole-CLI uninstall never
  // leaves a dangling $CODEX_HOME/hooks.json entry pointing at a binary we are
  // about to remove. Best-effort: a malformed hooks.json is left untouched.
  try {
    const codexRes = removeCodex({ hooksPathOverride: codexHooksFile });
    if (codexRes.changed) {
      log(`Removed Meetless Codex hooks from ${codexRes.filePath}.`);
    } else {
      log(`No Meetless Codex hooks found in ${codexRes.filePath}.`);
    }
  } catch (err) {
    errlog(
      `Could not update ${codexHooksFile}: ${err instanceof Error ? err.message : String(err)}. ` +
        `Remove the Meetless entries by hand if present.`,
    );
  }

  if (skillExists(skillDir)) {
    const r = removeDir(skillDir);
    if (r.error) {
      hadError = true;
      errlog(`Could not remove ${skillDir}: ${r.error}`);
    } else {
      log(`Removed ${skillDir}.`);
    }
  }

  if (homeExists(home)) {
    const r = removeDir(home);
    if (r.error) {
      hadError = true;
      errlog(`Could not remove ${home}: ${r.error}`);
    } else {
      log(`Removed ${home}.`);
    }
  } else {
    log(`${home} was already absent.`);
  }

  // 6. Binary: print, never self-delete.
  log("");
  log("Local state is gone. One step left, to remove the `mla` binary itself:");
  for (const line of detectBinaryRemovalHint(binPath, realPath)) log(line);

  return hadError ? 1 : 0;
}
