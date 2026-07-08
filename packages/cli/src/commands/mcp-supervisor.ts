import { spawn } from "child_process";
import { MCP_RESTART_EXIT_CODE } from "../lib/mcp-restart";
import { installOrphanGuard } from "../lib/orphan-guard";

// The supervising parent for `mla mcp` (see lib/mcp-restart.ts for the why).
// This process is intentionally dumb: it holds the client's stdio pipe open and
// keeps a single `mla mcp --child` worker alive under it. The worker serves the
// MCP protocol; when it detects a newer build on disk and goes idle it exits
// with MCP_RESTART_EXIT_CODE, and we respawn it on the fresh dist. Because the
// parent never closes fd 0/1, the MCP client never sees a disconnect across a
// reload. Every other worker exit (0 clean disconnect via stdin EOF, 1/2 error)
// is final and we propagate it.

// Storm cap: tolerate this many reloads inside the window before giving up, so a
// pathological loop (e.g. a build-info `builtAt` that is perpetually "newer" due
// to clock skew) degrades to the old manual-restart behaviour instead of
// respawning without bound. Legitimate dev rebuilds are far rarer than this.
export const MCP_RESTART_MAX = 5;
export const MCP_RESTART_WINDOW_MS = 60_000;

export interface RunMcpSupervisorDeps {
  // Spawns `mla mcp --child <argv>` sharing this process's stdio, resolving with
  // the worker's exit code. `onChild` (when provided) is handed a killer for the
  // freshly spawned worker so the supervisor can take it down on its own death.
  // Injected in tests; the default spawns the real CLI.
  spawnChild?: (
    childArgv: string[],
    onChild?: (kill: () => void) => void,
  ) => Promise<number>;
  errorLog?: (msg: string) => void;
  // Monotonic clock for the storm window; injected so tests are wall-clock-free.
  now?: () => number;
  // Wires process teardown so a signalled / exiting supervisor reaps its current
  // worker instead of orphaning it to pid 1. Passed a stable `killCurrent` that
  // kills whichever worker is live at the moment it fires. Injected as a no-op in
  // tests so the suite registers no real process listeners; the default wires
  // SIGTERM/SIGINT/SIGHUP (kill + exit 143) and 'exit' (kill only).
  installTeardown?: (killCurrent: () => void) => void;
  env?: NodeJS.ProcessEnv;
}

// Re-spawn the SAME mla binary as `mla mcp --child`, inheriting our stdio so the
// worker reads/writes the exact pipe the client connected to us on. process.exit
// in the worker (the reload signal) closes only the worker's dup'd fds; ours stay
// open, so the client's connection survives the swap. `onChild` is handed a
// killer so the supervisor can SIGTERM this worker if the supervisor itself is
// told to stop (otherwise a TERM to the supervisor would orphan the worker).
function defaultSpawnChild(
  childArgv: string[],
  onChild?: (kill: () => void) => void,
): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [process.argv[1], "mcp", "--child", ...childArgv],
      { stdio: "inherit", env: process.env },
    );
    onChild?.(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        // already gone; nothing to reap.
      }
    });
    child.on("exit", (code, signal) =>
      resolve(typeof code === "number" ? code : signal ? 1 : 0),
    );
    child.on("error", () => resolve(1));
  });
}

// Wire the supervisor's own teardown to the current worker by delegating to the
// SAME guard the worker uses (lib/orphan-guard.ts), so the supervisor gets both
// backstops, not just signal handling:
//   - SIGTERM/SIGINT/SIGHUP: kill the worker first (onTerminate), then exit 143
//     (the standard "terminated by SIGTERM" code) so the chain collapses cleanly
//     instead of leaving the worker blocked on a stdin whose EOF never comes.
//   - parent-death watchdog: if the supervisor is orphaned (ppid -> 1) while its
//     worker is still alive beneath it, the worker's ppid is the still-running
//     supervisor (NOT 1), so the worker's own watchdog never fires. The
//     supervisor's does: it kills the worker (onTerminate) and exits 0. That
//     orphaned-supervisor case was the MAJORITY of the measured leak (148 vs 61
//     workers), so the watchdog has to live here too, not just at the leaf.
// The 'exit' listener is a belt-and-suspenders reap for any OTHER exit path (the
// guard wires only signals + the watchdog); kill is synchronous, so it is safe
// to call from inside an 'exit' handler.
function defaultInstallTeardown(killCurrent: () => void): void {
  installOrphanGuard({ onTerminate: killCurrent, signalExitCode: 143 });
  process.on("exit", () => killCurrent());
}

export async function runMcpSupervisor(
  argv: string[],
  deps: RunMcpSupervisorDeps = {},
): Promise<number> {
  const spawnChild = deps.spawnChild ?? defaultSpawnChild;
  const errorLog = deps.errorLog ?? ((m: string) => console.error(m));
  const now = deps.now ?? Date.now;
  const installTeardown = deps.installTeardown ?? defaultInstallTeardown;

  // The killer for whichever worker is live right now. Reset to a no-op the
  // instant a worker exits, so a signal that races the worker's death (or the
  // gap between reload-respawns) never double-kills or targets a dead pid. The
  // teardown handlers below close over this slot, not over any one worker.
  let killCurrentChild: () => void = () => {};
  installTeardown(() => killCurrentChild());

  const restarts: number[] = [];
  for (;;) {
    const code = await spawnChild(argv, (kill) => {
      killCurrentChild = kill;
    });
    killCurrentChild = () => {};
    if (code !== MCP_RESTART_EXIT_CODE) return code;

    const t = now();
    restarts.push(t);
    const recent = restarts.filter((ts) => t - ts < MCP_RESTART_WINDOW_MS);
    if (recent.length > MCP_RESTART_MAX) {
      errorLog(
        `Meetless MCP: ${recent.length} reloads within ` +
          `${Math.round(MCP_RESTART_WINDOW_MS / 1000)}s; giving up to avoid a ` +
          `restart storm. Restart your editor to recover.`,
      );
      return code;
    }
    errorLog(
      "Meetless MCP: a newer build is on disk; reloading the server " +
        "(no editor restart needed).",
    );
  }
}
