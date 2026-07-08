// Reaping guard for the long-lived `mla mcp` process tree (notes/20260622-mla-
// mcp-process-leak-findings-and-fix.md, Tier 1). Shared by BOTH levels:
//   - the worker (runMcp), which blocks on stdin EOF, and
//   - the supervisor (runMcpSupervisor), which blocks on `await spawnChild`.
//
// The worker's MCP server blocks on stdin EOF (server.onclose in @meetless/mcp's
// runStdioServer) as its ONLY exit path. So if the client dies WITHOUT closing
// the stdin pipe (force-quit, crash, or a SIGTERM aimed at a parent in the
// spawn chain that does not cascade), the worker is orphaned, reparented to
// launchd (pid 1), and blocks on a stdin whose EOF will never arrive. The
// supervisor has the mirror-image problem: if ITS parent dies but the worker
// underneath it stays alive (so the worker's ppid is the still-running
// supervisor, NOT 1, and the worker's own watchdog never fires), the supervisor
// sits forever in `await spawnChild`. That orphaned-supervisor case was in fact
// the MAJORITY of the measured leak (148 supervisors vs 61 workers), so the
// watchdog has to live at every level, not just the leaf.
//
// Two backstops:
//   1. SIGTERM/SIGINT/SIGHUP handlers: a direct signal tears the process down
//      cleanly instead of being ignored while it waits. They run onTerminate
//      first (the supervisor uses this to SIGTERM its in-flight worker so the
//      whole tree collapses) and exit with signalExitCode.
//   2. A parent-death watchdog: poll process.ppid; once it is 1 the original
//      parent (client or supervisor) is gone, so run onTerminate and exit 0.
//      macOS and Linux reparent orphans to pid 1, which makes this a reliable
//      orphan signal. The timer is unref'd so it never, by itself, keeps the
//      process alive (a unref'd timer does not hold the event loop open, so the
//      clean disconnect/await path still ends the process exactly on time).
//
// Everything is injectable so the guard's behaviour is unit-tested without
// registering real process listeners or wall-clock timers in the jest runner.

export const ORPHAN_POLL_MS = 5000;

// The signals a terminal/editor or an OS shutdown sends to ask a process to
// stop. Without these handlers Node's defaults still terminate on SIGTERM/SIGINT
// in many cases, but an installed handler guarantees a clean, deterministic
// teardown (run onTerminate, then exit with our chosen code) and covers SIGHUP,
// which a closing terminal session delivers.
const GUARD_SIGNALS: NodeJS.Signals[] = ["SIGTERM", "SIGINT", "SIGHUP"];

export interface OrphanGuardDeps {
  // Registers a process signal handler. Default: process.on.
  on?: (signal: NodeJS.Signals, handler: () => void) => void;
  // Terminates the process. Default: process.exit.
  exit?: (code: number) => void;
  // Returns the current parent pid. Default: () => process.ppid.
  getPpid?: () => number;
  // Schedules the watchdog poll, returning a handle with unref(). Default:
  // setInterval (whose handle's .unref() detaches it from the event loop).
  setIntervalFn?: (fn: () => void, ms: number) => { unref: () => void };
  // Poll cadence; bounds an orphan's lifetime. Default ORPHAN_POLL_MS (5s).
  pollMs?: number;
  // Ran just before this process exits, on BOTH the signal and watchdog paths.
  // The worker leaves it a no-op (it owns no children); the supervisor passes a
  // killer for its current worker so reaping cascades down the tree. Default:
  // no-op.
  onTerminate?: () => void;
  // Exit code for the SIGNAL path. The worker exits 0 (matching its own
  // clean-disconnect code); the supervisor exits 143 (the conventional
  // "terminated by SIGTERM" code). The watchdog/orphan path always exits 0 (a
  // gone parent is a clean shutdown, not a failure), regardless of this value.
  // Default: 0.
  signalExitCode?: number;
}

// Install a level's death backstops. Call once, right before the long-lived
// wait (the worker's serve loop, or the supervisor's spawn loop). Idempotency is
// the caller's concern: in production each is invoked once per process, and the
// unit tests inject a no-op.
export function installOrphanGuard(deps: OrphanGuardDeps = {}): void {
  const on = deps.on ?? ((signal, handler) => void process.on(signal, handler));
  const exit = deps.exit ?? ((code) => process.exit(code));
  const getPpid = deps.getPpid ?? (() => process.ppid);
  const setIntervalFn =
    deps.setIntervalFn ?? ((fn, ms) => setInterval(fn, ms));
  const pollMs = deps.pollMs ?? ORPHAN_POLL_MS;
  const onTerminate = deps.onTerminate ?? (() => {});
  const signalExitCode = deps.signalExitCode ?? 0;

  for (const signal of GUARD_SIGNALS) {
    on(signal, () => {
      onTerminate();
      exit(signalExitCode);
    });
  }

  const timer = setIntervalFn(() => {
    if (getPpid() === 1) {
      onTerminate();
      exit(0);
    }
  }, pollMs);
  // Never let the watchdog itself hold the process open; the server's stdin
  // pipe / the spawn await is the thing that should keep it alive, not this poll.
  timer.unref();
}
