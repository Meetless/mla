import * as crypto from "crypto";
import * as fs from "fs";
import { HOME, readConfig } from "./config";

// Dead-auth circuit breaker (incident: a dead `mla login` self-DoSing control).
//
// THE PROBLEM. When a user-token session's refresh token is genuinely dead
// (expired ~30d idle, revoked, or rotated out from under a stale process), every
// hook-driven `mla` call (heartbeat, steer-sync, flush, _internal refresh) does
// the same dance: authenticated control call -> 401 -> refresh -> 401 -> surface
// "login expired". With the editor firing those hooks on every tool use across
// several long-lived `mla mcp` workers, that became a tight validate+refresh
// storm against control (measured ~6-8 req/sec on constant hashed keys), i.e. a
// self-inflicted DoS that no server-side rate limit can cure (the server can only
// cheapen each rejection, not stop the client from asking).
//
// THE CURE. The FIRST process to have its refresh token REJECTED writes a small
// sentinel here, keyed to a one-way fingerprint of that exact refresh token.
// Every later user-token control call consults it first (consultAuthBreaker) and
// fails fast WITHOUT touching control. The flood collapses from "forever" to a
// bounded burst (one validate+refresh per process until the shared sentinel lands,
// then silence).
//
// WHY FINGERPRINT-KEYED (self-healing). The sentinel records sha256(refreshToken)
// .slice(0,16), NOT a bare "auth is dead" flag. consult re-reads the ON-DISK
// config (not the caller's possibly-stale in-memory cfg) and only stays open while
// the on-disk refresh token still matches the fingerprint. The instant the token
// changes (an `mla login` writes a fresh pair) the fingerprint no longer matches,
// consult clears the sentinel and lets the call through. That is what lets a
// re-login heal the long-lived `mla mcp` workers LIVE: the worker bound its cfg
// object once at boot, but consult reads disk, sees the new token, and reopens the
// gate without a restart. Comparing the in-memory token instead would wedge the
// worker forever (it would never observe the re-login).
//
// WHY THIS LEAKS NOTHING. The fingerprint is a one-way sha256 slice; it cannot be
// reversed to a token, and the file lives right next to cli-config.json (which
// holds the actual tokens, mode 0600) anyway.

// Sibling of CFG_PATH (config.ts), so it shares the config's home and is wiped by
// the same `rm -rf ~/.meetless` an operator already uses to reset.
export const AUTH_BREAKER_PATH = `${HOME}/auth-dead.json`;

interface BreakerSentinel {
  // sha256(refreshToken).slice(0,16). The gate is open ONLY while the on-disk
  // refresh token still fingerprints to this value.
  refreshFingerprint: string;
  // ISO timestamp the breaker tripped (diagnostics only; not load-bearing).
  deadSince: string;
  // Why it tripped (diagnostics only).
  reason: string;
}

// One-way, non-reversible. Same construction as control's hashToken prefix and
// http.ts's rate-limit keys, so the value is recognizable in logs without
// exposing token material.
export function fingerprintToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex").slice(0, 16);
}

// Trip the breaker for a specific refresh token that control just REJECTED. Only
// http.ts's refreshUserToken calls this, and only on a true "unauthorized"
// (401/410) outcome, never on a transient/throttled one, so the gate can never
// close on a mere rate-limit burst. Best-effort: a write failure just means the
// next process re-attempts the dance and trips it then.
export function tripAuthBreaker(refreshToken: string, reason: string): void {
  const sentinel: BreakerSentinel = {
    refreshFingerprint: fingerprintToken(refreshToken),
    deadSince: new Date().toISOString(),
    reason,
  };
  try {
    // Write-then-rename so a concurrent reader never sees a torn file (5 workers
    // + N hooks share this path).
    const tmp = `${AUTH_BREAKER_PATH}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(sentinel) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, AUTH_BREAKER_PATH);
  } catch {
    // Best-effort sentinel; never let a breaker write break the caller.
  }
}

// Returns true iff the breaker is OPEN: a prior refresh was rejected AND the
// on-disk refresh token still matches that rejection's fingerprint. Fails OPEN
// (returns true) for nothing: every uncertain path fails CLOSED (returns false,
// let the call proceed) so a bug here can never wedge a healthy session. Clears a
// stale sentinel as a side effect when the on-disk credential has moved on.
export function consultAuthBreaker(): boolean {
  let raw: string;
  try {
    raw = fs.readFileSync(AUTH_BREAKER_PATH, "utf8");
  } catch {
    return false; // No sentinel (the common, healthy case) -> proceed.
  }

  let sentinel: BreakerSentinel;
  try {
    sentinel = JSON.parse(raw) as BreakerSentinel;
  } catch {
    return false; // Torn/garbage read (concurrent writer) -> proceed, don't block.
  }
  if (!sentinel || typeof sentinel.refreshFingerprint !== "string") {
    return false;
  }

  // Compare against the ON-DISK token, not the caller's in-memory cfg, so a
  // re-login that rotated the token on disk reopens the gate for live workers.
  let cfg;
  try {
    cfg = readConfig();
  } catch {
    return false; // Config unreadable -> fail open, never block on our own read.
  }
  if (cfg.auth.mode !== "user-token") {
    // Logged out / downgraded to shared-key: the dead user-token is irrelevant.
    clearAuthBreaker();
    return false;
  }

  if (fingerprintToken(cfg.auth.refreshToken) === sentinel.refreshFingerprint) {
    return true; // Same dead token still on disk -> gate stays shut.
  }

  // The on-disk token changed (a re-login happened): the sentinel is stale.
  clearAuthBreaker();
  return false;
}

// Clear the breaker. Called on a successful login/refresh and on the stale-token
// path above. Idempotent and best-effort.
export function clearAuthBreaker(): void {
  try {
    fs.unlinkSync(AUTH_BREAKER_PATH);
  } catch {
    // Already gone (never tripped, or another process cleared it first).
  }
}
