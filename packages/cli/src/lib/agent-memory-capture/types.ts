// src/lib/agent-memory-capture/types.ts
//
// Shared types for the agent-memory capture pipeline
// (notes/20260626-agent-memory-auto-capture-proposal.md). This subsystem routes
// the coding agent's own private auto-memory writes
// (`~/.claude/projects/<encoded-cwd>/memory/*.md`) into the governed KB, walled
// off from grounding any session until a human accepts a derived claim.
//
// Phase 1 here is DRY-RUN ONLY: it observes, classifies, secret-scans, and
// records a metadata-only decision per file. It never uploads. Live ingestion
// (Phase 2A+) is blocked upstream by the missing cross-revision claim-grain
// idempotency (DERIVED-IDEMPOTENCY-1, §5.2) and is intentionally not built here.

// One local capture binding per canonical memory directory (§3). The directory
// is the shared resource (worktrees share it), so the binding keys on the
// directory's realpath, never the repo.
export interface MemoryBinding {
  // Stable UUID. Reused on reactivation of the same memoryDir + workspace; the
  // synthetic source path embeds it, so dedup depends on its stability.
  bindingId: string;
  // Canonical realpath of the consented directory (the identity key).
  memoryDir: string;
  // The one workspace this directory binds to (MEMORY-WORKSPACE-1).
  workspaceId: string;
  enabled: boolean;
  // ISO timestamp of the opt-in.
  consentedAt: string;
}

export interface BindingStore {
  version: 1;
  bindings: MemoryBinding[];
}

// The thin dry-run ledger entry, keyed by a file's path relative to memoryDir
// (§4). Deliberately thin: the server owns processing/extraction state; the
// ledger never mirrors it. `lastDecision` is the 3-state reduction the doc
// specifies; the richer JSONL `decision` is for volume analysis only.
export type LedgerDecision = "eligible" | "skipped" | "blocked";

export interface LedgerEntry {
  lastObservedHash: string;
  lastDecision: LedgerDecision;
  // Set only when lastDecision === "blocked"; a scanner-policy bump that does
  // not match re-evaluates the file (RETRY-2 for blocks).
  blockedScannerVersion?: string;
  lastObservedAt: string;
}

export interface Ledger {
  version: 1;
  // relativePath -> entry
  entries: Record<string, LedgerEntry>;
}

// The rich per-file decision the dry-run emits to JSONL. `decision` is richer
// than the ledger's 3-state so Phase 1 can measure dynamic volume (changes/day,
// rewrites, deletions, reclassifications, blocked updates). NEVER carries raw
// content (only a hash + byte count + matched secret RULE ids, never the secret
// text).
export type Decision =
  | "unchanged" // present, content identical to last observation; no action
  | "eligible" // project + clean + changed/new; WOULD upload a new revision
  | "blocked" // project but a known secret pattern matched; do not upload
  | "reclassified" // was project, now feedback/user/reference; withdraw
  | "failed" // malformed / oversized / unreadable / scanner unavailable
  | "deleted" // tracked file absent after a COMPLETE scan; retire derived
  | "skipped"; // ineligible and never tracked (non-project, denylisted)

// Phase posture for the secret scanner (An's verdict 2026-06-27, proposal §6).
// Local-only phases (0A static report, Phase 1 dry-run) run "observe": secret
// hits are recorded as telemetry on the file's content-state decision but NEVER
// produce a `blocked` decision, because nothing is uploaded, so there is nothing
// to protect. "block" is the future Phase 2B pre-upload posture: fail-closed, a
// hit becomes a `blocked` decision and pins the scanner version (RETRY-2).
// "off" skips scanning entirely. Local phases must default to "observe".
export type ScannerMode = "off" | "observe" | "block";

export interface DecisionRecord {
  // Synthetic reserved source path `_external/agent-auto-memory/<bindingId>/<rel>`.
  sourceId: string;
  relativePath: string;
  // sha256 hex of the exact bytes read; null when the file could not be read.
  hash: string | null;
  bytes: number;
  decision: Decision;
  reason: string;
  // Matched secret RULE ids only (e.g. ["redis_directive"]); never the secret.
  secretRuleIds: string[];
  observedAt: string;
}

export interface ScanSummary {
  bindingId: string;
  memoryDir: string;
  workspaceId: string;
  // Whether the directory scan completed without a read/iteration error. When
  // false, NO deletions or reclassifications are reconciled this pass (§4).
  scanComplete: boolean;
  records: DecisionRecord[];
}

// ---------------------------------------------------------------------------
// LIVE capture (Phase 2A+) state. Distinct from the dry-run ledger above: the
// live ledger tracks what the SERVER acknowledged, not what we observed, so a
// failed upload never looks "settled" (RETRY-2). Kept in its own file so a
// binding can never have its dry-run and live state collide (§4 ledger shapes).
// ---------------------------------------------------------------------------

// The realized outcome of one live pass over a file. Mirrors the dry-run
// Decision but names the EFFECTED action ("uploaded", not "eligible") because
// the live path actually performs the network op.
export type LiveOutcome =
  | "uploaded" // UPSERT_SOURCE_REVISION acked + hash-matched; lastUploadedHash advanced
  | "unchanged" // content == lastUploadedHash, or still-blocked under the same scanner
  | "blocked" // a known credential FORMAT matched; withheld from upload (SECRET-1)
  | "reclassified" // was project, now non-project; WITHDRAW_SOURCE issued
  | "deleted" // absent after a COMPLETE scan; WITHDRAW_SOURCE issued
  | "deferred" // changed + clean, but the per-pass upload cap was hit; left UNSETTLED and re-attempted next pass (no-backfill safeguard, §6)
  | "skipped" // non-project, never tracked
  | "failed"; // malformed/oversized/unreadable/scanner_unavailable/upload_failed/hash_mismatch

// Per-file LIVE ledger entry, keyed by path relative to memoryDir (§4 "Live").
// `lastUploadedHash` advances ONLY on a hash-matched ack (COMMIT-1), so a failed
// or unverified upload leaves it untouched and the next pass re-attempts.
export interface LiveLedgerEntry {
  // Raw sha256 of the bytes the server last ACKED for this path. Absent until a
  // first successful upload. The unchanged check compares against this.
  lastUploadedHash?: string;
  // Server revision id from that ack (audit + future WITHDRAW targeting).
  lastUploadedRevisionId?: string;
  // Server logical source id from that ack (audit).
  lastLogicalSourceId?: string;
  // Synthetic reserved source path the upload addressed (audit).
  lastSourceId?: string;
  // Set only while the file is WITHHELD by the credential denylist. A scanner
  // version that no longer matches re-evaluates the file (RETRY-2 for blocks).
  blockedHash?: string;
  blockedScannerVersion?: string;
  // ISO of the last processing ATTEMPT (success or failure), for observability.
  lastAttemptAt: string;
}

export interface LiveLedger {
  version: 1;
  // relativePath -> entry
  entries: Record<string, LiveLedgerEntry>;
}

// The rich per-file outcome the live pass emits. NEVER carries raw content (only
// a hash + byte count + matched credential RULE ids, never the secret text).
export interface LiveRecord {
  sourceId: string;
  relativePath: string;
  hash: string | null;
  bytes: number;
  outcome: LiveOutcome;
  reason: string;
  // Matched credential RULE ids only (e.g. ["redis_directive"]); never the secret.
  secretRuleIds: string[];
  // Server revision id when an upload was acked.
  revisionId?: string | null;
  // Server-reported create/dedup outcome when an upload was acked.
  serverOutcome?: "created" | "already_exists" | null;
  observedAt: string;
}

export interface LiveScanSummary {
  bindingId: string;
  memoryDir: string;
  workspaceId: string;
  scanComplete: boolean;
  records: LiveRecord[];
}
