import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveMeetlessHome } from "../config";
import { ScanResult, Verdicts } from "./types";
import { renderStaleContextXml } from "./render";

// This machine's Meetless state root, i.e. the `.meetless` dir that holds every per-workspace
// artifact below.
//
// An EXPLICIT `home` always wins and keeps this module's historical convention: `home` is the OS
// home and we append the `.meetless` segment ourselves (unlike config.HOME, where `home` IS the
// `.meetless` dir). Tests and injected deps rely on that to get an isolated root per case.
//
// With no home passed, MEETLESS_HOME decides. It always should have: that variable is the documented
// "relocate this machine's Meetless state" knob, and config.HOME (bundle cache, telemetry, logs)
// already honored it while every path here ignored it, so an operator who set it got a split brain,
// bundle in the new root and scan cache in the old one.
//
// A correction, because the note that used to sit here had it exactly backwards and that error is
// what let the $HOME bug live: it claimed "on macOS os.homedir() reads getpwuid and IGNORES $HOME".
// The opposite is true, on Darwin as on Linux. `env HOME=/tmp/x node -p 'os.homedir()'` prints
// /tmp/x, and `HOME='~'` prints a literal `~`. os.homedir() returns $HOME VERBATIM and consults
// getpwuid only when $HOME is UNSET; it is os.userInfo() that ignores $HOME. Believing the inverse
// made a poisoned $HOME look impossible, so nothing validated it, and a launcher that exported
// HOME='' had this join() collapse to a relative ".meetless" under process.cwd(). Resolution now
// goes through config.resolveMeetlessHome, which validates and recovers.
//
// With the variable unset (every production install) this resolves exactly as before.
function stateRoot(home?: string): string {
  if (home !== undefined) return join(home, ".meetless");
  return resolveMeetlessHome();
}
function wsDir(home: string | undefined, workspaceId: string): string {
  return join(stateRoot(home), "workspaces", workspaceId);
}
export function scanCachePath(workspaceId: string, home?: string): string {
  return join(wsDir(home, workspaceId), "scan-cache.json");
}
export function verdictsPath(workspaceId: string, home?: string): string {
  return join(wsDir(home, workspaceId), "scanner-verdicts.json");
}
// The floor-projection materialization receipt (matrix doc Phase 2). A local artifact,
// written next to scan-cache.json, that records the outcome of the last projection write
// (written | unchanged | blocked) for the async flush to upload. No network on this path.
export function projectionReceiptPath(workspaceId: string, home?: string): string {
  return join(wsDir(home, workspaceId), "projection-receipt.json");
}
// The review-card journal the Stop hook appends to at the end of a session. Written shell-side
// (hooks-template/stop.sh, straight to $HOME); this is the reader's half of the same path.
export function reviewCardsPath(workspaceId: string, home?: string): string {
  return join(wsDir(home, workspaceId), "review-cards.jsonl");
}
// The assembler's out-of-band audit (targeted-rule-injection §4.4). The assemble-context
// subcommand budgets the model-facing envelope, then records WHAT it delivered vs dropped
// (and any overflow) here rather than in the byte-limited prompt. Diagnostic only: a failed
// write never breaks delivery.
export function assembleAuditPath(workspaceId: string, home?: string): string {
  return join(wsDir(home, workspaceId), "assemble-audit.json");
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2), "utf8");
}
function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

export function writeScanCache(home: string | undefined, workspaceId: string, result: ScanResult): void {
  writeJson(scanCachePath(workspaceId, home), result);
}
export function readScanCache(home: string | undefined, workspaceId: string): ScanResult | null {
  return readJson<ScanResult>(scanCachePath(workspaceId, home));
}

// The persisted shape of a projection receipt. `projection` is the load-bearing field
// (matrix doc Phase 2); the rest is diagnostic provenance. Best-effort: a failed write
// never breaks the scan that produced it.
export interface PersistedProjectionReceipt {
  schemaVersion: 1;
  at: string; // ISO timestamp of the materialization attempt
  workspaceId: string;
  // "removed" = an owned projection was torn down because the floor was legitimately revoked
  // (fresh bundle, zero floor rules); distinct from "unchanged" (nothing to do) so a revocation
  // is observable and never masquerades as a no-op.
  projection: "written" | "unchanged" | "blocked" | "removed";
  reason?: string;
  bundleId: string;
}
export function writeProjectionReceipt(
  home: string | undefined,
  workspaceId: string,
  receipt: PersistedProjectionReceipt,
): void {
  try {
    writeJson(projectionReceiptPath(workspaceId, home), receipt);
  } catch {
    // A receipt is observability, never a gate: a failure here must not break the scan.
  }
}
export function readProjectionReceipt(
  home: string | undefined,
  workspaceId: string,
): PersistedProjectionReceipt | null {
  return readJson<PersistedProjectionReceipt>(projectionReceiptPath(workspaceId, home));
}

// The persisted assembler audit (§4.4, §7). `state` names which cache-degradation row fired
// (or "normal"); `delivered`/`omitted` name rules by their durable identity; `overflow` is
// true iff the mandatory-scoped fail-loud marker replaced the scoped block.
//
// `versionId` on a delivered/omitted row is the durable RuleVersion identity of that rule
// (§7.4), enriched at the persistence boundary from the scan-cache floor/scoped arrays (the
// pure assembler keeps its result minimal so its tests do not churn on identity plumbing).
// `represents` on a delivered row lists the RuleVersions this injected rule canonically stands
// in for after dedup (§7.3 REPRESENTED_BY_RULE_VERSION): an absorbed MUST is honestly reported
// as delivered-by-equivalent, never as lost. Both are optional (absent when unknown / nothing
// absorbed) so a row written by an older build still parses.
export interface PersistedAssembleAudit {
  schemaVersion: 1;
  at: string;
  workspaceId: string;
  state: "normal" | "overflow" | "old-schema" | "incomplete" | "base-invariant";
  bytes: number;
  safeTotal: number;
  overflow: boolean;
  explicitPaths: string[];
  delivered: Array<{ ruleId: string; tier: string; versionId?: string; represents?: string[] }>;
  omitted: Array<{ ruleId: string; reason: string; versionId?: string }>;
  // The prompt-time reconciliation rehash partition (ADR §3.3 item 9). Present ONLY when the
  // scan cache carried reconciliation findings; Phase 2B populates them, so every Phase 2A cache
  // carries none and this key is omitted from every 2A audit. `kept` = findings whose cited file's
  // current content-normalization-v1 digest still equals the evaluated digest (eligible to inject,
  // pending the blocked Phase-3 renderer). `needsReevaluation` = findings dropped from THIS prompt
  // because the file drifted (`digest_drift`), could not be read (`unreadable`), or failed
  // normalization (`normalization_error`); never auto-resolved (item #6), only held back. This
  // audit is the sole Phase 2A consumer of the rehash, so it is where the partition is observed.
  reconciliation?: {
    kept: Array<{ path: string; reason: string }>;
    needsReevaluation: Array<{ path: string; reason: string }>;
  };
}
export function writeAssembleAudit(
  home: string | undefined,
  workspaceId: string,
  audit: PersistedAssembleAudit,
): void {
  try {
    writeJson(assembleAuditPath(workspaceId, home), audit);
  } catch {
    // The audit is observability, never a gate: a failure here must not break delivery.
  }
}

const EMPTY_VERDICTS: Verdicts = { schemaVersion: 1, accepted: [], dismissed: [] };
export function readVerdicts(home: string | undefined, workspaceId: string): Verdicts {
  return readJson<Verdicts>(verdictsPath(workspaceId, home)) ?? { ...EMPTY_VERDICTS };
}
export function writeVerdicts(home: string | undefined, workspaceId: string, v: Verdicts): void {
  writeJson(verdictsPath(workspaceId, home), v);
}

// Dismissed signals are removed; the stale block + inventory are re-derived so the
// cache the hot path reads always reflects the latest verdicts.
export function applyVerdicts(result: ScanResult, verdicts: Verdicts): ScanResult {
  const dismissed = new Set(verdicts.dismissed);
  const staleSignals = result.staleSignals.filter((s) => !dismissed.has(s.id));
  return {
    ...result,
    staleSignals,
    staleContextXml: renderStaleContextXml(staleSignals),
    inventory: { ...result.inventory, staleSignals: staleSignals.length },
  };
}
