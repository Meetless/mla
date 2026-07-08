import { planQueuePrune, executeQueuePrune } from "../lib/spool";

export interface QueuePruneOpts {
  queueDir?: string;
  hookDir?: string;
  now?: number;
}

interface ParsedArgs {
  yes: boolean;
  dryRun: boolean;
  flush: boolean;
  maxAgeHours: number | null;
  session: string | undefined;
  error: string | null;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {
    yes: false,
    dryRun: false,
    flush: true,
    maxAgeHours: null,
    session: undefined,
    error: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--yes" || a === "-y") out.yes = true;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--no-flush") out.flush = false;
    else if (a === "--max-age-hours") {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v) || v < 0) {
        out.error = `--max-age-hours expects a non-negative number, got: ${argv[i] ?? "(missing)"}`;
        return out;
      }
      out.maxAgeHours = v;
    } else if (a === "--session") {
      out.session = argv[++i];
      if (!out.session) {
        out.error = "--session expects a session id";
        return out;
      }
    } else {
      out.error = `Unknown flag: ${a}`;
      return out;
    }
  }
  return out;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}K`;
  return `${(n / (1024 * 1024)).toFixed(1)}M`;
}

function fmtAge(sec: number | null): string {
  if (sec === null) return "n/a";
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  if (sec < 86_400) return `${(sec / 3600).toFixed(1)}h`;
  return `${(sec / 86_400).toFixed(1)}d`;
}

export async function runQueuePrune(argv: string[], opts: QueuePruneOpts = {}): Promise<number> {
  const a = parseArgs(argv);
  if (a.error) {
    console.error(a.error);
    return 2;
  }
  const maxAgeSec = a.maxAgeHours != null ? Math.round(a.maxAgeHours * 3600) : undefined;
  const plan = planQueuePrune({
    maxAgeSec,
    sessionId: a.session,
    queueDir: opts.queueDir,
    now: opts.now,
  });

  if (plan.candidates.length === 0) {
    console.log(`Nothing to prune (${plan.skippedFresh} session(s) too fresh to be litter).`);
    return 0;
  }

  console.log(
    `Prune plan: ${plan.candidates.length} dead session(s), ${plan.totalFiles} files, ` +
      `${plan.totalUnflushedEvents} un-flushed event(s), ${fmtBytes(plan.totalBytes)}, ` +
      `oldest ${fmtAge(plan.oldestAgeSec)}.`,
  );
  for (const c of plan.candidates.slice(0, 20)) {
    console.log(
      `  ${c.sessionId}  ${c.files.length} files  ${c.unflushedEvents} ev  ${fmtAge(c.ageSec)}`,
    );
  }
  if (plan.candidates.length > 20) {
    console.log(`  ... and ${plan.candidates.length - 20} more`);
  }

  if (!a.yes || a.dryRun) {
    console.log(
      `\nDry run (no files removed). Re-run with --yes to prune` +
        (a.flush ? "; un-flushed events are flushed best-effort first" : "") +
        `.`,
    );
    return 0;
  }

  const res = executeQueuePrune(plan, { hookDir: opts.hookDir, flush: a.flush });
  console.log(
    `Pruned ${res.prunedSessions.length} session(s): removed ${res.removedFiles} files` +
      (res.flushedSessions ? `, flushed ${res.flushedSessions} before prune` : "") +
      (res.discardedEvents ? `, discarded ${res.discardedEvents} undeliverable event(s)` : "") +
      `.`,
  );
  return 0;
}
