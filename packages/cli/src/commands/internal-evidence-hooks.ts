// The CE0 hook subcommands: the live wiring between Claude Code's UserPromptSubmit,
// PostToolUse, and Stop hooks and the CE0 durable store
// (notes/20260617-evidence-consultation-forcing-function-proposal.md §4.1, the one
// remaining durable-layer piece). The managed ce0-*.sh hooks pipe their raw hook stdin
// into one of these subcommands; each is a thin IO shell over a committed adapter.
//
// Every subcommand obeys the same RECORD_ONLY discipline as the adapters it wraps:
//   - It ALWAYS writes the empty `{}` body to stdout and exits 0. It can never inject an
//     additionalContext, never deny, never block a turn. Injection is a CE2 concern that
//     demands a new immutable rule version; CE0 is a measurement harness.
//   - It is dormant when no workspace resolves (a repo CE0 is not bound to): it opens no
//     store and writes nothing, it just emits the pass-through body. The workspace
//     resolution IS the activation gate; the scripts carry no activation check.
//   - It fails soft on every error. Malformed stdin, a missing store directory, a
//     persistence fault: all are swallowed, leaving the clean `{}` exit-0 pass-through.
//     A CE0 bookkeeping failure must never disturb the turn it observed.
//
// The subcommands take no argv flags (the hook pipes everything on stdin), mirroring
// `_internal pretool-observe`.

import * as fs from "fs";
import * as path from "path";
import { performance } from "perf_hooks";

import { defaultCe0StorePath } from "./evidence";
import { resolveWorkspaceIdWithEnv } from "../lib/workspace";
import { openCe0Store, closeCe0Store, type Ce0Store } from "../lib/rules/ce0-store";
import { observeUserPromptSubmit } from "../lib/rules/prompt-submit-adapter";
import { captureMemoryConsultation } from "../lib/rules/consultation-capture-adapter";
import { observeStop } from "../lib/rules/stop-adapter";
import { resolveActiveRuntimeScopeId } from "../lib/rules/runtime-scope";
import { resolveConsultEvidenceRuleBinding } from "../lib/rules/consult-evidence-binding";
import {
  buildEvidenceHookHealthEvent,
  buildEvidenceConsultationCompletedEvent,
} from "../lib/rules/ce0-telemetry";
import { emitCe0Event } from "../lib/rules/ce0-emit";
import type { Ce0Hook } from "../lib/analytics/envelope";
import type { RecordInput } from "../lib/analytics/recorder";

/** The single response a CE0 hook is ever allowed to emit: the empty no-decision body. */
const CE0_HOOK_PASS_THROUGH = "{}";

/** What a hook body did, surfaced back to the shared shell so it can emit the §6.4 health event.
 * `operationIdentity` is the stable per-hook coordinate the hook acted on (assessmentId, consultationId,
 * or the rendered LocalTurnIdentity). It is ABSENT when the invocation produced no coordinate (an INFRA
 * outcome, a NOT_APPLICABLE / non-governed no-op): with no operationIdentity the health event cannot form
 * its deterministic eventId (§6.4 P0.2), so the shell emits nothing for a coordinate-less invocation. */
interface Ce0HookBodyResult {
  operationIdentity?: string;
  /** The §6.4 PRIMARY event this hook produced (e.g. evidence_consultation_completed), to emit alongside
   * the health watchdog. ABSENT when the invocation produced no primary fact. It is appended BEFORE the
   * health event so the health durationMs covers the primary append, and shares the health event's
   * fail-soft local-append delivery. */
  primaryEvent?: RecordInput;
}

/** The IO + activation seams every CE0 hook subcommand shares. Defaults are the real
 * stdin reader, stdout writer, workspace resolver, and store opener; tests inject all. */
export interface Ce0HookIo {
  readStdin?: () => Promise<string>;
  writeOut?: (s: string) => void;
  resolveWorkspaceId?: () => string | undefined;
  /** The active runtime scope id the consult-evidence obligation binds to (P0.51). Production
   * realpath-resolves the checkout root; tests inject a fixed scope to arm/disarm the rule. Used by
   * turn-open (to stamp the obligation's version identity) and Stop (to claim it). */
  resolveRuntimeScopeId?: (cwd?: string) => string;
  storePath?: string;
  openStore?: (dbPath: string) => Ce0Store;
  /** The fail-soft live-telemetry sink for the §6.4 evidence_hook_health event. */
  emit?: typeof emitCe0Event;
  /** Wall clock for the telemetry envelope's emitted-at (ISO). Defaults to Date.now. */
  now?: () => number;
  /** Monotonic clock for the health event's hook-entry-to-append durationMs (§6.4 P0.2). Defaults to
   * perf_hooks performance.now; injected in tests for a deterministic duration. */
  monotonicNowMs?: () => number;
}

function readStdinReal(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (c: Buffer) => chunks.push(c));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
}

/** Best-effort pull of the hook payload's session_id; null when stdin is absent or malformed. The
 * STOP operationIdentity and the telemetry envelope both join on it, so it is parsed once in the shell. */
function parseSessionId(raw: string): string | null {
  try {
    const p = JSON.parse(raw) as { session_id?: unknown };
    return typeof p.session_id === "string" ? p.session_id : null;
  } catch {
    return null;
  }
}

/**
 * The shared IO shell for every CE0 hook subcommand. Reads stdin best-effort, resolves the
 * workspace (the activation gate), opens the store, runs `body`, closes the store, and ALWAYS
 * writes the empty pass-through body + returns exit 0. Every fault is swallowed so the hook
 * never blocks a turn. `body` runs one adapter (discarding its injection-free response) and returns
 * the coordinate it acted on; when a coordinate is present the shell appends the §6.4 evidence_hook_health
 * watchdog event via the fail-soft live-telemetry sink (durable store write already committed; telemetry
 * is strictly best-effort on top, P0.2).
 */
async function runCe0Hook(
  io: Ce0HookIo,
  hook: Ce0Hook,
  body: (store: Ce0Store, workspaceId: string, raw: string, sessionId: string | null) => Ce0HookBodyResult,
): Promise<number> {
  const monotonicNow = io.monotonicNowMs ?? ((): number => performance.now());
  const enteredAtMs = monotonicNow();
  const writeOut = io.writeOut ?? ((s: string) => process.stdout.write(s));
  let raw = "";
  try {
    raw = await (io.readStdin ?? readStdinReal)();
  } catch {
    raw = "";
  }
  const sessionId = parseSessionId(raw);
  try {
    const workspaceId = (io.resolveWorkspaceId ?? resolveWorkspaceIdWithEnv)();
    if (workspaceId) {
      const dbPath = io.storePath ?? defaultCe0StorePath();
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      const store = (io.openStore ?? openCe0Store)(dbPath);
      let result: Ce0HookBodyResult;
      try {
        result = body(store, workspaceId, raw, sessionId);
      } finally {
        closeCe0Store(store);
      }
      const emit = io.emit ?? emitCe0Event;
      const now = io.now ?? Date.now;
      const coords = { workspaceId, sessionId, nowMs: now() };
      // The primary event (the fact the hook produced) ships first; the health watchdog's monotonic
      // durationMs is sampled after, so it covers the primary append (§6.4 P0.2).
      if (result.primaryEvent) {
        emit(result.primaryEvent, coords);
      }
      if (result.operationIdentity) {
        const durationMs = Math.round(monotonicNow() - enteredAtMs);
        const event = buildEvidenceHookHealthEvent({
          hook,
          operationIdentity: result.operationIdentity,
          durationMs,
          failed: false,
          reason: null,
        });
        emit(event, coords);
      }
    }
  } catch {
    // Fail-soft: a CE0 record (or telemetry) failure must never escalate into a blocking hook.
  }
  writeOut(CE0_HOOK_PASS_THROUGH);
  return 0;
}

/** Deps for the UserPromptSubmit hook: the shared IO plus the adapter's clock + id minter. */
export interface EvidenceTurnOpenDeps extends Ce0HookIo {
  now?: () => number;
  newId?: (kind: "assessment" | "obligation") => string;
}

/**
 * `mla _internal evidence-turn-open` -- the UserPromptSubmit hook entry. Classifies the
 * turn's memory requirement, persists its assessment, and (only for a REQUIRED turn) creates
 * the turn's TurnRuleObligation. Always emits `{}` exit 0.
 */
export async function runInternalEvidenceTurnOpen(
  _argv: string[],
  deps: EvidenceTurnOpenDeps = {},
): Promise<number> {
  return runCe0Hook(deps, "USER_PROMPT_SUBMIT", (store, workspaceId, raw) => {
    // Resolve the obligation's rule identity from the active runtime scope (P0.51): the LIVE attested
    // consult-evidence version when an operator has armed this checkout, the frozen compile-time identity
    // otherwise. The obligation is stamped with whichever this returns, so arming binds with no behavior
    // change (the rule stays RECORD_ONLY -- arming only gives the obligation a durable version to claim).
    const runtimeScopeId = (deps.resolveRuntimeScopeId ?? resolveActiveRuntimeScopeId)();
    const ruleBinding = resolveConsultEvidenceRuleBinding(store, runtimeScopeId);
    const { outcome } = observeUserPromptSubmit(raw, {
      store,
      workspaceId,
      ruleBinding,
      now: deps.now,
      newId: deps.newId,
    });
    // §6.4: the UserPromptSubmit health event's operation identity is the assessmentId of the turn it
    // opened. An INFRA outcome opened no turn and has no assessmentId, so it emits no health event.
    return { operationIdentity: outcome.kind === "ASSESSED" ? outcome.assessmentId : undefined };
  });
}

/** Deps for the PostToolUse hook: the shared IO plus the adapter's clock + id minter. */
export interface EvidenceCaptureDeps extends Ce0HookIo {
  now?: () => number;
  newId?: () => string;
}

/**
 * `mla _internal evidence-capture` -- the PostToolUse hook entry. When the agent calls a
 * governed-memory pull, records the FACT of that consultation as a ConsultationAttempt under
 * the live turn's identity; a non-governed tool is a no-op. Always emits `{}` exit 0.
 */
export async function runInternalEvidenceCapture(
  _argv: string[],
  deps: EvidenceCaptureDeps = {},
): Promise<number> {
  return runCe0Hook(deps, "CONSULTATION_CAPTURE", (store, workspaceId, raw) => {
    const { outcome } = captureMemoryConsultation(raw, {
      store,
      workspaceId,
      now: deps.now,
      newId: deps.newId,
    });
    if (outcome.kind !== "CAPTURED") {
      // A non-governed tool (NOT_APPLICABLE) or an INFRA outcome records no consultation: no primary event
      // and no operation identity, so the shell emits nothing for this invocation (§6.4 P0.2).
      return {};
    }
    // §6.4: a governed-memory pull emits one evidence_consultation_completed primary event keyed by the
    // consultationId, plus the health watchdog under the same consultationId. A CE0 capture carries neither
    // a rule version (the obligation is finalized offline) nor a timed retrieval latency, so both stay
    // absent (R4 P1.2 / P0.2). delivered_to_answering_context is true: the agent pulled the evidence into
    // its own answering context, mirroring the persisted ConsultationAttempt row.
    const primaryEvent = buildEvidenceConsultationCompletedEvent({
      consultationId: outcome.consultationId,
      localTurnSequence: outcome.localTurnSequence,
      source: outcome.source,
      execution: outcome.execution,
      result: outcome.result,
      deliveredToAnsweringContext: true,
    });
    return { operationIdentity: outcome.consultationId, primaryEvent };
  });
}

/**
 * `mla _internal evidence-stop` -- the Stop hook entry. The first Stop of a turn runs §2.3's two
 * stages: Stage A stamps stopObservedAt and freezes the obligation's eligibility boundary at the
 * high-water consultation token (I/O-free), then Stage B best-effort snapshots the response from the
 * payload's transcript_path. A later Stop is an idempotent no-op on both. The boundary is a stored
 * token and the clock defaults to Date.now inside the adapter, so this entry needs no minter. Always
 * emits `{}` exit 0.
 */
export async function runInternalEvidenceStop(
  _argv: string[],
  deps: Ce0HookIo = {},
): Promise<number> {
  return runCe0Hook(deps, "STOP", (store, workspaceId, raw, sessionId) => {
    // Re-resolve the same binding the turn-open adapter stamped the obligation with (P0.51): claimFirstStop
    // joins the obligation on (ws, session, seq, ruleVersionId), so the Stop MUST claim with the active
    // runtime scope's bound version (the LIVE attested one when armed, the frozen compile-time identity
    // when unarmed), or it would orphan the armed obligation and never freeze its boundary. This is the
    // symmetric Stop half of the binding; the rule stays RECORD_ONLY (the version only gives Stop a durable
    // identity to claim against).
    const runtimeScopeId = (deps.resolveRuntimeScopeId ?? resolveActiveRuntimeScopeId)();
    const ruleBinding = resolveConsultEvidenceRuleBinding(store, runtimeScopeId);
    const { outcome } = observeStop(raw, { store, workspaceId, ruleVersionId: ruleBinding.ruleVersionId });
    // §6.4: the Stop health event's operation identity is the rendered LocalTurnIdentity of the turn it
    // claimed (`${workspaceId}:${sessionId}:${localTurnSequence}`). CLAIMED/ALREADY_CLAIMED carry the
    // localTurnSequence but not the workspace or session, so the shell composes the key from the body's
    // workspaceId and the parsed sessionId. A NOT_APPLICABLE / INFRA Stop claimed no obligation and a
    // sessionId-less payload cannot form the key, so either emits no health event.
    const claimed = outcome.kind === "CLAIMED" || outcome.kind === "ALREADY_CLAIMED";
    const operationIdentity =
      claimed && sessionId !== null ? `${workspaceId}:${sessionId}:${outcome.localTurnSequence}` : undefined;
    return { operationIdentity };
  });
}
