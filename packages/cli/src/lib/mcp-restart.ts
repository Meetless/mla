// Self-heal supervisor split for `mla mcp`. The recurring "This operation was
// aborted" reports trace to the stale-dist footgun: `mla mcp` is a long-lived
// stdio daemon and Node NEVER hot-reloads the dist it loaded at spawn, so an
// editor window opened before a fix keeps serving the OLD code for days (e.g.
// aborting /v1/ask at the pre-fix deadline). The staleness WARNING (see
// lib/staleness.ts) makes that visible but still needs a human to restart the
// editor. This module turns the warning into self-healing.
//
// The shape: `mla mcp` (no `--child`) runs as a thin PARENT that holds the
// client's stdio pipe and respawns a `mla mcp --child` WORKER. The worker does
// all the serving; when it notices a newer build on disk AND is idle, it exits
// with MCP_RESTART_EXIT_CODE. The parent never releases fd 0/1, so the MCP
// client never sees a disconnect; it just respawns a fresh worker that loads the
// NEW dist. Any other worker exit code (0 clean disconnect, 1/2 error) is
// propagated and the parent exits too. No editor restart required.

// The sentinel the worker exits with to ask the parent for a reload. Must differ
// from the worker's own exit codes (0/1/2) so the parent can distinguish "reload
// me" from "I'm done" / "I errored", and stay out of the 129..255 signal band so
// a SIGTERM-killed child is never mistaken for a reload request. ("86 it.")
export const MCP_RESTART_EXIT_CODE = 86;

// The marker the supervisor appends when it RESPAWNS a worker (never on the
// first spawn). It exists because a reload is invisible to the MCP client by
// design: the parent holds fd 0/1 across the swap so the client never sees a
// disconnect, and therefore never re-handshakes and never re-requests
// `tools/list`. The client keeps handing the model the tool schema it cached at
// spawn, so a reload moves the handler code and leaves the advertised contract
// two days stale. That is the M1 defect measured in
// notes/20260809-did-mla-help-session-4caa06b9-the-contract-was-two-days-stale.md.
//
// A worker that boots with this marker emits `notifications/tools/list_changed`
// once it is connected, which is the ONE mechanism that actually moves the
// model-visible schema: measured 2026-08-09, Claude Code 2.1.211 (protocol
// 2025-11-25) re-requests `tools/list` 5 ms later and the new tools/params reach
// the model. (Codex 0.144.6 ignores it; `mla doctor` carries the fallback for
// hosts that do not honour the notification.)
//
// Deliberately NOT the same signal as `--child`: every reload is a child, but the
// FIRST child is not a reload, and announcing there would be noise ahead of the
// handshake's own tools/list.
export const MCP_RELOAD_FLAG = "--reloaded";

/**
 * Is THIS `mla mcp` invocation the spawned worker (vs the supervising parent)?
 * True when the parent passed `--child`, or when MEETLESS_MCP_CHILD is set (a
 * belt-and-suspenders env signal). The worker wires its stale->exit self-heal;
 * the parent never does.
 */
export function isMcpChild(argv: string[], env: NodeJS.ProcessEnv): boolean {
  return argv.includes("--child") || env.MEETLESS_MCP_CHILD === "1";
}

/**
 * Was THIS worker spawned as a reload (a self-heal respawn), rather than as the
 * session's first worker? Only a reload announces its tool list, because only a
 * reload happens behind a client that has already cached the old one. Mirrors
 * isMcpChild's argv-or-env shape so the two signals stay symmetric.
 */
export function isMcpReload(argv: string[], env: NodeJS.ProcessEnv): boolean {
  return argv.includes(MCP_RELOAD_FLAG) || env.MEETLESS_MCP_RELOADED === "1";
}

/**
 * Should this `mla mcp` invocation run the supervising parent? Yes for a bare
 * launch; no when it IS the child worker (avoids an infinite spawn) and no when
 * the kill switch MEETLESS_MCP_SUPERVISOR=0 is set (falls back to a single
 * in-process server, the pre-supervisor behaviour, if the parent ever misbehaves).
 */
export function shouldSuperviseMcp(
  argv: string[],
  env: NodeJS.ProcessEnv,
): boolean {
  if (isMcpChild(argv, env)) return false;
  if (env.MEETLESS_MCP_SUPERVISOR === "0") return false;
  return true;
}
