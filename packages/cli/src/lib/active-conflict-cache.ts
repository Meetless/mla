// Active cross-session conflict snapshot: the zero-network hand-off between the
// CLI turn-boundary sync (`_internal steer-sync`, which fetches the session's
// currently-open conflicts from control on the SAME pass that pulls steers) and
// the PreToolUse hook (which surfaces a SOFT warning when one is open).
//
// G8 / D1, notes/20260626-g8-cross-session-conflict-redesign.md §11.3 (CRITICAL-5).
// The snapshot is the COMPLETE current open-conflict set, overwritten each turn
// (never appended), so a resolved conflict simply disappears on the next sync and
// the warning stops automatically. The hook reads it synchronously with NO network
// call (same hot-path constraint as the steer cache and the governance nudge).
//
// Two deliberate properties:
//   - The signal source is the refreshed complete snapshot, NEVER steer-injection
//     state. A steer can be injected once and then the conflict resolves; injection
//     state is not conflict state (§11.3 / §11.4).
//   - A snapshot that fails to refresh (sync down) FAILS OPEN: a reader past the TTL
//     treats it as absent (no warning) rather than a stuck warning. The warning is
//     soft, so the safe direction on staleness is to say nothing.
//
// The file lives beside the steer cache under $MEETLESS_HOME/logs/steer/ because the
// same turn-boundary pass writes both; the session id is opaque
// (CLAUDE_CODE_SESSION_ID), used verbatim like the steer cache.

import * as fs from "fs";
import * as path from "path";

import { HOME } from "./config";

/**
 * One open cross-session conflict for a session, mirrored from control's
 * `GET /internal/v1/session-conflicts/by-session/:sid/active`. `openedAt` is the
 * case-open instant (ISO); `reason` is a short human string the warning surfaces.
 */
export interface ActiveConflict {
  caseId: string;
  openedAt: string;
  reason: string;
}

// How long a snapshot stays trusted before a reader treats it as stale and fails
// open. The sync rewrites it every flush (Stop hook, once per turn), so a healthy
// session refreshes well inside this window; a window this wide only matters when
// the sync is genuinely down, at which point failing open is the intended safe
// outcome. Generous on purpose: a single long agent turn must not false-expire a
// real open conflict.
export const ACTIVE_CONFLICT_TTL_SECONDS = 30 * 60;

/** The soft/hard gate flag (§11.3). Soft surfaces a warning and permits the tool;
 * hard (a default-deny block) is DEFERRED per §0.1 and not built in this commit. */
export type ConflictGateMode = "soft" | "hard";

/** The shipped default. Soft only: a default-deny that fails closed on a stale
 * snapshot would brick coding sessions and burn trust (§0.1, the wedge's own
 * "soft gate before hard gate" non-negotiable). wire.ts re-exports this as the
 * system default so flipping to hard later is a single wired change, not a rewrite. */
export const DEFAULT_CONFLICT_GATE_MODE: ConflictGateMode = "soft";

/** Resolve the gate mode from the environment, defaulting to soft. An unknown
 * value degrades to soft (fail-safe): the only behavior that can ever block a tool
 * is the explicit, opted-in hard mode, which is not enabled now. */
export function resolveConflictGateMode(
  env: NodeJS.ProcessEnv = process.env,
): ConflictGateMode {
  return env.MEETLESS_D1_CONFLICT_GATE === "hard" ? "hard" : DEFAULT_CONFLICT_GATE_MODE;
}

export function activeConflictCachePath(sessionId: string, home: string = HOME): string {
  return path.join(home, "logs", "steer", `active-conflicts-${sessionId}.json`);
}

interface ActiveConflictCacheBody {
  conflicts?: unknown;
  ts?: unknown;
}

// Best-effort: a failed cache write must never break the steer-sync hop (itself
// best-effort inside flush.sh). Worst case the hook keeps reading the prior
// snapshot until it ages past the TTL and fails open.
export function writeActiveConflictCache(
  sessionId: string,
  conflicts: ActiveConflict[],
  home: string = HOME,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): void {
  try {
    const file = activeConflictCachePath(sessionId, home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ conflicts, ts: nowSeconds }));
  } catch {
    /* non-fatal */
  }
}

function coerceConflicts(raw: unknown): ActiveConflict[] {
  if (!Array.isArray(raw)) return [];
  const out: ActiveConflict[] = [];
  for (const item of raw) {
    if (
      item &&
      typeof item === "object" &&
      typeof (item as ActiveConflict).caseId === "string" &&
      typeof (item as ActiveConflict).openedAt === "string" &&
      typeof (item as ActiveConflict).reason === "string"
    ) {
      const c = item as ActiveConflict;
      out.push({ caseId: c.caseId, openedAt: c.openedAt, reason: c.reason });
    }
  }
  return out;
}

/**
 * Read the session's open-conflict snapshot for the PreToolUse warning. Returns []
 * on ANY of: missing file, parse failure, malformed body, or a snapshot older than
 * `ttlSeconds` (the fail-open staleness guard). [] means "no warning"; a non-empty
 * result means at least one currently-open conflict. The reader never throws and
 * never touches the network.
 */
export function readActiveConflicts(
  sessionId: string,
  opts: {
    home?: string;
    nowSeconds?: number;
    ttlSeconds?: number;
  } = {},
): ActiveConflict[] {
  const home = opts.home ?? HOME;
  const nowSeconds = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  const ttlSeconds = opts.ttlSeconds ?? ACTIVE_CONFLICT_TTL_SECONDS;
  try {
    const file = activeConflictCachePath(sessionId, home);
    const body = JSON.parse(fs.readFileSync(file, "utf8")) as ActiveConflictCacheBody;
    // Staleness guard: a snapshot whose ts is missing, non-numeric, or older than
    // the TTL is treated as absent so a sync-down session fails open.
    const ts = typeof body.ts === "number" ? body.ts : null;
    if (ts === null || nowSeconds - ts > ttlSeconds) {
      return [];
    }
    return coerceConflicts(body.conflicts);
  } catch {
    return [];
  }
}
