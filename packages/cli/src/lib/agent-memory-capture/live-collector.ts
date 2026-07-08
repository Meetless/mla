// src/lib/agent-memory-capture/live-collector.ts
//
// Orchestrates one LIVE collection + upload pass across all enabled bindings
// (proposal §4 lifecycle + §6 Phase 2A). Mirrors the dry-run collector.ts shape
// exactly (per-binding lock, fail-soft per binding, append only the actionable
// outcomes to a metadata-only JSONL), but the per-file engine is
// collectAndUploadOnce, which ACTUALLY uploads/withdraws against intel.
//
// GATING: live capture is wired into the existing Stop auto-index worker (NOT a
// new hook) and runs by default. Two gates make a pass a no-op: there must be a
// resolvable actor identity (we never upload anonymously) and at least one
// consented binding (CONSENT-1). Consent is per-binding and is the operator
// control: `mla agent-memory enable` opts a directory in, `disable` opts it out.
// The per-file credential denylist (SECRET-1, below) is the third, byte-level
// gate that withholds any file carrying a known credential format.
//
// SECRET-1: the per-file engine runs the credential denylist fail-closed before
// any byte leaves the machine. This orchestrator adds a second guard, the
// no-backfill per-pass upload cap (§6), so the FIRST live pass cannot dump the
// whole backlog at once; the cap drains over successive passes.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { HOME, readConfig, type CliConfig } from "../config";
import { acquireBindingLock } from "./lock";
import { listEnabledBindings } from "./binding";
import {
  collectAndUploadOnce,
  isLiveActionable,
  type LiveCollectDeps,
} from "./live-pipeline";
import { liveDecisionLogPath } from "./paths";
import { createIntelUpsertClient, type UpsertClient } from "./upsert-client";
import type { LiveRecord, LiveScanSummary, MemoryBinding } from "./types";

// Default per-pass upload cap (no-backfill, §6). Conservative on purpose: the
// first live pass over a backlog uploads at most this many revisions, the rest
// defer and drain over later Stops. Override with MEETLESS_AGENT_MEMORY_MAX_UPLOADS.
export const DEFAULT_MAX_UPLOADS_PER_PASS = 25;

function resolveMaxUploads(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.MEETLESS_AGENT_MEMORY_MAX_UPLOADS ?? "").trim();
  if (!raw) return DEFAULT_MAX_UPLOADS_PER_PASS;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX_UPLOADS_PER_PASS;
}

// Append the actionable live outcomes for one binding to its JSONL. Metadata
// only (the LiveRecord shape: sourceId, relativePath, hash, bytes, outcome,
// reason, secretRuleIds, revisionId, serverOutcome, observedAt). NEVER raw
// content. unchanged/skipped no-ops are dropped so the log stays bounded.
export function appendLiveDecisions(
  bindingId: string,
  records: LiveRecord[],
  home: string = HOME,
): number {
  const actionable = records.filter((r) => isLiveActionable(r.outcome));
  if (actionable.length === 0) return 0;
  const dest = liveDecisionLogPath(bindingId, home);
  mkdirSync(dirname(dest), { recursive: true });
  const lines = actionable.map((r) => JSON.stringify(r)).join("\n") + "\n";
  appendFileSync(dest, lines, { mode: 0o600 });
  return actionable.length;
}

export interface LiveBindingPassResult {
  bindingId: string;
  // null when skipped because another collector held the lock, OR when the
  // pipeline threw (fail-soft); `locked` disambiguates the two.
  summary: LiveScanSummary | null;
  locked: boolean;
  appended: number;
}

async function runForBindingLive(
  binding: MemoryBinding,
  deps: LiveCollectDeps,
): Promise<LiveBindingPassResult> {
  const home = deps.home ?? HOME;
  // Same per-binding lock as the dry-run collector: dry-run and live passes are
  // mutually exclusive on a binding (they share the lock namespace), so they can
  // never interleave and corrupt either ledger.
  const lock = acquireBindingLock(binding.bindingId, deps.nowIso, home);
  if (!lock) {
    return { bindingId: binding.bindingId, summary: null, locked: false, appended: 0 };
  }
  try {
    const summary = await collectAndUploadOnce(binding, deps);
    const appended = appendLiveDecisions(binding.bindingId, summary.records, home);
    return { bindingId: binding.bindingId, summary, locked: true, appended };
  } finally {
    lock.release();
  }
}

export interface LiveCollectorRunOptions {
  nowIso: string;
  home?: string;
  // The network seam + actor. Injected by tests; the real path below builds
  // createIntelUpsertClient(readConfig()) and reads the actor from config.
  client?: UpsertClient;
  actor?: string;
  // Override the resolved CliConfig (tests). Ignored when `client` is injected.
  cfg?: CliConfig;
  scan?: LiveCollectDeps["scan"];
  scannerVersion?: string;
  // Defaults to "block" via collectAndUploadOnce (live is fail-closed).
  scannerMode?: LiveCollectDeps["scannerMode"];
  // No-backfill cap. Defaults to the env-resolved value (DEFAULT_MAX_UPLOADS_PER_PASS).
  maxUploadsPerPass?: number;
  env?: NodeJS.ProcessEnv;
}

// Build the real UpsertClient + actor from config, or fail-closed. Returns null
// when there is no resolvable actor identity (never upload anonymously) or the
// config cannot be read. Skipped entirely when a client is injected (tests).
function resolveClientAndActor(
  opts: LiveCollectorRunOptions,
): { client: UpsertClient; actor: string } | null {
  if (opts.client) {
    // An injected client with no actor is a test misconfiguration; require both.
    if (!opts.actor) return null;
    return { client: opts.client, actor: opts.actor };
  }
  let cfg: CliConfig;
  try {
    cfg = opts.cfg ?? readConfig();
  } catch {
    return null;
  }
  const actor = (opts.actor ?? cfg.actorUserId ?? "").trim();
  if (!actor) return null; // not logged in -> never upload anonymously.
  return { client: createIntelUpsertClient(cfg), actor };
}

// Run a LIVE pass over every enabled binding. Fail-soft per binding: one
// binding's error never aborts the others. Returns [] WITHOUT touching the
// network when there is no resolvable actor or when there are no enabled
// bindings. Async because the per-file engine awaits the network.
export async function runLiveCollector(
  opts: LiveCollectorRunOptions,
): Promise<LiveBindingPassResult[]> {
  // Gate 1: a resolvable client + actor (never upload anonymously).
  const resolved = resolveClientAndActor(opts);
  if (!resolved) return [];

  const home = opts.home ?? HOME;
  // Gate 2: at least one consented binding (CONSENT-1). Consent is the operator
  // control now that capture runs by default; an empty set is a clean no-op.
  const bindings = listEnabledBindings(home);
  if (bindings.length === 0) return [];

  const env = opts.env ?? process.env;
  const deps: LiveCollectDeps = {
    client: resolved.client,
    actor: resolved.actor,
    nowIso: opts.nowIso,
    home,
    maxUploadsPerPass: opts.maxUploadsPerPass ?? resolveMaxUploads(env),
    ...(opts.scan ? { scan: opts.scan } : {}),
    ...(opts.scannerVersion ? { scannerVersion: opts.scannerVersion } : {}),
    ...(opts.scannerMode ? { scannerMode: opts.scannerMode } : {}),
  };

  const out: LiveBindingPassResult[] = [];
  for (const b of bindings) {
    try {
      out.push(await runForBindingLive(b, deps));
    } catch {
      out.push({ bindingId: b.bindingId, summary: null, locked: false, appended: 0 });
    }
  }
  return out;
}
