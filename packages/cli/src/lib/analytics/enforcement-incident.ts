// Enforcement-incident emit seam (the deny tile,
// notes/20260627-mla-product-health-dashboard-posthog-metrics.md §5.1).
//
// The local-append-only bridge between the PreToolUse enforcement branches and the generic
// analytics spool.
//
// THIS IS THE ACTIVE AUDIT PATH, and it is the only one. Corrected 2026-08-05: this header used to
// say "the durable EnforcementAttempt row already recorded the deny; this telemetry is strictly
// best-effort on top of it." That has not been true since enforcement moved to the backend rule
// bundle. The device-local SQLite tables it referred to (`tool_attempt` and `rule_evaluation_record`
// in ~/.meetless/ce0/evidence.db) stopped receiving rows on 2026-06-29, predating every incident now
// in the control queue, and their CHECK constraints cannot even represent WARN, which carries the
// majority of live incidents. Nothing writes them and no active reader requires them. Do not revive
// them without evidence that one does.
//
// The full active path:
//
//   hook -> synchronous local append to ~/.meetless/events.jsonl
//        -> detached forwarding
//        -> control.analytics_events
//        -> enforcement review surfaces (`mla enforcement`, the console review queue)
//
// Two invariants hold across it:
//
//   - Local-append-only: the hook NEVER makes a synchronous network call. recordAnalyticsEvent
//     appends to the local jsonl and buffers for the detached forward; remote delivery is that
//     path's job, and a forwarding failure after a successful append never blocks the hook.
//   - NEVER THROWS, but no longer silently swallows. The append reports success through its return
//     value so each caller can choose: a warn ignores it, and a hard deny WITHHOLDS THE BLOCK
//     (INV-8 requires a complete audit record before blocking, so a block we cannot evidence is an
//     authority we are not entitled to assert).
//
// Difference from ce0-emit: where CE0 SKIPS when there is no ambient run/trace (a CE0 line
// that cannot join the enrichment is worse than none), an enforcement incident is rare and
// high-value and self-joins by incident_id, so we MINT a run/trace when the fast path did not
// bootstrap one rather than drop the event.

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
  type EnforcementCeiling,
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
  /** The ceiling the human ATTESTED the deciding rule at, snapshotted at incident creation. Required
   * on every producer (deny and warn alike) so a ceiling-less incident is a compile error rather than
   * a silent gap; `enforcement-ceiling.spec.ts` pins that both branches supply it. Kept separate from
   * `decision` on purpose: see EnforcementIncidentPayload.enforcement_ceiling. */
  enforcementCeiling: EnforcementCeiling;
  /** INV-8 consent state. "overridden" means a human redeemed a single-use, action-scoped grant and
   * the block was withheld. Absent means the block stood, which is the overwhelming majority, so the
   * field stays off those rows rather than carrying a noisy "none". */
  consentState?: "overridden";
  /** The user's answer to an ASK prompt. Only "unknown" is possible today; the host exposes no
   * permission outcome to a hook. Set on ask rows so the absence of an answer is RECORDED rather
   * than merely missing. */
  askOutcome?: "unknown";
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
 * The event id for one enforcement LIFECYCLE STAGE of one incident.
 *
 * Two properties have to hold at once, and keying on the incident id alone gave only the first:
 *
 *   1. A RETRIED delivery of the same stage must dedup. control.analytics_events has eventId as its
 *      primary key, so a deterministic id is what makes at-least-once forwarding exactly-once.
 *   2. A DIFFERENT stage of the same incident must NOT dedup. The block and the human override that
 *      answers it deliberately share an incident id (one enforcement episode, which is the honest
 *      model), but they are different events.
 *
 * Found live on 2026-08-05: the block and its override both hashed to ccf3fae51aea...29a, so the
 * override was silently DISCARDED AT INGEST by the primary key. The episode read back from control
 * as though no override had ever happened, which is precisely the accountability hole the consent
 * record exists to close.
 *
 * Namespacing the stage fixes it without minting a second incident id, and follows the shape already
 * used by the outcome event (`enf-outcome:<id>`) and the adjudication event (`enf-adj:<id>:<uuid>`).
 */
export function enforcementIncidentEventId(
  incidentId: string,
  consentState?: "overridden",
): string {
  return consentState
    ? deterministicEventId(`enf-consent:${incidentId}`, 0)
    : deterministicEventId(incidentId, 0);
}

/**
 * Append one enforcement-incident event to the local analytics spool under a "hook" run-context
 * envelope, and REPORT whether the append landed.
 *
 * Returns true when the durable local row exists, false on any fault. It never throws, so a caller
 * can never be broken by telemetry; the boolean is the only channel. The deny branch treats false as
 * "withhold the block" and the warn branch ignores it, which is the whole INV-8 asymmetry in one
 * value.
 *
 * The event_id is deterministic on the incident id, so a re-fired hook and a retried forward both
 * dedup instead of minting a second incident.
 */
export function emitEnforcementIncident(
  input: EnforcementIncidentInput,
  coords: EnforcementIncidentCoords,
  deps: EnforcementIncidentDeps = {},
): boolean {
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
      // Snapshotted at creation from the rule that fired, never joined later. Unconditional (not
      // presence-guarded like rule_node_id/rule_text below) because the input type requires it, so
      // every current producer supplies it and a future one cannot silently omit it.
      enforcement_ceiling: input.enforcementCeiling,
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
    // The consent dimension (INV-8). Present only on an overridden block, so the absence of the key
    // honestly means "the block stood" rather than "we did not look". A closed enum, safe to project.
    if (input.consentState) {
      payload.consent_state = input.consentState;
    }
    // Only on an ask. A deny or warn carrying "ask_outcome" would be nonsense, and an ask WITHOUT it
    // would read as "we forgot" rather than "the host cannot tell us".
    if (input.askOutcome) {
      payload.ask_outcome = input.askOutcome;
    }

    const record = deps.record ?? recordAnalyticsEvent;
    // The append's success is REPORTED rather than swallowed. The caller decides what it means:
    // a warn ignores it (the advisory is already non-blocking, so a spool fault costs a measurement),
    // and a hard deny withholds the block (INV-8 requires a complete audit record BEFORE blocking,
    // so an unauditable block asserts an authority we cannot evidence). Still never THROWS: the
    // return value is the only channel, so no caller can be broken by telemetry.
    let appended = true;
    record(
      ctx,
      {
        eventType: "mla_enforcement_incident",
        payload: payload as unknown as Record<string, unknown>,
        eventId: enforcementIncidentEventId(input.incidentId, input.consentState),
      },
      deps.env ?? process.env,
      () => {
        appended = false;
      },
    );
    return appended;
  } catch {
    // Never throws. A fault is reported as "not appended" so the caller can degrade deliberately.
    return false;
  }
}
