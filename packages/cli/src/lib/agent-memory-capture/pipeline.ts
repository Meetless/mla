// src/lib/agent-memory-capture/pipeline.ts
//
// The exact-byte collection flow + the §4 lifecycle transition router. One
// immutable byte buffer per file: the bytes hashed, parsed, and scanned are
// provably the bytes that WOULD be uploaded, closing the TOCTOU where an editor
// rewrites the file between a path scan and a re-read. A scan failure must never
// mutate lifecycle (no upload, no retire) — that invariant lives in the routing
// table below.
//
// Phase 1 is DRY-RUN: this computes a decision per file and updates the thin
// ledger, but uploads nothing. The synthetic source id and content hash are
// computed so the dry-run records what a live upload WOULD address.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { HOME } from "../config";
import { scanForSecrets, SECRET_SCANNER_VERSION } from "../redactor";
import { classifyMemory } from "./classify";
import { enumerateEligibleFiles, MAX_FILE_BYTES } from "./containment";
import { readLedger, writeLedger } from "./ledger";
import type { DecisionRecord, Ledger, MemoryBinding, ScanSummary, ScannerMode } from "./types";

export function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

export function syntheticSourceId(bindingId: string, relativePath: string): string {
  return `_external/agent-auto-memory/${bindingId}/${relativePath}`;
}

// Only these decisions represent an event worth persisting to the JSONL.
// `unchanged` and `skipped` are no-ops emitted every scan; persisting them would
// grow the log without bound (a Phase 1 exit criterion).
export function isActionable(decision: DecisionRecord["decision"]): boolean {
  return decision !== "unchanged" && decision !== "skipped";
}

export interface CollectDeps {
  // Injected so a test can simulate "scanner unavailable" (a throw) and assert
  // the posture-dependent routing. Defaults to the real scanner.
  scan?: (text: string) => string[];
  scannerVersion?: string;
  // Secret-scanner posture (§6). Local-only phases default to "observe": secret
  // hits become telemetry, never a `blocked` decision, because nothing is
  // uploaded. "block" is the future pre-upload (Phase 2B) fail-closed posture.
  scannerMode?: ScannerMode;
  nowIso: string;
  home?: string;
}

// Run one dry-run collection pass for a single binding. Pure with respect to the
// network (uploads nothing); reads the real directory and mutates the local
// ledger. Returns every file's decision (the writer persists only the
// actionable ones).
export function collectOnce(binding: MemoryBinding, deps: CollectDeps): ScanSummary {
  const home = deps.home ?? HOME;
  const scan = deps.scan ?? scanForSecrets;
  const scannerVersion = deps.scannerVersion ?? SECRET_SCANNER_VERSION;
  // Local phases (0A/1) observe; only the future pre-upload path blocks.
  const scannerMode: ScannerMode = deps.scannerMode ?? "observe";
  const now = deps.nowIso;

  const ledger: Ledger = readLedger(binding.bindingId, home);
  const { files, complete } = enumerateEligibleFiles(binding.memoryDir);

  const records: DecisionRecord[] = [];
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

    // Oversized: known from stat; never read, never upload, never retire.
    if (f.bytes > MAX_FILE_BYTES) {
      records.push({ ...base(f.relativePath, f.bytes), hash: null, decision: "failed", reason: "oversized" });
      continue;
    }

    let buf: Buffer;
    try {
      buf = readFileSync(f.realPath);
    } catch {
      records.push({ ...base(f.relativePath, f.bytes), hash: null, decision: "failed", reason: "unreadable" });
      continue;
    }
    // Guard the race where the file grew between stat and read.
    if (buf.length > MAX_FILE_BYTES) {
      records.push({ ...base(f.relativePath, buf.length), hash: null, decision: "failed", reason: "oversized" });
      continue;
    }

    const hash = sha256Hex(buf);
    const text = buf.toString("utf8");
    const cls = classifyMemory(text);
    const prior = ledger.entries[f.relativePath];

    if (cls.malformed) {
      records.push({ ...base(f.relativePath, buf.length), hash, decision: "failed", reason: "malformed_frontmatter" });
      continue;
    }

    if (cls.type !== "project") {
      // Was it previously a tracked project file? Ledger presence is the signal
      // (we only ever create entries for project files).
      if (prior) {
        delete ledger.entries[f.relativePath];
        mutated = true;
        records.push({
          ...base(f.relativePath, buf.length),
          hash,
          decision: "reclassified",
          reason: `reclassified project -> ${cls.type ?? "none"}`,
        });
      } else {
        records.push({
          ...base(f.relativePath, buf.length),
          hash,
          decision: "skipped",
          reason: cls.type ? `type ${cls.type}` : "no project type",
        });
      }
      continue;
    }

    // type === project: secret-scan the EXACT bytes. Posture decides what a hit
    // means (§6). "off" skips scanning. "observe" (the local default) records
    // matched rule ids as telemetry but never blocks: nothing is uploaded, so a
    // scanner outage is not a safety event either. "block" (future pre-upload)
    // is fail-closed: an outage fails the file, a hit becomes a `blocked`
    // decision and pins the scanner version.
    let secretRuleIds: string[] = [];
    if (scannerMode !== "off") {
      try {
        secretRuleIds = scan(text);
      } catch {
        if (scannerMode === "block") {
          records.push({
            ...base(f.relativePath, buf.length),
            hash,
            decision: "failed",
            reason: "scanner_unavailable",
          });
          continue;
        }
        secretRuleIds = [];
      }
    }

    if (scannerMode === "block" && secretRuleIds.length > 0) {
      const alreadyBlocked =
        prior?.lastDecision === "blocked" &&
        prior.lastObservedHash === hash &&
        prior.blockedScannerVersion === scannerVersion;
      if (alreadyBlocked) {
        records.push({
          ...base(f.relativePath, buf.length),
          hash,
          decision: "unchanged",
          reason: "blocked (unchanged, same scanner)",
          secretRuleIds,
        });
      } else {
        ledger.entries[f.relativePath] = {
          lastObservedHash: hash,
          lastDecision: "blocked",
          blockedScannerVersion: scannerVersion,
          lastObservedAt: now,
        };
        mutated = true;
        records.push({
          ...base(f.relativePath, buf.length),
          hash,
          decision: "blocked",
          reason: "secret pattern matched",
          secretRuleIds,
        });
      }
      continue;
    }

    // project + clean (or observe/off, where secretRuleIds rides along as a
    // telemetry-only signal on the content-state decision).
    if (prior && prior.lastObservedHash === hash && prior.lastDecision !== "blocked") {
      records.push({
        ...base(f.relativePath, buf.length),
        hash,
        decision: "unchanged",
        reason: "content identical",
        secretRuleIds,
      });
      continue;
    }

    ledger.entries[f.relativePath] = {
      lastObservedHash: hash,
      lastDecision: "eligible",
      lastObservedAt: now,
    };
    mutated = true;
    records.push({
      ...base(f.relativePath, buf.length),
      hash,
      decision: "eligible",
      reason: prior ? "changed" : "new",
      secretRuleIds,
    });
  }

  // Deletions: only reconcile when the scan completed; a partial scan must never
  // mistake an un-enumerated file for a deletion.
  if (complete) {
    for (const rel of Object.keys(ledger.entries)) {
      if (present.has(rel)) continue;
      delete ledger.entries[rel];
      mutated = true;
      records.push({
        sourceId: syntheticSourceId(binding.bindingId, rel),
        relativePath: rel,
        bytes: 0,
        hash: null,
        decision: "deleted",
        reason: "absent after complete scan",
        secretRuleIds: [],
        observedAt: now,
      });
    }
  }

  if (mutated) writeLedger(binding.bindingId, ledger, home);

  return {
    bindingId: binding.bindingId,
    memoryDir: binding.memoryDir,
    workspaceId: binding.workspaceId,
    scanComplete: complete,
    records,
  };
}
