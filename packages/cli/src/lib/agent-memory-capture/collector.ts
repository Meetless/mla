// src/lib/agent-memory-capture/collector.ts
//
// Orchestrates one dry-run collection pass across all enabled bindings: take the
// per-binding lock (skip if a live collector holds it), run the exact-byte
// pipeline, append only the ACTIONABLE decisions to a metadata-only JSONL, and
// release the lock. Uploads nothing (Phase 1).
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { HOME } from "../config";
import { acquireBindingLock } from "./lock";
import { listEnabledBindings } from "./binding";
import { collectOnce, isActionable, type CollectDeps } from "./pipeline";
import { decisionLogPath } from "./paths";
import type { DecisionRecord, MemoryBinding, ScanSummary } from "./types";

// Append the actionable decisions for one binding to its JSONL. Metadata only:
// each line is {sourceId, relativePath, hash, bytes, decision, reason,
// secretRuleIds, observedAt}. NEVER raw content. Unchanged/skipped no-ops are
// dropped so the log does not grow without bound.
export function appendDecisions(
  bindingId: string,
  records: DecisionRecord[],
  home: string = HOME,
): number {
  const actionable = records.filter((r) => isActionable(r.decision));
  if (actionable.length === 0) return 0;
  const dest = decisionLogPath(bindingId, home);
  mkdirSync(dirname(dest), { recursive: true });
  const lines = actionable.map((r) => JSON.stringify(r)).join("\n") + "\n";
  appendFileSync(dest, lines, { mode: 0o600 });
  return actionable.length;
}

export interface BindingPassResult {
  bindingId: string;
  // null when skipped because another live collector held the lock.
  summary: ScanSummary | null;
  locked: boolean;
  appended: number;
}

function runForBinding(binding: MemoryBinding, deps: CollectDeps): BindingPassResult {
  const home = deps.home ?? HOME;
  const lock = acquireBindingLock(binding.bindingId, deps.nowIso, home);
  if (!lock) {
    return { bindingId: binding.bindingId, summary: null, locked: false, appended: 0 };
  }
  try {
    const summary = collectOnce(binding, deps);
    const appended = appendDecisions(binding.bindingId, summary.records, home);
    return { bindingId: binding.bindingId, summary, locked: true, appended };
  } finally {
    lock.release();
  }
}

export interface CollectorRunOptions {
  nowIso: string;
  home?: string;
  scan?: CollectDeps["scan"];
  scannerVersion?: string;
  // Defaults to "observe" via collectOnce: the dry-run records secret signals
  // but never blocks, because it uploads nothing.
  scannerMode?: CollectDeps["scannerMode"];
}

// Run a dry-run pass over every enabled binding. Fail-soft per binding: one
// binding's error never aborts the others.
export function runDryRunCollector(opts: CollectorRunOptions): BindingPassResult[] {
  const home = opts.home ?? HOME;
  const bindings = listEnabledBindings(home);
  const deps: CollectDeps = {
    nowIso: opts.nowIso,
    home,
    ...(opts.scan ? { scan: opts.scan } : {}),
    ...(opts.scannerVersion ? { scannerVersion: opts.scannerVersion } : {}),
    ...(opts.scannerMode ? { scannerMode: opts.scannerMode } : {}),
  };
  const out: BindingPassResult[] = [];
  for (const b of bindings) {
    try {
      out.push(runForBinding(b, deps));
    } catch {
      out.push({ bindingId: b.bindingId, summary: null, locked: false, appended: 0 });
    }
  }
  return out;
}
