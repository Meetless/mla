// Analytics recorder: the single entry point a command uses to emit an event
// (spec section 10, the dual-sink contract). It does three things, in order:
//
//   1. Assemble the envelope from the run context (run_id, trace_id, session_id,
//      workspace_id, distinct_id) + the caller's event_type/payload.
//   2. Append it to the local jsonl IMMEDIATELY (durable, offline-safe, the
//      source of truth for `mla stats`). This happens even with remote analytics
//      off (gated only by localStatsEnabled inside the store).
//   3. Buffer it for a best-effort remote forward at run finalize.
//
// The local append is synchronous and unconditional-by-consent; the remote
// forward is deferred to flushAnalyticsEvents() so a single run makes at most one
// control round-trip. This keeps analytics off the command's hot path: nothing
// here blocks or can throw into the command.

import { CliConfig } from "../config";
import { getRepoFingerprint, getRunId, getRunTraceId } from "../observability";
import {
  AnalyticsEvent,
  EventSource,
  EventType,
  makeEnvelope,
} from "./envelope";
import { mintEventId } from "./event-id";
import { appendEvent } from "./store";
import { machineId } from "./store";
import { forwardEvents, ForwardResult } from "./forwarder";

// The run-context an event needs beyond its own payload. trace_id/run_id default
// to the run-local values set at bootstrap; the caller may override (e.g. a
// server-recomputable outcome supplies a deterministic event_id).
export interface RecordContext {
  workspaceId: string | null;
  sessionId: string | null;
  distinctId?: string | null;
  runId?: string | null;
  traceId?: string | null;
  source?: EventSource;
  // The un-collapsed workspace-scoped actor cuid for the attribution block (T1.10).
  // Distinct from distinctId, which falls back to a hashed machine id on an
  // actorless run; this is null when there is genuinely no workspace actor.
  actorWorkspaceUserId?: string | null;
  // Per-run repo fingerprint override (T1.10). Defaults to the bootstrap-set
  // singleton (getRepoFingerprint); tests pass it explicitly for determinism.
  repoFingerprint?: string | null;
  // ISO timestamp; caller supplies it (the CLI has a clock, tests pass a fixed
  // value for determinism). created_at defaults to this; emitted_at too.
  now: string;
}

// Payload is the event-specific fields (everything in AnalyticsEvent that is not
// an envelope field). event_id is optional: omit to mint a fresh CLI-origin id,
// or pass a deterministic id for server-recomputable events.
export interface RecordInput {
  eventType: EventType;
  payload: Record<string, unknown>;
  eventId?: string;
}

let buffer: AnalyticsEvent[] = [];

// Build the fully-formed, flat event (envelope + payload merged). Pure: no I/O,
// so the test contract can assert envelope completeness on the returned object.
export function buildEvent(ctx: RecordContext, input: RecordInput): AnalyticsEvent {
  const runId = ctx.runId ?? getRunId();
  const traceId = ctx.traceId ?? getRunTraceId();
  if (!runId) {
    throw new Error("buildEvent requires a run_id (call setRunId at bootstrap or pass ctx.runId)");
  }
  if (!traceId) {
    throw new Error("buildEvent requires a trace_id (call setRunTraceId at bootstrap or pass ctx.traceId)");
  }
  const envelope = makeEnvelope({
    event_id: input.eventId ?? mintEventId(),
    event_type: input.eventType,
    created_at: ctx.now,
    emitted_at: ctx.now,
    workspace_id: ctx.workspaceId,
    distinct_id: ctx.distinctId ?? (ctx.workspaceId ? null : machineId()),
    session_id: ctx.sessionId,
    run_id: runId,
    trace_id: traceId,
    source: ctx.source ?? "cli",
    actor_workspace_user_id: ctx.actorWorkspaceUserId ?? null,
    repo_fingerprint: ctx.repoFingerprint ?? getRepoFingerprint(),
  });
  // Flat merge: envelope first so a stray envelope-named payload key can't shadow
  // the real join fields.
  return { ...input.payload, ...envelope } as unknown as AnalyticsEvent;
}

// Record an event: append locally now, buffer for remote forward later. Returns
// the built event so a caller (or test) can inspect it. Never throws on I/O.
export function recordAnalyticsEvent(
  ctx: RecordContext,
  input: RecordInput,
  env: NodeJS.ProcessEnv = process.env,
  onError?: (err: unknown) => void,
): AnalyticsEvent {
  const ev = buildEvent(ctx, input);
  appendEvent(ev, env, onError);
  buffer.push(ev);
  return ev;
}

// Flush the buffered events to control (best-effort). Called once at run finalize.
// Drains the in-process buffer unconditionally: this is the only forward attempt
// for these events (there is no cross-run replay). On a forward failure they stay
// durable in the local jsonl (the source of truth for `mla stats`); only the remote
// rollup misses them, reported as unknown rather than zero (INV-GLOBAL-UNKNOWN-1).
export async function flushAnalyticsEvents(
  cfg: CliConfig,
  env: NodeJS.ProcessEnv = process.env,
  onError?: (err: unknown) => void,
  timeoutMs?: number,
): Promise<ForwardResult> {
  const pending = buffer;
  buffer = [];
  if (pending.length === 0) {
    return {
      attempted: 0,
      forwarded: 0,
      skippedConsent: false,
      skippedNotEmittable: 0,
      failed: 0,
    };
  }
  return forwardEvents(cfg, pending, env, onError, timeoutMs);
}

// Test-only: drop any buffered events so suites don't bleed state across cases.
export function resetRecorderForTesting(): void {
  buffer = [];
}

// Test/inspection: a copy of the current buffer.
export function peekBuffer(): AnalyticsEvent[] {
  return [...buffer];
}
