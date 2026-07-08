import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ScanResult, Verdicts } from "./types";
import { renderStaleContextXml } from "./render";

function wsDir(home: string, workspaceId: string): string {
  return join(home, ".meetless", "workspaces", workspaceId);
}
export function scanCachePath(workspaceId: string, home = homedir()): string {
  return join(wsDir(home, workspaceId), "scan-cache.json");
}
export function verdictsPath(workspaceId: string, home = homedir()): string {
  return join(wsDir(home, workspaceId), "scanner-verdicts.json");
}
// The floor-projection materialization receipt (matrix doc Phase 2). A local artifact,
// written next to scan-cache.json, that records the outcome of the last projection write
// (written | unchanged | blocked) for the async flush to upload. No network on this path.
export function projectionReceiptPath(workspaceId: string, home = homedir()): string {
  return join(wsDir(home, workspaceId), "projection-receipt.json");
}
// The assembler's out-of-band audit (targeted-rule-injection §4.4). The assemble-context
// subcommand budgets the model-facing envelope, then records WHAT it delivered vs dropped
// (and any overflow) here rather than in the byte-limited prompt. Diagnostic only: a failed
// write never breaks delivery.
export function assembleAuditPath(workspaceId: string, home = homedir()): string {
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

export function writeScanCache(home: string, workspaceId: string, result: ScanResult): void {
  writeJson(scanCachePath(workspaceId, home), result);
}
export function readScanCache(home: string, workspaceId: string): ScanResult | null {
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
  home: string,
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
  home: string,
  workspaceId: string,
): PersistedProjectionReceipt | null {
  return readJson<PersistedProjectionReceipt>(projectionReceiptPath(workspaceId, home));
}

// The persisted assembler audit (§4.4). `state` names which cache-degradation row fired
// (or "normal"); `delivered`/`omitted` name rules by their durable identity; `overflow` is
// true iff the required-scoped fail-loud marker replaced the scoped block.
export interface PersistedAssembleAudit {
  schemaVersion: 1;
  at: string;
  workspaceId: string;
  state: "normal" | "overflow" | "old-schema" | "incomplete" | "base-invariant";
  bytes: number;
  safeTotal: number;
  overflow: boolean;
  explicitPaths: string[];
  delivered: Array<{ ruleId: string; tier: string }>;
  omitted: Array<{ ruleId: string; reason: string }>;
}
export function writeAssembleAudit(
  home: string,
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
export function readVerdicts(home: string, workspaceId: string): Verdicts {
  return readJson<Verdicts>(verdictsPath(workspaceId, home)) ?? { ...EMPTY_VERDICTS };
}
export function writeVerdicts(home: string, workspaceId: string, v: Verdicts): void {
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
