import * as fs from "fs";
import * as path from "path";

import { type CliConfig, readConfig } from "../lib/config";
import { resolveWorkspaceIdWithEnv } from "../lib/workspace";
import { getRunId, getRunTraceId, mintRunId, mintTraceId } from "../lib/observability";
import {
  openCe0Store,
  closeCe0Store,
  defaultCe0StorePath,
  listTurnMemoryAssessments,
  listDeadlineClaimedObligations,
  listConsultationsForTurn,
  type Ce0Store,
} from "../lib/rules/ce0-store";
import { runCe0Export, runCe0ImportLabels } from "../lib/rules/ce0-evidence";
import { DEFAULT_RECALL_SAMPLE_RATE } from "../lib/rules/ce0-recall-sample";
import { projectAssessedEvent, projectFinalizedEvent } from "../lib/rules/ce0-telemetry-project";
import {
  recordAnalyticsEvent,
  flushAnalyticsEvents,
  type RecordContext,
} from "../lib/analytics/recorder";
import { readEvents, machineId } from "../lib/analytics/store";

// `mla evidence` -- the one human-only CE0 labeling workflow
// (notes/20260617-evidence-consultation-forcing-function-proposal.md §2.3). CE0 is a measurement
// harness: the runtime hooks only record facts (the per-turn assessment, the consultation attempts)
// and the first Stop freezes the eligibility boundary. Satisfaction and coverage are graded OFFLINE,
// by a human, through this command. There is no model call and no external egress here; the response
// ceiling stays RECORD_ONLY.
//
//   mla evidence ce0-export                 Write the JSONL a labeler audits: every deadline-claimed,
//                                           not-yet-finalized obligation with the deterministic
//                                           machine baseline recomputed over its eligible consultations.
//   mla evidence ce0-import-labels <file>   Read a labeled JSONL back, validate each label against the
//                                           current export snapshot, and CAS-finalize the matched
//                                           obligations. Prints the finalize / conflict / reject /
//                                           agreement report.
//
// The command is a thin IO shell over the pure ce0-evidence core; the store path, workspace
// resolution, and the stdout / stderr sinks are injectable so the workflow is testable end to end.

const USAGE =
  "usage: mla evidence <ce0-export | ce0-import-labels <file> | ce0-emit-telemetry>";

/** Re-exported from ce0-store (its new home) so the existing `./evidence` consumers
 * (doctor, rules, internal-evidence-hooks) keep importing it unchanged. The resolver moved
 * onto the lean store module to keep evidence.ts's analytics/observability graph off the
 * PreToolUse deny hot path (latency lever A). */
export { defaultCe0StorePath };

const RECALL_SAMPLE_RATE_FLAG = "--recall-sample-rate";

/**
 * Parse the optional `--recall-sample-rate <value>` (or `=<value>`) flag for `ce0-export`. Absent ->
 * the pinned DEFAULT_RECALL_SAMPLE_RATE (sample every unflagged turn). Present -> a finite fraction in
 * [0, 1]; anything else (non-numeric, out of range, missing value) is an operator error reported with a
 * non-zero exit so a bad rate never silently narrows the recall denominator
 * (notes/20260617-evidence-consultation-forcing-function-proposal.md lines 2129, 2145).
 */
function parseRecallSampleRate(args: string[]): { value: number } | { error: string } {
  let raw: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const tok = args[i];
    if (tok === RECALL_SAMPLE_RATE_FLAG) {
      raw = args[i + 1];
      i++;
    } else if (tok.startsWith(`${RECALL_SAMPLE_RATE_FLAG}=`)) {
      raw = tok.slice(RECALL_SAMPLE_RATE_FLAG.length + 1);
    }
  }
  if (raw === undefined) return { value: DEFAULT_RECALL_SAMPLE_RATE };
  const value = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(value) || value < 0 || value > 1) {
    return { error: `${RECALL_SAMPLE_RATE_FLAG} must be a number in [0, 1] (got "${raw}")` };
  }
  return { value };
}

export interface EvidenceDeps {
  /** Resolve the workspace whose obligations to export / finalize. */
  resolveWorkspaceId?: () => string | undefined;
  /** Where the CE0 SQLite store lives (defaults to the Meetless home). */
  storePath?: string;
  /** Open the store at a path (seam for tests; defaults to the real opener). */
  openStore?: (dbPath: string) => Ce0Store;
  /** Read the labels file (seam for tests; defaults to fs). */
  readFile?: (p: string) => string;
  out?: (line: string) => void;
  err?: (line: string) => void;
  // Seams used only by `ce0-emit-telemetry` (the offline telemetry projection). The hooks are pure
  // durable writers; this sweep is the single producer of the two store-backed §6.4 events.
  record?: typeof recordAnalyticsEvent;
  flush?: typeof flushAnalyticsEvents;
  readCfg?: () => CliConfig | null;
  readEvents?: typeof readEvents;
  machineId?: () => string;
  runId?: string;
  traceId?: string;
  distinctId?: string | null;
  nowMs?: number;
  env?: NodeJS.ProcessEnv;
}

export async function runEvidence(argv: string[], deps: EvidenceDeps = {}): Promise<number> {
  const out = deps.out ?? ((line: string) => console.log(line));
  const err = deps.err ?? ((line: string) => console.error(line));
  const sub = argv[0];

  if (sub === "ce0-export") {
    const rate = parseRecallSampleRate(argv.slice(1));
    if ("error" in rate) {
      err(`mla evidence ce0-export: ${rate.error}\n${USAGE}`);
      return 2;
    }
    return withWorkspaceAndStore(deps, err, (workspaceId, store) => {
      out(runCe0Export(store, workspaceId, rate.value));
      return 0;
    });
  }

  if (sub === "ce0-import-labels") {
    const file = argv[1];
    if (!file) {
      err(`mla evidence ce0-import-labels: missing labels file argument\n${USAGE}`);
      return 2;
    }
    const readFile = deps.readFile ?? ((p: string) => fs.readFileSync(p, "utf8"));
    const labelJsonl = readFile(file);
    return withWorkspaceAndStore(deps, err, (workspaceId, store) => {
      const report = runCe0ImportLabels(store, workspaceId, labelJsonl);
      out(JSON.stringify(report));
      return 0;
    });
  }

  if (sub === "ce0-emit-telemetry") {
    return runEmitTelemetry(deps, out, err);
  }

  err(`mla evidence: unknown subcommand ${sub ? `"${sub}"` : "(none)"}\n${USAGE}`);
  return 2;
}

/** `mla evidence ce0-emit-telemetry`: project the CE0 store into the two §6.4 events it honestly
 * backs (memory_requirement_assessed per assessment, evidence_obligation_finalized per FINALIZED
 * obligation), record each locally, then best-effort forward to control. A repeated sweep is
 * idempotent two ways: the deterministic event_id dedupes on the remote sink, and a local skip-set
 * (the event_ids already in the local log for these two types) avoids re-appending the same lines.
 * Each event carries the ORIGINAL turn's session, so the analytics side joins it to the turn it
 * describes, not to this emit run. */
async function runEmitTelemetry(
  deps: EvidenceDeps,
  out: (line: string) => void,
  err: (line: string) => void,
): Promise<number> {
  const env = deps.env ?? process.env;
  const record = deps.record ?? recordAnalyticsEvent;
  const read = deps.readEvents ?? readEvents;
  const readCfg =
    deps.readCfg ??
    ((): CliConfig | null => {
      try {
        return readConfig();
      } catch {
        return null;
      }
    });
  const cfg = readCfg();
  // One run_id per invocation (never derived from trace); reuse the bootstrap-set run/trace when
  // present so all events in this sweep share them, else mint fresh (a standalone measurement run).
  const runId = deps.runId ?? getRunId() ?? mintRunId();
  const traceId = deps.traceId ?? getRunTraceId() ?? mintTraceId();
  const distinctId = deps.distinctId ?? cfg?.actorUserId ?? (deps.machineId ?? machineId)();
  const nowIso = new Date(deps.nowMs ?? Date.now()).toISOString();

  let assessed = 0;
  let finalized = 0;
  let skipped = 0;

  const code = withWorkspaceAndStore(deps, err, (workspaceId, store) => {
    // Skip-set: every event_id already logged locally for the two projected types. Keeps a repeated
    // sweep from re-appending lines the deterministic event_id would otherwise dedupe only remotely.
    const emitted = new Set<string>();
    for (const ev of read(env)) {
      if (
        (ev.event_type === "memory_requirement_assessed" ||
          ev.event_type === "evidence_obligation_finalized") &&
        typeof ev.event_id === "string"
      ) {
        emitted.add(ev.event_id);
      }
    }

    const emit = (sessionId: string | null, input: ReturnType<typeof projectAssessedEvent>): boolean => {
      if (input.eventId && emitted.has(input.eventId)) {
        skipped++;
        return false;
      }
      const ctx: RecordContext = { workspaceId, sessionId, distinctId, runId, traceId, now: nowIso };
      record(ctx, input, env);
      if (input.eventId) emitted.add(input.eventId);
      return true;
    };

    for (const a of listTurnMemoryAssessments(store, workspaceId)) {
      if (emit(a.sessionId, projectAssessedEvent(a))) assessed++;
    }
    for (const o of listDeadlineClaimedObligations(store, workspaceId)) {
      if (o.status !== "FINALIZED") continue;
      const consultations = listConsultationsForTurn(store, {
        workspaceId: o.workspaceId,
        sessionId: o.sessionId,
        localTurnSequence: o.localTurnSequence,
      });
      if (emit(o.sessionId, projectFinalizedEvent(o, consultations))) finalized++;
    }
    return 0;
  });

  if (code !== 0) return code;

  if (cfg) {
    const flush = deps.flush ?? flushAnalyticsEvents;
    await flush(cfg, env);
  }
  out(JSON.stringify({ emitted: { assessed, finalized }, skipped }));
  return 0;
}

/** Resolve the workspace, ensure the store directory exists, open it, run `body`, and close it. A
 * missing workspace is exit 1 (an operator problem: run from a marked repo or set the env var). */
function withWorkspaceAndStore(
  deps: EvidenceDeps,
  err: (line: string) => void,
  body: (workspaceId: string, store: Ce0Store) => number,
): number {
  const resolve = deps.resolveWorkspaceId ?? resolveWorkspaceIdWithEnv;
  const workspaceId = resolve();
  if (!workspaceId) {
    err(
      "mla evidence: no workspace resolved. Run from a directory with a .meetless.json marker, " +
        "or set MEETLESS_WORKSPACE_ID.",
    );
    return 1;
  }

  const dbPath = deps.storePath ?? defaultCe0StorePath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const open = deps.openStore ?? openCe0Store;
  const store = open(dbPath);
  try {
    return body(workspaceId, store);
  } finally {
    closeCe0Store(store);
  }
}
