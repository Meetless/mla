// Active-run guard (verdict item 3): one onboarding run per workspace at a time.
//
// `enrich plan` is the expensive bookend (it scans the repo, prepares git evidence, and the
// skill then dispatches scouts). Two concurrent runs in the same workspace would race on the
// shared run-record dir and double the scout fan-out, so a second `plan` must be rejected
// while one is live. The lock is a single file per workspace,
// `~/.meetless/workspaces/<workspaceId>/onboarding-active.json`, claimed with an atomic
// exclusive create ("wx"): the filesystem, not a read-then-write, decides the winner.
//
// A crashed run must never block forever, so the lock self-expires: it records `createdAt`
// and a derived `expiresAt` (createdAt + budget + grace). Staleness is judged purely by the
// timestamp, never by run-ID ordering (run IDs are random UUIDs, not monotonic). A second
// invocation that finds a stale lock reclaims it exactly once (unlink, then retry the
// exclusive create); if a real concurrent acquirer wins that race, we still reject. An
// unreadable lock fails CLOSED: we refuse rather than risk clobbering a live run.

import { mkdirSync, writeFileSync, readFileSync, unlinkSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";

export const ONBOARDING_LOCK_SCHEMA_VERSION = 1 as const;

// Grace beyond the run's soft budget before the lock is presumed dead and reclaimable. The
// agentic middle is a SOFT budget (no hard cancel), and ingest runs after the scouts finish,
// so the lock must outlive the budget by enough to cover a legitimately slow run. Five
// minutes on a four-minute budget gives a live run room while still freeing a crashed one.
export const ONBOARDING_LOCK_GRACE_MS = 5 * 60_000;

export interface OnboardingLock {
  schemaVersion: typeof ONBOARDING_LOCK_SCHEMA_VERSION;
  runId: string;
  workspaceId: string;
  repositoryRoot: string;
  createdAt: string; // ISO 8601; the authoritative timestamp (staleness is judged from this)
  expiresAt: string; // ISO 8601; createdAt + ttl, surfaced so a reject can say when it frees
}

export function onboardingLockPath(home: string, workspaceId: string): string {
  return join(home, "workspaces", workspaceId, "onboarding-active.json");
}

export type AcquireResult =
  // Acquired (newly created, or reclaimed from a provably stale prior lock).
  | { ok: true; lock: OnboardingLock }
  // Rejected. `held` is the live lock when readable, or null when the existing lock is
  // unreadable (fail-closed: we refuse without being able to attribute the holder).
  | { ok: false; held: OnboardingLock | null };

// True once the lock's expiry is in the past, i.e. the holding run has outlived its budget +
// grace and is presumed dead. A malformed expiry is treated as stale (reclaimable) rather
// than as an eternal lock. Comparison is timestamp-based, never run-ID-based.
export function isLockStale(lock: Pick<OnboardingLock, "expiresAt">, now: string): boolean {
  const expiry = Date.parse(lock.expiresAt);
  if (Number.isNaN(expiry)) return true;
  return Date.parse(now) > expiry;
}

export function acquireOnboardingLock(input: {
  home: string;
  workspaceId: string;
  runId: string;
  repositoryRoot: string;
  now: string; // ISO 8601
  ttlMs: number; // lock lifetime; a dead run frees the lock once now passes createdAt + ttl
}): AcquireResult {
  const path = onboardingLockPath(input.home, input.workspaceId);
  mkdirSync(dirname(path), { recursive: true });

  const createdAtMs = Date.parse(input.now);
  const lock: OnboardingLock = {
    schemaVersion: ONBOARDING_LOCK_SCHEMA_VERSION,
    runId: input.runId,
    workspaceId: input.workspaceId,
    repositoryRoot: input.repositoryRoot,
    createdAt: input.now,
    expiresAt: new Date(createdAtMs + Math.max(0, input.ttlMs)).toISOString(),
  };
  const body = JSON.stringify(lock, null, 2);

  // Atomic exclusive create: succeeds only if no lock file exists. The kernel arbitrates the
  // race; we never read-then-write. Returns true on claim, false on EEXIST, throws otherwise.
  const tryCreate = (): boolean => {
    try {
      writeFileSync(path, body, { flag: "wx" });
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw e;
    }
  };

  if (tryCreate()) return { ok: true, lock };

  // A lock already exists. Read it; only reclaim it if it is provably stale.
  let held: OnboardingLock | null;
  try {
    held = JSON.parse(readFileSync(path, "utf8")) as OnboardingLock;
  } catch {
    return { ok: false, held: null }; // unreadable/corrupt: fail closed
  }

  if (!isLockStale(held, input.now)) return { ok: false, held };

  // Stale: reclaim exactly once. Unlink, then retry the exclusive create. If a concurrent
  // acquirer slipped a fresh lock in between, the retry fails and we reject (no clobber).
  try {
    unlinkSync(path);
  } catch {
    // already removed by someone else; fall through to the retry
  }
  if (tryCreate()) return { ok: true, lock };

  let raced: OnboardingLock | null = null;
  try {
    raced = JSON.parse(readFileSync(path, "utf8")) as OnboardingLock;
  } catch {
    raced = null;
  }
  return { ok: false, held: raced };
}

// Release the lock only if it still belongs to this run. Never free another run's lock: a
// second run that reclaimed a stale lock owns it now, and ingest of an abandoned run must not
// unlock a live one. Best-effort and idempotent (a missing/foreign lock is a no-op).
export function releaseOnboardingLock(home: string, workspaceId: string, runId: string): void {
  const path = onboardingLockPath(home, workspaceId);
  if (!existsSync(path)) return;
  try {
    const lock = JSON.parse(readFileSync(path, "utf8")) as OnboardingLock;
    if (lock.runId !== runId) return; // not ours
  } catch {
    return; // unreadable: leave it for stale-reclaim, do not guess
  }
  try {
    unlinkSync(path);
  } catch {
    // best-effort: a leftover lock self-expires via its ttl
  }
}
