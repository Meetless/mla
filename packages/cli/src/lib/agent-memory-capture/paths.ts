// src/lib/agent-memory-capture/paths.ts
//
// All capture-local state lives under the mla HOME (~/.meetless by default),
// in its OWN files, deliberately NOT folded into cli-config.json. cli-config is
// a carefully-guarded credential surface; capture bindings are non-credential
// local state and get their own file, matching how SESSION_GATE_DIR / QUEUE_DIR
// are kept separate from the config.
import { join } from "node:path";

import { HOME } from "../config";

// The binding registry: { version, bindings: MemoryBinding[] }.
export function bindingsPath(home: string = HOME): string {
  return join(home, "agent-memory-bindings.json");
}

// Per-binding thin dry-run ledger: <home>/agent-memory/ledger/<bindingId>.json.
export function ledgerPath(bindingId: string, home: string = HOME): string {
  return join(home, "agent-memory", "ledger", `${bindingId}.json`);
}

// Per-binding advisory lockfile (PID-liveness; self-releases on process death).
export function lockPath(bindingId: string, home: string = HOME): string {
  return join(home, "agent-memory", "locks", `${bindingId}.lock`);
}

// Append-only, metadata-only decision log for the dry-run collector. One JSONL
// per binding so volume analysis is per-source. NEVER contains raw content.
export function decisionLogPath(bindingId: string, home: string = HOME): string {
  return join(home, "agent-memory", "decisions", `${bindingId}.jsonl`);
}

// Per-binding LIVE ledger (Phase 2A+): <home>/agent-memory/live-ledger/<bindingId>.json.
// Kept separate from the dry-run ledger so the two state shapes can never collide
// on the same binding (§4) and a binding's live progress is never clobbered by an
// earlier dry-run pass (or vice versa).
export function liveLedgerPath(bindingId: string, home: string = HOME): string {
  return join(home, "agent-memory", "live-ledger", `${bindingId}.json`);
}

// Append-only, metadata-only outcome log for the LIVE collector. NEVER contains
// raw content; carries hashes, byte counts, matched credential rule ids, and the
// server revision ids of acked uploads.
export function liveDecisionLogPath(bindingId: string, home: string = HOME): string {
  return join(home, "agent-memory", "live-decisions", `${bindingId}.jsonl`);
}
