// A partial Codex install, surfaced on ordinary `mla` commands. INSPECTION ONLY.
//
// The condition: a `$CODEX_HOME/hooks.json` written before `b2486c443` (2026-07-21)
// has every managed hook except `Stop`. Codex then fires SessionStart,
// UserPromptSubmit and PostToolUse normally, MLA records the run and its events, and
// nothing ever requests a finalize. Turn assembly runs only inside the
// AGENT_RUN_FINALIZED handler, so the session produces zero turns and zero claims
// while looking, from the outside, exactly like a working integration. Production
// 2026-08-10..08-16: 89 Codex runs, 0 finalized, 0 turns, 25,166 events in one
// workspace alone.
//
// WHY THIS DOES NOT REPAIR IT. Reconciling `hooks.json` from whatever MLA command
// happens to run is the wrong ownership boundary: startup would mutate a file another
// tool owns, a user could not tell installation from ordinary execution, the next
// Codex schema change would turn a runtime path into a migration engine, and starting
// MLA would change the evidence being debugged. `mla codex install` is the reconciler
// and it is the only one.

import { codexIntegrationDiagnostic } from "../connectors/codex/wire";

// Commands that must never carry it, and why each one is here:
//
//   _internal   the agent-invoked hot path (codex-hook, pretool-observe, finalize-
//               session, capture-decisions). Runs on every event; `pretool-observe`
//               also owns an exact stdout envelope. The wrapper warns once per
//               SESSION instead, which is the same information at 1/N the volume.
//   flush/queue spool drains, spawned detached by the hooks on every turn.
//   doctor      renders the full check with the missing events and the repair.
//   codex       `codex install` IS the repair and prints its own outcome.
//   help/-h/-v  read by scripts and by `mla --version` parsers.
const SILENT = new Set([
  "_internal",
  "flush",
  "queue",
  "doctor",
  "codex",
  "help",
  "--help",
  "-h",
  "--version",
  "-v",
]);

/** Whether `cmd` is an ordinary operator command that may carry the warning. */
export function shouldWarnCodexPartial(cmd: string | undefined): boolean {
  if (!cmd) return false; // bare `mla` prints the catalog; do not decorate it
  return !SILENT.has(cmd);
}

/**
 * Emit the warning for `cmd`, once, if the Codex integration is partial.
 *
 * Cheap by construction: one `existsSync` plus one small `JSON.parse` for operators
 * who have a Codex integration at all, and a single `existsSync` for everyone else.
 * Total -- any failure is silence, because a diagnostic that can break a command is
 * worse than the condition it reports.
 */
export function warnIfCodexPartial(
  cmd: string | undefined,
  write: (line: string) => void = (l) => process.stderr.write(l + "\n"),
): void {
  if (!shouldWarnCodexPartial(cmd)) return;
  try {
    const diagnostic = codexIntegrationDiagnostic();
    if (diagnostic.state === "partial" && diagnostic.message) write(diagnostic.message);
  } catch {
    /* inspection must never cost a command its run */
  }
}
