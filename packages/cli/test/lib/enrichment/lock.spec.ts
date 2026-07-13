import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  acquireOnboardingLock,
  releaseOnboardingLock,
  onboardingLockPath,
  isLockStale,
  ONBOARDING_LOCK_GRACE_MS,
  ONBOARDING_LOCK_SCHEMA_VERSION,
  type OnboardingLock,
} from "../../../src/lib/enrichment/lock";

const WS = "ws_lock";
const T0 = "2026-06-26T00:00:00.000Z";
const TTL = 240_000 + ONBOARDING_LOCK_GRACE_MS; // a 4-minute budget plus the standard grace

function plusMs(iso: string, ms: number): string {
  return new Date(Date.parse(iso) + ms).toISOString();
}

function readLock(home: string, ws: string): OnboardingLock {
  return JSON.parse(readFileSync(onboardingLockPath(home, ws), "utf8")) as OnboardingLock;
}

describe("onboardingLockPath", () => {
  it("is one file per workspace under workspaces/<id>/onboarding-active.json", () => {
    expect(onboardingLockPath("/home", "ws_x")).toBe(
      join("/home", "workspaces", "ws_x", "onboarding-active.json"),
    );
  });
});

describe("acquireOnboardingLock", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "mla-lock-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  const acquire = (over: Partial<Parameters<typeof acquireOnboardingLock>[0]> = {}) =>
    acquireOnboardingLock({
      home,
      workspaceId: WS,
      runId: "run-a",
      repositoryRoot: "/repo",
      now: T0,
      ttlMs: TTL,
      ...over,
    });

  it("claims a free lock and writes the record with a derived expiry", () => {
    const res = acquire();
    expect(res.ok).toBe(true);
    expect(existsSync(onboardingLockPath(home, WS))).toBe(true);
    const lock = readLock(home, WS);
    expect(lock).toEqual({
      schemaVersion: ONBOARDING_LOCK_SCHEMA_VERSION,
      runId: "run-a",
      workspaceId: WS,
      repositoryRoot: "/repo",
      createdAt: T0,
      expiresAt: plusMs(T0, TTL),
    });
  });

  it("creates the workspace directory if it does not exist", () => {
    expect(existsSync(dirname(onboardingLockPath(home, WS)))).toBe(false);
    expect(acquire().ok).toBe(true);
  });

  it("rejects a second invocation while a live lock is held", () => {
    expect(acquire({ runId: "run-a" }).ok).toBe(true);
    const second = acquire({ runId: "run-b", now: plusMs(T0, 1_000) });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.held?.runId).toBe("run-a");
      expect(second.held?.expiresAt).toBe(plusMs(T0, TTL));
    }
    // The original lock is untouched: the loser never overwrote the winner.
    expect(readLock(home, WS).runId).toBe("run-a");
  });

  it("reclaims a stale lock (past its expiry) for a new run", () => {
    expect(acquire({ runId: "run-a" }).ok).toBe(true);
    // One millisecond past the first lock's expiry: presumed dead.
    const later = plusMs(T0, TTL + 1);
    const res = acquire({ runId: "run-b", now: later });
    expect(res.ok).toBe(true);
    const lock = readLock(home, WS);
    expect(lock.runId).toBe("run-b");
    expect(lock.createdAt).toBe(later);
    expect(lock.expiresAt).toBe(plusMs(later, TTL));
  });

  it("does NOT reclaim a lock exactly at its expiry instant (strict past only)", () => {
    expect(acquire({ runId: "run-a" }).ok).toBe(true);
    const atExpiry = plusMs(T0, TTL); // now == expiresAt: not yet stale
    expect(acquire({ runId: "run-b", now: atExpiry }).ok).toBe(false);
    expect(readLock(home, WS).runId).toBe("run-a");
  });

  it("fails CLOSED when the existing lock is unreadable (does not clobber)", () => {
    const path = onboardingLockPath(home, WS);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{ not json", "utf8");
    const res = acquire({ runId: "run-b" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.held).toBeNull();
    // The corrupt file is left in place for an operator to inspect, not silently replaced.
    expect(readFileSync(path, "utf8")).toBe("{ not json");
  });

  it("treats a lock with a malformed expiry as stale and reclaims it", () => {
    const path = onboardingLockPath(home, WS);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({ schemaVersion: 1, runId: "run-old", workspaceId: WS, repositoryRoot: "/repo", createdAt: T0, expiresAt: "not-a-date" }),
      "utf8",
    );
    const res = acquire({ runId: "run-b", now: plusMs(T0, 1_000) });
    expect(res.ok).toBe(true);
    expect(readLock(home, WS).runId).toBe("run-b");
  });

  it("clamps a negative ttl to zero (expiry == createdAt, immediately reclaimable)", () => {
    const res = acquire({ ttlMs: -5_000 });
    expect(res.ok).toBe(true);
    expect(readLock(home, WS).expiresAt).toBe(T0);
  });

  // An ABANDONED run (agent crashed, human hit Ctrl-C mid-onboard) leaves a lock that is live
  // by the clock, so the timestamp rule cannot free it: without an override, `/mla onboard` is
  // blocked for the rest of budget + grace. `enrich plan --force` already means "onboard this
  // repository again"; it takes the lock too, and reports what it displaced.
  it("--force reclaims a LIVE lock and reports the run it displaced", () => {
    expect(acquire({ runId: "run-a" }).ok).toBe(true);
    const now = plusMs(T0, 1_000); // well inside run-a's ttl
    const res = acquire({ runId: "run-b", now, force: true });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.reclaimedLive?.runId).toBe("run-a"); // displaced a run that had NOT expired
      expect(res.lock.runId).toBe("run-b");
    }
    expect(readLock(home, WS).runId).toBe("run-b");
  });

  it("--force does not report reclaimedLive when the lock it took was already stale", () => {
    expect(acquire({ runId: "run-a" }).ok).toBe(true);
    const res = acquire({ runId: "run-b", now: plusMs(T0, TTL + 1), force: true });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.reclaimedLive).toBeUndefined(); // expiry freed it; force displaced nothing
  });

  it("--force reclaims an unreadable lock (the fail-closed branch is what force overrides)", () => {
    const path = onboardingLockPath(home, WS);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{ not json", "utf8");
    const res = acquire({ runId: "run-b", force: true });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.reclaimedLive).toBeUndefined(); // nothing attributable was displaced
    expect(readLock(home, WS).runId).toBe("run-b");
  });

  it("still claims a free lock under --force (no prior lock, nothing displaced)", () => {
    const res = acquire({ runId: "run-a", force: true });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.reclaimedLive).toBeUndefined();
    expect(readLock(home, WS).runId).toBe("run-a");
  });
});

describe("isLockStale", () => {
  it("is false before expiry, true strictly after", () => {
    expect(isLockStale({ expiresAt: plusMs(T0, 1) }, T0)).toBe(false);
    expect(isLockStale({ expiresAt: T0 }, T0)).toBe(false);
    expect(isLockStale({ expiresAt: T0 }, plusMs(T0, 1))).toBe(true);
  });

  it("treats a malformed expiry as stale", () => {
    expect(isLockStale({ expiresAt: "garbage" }, T0)).toBe(true);
  });
});

describe("releaseOnboardingLock", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "mla-lock-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  const acquire = (runId: string, now = T0) =>
    acquireOnboardingLock({ home, workspaceId: WS, runId, repositoryRoot: "/repo", now, ttlMs: TTL });

  it("frees a lock owned by the given run", () => {
    expect(acquire("run-a").ok).toBe(true);
    releaseOnboardingLock(home, WS, "run-a");
    expect(existsSync(onboardingLockPath(home, WS))).toBe(false);
  });

  it("never frees a lock owned by a different run", () => {
    // A successor reclaimed the lock; the abandoned run's ingest must not unlock it.
    expect(acquire("run-b").ok).toBe(true);
    releaseOnboardingLock(home, WS, "run-a");
    expect(existsSync(onboardingLockPath(home, WS))).toBe(true);
    expect(readLock(home, WS).runId).toBe("run-b");
  });

  it("is a no-op when no lock exists", () => {
    expect(() => releaseOnboardingLock(home, WS, "run-a")).not.toThrow();
    expect(existsSync(onboardingLockPath(home, WS))).toBe(false);
  });

  it("leaves an unreadable lock in place (lets stale-reclaim handle it)", () => {
    const path = onboardingLockPath(home, WS);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{ corrupt", "utf8");
    releaseOnboardingLock(home, WS, "run-a");
    expect(readFileSync(path, "utf8")).toBe("{ corrupt");
  });

  it("acquire after release lets a new run start cleanly", () => {
    expect(acquire("run-a").ok).toBe(true);
    releaseOnboardingLock(home, WS, "run-a");
    const res = acquire("run-b", plusMs(T0, 1_000));
    expect(res.ok).toBe(true);
    expect(readLock(home, WS).runId).toBe("run-b");
  });
});
