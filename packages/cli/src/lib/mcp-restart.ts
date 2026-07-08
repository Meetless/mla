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
