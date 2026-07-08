// src/lib/agent-memory-capture/ledger.ts
//
// The thin per-binding dry-run ledger (§4). It stores only what the COLLECTOR
// needs to avoid re-emitting events for unchanged content; it deliberately does
// NOT mirror server processing/extraction state (two state machines would
// diverge). Keyed by a file's path relative to memoryDir.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { HOME } from "../config";
import { ledgerPath } from "./paths";
import type { Ledger } from "./types";

function emptyLedger(): Ledger {
  return { version: 1, entries: {} };
}

export function readLedger(bindingId: string, home: string = HOME): Ledger {
  let raw: string;
  try {
    raw = readFileSync(ledgerPath(bindingId, home), "utf8");
  } catch {
    return emptyLedger();
  }
  try {
    const parsed = JSON.parse(raw) as Partial<Ledger>;
    if (!parsed || typeof parsed.entries !== "object" || parsed.entries === null) {
      return emptyLedger();
    }
    return { version: 1, entries: parsed.entries as Ledger["entries"] };
  } catch {
    return emptyLedger();
  }
}

export function writeLedger(bindingId: string, ledger: Ledger, home: string = HOME): void {
  const dest = ledgerPath(bindingId, home);
  mkdirSync(dirname(dest), { recursive: true });
  const tmp = `${dest}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(ledger, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, dest);
}
