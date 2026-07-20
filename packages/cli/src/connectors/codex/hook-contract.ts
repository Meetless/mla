// hook-contract.ts: the neutral, dependency-free data contract for the Codex
// connector's global-hook wiring ($CODEX_HOME/hooks.json). It is the Codex
// sibling of connectors/claude-code/hook-contract.ts and follows the same rule:
// declares no IO and no behavior, only the shared shape the installer
// (connectors/codex/wire.ts) and the uninstaller render from.
//
// KEY DIFFERENCE from the Claude contract. Claude registers hook-SCRIPT command
// paths (`"~/.meetless/hooks/pre-tool-use.sh"`), identified by basename +
// `hooks/` parent (isManagedHookCommand). Codex registers mla SUBCOMMANDS
// (`"<mla>" _internal pretool-observe`), so the "is ours" identity is the
// subcommand TOKEN SEQUENCE, path-prefix-agnostic so it survives a binary
// upgrade that relocates the mla path. That difference lives entirely here; the
// merge engine (lib/hook-reconcile.ts) is shared and identical.

import type { WantedHook } from "../../lib/hook-reconcile";

// PreToolUse matcher for Codex. Every tool that can put bytes on disk, mapped to
// Codex's tool names: `apply_patch` is Codex's structured edit tool (Claude's
// equivalents are MultiEdit/NotebookEdit), plus Write/Edit and Bash so a shell
// redirect (`cat > notes/x.md`, `tee`, `sed -i`) cannot route around a
// path-scoped governed rule. Exact alternation, never the empty catch-all: Read/
// Grep/Glob never spawn the deny seam, and `deriveWriteTargets` (inside
// pretool-observe) still decides what a given call actually writes.
export const CODEX_PRE_TOOL_USE_MATCHER = "^(Write|Edit|apply_patch|Bash)$";

// UserPromptSubmit carries the same 30s ceiling as the Claude wiring: the
// grounding assembly (~/.meetless/hooks/user-prompt-submit.sh) injects the
// Layer-1 floor with zero network and best-effort appends a Layer-2 pull whose
// curl deadline sits well under this, so WE own the timeout, not a SIGKILL.
export const CODEX_USER_PROMPT_SUBMIT_TIMEOUT = 30;

// A managed Codex hook, expressed as a stable subcommand token sequence rather
// than a command string, so identity is independent of the mla path prefix.
export type CodexManagedHook = {
  event: string;
  /** The mla subcommand args, e.g. ["_internal", "pretool-observe"]. */
  subcommand: string[];
  matcher?: string;
  timeout?: number;
};

// Single source of truth for the Codex hook events Meetless manages. The
// installer derives its wanted list from this; the uninstaller identifies our
// entries from the SAME list, so a hook added to install can never be silently
// missed by uninstall.
//
//   PreToolUse       -> `mla _internal pretool-observe` (DIRECT reuse of the
//                       existing deny seam; zero new decision code)
//   UserPromptSubmit -> `mla _internal codex-hook user-prompt-submit` (a thin
//                       wrapper that shells into the shared grounding script)
export const CODEX_MANAGED_HOOKS: CodexManagedHook[] = [
  {
    event: "PreToolUse",
    // Codex does not support permissionDecision:"ask" on PreToolUse: it marks
    // the hook failed and continues the tool call. The response-mode flag keeps
    // the shared evaluator but maps that one unsafe wire result to a supported
    // deny (see internal-pretool-observe.ts).
    subcommand: ["_internal", "pretool-observe", "--codex"],
    matcher: CODEX_PRE_TOOL_USE_MATCHER,
  },
  {
    event: "UserPromptSubmit",
    subcommand: ["_internal", "codex-hook", "user-prompt-submit"],
    timeout: CODEX_USER_PROMPT_SUBMIT_TIMEOUT,
  },
];

// Installer versions before the Codex ASK compatibility fix registered the
// shared observer without `--codex`. Keep recognizing that exact command as
// ours so upgrade reconciles it in place instead of stacking a second hook.
const CODEX_LEGACY_MANAGED_HOOKS: CodexManagedHook[] = [
  {
    event: "PreToolUse",
    subcommand: ["_internal", "pretool-observe"],
  },
];

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// A managed command, matched by its subcommand token run appearing as
// whitespace-delimited tokens anywhere in the command string. Anchored on token
// boundaries (leading start-or-space, trailing space-or-end) so it recognizes a
// managed entry regardless of the mla path prefix or trailing args, without
// matching an unrelated operator command that merely contains the substring.
function subcommandRegex(subcommand: string[]): RegExp {
  return new RegExp("(^|\\s)" + subcommand.map(escapeRe).join("\\s+") + "(\\s|$)");
}

/**
 * Return the Codex event a command is our managed hook for, or null. Used as the
 * `isOurs` identity by the shared reconcile engine. Path-prefix-agnostic: it
 * keys on the subcommand token run, so an entry written by an older/relocated
 * mla binary is still recognized as ours and reconciled in place.
 */
export function codexManagedEventOf(command: string): string | null {
  if (typeof command !== "string" || command.length === 0) return null;
  for (const h of CODEX_MANAGED_HOOKS) {
    if (subcommandRegex(h.subcommand).test(command)) return h.event;
  }
  for (const h of CODEX_LEGACY_MANAGED_HOOKS) {
    if (subcommandRegex(h.subcommand).test(command)) return h.event;
  }
  return null;
}

/** True when `command` is our managed hook for `event`. */
export function isCodexManagedCommand(command: string, event: string): boolean {
  return codexManagedEventOf(command) === event;
}

/**
 * Build the exact `wanted` hook list for the reconcile engine, given the quoted
 * mla command prefix (e.g. `"/usr/local/bin/mla"`). Pure: joins the prefix with
 * each managed subcommand into the command string Codex will run through a shell.
 */
export function buildCodexWantedHooks(mlaCommandPrefix: string): WantedHook[] {
  return CODEX_MANAGED_HOOKS.map((h) => ({
    event: h.event,
    matcher: h.matcher,
    timeout: h.timeout,
    command: [mlaCommandPrefix, ...h.subcommand].join(" "),
  }));
}
