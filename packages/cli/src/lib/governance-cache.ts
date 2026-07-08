// A-0c (A4 surface 2): the pending-count hand-off the `mla kb pending` command
// writes for the user-prompt-submit hook to read.
//
// The hook nudges the coding agent when relationship candidates are pending review,
// but Patch 8 forbids it from adding a synchronous hot-path network call to learn
// the count. So the count travels OUT OF BAND: `mla kb pending` already fetched the
// queue (it knows the count for free), and drops it in a tiny local cache here; the
// hook reads that cache with zero network. The tradeoff is proactivity: the cache
// only refreshes when someone runs `mla kb pending`, which is accepted for v1.
//
// This path + shape MUST stay byte-identical to the bash reader (common.sh
// governance_count_file): $MEETLESS_HOME/logs/governance/pending-count-<ws>.json,
// workspace id sanitized with the SAME rule as `tr -c 'A-Za-z0-9_.-' '_'`, body
// {count, ts} with ts in epoch SECONDS (bash compares against `date +%s`). The
// governance-cache.spec pins this contract.

import * as fs from "fs";
import * as path from "path";

import { HOME } from "./config";

// Mirror of bash `tr -c 'A-Za-z0-9_.-' '_'`: every char OUTSIDE the allowed set
// becomes a single '_' (one-for-one, no collapsing), so the writer and reader
// always resolve the identical filename for a given workspace id.
function sanitizeWorkspaceId(workspaceId: string): string {
  return workspaceId.replace(/[^A-Za-z0-9_.-]/g, "_");
}

export function pendingCountCachePath(workspaceId: string, home: string = HOME): string {
  return path.join(home, "logs", "governance", `pending-count-${sanitizeWorkspaceId(workspaceId)}.json`);
}

// Best-effort: a failure to write the cache must never break the `mla kb pending`
// command itself (the human still got their listing). The worst case is the hook
// keeps reading the previous count until the next successful write.
export function writePendingCountCache(workspaceId: string, count: number, home: string = HOME): void {
  try {
    const file = pendingCountCachePath(workspaceId, home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ count, ts: Math.floor(Date.now() / 1000) }));
  } catch {
    /* non-fatal: the listing already succeeded; the nudge just reads a staler count */
  }
}
