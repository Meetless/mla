import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";
import { QUEUE_DIR, HOOKS_DIR } from "./config";

// Spool helpers used by `mla flush` to scan and drain pending queue files.
// The actual flush mechanic lives in ~/.meetless/hooks/flush.sh; we call it
// for each pending session so we share the same locking + transformation logic.

export function listActiveSessions(): string[] {
  if (!fs.existsSync(QUEUE_DIR)) return [];
  const out: Set<string> = new Set();
  for (const f of fs.readdirSync(QUEUE_DIR)) {
    if (f.endsWith(".jsonl")) {
      out.add(f.replace(/\.jsonl$/, ""));
    } else if (f.includes(".jsonl.draining.")) {
      out.add(f.split(".jsonl.")[0]);
    }
  }
  return Array.from(out);
}

export interface QueueDepth {
  sessions: number;
  events: number;
  orphans: number;
  oldestAgeSec: number | null;
}

// queueDepth must account for both live spool files AND orphan
// `.jsonl.draining.*` snapshots. The doctor surfaces oldestAgeSec as the
// signal that something is stuck; an interrupted flush leaves the live file
// gone and only a draining-suffixed remnant behind. If we measured age from
// .jsonl files alone, a queue with N orphan drains stranded for hours would
// show "oldest age n/a" and the operator would call doctor GREEN. Treat any
// readable file in the queue dir (live or draining) as evidence of pending
// work for the purposes of the oldest-age metric. `events` and `orphans`
// stay split so the operator can still see which side is heavier.
export function queueDepth(queueDir: string = QUEUE_DIR): QueueDepth {
  if (!fs.existsSync(queueDir)) return { sessions: 0, events: 0, orphans: 0, oldestAgeSec: null };
  let events = 0;
  let orphans = 0;
  let oldestMs = Number.POSITIVE_INFINITY;
  const sessions = new Set<string>();
  for (const f of fs.readdirSync(queueDir)) {
    const full = path.join(queueDir, f);
    if (f.endsWith(".jsonl")) {
      sessions.add(f.replace(/\.jsonl$/, ""));
      try {
        const raw = fs.readFileSync(full, "utf8");
        events += raw.split("\n").filter((l) => l.trim().length > 0).length;
        const st = fs.statSync(full);
        if (st.mtimeMs < oldestMs) oldestMs = st.mtimeMs;
      } catch {}
    } else if (f.includes(".jsonl.draining.")) {
      orphans += 1;
      sessions.add(f.split(".jsonl.")[0]);
      try {
        const raw = fs.readFileSync(full, "utf8");
        events += raw.split("\n").filter((l) => l.trim().length > 0).length;
        const st = fs.statSync(full);
        if (st.mtimeMs < oldestMs) oldestMs = st.mtimeMs;
      } catch {}
    }
  }
  return {
    sessions: sessions.size,
    events,
    orphans,
    oldestAgeSec: oldestMs === Number.POSITIVE_INFINITY ? null : Math.round((Date.now() - oldestMs) / 1000),
  };
}

// Suffixes flush.sh / common.sh create per session, MOST-SPECIFIC FIRST.
// classifyQueueFile returns on the first endsWith match, so the compound
// `.hb.lock` / `.narration-cursor.lock` MUST precede the bare `.lock`, else
// `<sid>.hb.lock` would classify under a phantom `<sid>.hb` session. reapQueue
// ONLY removes files whose suffix is in this set, so a stray non-Meetless file
// (or a `.workspaceId.bak.*` backup) is never touched. `.jsonl.draining.*` is
// handled separately (variable `.<pid>` tail). `.off` lives in session-gate/,
// not the queue dir, so it is intentionally absent here.
const SIDECAR_SUFFIXES = [
  ".hb.lock",
  ".narration-cursor.lock",
  ".narration-cursor",
  ".hb",
  ".repoPath",
  ".gitBaseline",
  ".workspaceId",
  ".turn",
  ".lock",
] as const;
const DEFAULT_QUEUE_GC_MAX_AGE_SEC = 86_400; // 24h idle before a session is litter
// A much longer gate before we reclaim a session that STILL has undelivered work.
// reapQueue normally refuses pending spools forever (skippedPending). But a
// no-workspace strand (a spool whose session never resolved a delivery target)
// can never drain, so absent this gate it accumulates without bound -- exactly
// the queue litter that piled up. A session whose newest file has not been
// touched in this window is definitively dead (an active session rewrites its
// .turn/.hb every turn, so the newest-mtime heartbeat cannot be this stale), and
// any events that WERE deliverable already drained during its lifetime. 7 days is
// deliberately far beyond the 24h litter gate so we never reclaim work that a
// live or recently-resumed session could still flush.
const DEFAULT_QUEUE_STRANDED_MAX_AGE_SEC = 604_800; // 7d idle before stranded work is reclaimed

export interface ReapResult {
  reaped: string[]; // session ids whose files were removed
  removedFiles: number; // total files unlinked
  skippedPending: number; // sessions with pending work younger than strandedMaxAgeSec (untouchable)
  skippedFresh: number; // content-reapable sessions whose newest file is younger than maxAgeSec
  strandedReaped: string[]; // sessions reclaimed DESPITE pending work (dead > strandedMaxAgeSec)
  discardedEvents: number; // undeliverable events discarded from those stranded spools
}

interface SessionGroup {
  files: string[];
  hasNonEmptySpool: boolean;
  hasDraining: boolean;
  newestMtimeMs: number;
}

// Map a queue-dir filename to its (sessionId, kind) or null if it is not a
// recognized Meetless artifact. Draining snapshots come first because they also
// end in a numeric `.draining.<pid>` tail that the plain-suffix match would miss.
function classifyQueueFile(name: string): { sessionId: string; isSpool: boolean; isDraining: boolean } | null {
  const drainIdx = name.indexOf(".jsonl.draining.");
  if (drainIdx > 0) {
    return { sessionId: name.slice(0, drainIdx), isSpool: false, isDraining: true };
  }
  if (name.endsWith(".jsonl")) {
    return { sessionId: name.slice(0, -".jsonl".length), isSpool: true, isDraining: false };
  }
  for (const sfx of SIDECAR_SUFFIXES) {
    if (name.endsWith(sfx)) {
      return { sessionId: name.slice(0, -sfx.length), isSpool: false, isDraining: false };
    }
  }
  return null;
}

// reapQueue: age-gated GC of dead-session litter (RC2). A session is reaped only
// when it has NO undelivered work (no non-empty `.jsonl`, no `.jsonl.draining.*`)
// AND its NEWEST file is older than maxAgeSec. Newest-mtime is the liveness
// heartbeat: an active session's `.jsonl`/`.turn` is rewritten every turn, so the
// age gate cannot reap a session that is merely between turns. Unlinking a `.lock`
// that another process holds is safe on POSIX (the lock is on the open inode; the
// holder keeps it), and the 24h gate makes a concurrent live flush impossible
// anyway. Pure function of the filesystem + injected `now` so it is deterministic
// under test.
export function reapQueue(
  opts: {
    maxAgeSec?: number;
    strandedMaxAgeSec?: number;
    now?: number;
    queueDir?: string;
    dryRun?: boolean;
  } = {},
): ReapResult {
  const queueDir = opts.queueDir ?? QUEUE_DIR;
  const now = opts.now ?? Date.now();
  const dryRun = opts.dryRun ?? false;
  const maxAgeSec =
    opts.maxAgeSec ??
    (process.env.MEETLESS_QUEUE_GC_MAX_AGE_SEC
      ? Number(process.env.MEETLESS_QUEUE_GC_MAX_AGE_SEC)
      : DEFAULT_QUEUE_GC_MAX_AGE_SEC);
  const strandedMaxAgeSec =
    opts.strandedMaxAgeSec ??
    (process.env.MEETLESS_QUEUE_STRANDED_MAX_AGE_SEC
      ? Number(process.env.MEETLESS_QUEUE_STRANDED_MAX_AGE_SEC)
      : DEFAULT_QUEUE_STRANDED_MAX_AGE_SEC);

  const result: ReapResult = {
    reaped: [],
    removedFiles: 0,
    skippedPending: 0,
    skippedFresh: 0,
    strandedReaped: [],
    discardedEvents: 0,
  };
  if (!fs.existsSync(queueDir)) return result;

  const groups = new Map<string, SessionGroup>();
  for (const name of fs.readdirSync(queueDir)) {
    const c = classifyQueueFile(name);
    if (!c) continue; // unrecognized -> never touch
    const full = path.join(queueDir, name);
    let g = groups.get(c.sessionId);
    if (!g) {
      g = { files: [], hasNonEmptySpool: false, hasDraining: false, newestMtimeMs: 0 };
      groups.set(c.sessionId, g);
    }
    g.files.push(full);
    let mtimeMs = 0;
    let sizeNonEmpty = false;
    try {
      const st = fs.statSync(full);
      mtimeMs = st.mtimeMs;
      sizeNonEmpty = st.size > 0;
    } catch {
      continue;
    }
    if (mtimeMs > g.newestMtimeMs) g.newestMtimeMs = mtimeMs;
    if (c.isSpool && sizeNonEmpty) g.hasNonEmptySpool = true;
    if (c.isDraining) g.hasDraining = true;
  }

  for (const [sessionId, g] of groups) {
    const ageSec = (now - g.newestMtimeMs) / 1000;
    const pending = g.hasNonEmptySpool || g.hasDraining;
    if (pending) {
      // Pending work is normally untouchable. Reclaim it ONLY once it is so old
      // (strandedMaxAgeSec, 7d) that the session is certainly dead and its events
      // are undeliverable. This is the ONLY branch that ever deletes a non-empty
      // spool; it stays reap-cheap (no flush, no fan-out) unlike `mla queue
      // prune`, which best-effort flushes first. Below the stranded gate we still
      // refuse, exactly as before.
      if (ageSec < strandedMaxAgeSec) {
        result.skippedPending += 1;
        continue;
      }
    } else if (ageSec < maxAgeSec) {
      result.skippedFresh += 1;
      continue;
    }
    // Count events we are about to discard from a stranded spool (observability;
    // an empty-sidecar reap discards nothing). Cheap: only stranded groups reach
    // here with pending work, and that set is small.
    let discarded = 0;
    if (pending) {
      for (const f of g.files) {
        if (!f.endsWith(".jsonl") && !f.includes(".jsonl.draining.")) continue;
        try {
          const st = fs.statSync(f);
          if (st.size > 0) {
            const raw = fs.readFileSync(f, "utf8");
            discarded += raw.split("\n").filter((l) => l.trim().length > 0).length;
          }
        } catch {}
      }
    }
    let removed = 0;
    for (const f of g.files) {
      if (dryRun) {
        // Count what WOULD be removed without touching disk (doctor's read-only
        // debt probe). statSync already succeeded above for files we counted, so
        // treat every grouped file as removable here.
        removed += 1;
        continue;
      }
      try {
        fs.rmSync(f, { force: true });
        removed += 1;
      } catch {}
    }
    if (removed > 0) {
      result.reaped.push(sessionId);
      result.removedFiles += removed;
      if (pending) {
        result.strandedReaped.push(sessionId);
        result.discardedEvents += discarded;
      }
    }
  }

  return result;
}

export interface PrunableSession {
  sessionId: string;
  files: string[]; // absolute paths
  unflushedEvents: number; // non-empty spool/draining line count at risk
  bytes: number;
  newestMtimeMs: number;
  ageSec: number;
}

export interface QueuePrunePlan {
  candidates: PrunableSession[];
  skippedFresh: number; // dead-shaped but newer than maxAgeSec
  totalFiles: number;
  totalUnflushedEvents: number;
  totalBytes: number;
  oldestAgeSec: number | null;
}

// planQueuePrune: the EXPLICIT reclaimer (powers `mla queue prune`). Unlike
// reapQueue it INCLUDES sessions with a non-empty `.jsonl` -- the stranded tails
// reapQueue refuses by its data-loss-safety rule. Safe only because prune is
// (a) manual, (b) age-gated (a session no hook has touched in maxAgeSec is dead),
// and (c) flushed best-effort before deletion (executeQueuePrune). Pure function
// of the filesystem + injected `now`.
export function planQueuePrune(
  opts: { maxAgeSec?: number; now?: number; queueDir?: string; sessionId?: string } = {},
): QueuePrunePlan {
  const queueDir = opts.queueDir ?? QUEUE_DIR;
  const now = opts.now ?? Date.now();
  const maxAgeSec = opts.maxAgeSec ?? DEFAULT_QUEUE_GC_MAX_AGE_SEC;
  const plan: QueuePrunePlan = {
    candidates: [],
    skippedFresh: 0,
    totalFiles: 0,
    totalUnflushedEvents: 0,
    totalBytes: 0,
    oldestAgeSec: null,
  };
  if (!fs.existsSync(queueDir)) return plan;

  const groups = new Map<
    string,
    { files: string[]; unflushedEvents: number; bytes: number; newestMtimeMs: number }
  >();
  for (const name of fs.readdirSync(queueDir)) {
    const c = classifyQueueFile(name);
    if (!c) continue;
    if (opts.sessionId && c.sessionId !== opts.sessionId) continue;
    const full = path.join(queueDir, name);
    let g = groups.get(c.sessionId);
    if (!g) {
      g = { files: [], unflushedEvents: 0, bytes: 0, newestMtimeMs: 0 };
      groups.set(c.sessionId, g);
    }
    g.files.push(full);
    try {
      const st = fs.statSync(full);
      if (st.mtimeMs > g.newestMtimeMs) g.newestMtimeMs = st.mtimeMs;
      g.bytes += st.size;
      if ((c.isSpool || c.isDraining) && st.size > 0) {
        const raw = fs.readFileSync(full, "utf8");
        g.unflushedEvents += raw.split("\n").filter((l) => l.trim().length > 0).length;
      }
    } catch {
      // unreadable -> still listed for deletion, just not counted
    }
  }

  let oldest: number | null = null;
  for (const [sessionId, g] of groups) {
    const ageSec = (now - g.newestMtimeMs) / 1000;
    if (ageSec < maxAgeSec) {
      plan.skippedFresh += 1;
      continue;
    }
    plan.candidates.push({
      sessionId,
      files: g.files,
      unflushedEvents: g.unflushedEvents,
      bytes: g.bytes,
      newestMtimeMs: g.newestMtimeMs,
      ageSec: Math.round(ageSec),
    });
    plan.totalFiles += g.files.length;
    plan.totalUnflushedEvents += g.unflushedEvents;
    plan.totalBytes += g.bytes;
    if (oldest === null || ageSec > oldest) oldest = ageSec;
  }
  plan.candidates.sort((a, b) => b.ageSec - a.ageSec);
  plan.oldestAgeSec = oldest === null ? null : Math.round(oldest);
  return plan;
}

export interface QueuePruneResult {
  prunedSessions: string[];
  removedFiles: number;
  discardedEvents: number; // events still in a spool at delete time (undeliverable)
  flushedSessions: number; // candidates we successfully best-effort flushed first
  recoveredFiles: number; // files a flush self-cleaned before we got to them
}

// executeQueuePrune: best-effort flush each candidate (so deliverable events are
// recovered, not discarded), then delete its remaining files. Flush is via the
// real flush.sh (shared locking + transform), failures ignored -- a 3-day-dead
// session whose AgentRun is gone simply will not deliver, and we prune it anyway.
export function executeQueuePrune(
  plan: QueuePrunePlan,
  opts: { hookDir?: string; flush?: boolean } = {},
): QueuePruneResult {
  const hookDir = opts.hookDir ?? HOOKS_DIR;
  const doFlush = opts.flush ?? true;
  const result: QueuePruneResult = {
    prunedSessions: [],
    removedFiles: 0,
    discardedEvents: 0,
    flushedSessions: 0,
    recoveredFiles: 0,
  };

  for (const c of plan.candidates) {
    if (doFlush && c.unflushedEvents > 0 && fs.existsSync(path.join(hookDir, "flush.sh"))) {
      const r = runFlushScript(c.sessionId, hookDir);
      if (r.ok) result.flushedSessions += 1;
    }
    let removed = 0;
    let discarded = 0;
    for (const f of c.files) {
      try {
        const st = fs.statSync(f); // throws if a flush already removed it
        if ((f.endsWith(".jsonl") || f.includes(".jsonl.draining.")) && st.size > 0) {
          const raw = fs.readFileSync(f, "utf8");
          discarded += raw.split("\n").filter((l) => l.trim().length > 0).length;
        }
        fs.rmSync(f, { force: true });
        removed += 1;
      } catch {
        result.recoveredFiles += 1; // gone already (flush self-cleaned it)
      }
    }
    if (removed > 0) {
      result.prunedSessions.push(c.sessionId);
      result.removedFiles += removed;
      result.discardedEvents += discarded;
    }
  }
  return result;
}

// Honest per-session flush outcome (BUG-1 E / BUG-2 H). flush.sh ALWAYS exits 0
// -- capture must never break a session -- so the process exit code carries no
// signal. The real outcome rides on a single machine-readable marker the flush's
// EXIT trap prints to stdout: `MLA_FLUSH_RESULT status=... delivered=N
// respooled=N authcode=...`. Statuses:
//   ok          drain delivered clean (events PATCHed, or session_started only)
//   empty       nothing was queued to send
//   locked      another flush already held the session lock (benign, retry later)
//   noworkspace no marker workspace bound; queue left intact
//   deferred    a transient failure (control 5xx / missing filter) re-spooled; retry
//   blocked     an auth rejection (401/403/404) re-spooled EVERYTHING; capture is down
//   unknown     marker absent (pre-BUG-1-E hook) or the flush crashed before the trap
export type FlushStatus =
  | "ok"
  | "empty"
  | "locked"
  | "noworkspace"
  | "deferred"
  | "blocked"
  | "unknown";

export interface FlushScriptResult {
  ok: boolean; // true only for a clean/empty drain (nothing left behind)
  status: FlushStatus;
  delivered: number; // events PATCHed to control this drain
  respooled: number; // event/finalize lines kept for a later retry
  authCode: string; // the 401/403/404 that blocked capture, or "" if none
  stderr: string;
}

const FLUSH_RESULT_RE =
  /^MLA_FLUSH_RESULT status=(\S+) delivered=(\d+) respooled=(\d+) authcode=(\S*)\s*$/;

function normalizeFlushStatus(raw: string): FlushStatus {
  switch (raw) {
    case "ok":
    case "empty":
    case "locked":
    case "noworkspace":
    case "deferred":
    case "blocked":
      return raw;
    default:
      return "unknown";
  }
}

// Parse the flush marker out of the script's stdout. The EXIT trap prints exactly
// one marker at the real script exit, so it is the LAST matching line;
// finalize-session (Pass 3) inherits stdout but never emits this prefix, so a
// line scan is safe. Returns null when no marker is present (older hook, or a
// bash that died before the trap fired).
export function parseFlushResult(stdout: string): Omit<FlushScriptResult, "stderr"> | null {
  const lines = stdout.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = FLUSH_RESULT_RE.exec(lines[i].trim());
    if (!m) continue;
    const status = normalizeFlushStatus(m[1]);
    return {
      ok: status === "ok" || status === "empty",
      status,
      delivered: Number(m[2]) || 0,
      respooled: Number(m[3]) || 0,
      authCode: m[4] || "",
    };
  }
  return null;
}

export function runFlushScript(sessionId: string, hookDir: string): FlushScriptResult {
  const flush = path.join(hookDir, "flush.sh");
  if (!fs.existsSync(flush)) {
    return {
      ok: false,
      status: "unknown",
      delivered: 0,
      respooled: 0,
      authCode: "",
      stderr: `flush.sh not found at ${flush}`,
    };
  }
  const r = spawnSync("bash", [flush, sessionId], { encoding: "utf8" });
  const parsed = parseFlushResult(r.stdout || "");
  if (!parsed) {
    // No marker: an older hook that predates BUG-1 E, or a flush that died before
    // its EXIT trap ran. Fall back to the (always-0) exit code so behaviour never
    // regresses for a stale hook -- worst case it reports the pre-fix "ok".
    return {
      ok: r.status === 0,
      status: "unknown",
      delivered: 0,
      respooled: 0,
      authCode: "",
      stderr: r.stderr || "",
    };
  }
  return { ...parsed, stderr: r.stderr || "" };
}
