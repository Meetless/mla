// EPIPE containment at the process edge.
//
// Node reports "the reader closed the pipe" as an `error` EVENT on the stream, never as
// a rejected promise. With no listener attached, that event becomes an uncaught
// exception and kills the process. Every `try/catch` and `.catch()` in this CLI is
// therefore structurally blind to it, which is how a purely cosmetic
// `process.stdout.write` in `maybePrintDeepLink` produced a FATAL in Sentry
// (MEETLESS-CLI-2, 2026-08-02).
//
// The blast radius is not that one printer. The CLI runs as a hook under Claude Code and
// Codex (pretool-entry, codex-hook, evidence-hooks, capture-decisions, pretool-observe),
// where stdout is a pipe owned by a parent that may exit first. pretool-entry's contract
// is to FAIL OPEN so an entrypoint fault can never escalate into a blocking tool
// decision; a closed pipe currently defeats that contract from underneath it.
//
// Scope is deliberately narrow. EPIPE and ERR_STREAM_DESTROYED (the same close, reported
// under a different code once the stream is already torn down) are swallowed because
// there is by definition nobody left to read the output. Everything else is RE-THROWN:
// a guard that ate ENOSPC would turn this from a crash fix into a way to lose real IO
// failures silently.

type ErrorEmitter = {
  on(event: "error", listener: (err: NodeJS.ErrnoException) => void): unknown;
};

const CLOSED_PIPE_CODES = new Set(["EPIPE", "ERR_STREAM_DESTROYED"]);

// Module-scoped, so a process that reaches the guard twice (cli.ts bootstrapping a
// command that itself calls into an entry helper) does not stack listeners and trip
// Node's MaxListenersExceededWarning on the very stream it is trying to keep quiet.
const guarded = new WeakSet<object>();

function guard(stream: ErrorEmitter | undefined): void {
  if (!stream || guarded.has(stream as object)) return;
  guarded.add(stream as object);
  stream.on("error", (err) => {
    if (CLOSED_PIPE_CODES.has(err?.code ?? "")) return;
    throw err;
  });
}

/**
 * Attach the closed-pipe guard to stdout and stderr. Idempotent, so it is safe to call
 * from every entrypoint. Call it FIRST, before anything can write.
 */
export function installStdioEpipeGuard(
  streams: { stdout?: ErrorEmitter; stderr?: ErrorEmitter } = {
    stdout: process.stdout,
    stderr: process.stderr,
  },
): void {
  guard(streams.stdout);
  guard(streams.stderr);
}
