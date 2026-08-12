// Onboarding-offer emit seam (P0-3 of
// notes/20260805-onboarding-reachability-and-aha-proposal.md).
//
// WHY THIS EXISTS, stated as the concrete failure it prevents. On 2026-08-02 we diagnosed the
// onboarding funnel correctly and shipped the SessionStart nudge. Four days later production had
// run 1,320 mla commands and ZERO onboarding runs, and we could not tell which of two opposite
// things was true:
//
//   offers rendered ~= 0    the trigger is not firing.        Fix the TRIGGER.
//   offers rendered high,   the ask is being read and ignored. Fix the ASK, or remove the human
//   conversions ~= 0        from the path entirely.
//
// The nudge emitted nothing, so neither number existed. The funnel was only visible at all
// because someone queried it from the far end a week later. A mitigation that cannot be measured
// cannot be iterated, and shipping a second one blind would repeat the mistake exactly.
//
// ONE EVENT, NOT TWO. There is no companion `offer_accepted` row and there should not be:
// `mla enrich <plan|ingest>` is an ordinary command that already emits its own `mla_command`
// (only `_internal` subcommands are dropped from that funnel, see capture.ts). So conversion is
// this row joined to a later enrich row in the same session, computed rather than instrumented.
//
// It mirrors onboarding-finding.ts and upholds the same two invariants:
//   - Local-append-only: no synchronous network call on the emit path.
//   - Fail-soft: any fault is swallowed. This row exists to MEASURE a nudge, never to be able to
//     break the session start that carries it.
//
// The event is content-free by construction: closed enums and counts only. No path, no filename,
// no rule text, and deliberately no corpus size (INV-POSTHOG-PII-1).

import { readConfig, type CliConfig } from "../config";
import { machineId } from "./store";
import { getRepoFingerprint, getRunId, getRunTraceId, mintRunId, mintTraceId } from "../observability";
import { deterministicEventId } from "./event-id";
import { recordAnalyticsEvent, type RecordContext } from "./recorder";
import type {
  OnboardingOfferCorpusState,
  OnboardingOfferPayload,
  OnboardingOfferSurface,
} from "./envelope";

/**
 * The classified, PII-safe facts of one rendered offer.
 *
 * The three seed counters are OPTIONAL because only a seeding surface can honestly report them.
 * Omit them at a surface that runs no seed (`retrieval_empty`): they emit as null and drop at the
 * projector, which is the truthful mirror of "no seed ran here". Passing 0/false instead would
 * assert a seed ran, found nothing, and succeeded.
 */
export interface OnboardingOfferInput {
  surface: OnboardingOfferSurface;
  corpusState: OnboardingOfferCorpusState;
  seededDocuments?: number | null;
  instructionFilesPresent?: number | null;
  seedFailed?: boolean | null;
}

/** The turn coordinate + emission clock the event needs beyond its own payload. */
export interface OnboardingOfferCoords {
  workspaceId: string | null;
  sessionId: string | null;
  /** Epoch ms at emission; becomes the envelope's ISO created_at/emitted_at. */
  nowMs: number;
}

/** Injection seams (all default to the real implementations; tests pin them). */
export interface OnboardingOfferDeps {
  record?: typeof recordAnalyticsEvent;
  readCfg?: () => CliConfig | null;
  machineId?: () => string;
  runId?: string | null;
  traceId?: string | null;
  repoFingerprint?: string | null;
  env?: NodeJS.ProcessEnv;
}

/**
 * Append one onboarding-offer event to the local analytics spool.
 *
 * The event_id is deterministic on (surface, session), so the SAME surface speaking twice in one
 * session dedups on control's (workspace_id, event_id) pair instead of inflating the render count
 * that the acceptance RATE divides by. That matters concretely here: an inflated denominator makes
 * a working ask look like a failing one, which is the precise direction that would get a good
 * mitigation killed by its own kill criterion.
 *
 * A sessionless invocation (a bare terminal `mla activate`) falls back to the run id, which is
 * unique per invocation. Two offers from one session then count twice, which is the honest answer
 * when we cannot prove they shared a session.
 */
export function emitOnboardingOffer(
  input: OnboardingOfferInput,
  coords: OnboardingOfferCoords,
  deps: OnboardingOfferDeps = {},
): void {
  try {
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
      distinctId: cfg?.actorUserId ?? mId,
      runId,
      traceId,
      source: "cli",
      actorWorkspaceUserId: cfg?.actorUserId ?? null,
      repoFingerprint: deps.repoFingerprint ?? getRepoFingerprint(),
      now: new Date(coords.nowMs).toISOString(),
    };

    const payload: OnboardingOfferPayload = {
      offer_surface: input.surface,
      offer_corpus_state: input.corpusState,
      // Clamped to a non-negative integer: these reach a dashboard, and a NaN from a caller's
      // arithmetic would poison an average rather than announce itself. Null passes through as
      // null (see OnboardingOfferInput): a surface that ran no seed reports nothing rather than
      // a zero that would read as a measurement.
      seeded_documents: input.seededDocuments == null ? null : safeCount(input.seededDocuments),
      instruction_files_present:
        input.instructionFilesPresent == null ? null : safeCount(input.instructionFilesPresent),
      seed_failed: input.seedFailed == null ? null : input.seedFailed === true,
    };

    const record = deps.record ?? recordAnalyticsEvent;
    record(
      ctx,
      {
        eventType: "mla_onboarding_offer",
        payload: payload as unknown as Record<string, unknown>,
        eventId: deterministicEventId(
          `onboarding-offer:${input.surface}:${coords.sessionId ?? runId}`,
          0,
        ),
      },
      deps.env ?? process.env,
      () => {
        /* fail-soft: a metrics append must never fail the session start it observed. */
      },
    );
  } catch {
    // Fail-soft: this row exists to measure the offer, never to be able to break it.
  }
}

function safeCount(n: number): number {
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}
