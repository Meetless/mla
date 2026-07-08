// tools/meetless-agent/src/lib/active-memory.ts
// Zone 1 (Active Review) store reader. The bash PostToolUse hook appends raw
// records to ~/.meetless/logs/kb-knowledge.jsonl (fast, flock-guarded, no network).
// All dedup/TTL/debounce/caps live here, applied at READ time, so the hot path
// stays a single append and the policy is unit-testable in isolation.
// See notes/20260604-auto-propose-produced-docs-to-kb.md (active-memory store).
import { readFileSync, existsSync } from "fs";
import { dedupIdentity, CaptureKind } from "./identity-envelope";

export interface ActiveMemoryRecord {
  ts: string;
  event: "active_memory_record";
  workspaceId: string;
  ownerUserId: string;
  repoRootHash: string;
  canonicalPath: string;
  contentHash: string;
  sessionId: string;
  turnIndex: number;
  sourceProduct: string;
  kind: CaptureKind;
  createdAt: string;
  // Absolute repo root, LOCAL-only (never transmitted). Lets the Zone 2 auto-index
  // resolve the doc on disk: absPath = join(repoRoot, canonicalPath). Optional for
  // backward-compat with pre-Phase-A records and the tagged_reference path (no root).
  repoRoot?: string;
}

export interface ReduceOpts {
  nowMs: number;
  ttlHours: number;
  maxRecords: number;
  // When set, only this session's records are reduced, and the filter is applied
  // BEFORE turn-debounce and content-dedup. This matters because the dedup identity
  // (identity-envelope.ts) is content-keyed and omits sessionId: an identical-content
  // record from another session, appended later, would otherwise evict this session's
  // on a post-reduce filter. Zone 2 auto-index scopes to its own session this way.
  sessionId?: string;
}

// Read the append-only log and return the live, deduped, debounced, capped set of
// Active Review candidates. Ordering: later records win on dedup (debounce keeps
// the final content of a turn; identical content collapses). Returns at most
// maxRecords, most recent first by file order.
export function reduceActiveMemory(file: string, opts: ReduceOpts): ActiveMemoryRecord[] {
  if (!existsSync(file)) return [];
  const ttlMs = opts.ttlHours * 3600 * 1000;
  const lines = readFileSync(file, "utf8").split("\n").filter((l) => l.trim().length > 0);

  // Debounce within a turn: the dedup identity excludes contentHash via a separate
  // path-key; collapse multiple edits to one canonicalPath in one (session,turn)
  // down to the final content, then apply content-hash dedup across turns.
  const turnKeyed = new Map<string, ActiveMemoryRecord>();
  for (const line of lines) {
    let r: ActiveMemoryRecord;
    try {
      r = JSON.parse(line) as ActiveMemoryRecord;
    } catch {
      continue;
    }
    if (r.event !== "active_memory_record") continue;
    if (opts.sessionId !== undefined && r.sessionId !== opts.sessionId) continue; // scope BEFORE dedup
    const created = Date.parse(r.createdAt);
    if (Number.isFinite(created) && opts.nowMs - created > ttlMs) continue; // TTL eviction
    const turnPathKey = [r.workspaceId, r.repoRootHash, r.ownerUserId, r.sessionId, r.turnIndex, r.canonicalPath, r.kind].join("|");
    turnKeyed.set(turnPathKey, r); // later edit in same turn wins (debounce)
  }

  // Content-hash dedup across turns: collapse identical content to one record.
  const deduped = new Map<string, ActiveMemoryRecord>();
  for (const r of turnKeyed.values()) {
    deduped.set(dedupIdentity(r), r); // later occurrence wins
  }

  const all = Array.from(deduped.values());
  if (all.length <= opts.maxRecords) return all;
  return all.slice(all.length - opts.maxRecords); // keep most recent
}

// Explicit-intent classifier: only an explicit "ingest into KB" creates a doc.
// Everything else (including "remember this") stays Active-only. Default deny:
// ambiguity never auto-ingests. Spec tests 17,29 / INV-NO-TIER1-KB-WRITE.
export type IngestIntent = "kb_ingest" | "active_only";
export function classifyIngestIntent(text: string): IngestIntent {
  const t = text.toLowerCase();
  if (/\b(ingest|add)\b.*\bkb\b/.test(t) || /\binto (the )?kb\b/.test(t)) return "kb_ingest";
  return "active_only";
}
