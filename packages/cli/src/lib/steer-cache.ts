// Cross-session steer transport: the zero-network hand-off between the CLI
// `_internal steer-sync` hop (which pulls steers from control) and the
// UserPromptSubmit hook (which injects them).
//
// steer-sync writes the deliverable set to steer-<sid>.json; the hook reads it
// with NO network call (same hot-path constraint as the governance nudge). The
// hook records which steer ids it injected in inject-<sid>.json; steer-sync reads
// THAT to mark them injected (PULLED -> INJECTED). Both files live under
// $MEETLESS_HOME/logs/steer/ and the paths + shapes MUST stay byte-identical to
// the bash helpers in common.sh (steer_cache_file / steer_inject_file). The
// session id is opaque (CLAUDE_CODE_SESSION_ID); like governance_inject_file it
// is used verbatim, no sanitization.

import * as fs from "fs";
import * as path from "path";

import { HOME } from "./config";

export interface CachedSteer {
  id: string;
  directive: string;
  caseId: string | null;
  createdAt: string;
}

export function steerCachePath(sessionId: string, home: string = HOME): string {
  return path.join(home, "logs", "steer", `steer-${sessionId}.json`);
}

export function steerInjectStatePath(sessionId: string, home: string = HOME): string {
  return path.join(home, "logs", "steer", `inject-${sessionId}.json`);
}

// Best-effort: a failed cache write must never break the steer-sync hop (which is
// itself best-effort inside flush.sh). Worst case the hook keeps reading the prior
// cache until the next successful write.
export function writeSteerCache(
  sessionId: string,
  steers: CachedSteer[],
  home: string = HOME,
): void {
  try {
    const file = steerCachePath(sessionId, home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ steers, ts: Math.floor(Date.now() / 1000) }));
  } catch {
    /* non-fatal */
  }
}

// Read the ids the hook recorded as injected. Returns [] on any absence/parse
// failure (the mark-injected loop then simply has nothing to flip this round).
export function readInjectedIds(sessionId: string, home: string = HOME): string[] {
  try {
    const file = steerInjectStatePath(sessionId, home);
    const body = JSON.parse(fs.readFileSync(file, "utf8")) as { injected?: unknown };
    if (!Array.isArray(body.injected)) return [];
    return body.injected.filter((x): x is string => typeof x === "string");
  } catch {
    return [];
  }
}
