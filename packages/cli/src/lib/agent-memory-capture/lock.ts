// src/lib/agent-memory-capture/lock.ts
//
// Per-bindingId mutual exclusion (CONCURRENCY-1): overlapping Stops must not
// double-process or corrupt the ledger, and a holder that dies must release
// automatically.
//
// The proposal asks for an OS advisory flock "so it self-releases on death (not
// a PID file)." Node ships no portable flock(2) (and macOS, the dogfood
// platform, has no `flock` binary either), so this implements the SAME
// invariant a different way: an exclusive-create lockfile whose holder is
// liveness-checked. A stale lockfile from a dead PID is immediately stealable
// (`process.kill(pid, 0)` throws ESRCH), which gives the "self-releases on
// death" property the design requires. Acquisition is non-blocking: a live
// holder means another collector is running, so we skip this pass and let the
// next Stop rescan.
import { mkdirSync, openSync, readFileSync, rmSync, writeSync, closeSync } from "node:fs";
import { dirname } from "node:path";

import { HOME } from "../config";
import { lockPath } from "./paths";

export interface LockHandle {
  release(): void;
}

function pidIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    // Signal 0 performs error checking without sending a signal: throws ESRCH
    // when no such process exists, EPERM when it exists but we can't signal it
    // (still alive). Either non-throw or EPERM means alive.
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readHolderPid(path: string): number | null {
  try {
    const first = readFileSync(path, "utf8").split("\n")[0]?.trim();
    const pid = Number(first);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function tryCreate(path: string, nowIso: string): LockHandle | null {
  let fd: number;
  try {
    fd = openSync(path, "wx"); // exclusive create; EEXIST if held
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return null;
    throw e;
  }
  try {
    writeSync(fd, `${process.pid}\n${nowIso}\n`);
  } finally {
    closeSync(fd);
  }
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      try {
        rmSync(path);
      } catch {
        // Already gone (stolen as stale, or never existed): nothing to do.
      }
    },
  };
}

// Acquire the per-binding lock without blocking. Returns null when a LIVE holder
// already owns it. A stale lockfile (dead holder) is stolen exactly once and the
// acquisition retried.
export function acquireBindingLock(
  bindingId: string,
  nowIso: string,
  home: string = HOME,
): LockHandle | null {
  const path = lockPath(bindingId, home);
  mkdirSync(dirname(path), { recursive: true });

  const first = tryCreate(path, nowIso);
  if (first) return first;

  // Held: only steal if the recorded holder is dead.
  const holder = readHolderPid(path);
  if (holder !== null && pidIsAlive(holder)) return null;

  try {
    rmSync(path);
  } catch {
    // Someone else just cleared/replaced it; fall through to one retry.
  }
  return tryCreate(path, nowIso);
}
