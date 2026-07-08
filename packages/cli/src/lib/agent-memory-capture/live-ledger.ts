// src/lib/agent-memory-capture/live-ledger.ts
//
// The per-binding LIVE ledger (§4 "Live"). Unlike the dry-run ledger, this one
// tracks what the SERVER acknowledged, not what we observed: `lastUploadedHash`
// advances ONLY on a hash-matched ack (COMMIT-1), so a failed or unverified
// upload leaves the entry "unsettled" and the next pass re-attempts (RETRY-2).
// Kept in its own file (liveLedgerPath) so it can never collide with the dry-run
// ledger on the same binding. Keyed by a file's path relative to memoryDir.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { HOME } from "../config";
import { liveLedgerPath } from "./paths";
import type { LiveLedger } from "./types";

function emptyLiveLedger(): LiveLedger {
  return { version: 1, entries: {} };
}

export function readLiveLedger(bindingId: string, home: string = HOME): LiveLedger {
  let raw: string;
  try {
    raw = readFileSync(liveLedgerPath(bindingId, home), "utf8");
  } catch {
    return emptyLiveLedger();
  }
  try {
    const parsed = JSON.parse(raw) as Partial<LiveLedger>;
    if (!parsed || typeof parsed.entries !== "object" || parsed.entries === null) {
      return emptyLiveLedger();
    }
    return { version: 1, entries: parsed.entries as LiveLedger["entries"] };
  } catch {
    return emptyLiveLedger();
  }
}

export function writeLiveLedger(
  bindingId: string,
  ledger: LiveLedger,
  home: string = HOME,
): void {
  const dest = liveLedgerPath(bindingId, home);
  mkdirSync(dirname(dest), { recursive: true });
  const tmp = `${dest}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(ledger, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, dest);
}
