// src/lib/agent-memory-capture/live-pipeline.ts
//
// The LIVE collection pass (Phase 2A+). Mirrors the dry-run §4 lifecycle router
// in pipeline.ts but ACTUALLY performs the network ops: it uploads eligible
// revisions (UPSERT_SOURCE_REVISION) and withdraws reclassified/deleted sources
// (WITHDRAW_SOURCE), against the injectable `UpsertClient`. It commits the LIVE
// ledger only on a verified server ack:
//
//   COMMIT-1: `lastUploadedHash` advances ONLY after a successful ack whose
//             server-echoed content hash equals the local hash (or, on older
//             intel that omits the echo, on a success outcome alone). A failed,
//             rejected, or hash-mismatched upload leaves the entry unsettled.
//   RETRY-2:  Because a failed upload never advances `lastUploadedHash`, the next
//             pass sees the file as still-changed and re-attempts it. A blocked
//             file is re-evaluated when the scanner version moves.
//
// SECRET-1: the credential denylist (`scanForCredentials`, NOT the entropy
// scanner) runs FAIL-CLOSED before any upload. A credential-format hit withholds
// the file; a scanner outage withholds the file. Nothing credential-bearing is
// handed to the client.
//
// One immutable byte buffer per file (the dry-run's TOCTOU guard): the bytes
// hashed, classified, scanned, and uploaded are provably the same bytes.
import { readFileSync } from "node:fs";

import { HOME } from "../config";
import { scanForCredentials, SECRET_SCANNER_VERSION } from "../redactor";
import { classifyMemory } from "./classify";
import { enumerateEligibleFiles, MAX_FILE_BYTES } from "./containment";
import { readLiveLedger, writeLiveLedger } from "./live-ledger";
import { sha256Hex, syntheticSourceId } from "./pipeline";
import type {
  LiveLedger,
  LiveLedgerEntry,
  LiveRecord,
  LiveScanSummary,
  MemoryBinding,
  ScannerMode,
} from "./types";
import type { UpsertClient } from "./upsert-client";

export interface LiveCollectDeps {
  // The network seam. Real impl = createIntelUpsertClient(cfg); tests inject a fake.
  client: UpsertClient;
  // The CLI actor (cfg.actorUserId) stamped on every wire op for audit.
  actor: string;
  // Credential denylist. Defaults to scanForCredentials (high-confidence formats
  // only, NOT the entropy heuristic, which over-blocks). Injectable so a test can
  // simulate a scanner outage (a throw).
  scan?: (text: string) => string[];
  scannerVersion?: string;
  // Live ALWAYS blocks on a credential hit (fail-closed). Exposed only so a test
  // can force "off" to exercise the no-scan path. Defaults to "block".
  scannerMode?: ScannerMode;
  // No-backfill safeguard (§6): the maximum number of UPLOAD attempts this pass.
  // Once reached, remaining changed+clean files are DEFERRED (left unsettled,
  // re-attempted next pass) instead of dumping the whole backlog at once.
  // undefined = uncapped (the dry-run-parity default; the live orchestrator sets
  // a conservative cap). Withdraws are cleanup, not backfill, and are uncapped.
  maxUploadsPerPass?: number;
  nowIso: string;
  home?: string;
}

// Only outcomes that represent an actual event are worth persisting to the live
// JSONL. "unchanged" and "skipped" are emitted every pass; persisting them would
// grow the log without bound.
export function isLiveActionable(outcome: LiveRecord["outcome"]): boolean {
  return outcome !== "unchanged" && outcome !== "skipped";
}

// Run one LIVE collection + upload pass for a single binding. Reads the real
// directory, performs network ops via the client, and mutates the LIVE ledger.
// Returns every file's outcome (the collector persists only the actionable ones).
export async function collectAndUploadOnce(
  binding: MemoryBinding,
  deps: LiveCollectDeps,
): Promise<LiveScanSummary> {
  const home = deps.home ?? HOME;
  const scan = deps.scan ?? scanForCredentials;
  const scannerVersion = deps.scannerVersion ?? SECRET_SCANNER_VERSION;
  // Live is fail-closed by default; "off" is a test-only escape hatch.
  const scannerMode: ScannerMode = deps.scannerMode ?? "block";
  const now = deps.nowIso;
  // No-backfill cap (§6). undefined = uncapped; otherwise stop attempting uploads
  // once this many have been attempted this pass and defer the rest.
  const cap = deps.maxUploadsPerPass;
  let uploadAttempts = 0;

  const ledger: LiveLedger = readLiveLedger(binding.bindingId, home);
  const { files, complete } = enumerateEligibleFiles(binding.memoryDir);

  const records: LiveRecord[] = [];
  const present = new Set<string>();
  let mutated = false;

  const base = (relativePath: string, bytes: number) => ({
    sourceId: syntheticSourceId(binding.bindingId, relativePath),
    relativePath,
    bytes,
    secretRuleIds: [] as string[],
    observedAt: now,
  });

  for (const f of files) {
    present.add(f.relativePath);
    const sourceId = syntheticSourceId(binding.bindingId, f.relativePath);

    // Oversized: known from stat; never read, never upload, never withdraw.
    if (f.bytes > MAX_FILE_BYTES) {
      records.push({ ...base(f.relativePath, f.bytes), hash: null, outcome: "failed", reason: "oversized" });
      continue;
    }

    let buf: Buffer;
    try {
      buf = readFileSync(f.realPath);
    } catch {
      records.push({ ...base(f.relativePath, f.bytes), hash: null, outcome: "failed", reason: "unreadable" });
      continue;
    }
    if (buf.length > MAX_FILE_BYTES) {
      records.push({ ...base(f.relativePath, buf.length), hash: null, outcome: "failed", reason: "oversized" });
      continue;
    }

    const hash = sha256Hex(buf);
    const text = buf.toString("utf8");
    const cls = classifyMemory(text);
    const prior = ledger.entries[f.relativePath];

    if (cls.malformed) {
      records.push({ ...base(f.relativePath, buf.length), hash, outcome: "failed", reason: "malformed_frontmatter" });
      continue;
    }

    if (cls.type !== "project") {
      // A previously-tracked project file became non-project: WITHDRAW it. A file
      // never tracked is simply skipped (it was never uploaded).
      if (prior) {
        const res = await deps.client.withdraw({
          workspaceId: binding.workspaceId,
          actor: deps.actor,
          relPath: sourceId,
          reason: "reclassified",
        });
        if (res.ok) {
          delete ledger.entries[f.relativePath];
          mutated = true;
          records.push({
            ...base(f.relativePath, buf.length),
            hash,
            outcome: "reclassified",
            reason: `reclassified project -> ${cls.type ?? "none"}`,
          });
        } else {
          // Leave the entry so the next pass retries the withdraw (RETRY-2).
          ledger.entries[f.relativePath] = { ...prior, lastAttemptAt: now };
          mutated = true;
          records.push({
            ...base(f.relativePath, buf.length),
            hash,
            outcome: "failed",
            reason: `withdraw_failed (reclassified): ${res.reason}`,
          });
        }
      } else {
        records.push({
          ...base(f.relativePath, buf.length),
          hash,
          outcome: "skipped",
          reason: cls.type ? `type ${cls.type}` : "no project type",
        });
      }
      continue;
    }

    // type === project. If the exact bytes already match what the server acked,
    // it is settled and clean by construction (we never upload a credential-
    // bearing file), so short-circuit WITHOUT re-scanning. Clear any stale block
    // marker (content reverted to the uploaded version).
    //
    // LIMITATION (documented, not a bug): this does NOT retroactively re-scan or
    // withdraw already-uploaded content when the scanner version bumps. RETRY-2's
    // re-evaluation applies to BLOCKED files, not settled uploads. Once content
    // is acked it is governed by the KB review rail, not the local scanner.
    if (prior?.lastUploadedHash === hash) {
      if (prior.blockedHash || prior.blockedScannerVersion) {
        const cleared: LiveLedgerEntry = { ...prior, lastAttemptAt: now };
        delete cleared.blockedHash;
        delete cleared.blockedScannerVersion;
        ledger.entries[f.relativePath] = cleared;
        mutated = true;
      }
      records.push({
        ...base(f.relativePath, buf.length),
        hash,
        outcome: "unchanged",
        reason: "content identical to last upload",
      });
      continue;
    }

    // Credential denylist, FAIL-CLOSED (SECRET-1). "off" is the test-only path.
    let secretRuleIds: string[] = [];
    if (scannerMode !== "off") {
      try {
        secretRuleIds = scan(text);
      } catch {
        // Scanner outage withholds the file: we cannot prove it is clean.
        records.push({
          ...base(f.relativePath, buf.length),
          hash,
          outcome: "failed",
          reason: "scanner_unavailable",
        });
        continue;
      }
    }

    if (scannerMode !== "off" && secretRuleIds.length > 0) {
      const alreadyBlocked =
        prior?.blockedHash === hash && prior?.blockedScannerVersion === scannerVersion;
      if (alreadyBlocked) {
        records.push({
          ...base(f.relativePath, buf.length),
          hash,
          outcome: "unchanged",
          reason: "blocked (unchanged, same scanner)",
          secretRuleIds,
        });
      } else {
        // Set the block marker but PRESERVE any prior upload settle (a file can
        // be blocked at a new revision while an older clean revision is on the
        // server). Never advance lastUploadedHash here.
        ledger.entries[f.relativePath] = {
          ...(prior ?? {}),
          blockedHash: hash,
          blockedScannerVersion: scannerVersion,
          lastAttemptAt: now,
        };
        mutated = true;
        records.push({
          ...base(f.relativePath, buf.length),
          hash,
          outcome: "blocked",
          reason: "credential format matched",
          secretRuleIds,
        });
      }
      continue;
    }

    // No-backfill cap (§6): once the per-pass upload budget is exhausted, DEFER
    // the remaining changed+clean files rather than uploading the whole backlog
    // in one burst. A deferred file is left UNSETTLED (the ledger is untouched),
    // so the next pass re-attempts it; the backlog drains `cap` files per pass.
    // Surfaced as a visible `deferred` count, never silently dropped.
    if (cap !== undefined && uploadAttempts >= cap) {
      records.push({
        ...base(f.relativePath, buf.length),
        hash,
        outcome: "deferred",
        reason: "per-pass upload cap reached",
        secretRuleIds,
      });
      continue;
    }
    uploadAttempts++;

    // project + clean + changed/new -> UPLOAD.
    const res = await deps.client.upsert({
      workspaceId: binding.workspaceId,
      actor: deps.actor,
      relPath: sourceId,
      content: text,
      contentHash: hash,
      bindingId: binding.bindingId,
      consentedAt: binding.consentedAt,
    });

    if (!res.ok || res.outcome === "failed") {
      // RETRY-2: do NOT advance lastUploadedHash; only stamp an attempt on an
      // existing entry (never create a bare entry for a never-settled file, so
      // deletion reconciliation cannot later withdraw something never uploaded).
      if (prior) {
        ledger.entries[f.relativePath] = { ...prior, lastAttemptAt: now };
        mutated = true;
      }
      records.push({
        ...base(f.relativePath, buf.length),
        hash,
        outcome: "failed",
        reason: res.ok ? `server_rejected: ${res.reason}` : res.reason,
        secretRuleIds,
      });
      continue;
    }

    // COMMIT-1: if the server echoed its content hash, it MUST equal ours.
    if (res.serverContentHash !== null && res.serverContentHash !== hash) {
      if (prior) {
        ledger.entries[f.relativePath] = { ...prior, lastAttemptAt: now };
        mutated = true;
      }
      records.push({
        ...base(f.relativePath, buf.length),
        hash,
        outcome: "failed",
        reason: "hash_mismatch",
        secretRuleIds,
      });
      continue;
    }

    // COMMIT-1 satisfied. Settle the ledger to this hash; clear any block marker.
    ledger.entries[f.relativePath] = {
      lastUploadedHash: hash,
      lastUploadedRevisionId: res.revisionId ?? undefined,
      lastLogicalSourceId: res.logicalSourceId ?? undefined,
      lastSourceId: sourceId,
      lastAttemptAt: now,
    };
    mutated = true;
    records.push({
      ...base(f.relativePath, buf.length),
      hash,
      outcome: "uploaded",
      reason: prior?.lastUploadedHash ? "changed" : "new",
      secretRuleIds,
      revisionId: res.revisionId,
      // Map the upsert vocabulary ("created"|"unchanged") onto the record's
      // create/dedup vocabulary; "unchanged" here means the server already held
      // these exact bytes under this path (a benign dedup), recorded as such.
      serverOutcome: res.outcome === "created" ? "created" : "already_exists",
    });
  }

  // Deletions: only when the scan completed (a partial scan must never mistake an
  // un-enumerated file for a deletion). WITHDRAW each absent tracked source; keep
  // the entry on a failed withdraw so the next complete pass retries it.
  if (complete) {
    for (const rel of Object.keys(ledger.entries)) {
      if (present.has(rel)) continue;
      const sourceId = syntheticSourceId(binding.bindingId, rel);
      const res = await deps.client.withdraw({
        workspaceId: binding.workspaceId,
        actor: deps.actor,
        relPath: sourceId,
        reason: "deleted",
      });
      if (res.ok) {
        delete ledger.entries[rel];
        mutated = true;
        records.push({
          sourceId,
          relativePath: rel,
          bytes: 0,
          hash: null,
          outcome: "deleted",
          reason: "absent after complete scan",
          secretRuleIds: [],
          observedAt: now,
        });
      } else {
        ledger.entries[rel] = { ...ledger.entries[rel], lastAttemptAt: now };
        mutated = true;
        records.push({
          sourceId,
          relativePath: rel,
          bytes: 0,
          hash: null,
          outcome: "failed",
          reason: `withdraw_failed (deleted): ${res.reason}`,
          secretRuleIds: [],
          observedAt: now,
        });
      }
    }
  }

  if (mutated) writeLiveLedger(binding.bindingId, ledger, home);

  return {
    bindingId: binding.bindingId,
    memoryDir: binding.memoryDir,
    workspaceId: binding.workspaceId,
    scanComplete: complete,
    records,
  };
}
