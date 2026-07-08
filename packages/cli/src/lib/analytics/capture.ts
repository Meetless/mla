// captureCommandEvent: the run-finalize entry point that records one normalized
// `mla_command` journey event (spec section 6.2, section 11.4). It is the only
// thing cli.ts has to call. It runs after the command result is known and is
// fully defensive: any failure here is swallowed so analytics can never change a
// command's exit code or break its output.
//
// Order (matters): derive the sequence fields BEFORE recording, since they are
// read from the strictly-prior `mla_command` rows in the local jsonl; then record
// locally (durable, consent-gated); then best-effort forward to control (bounded,
// telemetry-gated). The local append happens even with remote telemetry off
// (local-first, INV-LOCAL-STATS-1); the forward is a no-op unless opted in.

import { CliConfig } from "../config";
import { CommandPayload } from "./envelope";
import {
  classifyOutcome,
  classifyScope,
  normalizeCommand,
} from "./command-event";
import { computeSequence } from "./sequence";
import { machineId } from "./store";
import {
  flushAnalyticsEvents,
  recordAnalyticsEvent,
  RecordContext,
} from "./recorder";

export interface CaptureCommandParams {
  argv: string[];
  exitCode: number;
  threw: boolean;
  thrown: unknown;
  workspaceId: string | null;
  sessionId: string | null;
  // The workspace-scoped actor id (an opaque cuid, not end-user PII; spec section
  // 9). Used as distinct_id for funnels; falls back to a hashed machine id.
  actorUserId: string | null;
  mlaVersion: string;
  gitSha: string;
  // Wall-clock millis captured at bootstrap start and at finalize. duration_ms is
  // their difference; both are injectable so tests are deterministic.
  startedAtMs: number;
  nowMs: number;
  // null when the run has no control config (e.g. `mla init` on a fresh box):
  // record locally, skip the remote forward.
  cfg: CliConfig | null;
  env?: NodeJS.ProcessEnv;
  onError?: (err: unknown) => void;
}

// Build the normalized command payload (pure). Exported so the privacy test can
// assert directly on what would be emitted, no I/O.
export function buildCommandPayload(params: {
  argv: string[];
  exitCode: number;
  threw: boolean;
  thrown: unknown;
  mlaVersion: string;
  gitSha: string;
  startedAtMs: number;
  nowMs: number;
  sessionId: string | null;
  env?: NodeJS.ProcessEnv;
}): CommandPayload {
  const { command, subcommand, flags_shape } = normalizeCommand(params.argv);
  const { outcome, error_class, retryable } = classifyOutcome(
    params.exitCode,
    params.threw,
    params.thrown,
  );
  const seq = computeSequence(params.sessionId, params.startedAtMs, params.env);
  const duration_ms = Math.max(0, params.nowMs - params.startedAtMs);

  return {
    command,
    subcommand,
    flags_shape,
    scope: classifyScope(command, flags_shape),
    duration_ms,
    exit_code: params.exitCode,
    outcome,
    error_class,
    retryable,
    // The CLI command itself does not edit a code surface (that signal is for
    // hook-origin events that wrap an edit). Honest default for a command event.
    touched_surface: "unknown",
    mla_version: params.mlaVersion,
    git_sha: params.gitSha,
    command_index_in_session: seq.command_index_in_session,
    preceded_by: seq.preceded_by,
    session_idle_gap_ms: seq.session_idle_gap_ms,
  };
}

export async function captureCommandEvent(params: CaptureCommandParams): Promise<void> {
  const env = params.env ?? process.env;
  try {
    // `_internal` subcommands (evidence-inject, evidence-correlate, auto-index,
    // finalize-session, active-review) are machine-internal plumbing spawned by
    // hooks, not user journey steps. Emitting an mla_command for them pollutes the
    // command-journey funnel with `command:"_internal", subcommand:null` noise, so
    // skip the journey event entirely. The remote flush is kept: an internal
    // command flushes its own buffer before this point, but keeping the flush
    // preserves forwarding for any value events still buffered (no-op when empty).
    const isInternal = normalizeCommand(params.argv).command === "_internal";

    if (!isInternal) {
      const payload = buildCommandPayload({
        argv: params.argv,
        exitCode: params.exitCode,
        threw: params.threw,
        thrown: params.thrown,
        mlaVersion: params.mlaVersion,
        gitSha: params.gitSha,
        startedAtMs: params.startedAtMs,
        nowMs: params.nowMs,
        sessionId: params.sessionId,
        env,
      });

      const nowIso = new Date(params.nowMs).toISOString();
      const ctx: RecordContext = {
        workspaceId: params.workspaceId,
        sessionId: params.sessionId,
        distinctId: params.actorUserId ?? machineId(),
        // The un-collapsed actor cuid for attribution (T1.10): honest null on an
        // actorless run, unlike distinctId which falls back to a hashed machine id.
        actorWorkspaceUserId: params.actorUserId,
        source: "cli",
        now: nowIso,
      };

      // Local append (durable) + buffer. Mints the CLI-origin event_id once.
      recordAnalyticsEvent(
        ctx,
        { eventType: "mla_command", payload: payload as unknown as Record<string, unknown> },
        env,
        params.onError,
      );
    }

    // Best-effort, bounded, telemetry-gated remote forward. Skipped entirely when
    // the run has no control config.
    if (params.cfg) {
      await flushAnalyticsEvents(params.cfg, env, params.onError);
    }
  } catch (err) {
    // Analytics must never break a command. Surface on the debug hook only.
    if (params.onError) params.onError(err);
  }
}
