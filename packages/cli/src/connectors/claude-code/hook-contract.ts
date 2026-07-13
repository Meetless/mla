// hook-contract.ts: the neutral, dependency-free data contract for Claude Code
// hook wiring. wire.ts's installers (fs/os side effects) and the plugin
// renderers (plugin-artifact.ts, pure functions) both need MANAGED_HOOK_SCRIPTS
// and MCP_SERVER_KEY; importing them from wire.ts would drag wire's fs/os/
// runWire dependency graph into a pure renderer's (and a future .mjs
// generator's require graph). This module is a constants file: it declares no
// IO and no behavior, only the shared shape both sides render from.

// PostToolUse matcher. EMPTY STRING is Claude Code's catch-all (equivalent to
// "*"): the hook fires after EVERY tool call. This is deliberate, not lazy.
//
// The hook does two jobs and they have different gating needs:
//   1. SPOOL the captured tools (Bash, Write/Edit/MultiEdit/NotebookEdit,
//      AskUserQuestion, the `mcp__meetless__*` evidence pulls). post-tool-use.sh
//      self-filters to exactly these by tool name, so the spool set is enforced
//      in the SCRIPT, not in the matcher.
//   2. Fire the F3-B throttled liveness HEARTBEAT at the top of every invocation
//      so lastSeenAt keeps advancing mid-turn.
//
// A named-list matcher (the old "Bash|Write|Edit|AskUserQuestion|mcp__meetless__")
// gated job 2 on job 1's set: during a read/explore/subagent-heavy turn (Read,
// Grep, Glob, Task, WebFetch never match) the hook never ran, the heartbeat never
// fired, lastSeenAt froze, and deriveLiveness aged an actively-working session
// into IDLE. The catch-all decouples them: the heartbeat fires on every tool, and
// the script still spools only the captured set, so the v0 privacy boundary (a
// Read/Grep turn spools nothing) is unchanged.
export const POST_TOOL_USE_MATCHER = "";

// PreToolUse matcher: every tool that can put bytes on disk.
//
// This was "^(Write|Edit)$" until 2026-07-11, when our own enforcement benchmark
// caught the hole that narrowness left. A forbidden-root rule says "never create or
// edit any file under <root>/" — a statement about a PATH — but a matcher scoped to
// two tools silently turned it into "…using Write or Edit". An agent that was told
// to route around a block did exactly that, in one step:
//
//     Write  notes/design.md        -> DENIED by the governed rule
//     Bash   cat > notes/design.md  -> succeeded; this hook never fired
//
// So the block stopped a model that was going to comply anyway and failed to stop the
// one that wasn't. The matcher now covers Bash (shell redirects, tee, cp/mv, sed -i)
// and the two file tools the old anchored regex also exempted, MultiEdit and
// NotebookEdit. It is still an EXACT alternation, NOT the empty catch-all: Read, Grep,
// Glob and friends never spawn the subcommand. `deriveWriteTargets` then decides what a
// call actually writes, and a read-only Bash command (`ls`, `grep`) derives no targets
// and passes straight through.
export const PRE_TOOL_USE_MATCHER = "^(Write|Edit|MultiEdit|NotebookEdit|Bash)$";

// PostToolUse matcher for the CE0 evidence-consultation hook (ce0-post-tool-use.sh,
// proposal §4.1). Unlike the load-bearing PostToolUse hook (catch-all so the F3-B
// heartbeat fires on EVERY tool), the CE0 hook only needs to observe the governed
// memory pulls, so it is scoped to the `mcp__meetless__*` MCP tools. The matcher is
// an UNANCHORED substring regex (no "^"/"$"): it matches the full tool name
// `mcp__meetless__meetless__retrieve_knowledge` (and kb_doc_detail/query). The
// capture adapter then filters precisely to the three governed pulls, so a slightly
// broad matcher only spawns the subcommand on meetless tools, never on every tool.
export const CE0_POST_TOOL_USE_MATCHER = "mcp__meetless__";

// Single source of truth for the Claude Code hook events Meetless manages.
// wire.ts's ensureClaudeSettings derives its wanted list from this; unwire.ts's
// removeMeetlessHooks iterates the SAME list so a hook added to install can
// never be silently missed by uninstall. `matcher === ""` is the catch-all.
//
// The engine keys a managed entry by script BASENAME (wire.ts's
// isManagedHookCommand), so MORE THAN ONE script can ride the same event: each
// basename owns its own settings entry. The three ce0-*.sh evidence hooks
// (RECORD_ONLY measurement harness, proposal §4.1) ride the EXISTING
// UserPromptSubmit/PostToolUse/Stop events as second managed entries beside the
// load-bearing capture hooks.
export type ManagedHookScript = {
  event: string;
  script: string;
  matcher?: string;
  timeout?: number;
};

export const MANAGED_HOOK_SCRIPTS: ManagedHookScript[] = [
  { event: "SessionStart", script: "session-start.sh" },
  { event: "UserPromptSubmit", script: "user-prompt-submit.sh", timeout: 30 },
  { event: "Stop", script: "stop.sh" },
  { event: "PostToolUse", script: "post-tool-use.sh", matcher: POST_TOOL_USE_MATCHER },
  { event: "PreToolUse", script: "pre-tool-use.sh", matcher: PRE_TOOL_USE_MATCHER },
  // Enforcement backstop (2026-07-11). Catch-all ON PURPOSE: it never inspects the tool
  // name, only whether a file appeared under a governed forbidden root — so a shell
  // redirect the PreToolUse parser cannot see is still reverted. This is the half of
  // enforcement that does not depend on out-guessing a shell.
  { event: "PostToolUse", script: "posttool-sweep.sh", matcher: "", timeout: 10 },
  // CE0 evidence-consultation hooks (RECORD_ONLY). No timeout: they mirror
  // pre-tool-use.sh (best-effort, fail-soft, always `{}` exit 0).
  { event: "UserPromptSubmit", script: "ce0-user-prompt-submit.sh" },
  { event: "PostToolUse", script: "ce0-post-tool-use.sh", matcher: CE0_POST_TOOL_USE_MATCHER },
  { event: "Stop", script: "ce0-stop.sh" },
  // CE0 telemetry-projection hook (proposal §6.4): gives the offline sweep an
  // automatic caller so the two precision/recall denominator events
  // (memory_requirement_assessed, evidence_obligation_finalized) project on each
  // session start instead of only when a human runs `mla evidence ce0-emit-telemetry`.
  // It carries a timeout because, unlike the three pure-local turn hooks, the sweep
  // ends in a best-effort network flush; the local projection runs first, so a
  // timed-out invocation still lands the denominator events locally.
  { event: "SessionStart", script: "ce0-session-start.sh", timeout: 30 },
];

// Single source of truth for the MCP server KEY in ~/.claude.json. wire.ts's
// ensureClaudeMcpServer registers exactly this key; unwire.ts's removeMeetlessMcp
// deletes exactly this key, so install and uninstall stay symmetric: register it
// there, remove it there, never drift.
export const MCP_SERVER_KEY = "meetless";
