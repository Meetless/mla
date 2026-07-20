// `mla codex <install|uninstall>`: the Codex connector's lifecycle command.
//
// This is a SIBLING to `mla activate`, not a branch of it. Claude's wiring lives
// in `runActivate`/`runWire`; Codex's lives here. The two connectors share the
// hook SCRIPTS under ~/.meetless/hooks (provisioned once by `ensureHookScripts`),
// but each owns its own registration file: Claude writes ~/.claude/settings.json,
// Codex writes $CODEX_HOME/hooks.json. Installing or removing one never touches
// the other's registration, and neither uninstall deletes the shared scripts
// (only whole-CLI `mla uninstall` does).
//
// Install provisions the scripts, reconciles $CODEX_HOME/hooks.json, and prints
// the §6.2 (C2) hook-trust instruction VERBATIM. It makes NO claim that the hooks
// are trusted, active, or enabled: Codex fails open until the operator grants
// trust via `/hooks`, and this command cannot observe that. Do not soften or
// strengthen the wording.

import { ensureHookScripts, backupAndPruneSettings } from "../lib/wire";
import { codexHooksPath, HomeResolutionDeps } from "../lib/config";
import type { ReconcileResult } from "../lib/hook-reconcile";
import {
  ensureCodexHooks,
  removeCodexHooks,
} from "../connectors/codex/wire";

// The C2 installer text, verbatim from proposal §6.2. Registration ONLY: it does
// not claim to have verified, trusted, activated, or enabled the hooks, because
// the installer cannot observe hook trust. Any change to this string is a
// governance regression; tests assert it byte-for-byte.
export const CODEX_INSTALL_TRUST_NOTICE =
  "Codex hooks registered.\n\n" +
  "Hook execution has not been verified. Start Codex, run /hooks, review the " +
  "MLA commands, and grant trust. Until then, MLA governance may be inactive " +
  "and tools may proceed normally.";

export interface CodexCommandDeps {
  log?: (msg: string) => void;
  errlog?: (msg: string) => void;
  /** Provision ~/.meetless/hooks/*.sh (defaults to the shared ensureHookScripts). */
  ensureScripts?: () => string[];
  /** Reconcile $CODEX_HOME/hooks.json (defaults to ensureCodexHooks). */
  ensureHooks?: (opts: { hooksPathOverride?: string; homeDeps?: HomeResolutionDeps }) => ReconcileResult;
  /** Strip our entries from $CODEX_HOME/hooks.json (defaults to removeCodexHooks). */
  removeHooks?: (opts: { hooksPathOverride?: string; homeDeps?: HomeResolutionDeps }) => {
    changed: boolean;
    filePath: string;
  };
  /** Override the hooks.json path (tests point this at a temp $CODEX_HOME). */
  hooksPathOverride?: string;
  homeDeps?: HomeResolutionDeps;
}

/**
 * `mla codex install`: provision the shared hook scripts, register the Codex
 * PreToolUse + UserPromptSubmit hooks in $CODEX_HOME/hooks.json, and print the
 * hook-trust instruction. Idempotent: a second run re-provisions nothing new and
 * adds no duplicate registration. A malformed hooks.json makes this FAIL VISIBLY
 * (exit 1, file named) rather than clobber a hand-edited file (§6.4).
 */
export async function runCodexInstall(
  argv: string[],
  deps: CodexCommandDeps = {},
): Promise<number> {
  const log = deps.log ?? ((m: string) => console.log(m));
  const errlog = deps.errlog ?? ((m: string) => console.error(m));
  const ensureScripts = deps.ensureScripts ?? (() => ensureHookScripts());
  const ensureHooks = deps.ensureHooks ?? ensureCodexHooks;

  for (const a of argv) {
    errlog(`Unknown flag for \`mla codex install\`: ${a}. Usage: mla codex install`);
    return 2;
  }

  // 1. Provision the shared bash scripts (byte-identical to what Claude installs).
  ensureScripts();

  // 2. Reconcile $CODEX_HOME/hooks.json. A corrupt file throws here; we do not
  //    overwrite it. Name the file and stop so the operator can fix it by hand.
  let result: ReconcileResult;
  try {
    result = ensureHooks({
      hooksPathOverride: deps.hooksPathOverride,
      homeDeps: deps.homeDeps,
    });
  } catch (err) {
    const hooksPath = deps.hooksPathOverride ?? codexHooksPath(deps.homeDeps);
    errlog(
      `Refusing to modify ${hooksPath}: it exists but is not valid JSON. ` +
        `Codex hooks were NOT registered. Fix or remove that file, then re-run ` +
        `\`mla codex install\`.`,
    );
    errlog(`  (${err instanceof Error ? err.message : String(err)})`);
    return 1;
  }

  // 3. Report what happened, then print the trust notice VERBATIM.
  if (result.changed) {
    log(`Registered Meetless Codex hooks in ${result.filePath}.`);
  } else {
    log(`Meetless Codex hooks already registered in ${result.filePath}.`);
  }
  log("");
  log(CODEX_INSTALL_TRUST_NOTICE);
  return 0;
}

/**
 * `mla codex uninstall`: strip ONLY the Meetless-managed entries from
 * $CODEX_HOME/hooks.json, leaving every user/third-party hook intact. Does NOT
 * delete the shared ~/.meetless/hooks/*.sh scripts (Claude may still use them),
 * and does NOT touch ~/.claude/settings.json. A malformed hooks.json is left
 * untouched (no clobber).
 */
export async function runCodexUninstall(
  argv: string[],
  deps: CodexCommandDeps = {},
): Promise<number> {
  const log = deps.log ?? ((m: string) => console.log(m));
  const errlog = deps.errlog ?? ((m: string) => console.error(m));
  const removeHooks = deps.removeHooks ?? removeCodexHooks;

  for (const a of argv) {
    errlog(`Unknown flag for \`mla codex uninstall\`: ${a}. Usage: mla codex uninstall`);
    return 2;
  }

  const res = removeHooks({
    hooksPathOverride: deps.hooksPathOverride,
    homeDeps: deps.homeDeps,
  });
  if (res.changed) {
    log(`Removed Meetless Codex hooks from ${res.filePath}.`);
    log("The shared hook scripts under ~/.meetless/hooks were left in place");
    log("(Claude Code may still use them). Run `mla uninstall` to remove everything.");
  } else {
    log(`No Meetless Codex hooks found in ${res.filePath}.`);
  }
  return 0;
}

/**
 * `mla codex` router. Dispatches the `install` / `uninstall` subcommands. No bare
 * form: `mla codex` with no subcommand prints usage and exits non-zero.
 */
export async function runCodex(argv: string[], deps: CodexCommandDeps = {}): Promise<number> {
  const errlog = deps.errlog ?? ((m: string) => console.error(m));
  const sub = argv[0];
  const rest = argv.slice(1);
  if (sub === "install") return runCodexInstall(rest, deps);
  if (sub === "uninstall") return runCodexUninstall(rest, deps);
  errlog(
    `Usage: mla codex <install|uninstall>\n` +
      `  install    register the Meetless Codex hooks in $CODEX_HOME/hooks.json\n` +
      `  uninstall  remove only the Meetless Codex hooks (keeps shared scripts)`,
  );
  return 2;
}
