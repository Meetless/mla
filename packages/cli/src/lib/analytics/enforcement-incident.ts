// Enforcement-incident emit seam (the deny tile,
// notes/20260627-mla-product-health-dashboard-posthog-metrics.md §5.1).
//
// The fail-soft, local-append-only bridge between the PreToolUse deny branch and the
// generic analytics spool. It mirrors ce0-emit.ts and upholds the same two invariants:
//
//   - Local-append-only: the hook NEVER makes a synchronous network call. recordAnalyticsEvent
//     appends to the local jsonl and buffers for the existing detached forward; remote
//     delivery is that path's job.
//   - Fail-soft: any fault (no config, a spool append fault, a build throw) is swallowed and
//     never escalates into the blocked turn. The durable EnforcementAttempt row already
//     recorded the deny; this telemetry is strictly best-effort on top of it.
//
// Difference from ce0-emit: where CE0 SKIPS when there is no ambient run/trace (a CE0 line
// that cannot join the enrichment is worse than none), a deny is rare and high-value and
// SELF-JOINS to its durable audit row via incident_id, so we MINT a run/trace when the fast
// path did not bootstrap one rather than drop the event.

import { readConfig, type CliConfig } from "../config";
import { machineId } from "./store";
import {
  getRepoFingerprint,
  getRunId,
  getRunTraceId,
  mintRunId,
  mintTraceId,
} from "../observability";
import { deterministicEventId } from "./event-id";
import { recordAnalyticsEvent, type RecordContext } from "./recorder";
import {
  type EnforcedTool,
  type EnforcementDecision,
  type EnforcementIncidentPayload,
  type TouchedSurface,
} from "./envelope";

/** The classified, PII-safe facts of one fired deny. */
export interface EnforcementIncidentInput {
  /** The durable EnforcementAttempt id (a ULID); also the event's business key. */
  incidentId: string;
  decision: EnforcementDecision;
  tool: EnforcedTool;
  touchedSurface: TouchedSurface;
  ruleVersionId: string;
  /** The deciding rule NODE id (stable across version cutovers, unlike the version id). Lets control
   * resolve the human rule NAME (sourceRuleId) even after the fired version is superseded or the rule
   * store is cut over. Opaque id, not PII. Omitted (older builds) leaves the row name-less. */
  ruleNodeId?: string | null;
  /** The deciding rule's own statement, snapshotted at block time. Immutable evidence: the review queue
   * reads it directly instead of joining a version id that can rot. Authored rule content, not user PII;
   * dropped from PostHog by the fail-closed allowlist (INV-POSTHOG-PII-1). Omitted for non-file/legacy
   * denies. */
  ruleText?: string | null;
  /** The runtime-relative path the rule blocked (never absolute, micro-decision A); null when the
   * target was not a runtime-relative file. Gives the review queue the WHAT behind each deny so the
   * operator can adjudicate. Allowlist-projected out of PostHog (INV-POSTHOG-PII-1), stored for the
   * console review surface only. */
  blockedPath?: string | null;
}

/** The turn coordinate + emission clock the event needs beyond its own payload. */
export interface EnforcementIncidentCoords {
  workspaceId: string | null;
  sessionId: string | null;
  /** Epoch ms at emission; becomes the envelope's ISO created_at/emitted_at. */
  nowMs: number;
}

/** Injection seams (all default to the real implementations; tests pin them). */
export interface EnforcementIncidentDeps {
  record?: typeof recordAnalyticsEvent;
  readCfg?: () => CliConfig | null;
  machineId?: () => string;
  runId?: string | null;
  traceId?: string | null;
  repoFingerprint?: string | null;
  env?: NodeJS.ProcessEnv;
}

/**
 * Append one enforcement-incident event to the local analytics spool under a "hook"
 * run-context envelope. Fail-soft and local-append-only: any fault is swallowed so a
 * telemetry failure never disturbs the deny. The event_id is deterministic on the
 * incident id so a re-fired hook dedups instead of double-counting the deny.
 */
export function emitEnforcementIncident(
  input: EnforcementIncidentInput,
  coords: EnforcementIncidentCoords,
  deps: EnforcementIncidentDeps = {},
): void {
  try {
    // A deny self-joins via incident_id, so mint a run/trace when absent rather than drop.
    const traceId = deps.traceId ?? getRunTraceId() ?? mintTraceId();
    const runId = deps.runId ?? getRunId() ?? mintRunId();

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
    const mId = (deps.machineId ?? machineId)();

    const ctx: RecordContext = {
      workspaceId: coords.workspaceId,
      sessionId: coords.sessionId,
      // Prefer the configured actor; else the hashed machine id (workspace-scoped
      // anonymous, never end-user PII).
      distinctId: cfg?.actorUserId ?? mId,
      runId,
      traceId,
      source: "hook",
      actorWorkspaceUserId: cfg?.actorUserId ?? null,
      repoFingerprint: deps.repoFingerprint ?? getRepoFingerprint(),
      now: new Date(coords.nowMs).toISOString(),
    };

    const payload: EnforcementIncidentPayload = {
      incident_id: input.incidentId,
      decision: input.decision,
      enforced_tool: input.tool,
      touched_surface: input.touchedSurface,
      rule_version_id: input.ruleVersionId,
      // Born unreviewed; an offline labeler supersedes (deterministic id keyed at v0,
      // a re-label emits v1+).
      review_status: "unreviewed",
    };
    // Attach the deciding rule's NODE id and STATEMENT only when present, so pre-capture events and
    // legacy denies stay lean. Both are snapshotted evidence: rule_node_id lets control resolve the human
    // rule name even after a version cutover, and rule_text is the block reason itself, so the review
    // queue never depends on a version-id join that rots. Both are dropped by the fail-closed PostHog
    // projector allowlist (INV-POSTHOG-PII-1); they live here purely for the console review queue.
    if (typeof input.ruleNodeId === "string" && input.ruleNodeId.length > 0) {
      payload.rule_node_id = input.ruleNodeId;
    }
    if (typeof input.ruleText === "string" && input.ruleText.length > 0) {
      payload.rule_text = input.ruleText;
    }
    // Attach the blocked path only when present so pre-capture events and non-file denies stay lean.
    // A raw path key is dropped by the fail-closed PostHog projector allowlist; it lives here purely
    // for the control-served console review queue.
    if (typeof input.blockedPath === "string" && input.blockedPath.length > 0) {
      payload.blocked_path = input.blockedPath;
    }

    const record = deps.record ?? recordAnalyticsEvent;
    record(
      ctx,
      {
        eventType: "mla_enforcement_incident",
        payload: payload as unknown as Record<string, unknown>,
        eventId: deterministicEventId(input.incidentId, 0),
      },
      deps.env ?? process.env,
      () => {
        /* fail-soft: an enforcement-telemetry append must never escalate into a blocking hook. */
      },
    );
  } catch {
    // Fail-soft: enforcement telemetry must never disturb the turn it observed.
  }
}
