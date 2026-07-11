// `mla _internal pretool-observe` (A1: make the R1 notes-location pilot live). The managed
// pre-tool-use.sh hook pipes its raw PreToolUse stdin into this subcommand and forwards whatever it
// writes on stdout back to Claude Code as the hook response.
//
// The decision is computed from the principal-bound backend rule bundle (§6): it emits a real deny on
// the wire when, and ONLY when, a bundle rule matches the call and its lease admits enforcement, an ASK
// when a stale-degraded or natively-attested ceiling applies, and the empty pass-through otherwise.
// Two invariants are load-bearing:
//
//   1. The decision is COMPUTED from the rule evaluation, never reflected from the input. A payload that
//      smuggles a `hookSpecificOutput.permissionDecision` cannot survive into stdout: the only deny this
//      command can emit is the one `decideBundleEnforcement` returns against the bundle, with a reason
//      the enforcement seam builds, never the attacker's string.
//
//   2. The hook can never block on infrastructure. A PreToolUse exit 2 (or a thrown error, or a missing
//      `mla`) would block the tool; we must never do that. Every failure path (unreadable stdin,
//      malformed payload, an unavailable bundle, a throwing dependency) fails OPEN to the exit-0
//      pass-through. The decision travels in the JSON body, never the exit code.

import {
  type ActiveConflict,
  type ConflictGateMode,
  readActiveConflicts,
  resolveConflictGateMode,
} from "../lib/active-conflict-cache";
import {
  type EnforceHookResponse,
  type EnforceOutcome,
  type EvaluateAndEnforceInput,
} from "../lib/rules/enforce-notes-version";
import { type R0DurableOutcome } from "../lib/rules/durable-observation";
import { parsePreToolUseInput } from "../lib/rules/observe-adapter";
import { classifyTouchedSurface, normalizeEnforcedTool } from "../lib/analytics/enforcement-classify";
// Type-only: erased at compile, so the recorder graph stays off the pass-through hot path.
// The runtime emit is reached via a lazy import in defaultEmitIncident.
import {
  type EnforcementIncidentCoords,
  type EnforcementIncidentInput,
} from "../lib/analytics/enforcement-incident";
import { resolveActiveRuntimeScopeId } from "../lib/rules/runtime-scope";
import { resolveWorkspaceIdWithEnv } from "../lib/workspace";
// The hook faces the principal-bound backend bundle (the rule source of record). These are loaded
// eagerly (they are pure: no store, no network at import) so the decision reads as one path.
import { resolveBundlePrincipal } from "../lib/rules/bundle-principal";
import { readRuleBundleCache, type BundleCacheRead, type BundlePrincipal } from "../lib/rules/bundle-cache";
import { HOME } from "../lib/config";
import { decideBundleEnforcement } from "../lib/rules/bundle-enforce";
import { type EligibleEnforcement } from "../lib/rules/deny-admission";
import { type ToolCall } from "../lib/rules/evaluator";
import { ulid } from "../lib/rules/ulid";

// The empty pass-through response: exit-0, carries no `hookSpecificOutput`, hence grants nothing and
// decides nothing (the documented Claude Code no-decision body).
export const PRETOOL_PASS_THROUGH: Record<string, never> = {};

export interface PretoolObserveOutput {
  stdout: string;
  exitCode: number;
}

/**
 * Pure. Map the enforce seam's internal response to the Claude Code PreToolUse wire shape. A deny
 * becomes the documented `hookSpecificOutput` deny body; everything else is the empty pass-through.
 * Exit code is ALWAYS 0: the decision rides the body, never the exit code (an exit 2 would block).
 */
export function renderPreToolUseResponse(seam: EnforceHookResponse): PretoolObserveOutput {
  if ("permissionDecision" in seam && seam.permissionDecision === "deny") {
    return {
      stdout: JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: seam.reason,
        },
      }),
      exitCode: 0,
    };
  }
  return { stdout: JSON.stringify(PRETOOL_PASS_THROUGH), exitCode: 0 };
}

/**
 * Pure. Render the interactive ASK body (§6.4): a stale-degraded DENY or a natively-attested ASK ceiling
 * surfaces as the documented Claude Code `permissionDecision: "ask"` body, scoping a single human
 * confirmation to this one action. Exit code is ALWAYS 0 (the decision rides the body, never the exit
 * code).
 */
export function renderPreToolUseAsk(reason: string): PretoolObserveOutput {
  return {
    stdout: JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "ask",
        permissionDecisionReason: reason,
      },
    }),
    exitCode: 0,
  };
}

/** The two audiences of a non-blocking advisory: `systemMessage` is human-facing (shown to the
 * operator), `additionalContext` is model-facing (fed to the agent on its NEXT request). Both the
 * cross-session conflict warning and the governed-rule WARN produce this shape, so they can be
 * concatenated when both fire on one call. */
export interface AdvisoryParts {
  systemMessage: string;
  additionalContext: string;
}

/**
 * Pure. Render a non-blocking advisory (INV-8): a body carrying `systemMessage` + `additionalContext`
 * and NO `permissionDecision`, so the tool is PERMITTED and Claude Code falls through to its normal
 * permission flow. The `additionalContext` reaches the model on its next request (post-action, alongside
 * the tool result), so an advisory is a "you just did X, here is the concern" heads-up, never a
 * pre-execution block. Exit code is ALWAYS 0. The key order (systemMessage first, then hookSpecificOutput)
 * is byte-stable so the existing conflict-warning wire snapshot is preserved.
 */
export function renderAdvisory(parts: AdvisoryParts): PretoolObserveOutput {
  return {
    stdout: JSON.stringify({
      systemMessage: parts.systemMessage,
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: parts.additionalContext,
      },
    }),
    exitCode: 0,
  };
}

/**
 * Pure. Build the SOFT cross-session conflict warning parts (G8 / D1 §11.3, CRITICAL-5) for the
 * session's open conflicts. The body carries NO `permissionDecision`, so the tool is PERMITTED. The
 * `systemMessage` is the operator heads-up ("an open conflict touches this work, resolve it in /now")
 * and the `additionalContext` is the agent steer ("pause this line of work"). The hard default-deny is
 * DEFERRED (§0.1): a fail-closed gate on a possibly-stale snapshot would brick coding sessions, so this
 * surface only ever warns. The mode is named purely for transparency; it never gates the wire shape.
 */
function buildConflictWarningParts(conflicts: ActiveConflict[], mode: ConflictGateMode): AdvisoryParts {
  const first = conflicts[0];
  const extra = conflicts.length - 1;
  const more = extra > 0 ? ` (and ${extra} more open on this session)` : "";
  const systemMessage =
    `Meetless: a pending cross-session conflict touches this work. ` +
    `${first.reason} Case ${first.caseId}${more}. ` +
    `Resolve it in /now before relying on this change.`;
  const additionalContext =
    `Meetless D1 early warning (gate: ${mode}). ${conflicts.length} open ` +
    `cross-session conflict(s) on this session. ${first.reason} ` +
    `Case ${first.caseId} opened ${first.openedAt}${more}. ` +
    `This is advisory and the tool is permitted; pause this line of work and ` +
    `check /now for the human decision before continuing.`;
  return { systemMessage, additionalContext };
}

/**
 * Pure. Render the SOFT cross-session conflict warning. Byte-identical to the historical body (the
 * wire snapshot test pins this): builds the parts and renders the advisory shape.
 */
export function renderConflictWarning(
  conflicts: ActiveConflict[],
  mode: ConflictGateMode,
): PretoolObserveOutput {
  return renderAdvisory(buildConflictWarningParts(conflicts, mode));
}

/**
 * Pure. Build the governed-rule WARN parts (INV-8, the non-blocking middle rung). A VIOLATION whose
 * attested ceiling is WARN surfaces the rule's concern to both audiences but NEVER a `permissionDecision`,
 * so it can never false-positive-block. `reason` is already the aggregated, cap-honored advisory body from
 * `decideBundleEnforcement`.
 */
function buildRuleWarnParts(reason: string): AdvisoryParts {
  const systemMessage = `Meetless (advisory): ${reason}`;
  const additionalContext =
    `Meetless governed-rule warning (advisory, non-blocking). ${reason} ` +
    `The tool was permitted; this is a heads-up, not a block. If the action violated the rule, ` +
    `correct it (for example, write to the allowed location) before continuing.`;
  return { systemMessage, additionalContext };
}

/**
 * Pure. Render a governed-rule WARN as the non-blocking advisory body (allow + additionalContext, no
 * permissionDecision, exit 0). This is the wire form of the enforcement ladder's WARN rung.
 */
export function renderPreToolUseWarn(reason: string): PretoolObserveOutput {
  return renderAdvisory(buildRuleWarnParts(reason));
}

export interface PretoolObserveDeps {
  readStdin: () => Promise<string>;
  writeOut: (s: string) => void;
  /** The active runtime scope/root. Production realpath-resolves the checkout root. */
  resolveScope?: () => { runtimeScopeId: string; runtimeProjectRoot: string };
  /** Runtime-scope path classifier; production uses the real filesystem canonicalizer in the seam. */
  classifyRuntime?: EvaluateAndEnforceInput["classifyRuntime"];
  /** The mint/stamp clock; production reads the wall clock. */
  clock?: () => { now: number; createdAt: string };
  /** The session's open cross-session conflict snapshot reader (G8 / D1 §11.3,
   * CRITICAL-5). Production reads the zero-network active-conflict cache the
   * turn-boundary sync writes; tests inject a fixed set. */
  readConflicts?: (sessionId: string) => ActiveConflict[];
  /** The soft/hard gate-mode resolver (default soft; hard deferred per §0.1).
   * Production reads the env flag; tests pin the mode. */
  resolveGateMode?: () => ConflictGateMode;
  /** The deny-telemetry emitter (the deny tile, §5.1). Production lazy-imports the real
   * emit (so the recorder graph stays off the non-deny hot path) and is awaited so its
   * synchronous local append completes before the short-lived hook process exits; tests
   * inject a spy. Fail-soft is the emitter's own contract; the caller still guards. */
  emitIncident?: (
    input: EnforcementIncidentInput,
    coords: EnforcementIncidentCoords,
  ) => void | Promise<void>;
  /** The bundle principal (workspace + project + session user) the cache read is bound to. Production
   * resolves it from the active workspace + login; tests inject it. Null means no resolvable principal,
   * which fails open to the conflict-warning pass-through (the runtime holds no enforceable bundle). */
  resolvePrincipal?: () => BundlePrincipal | null;
  /** The principal-bound, lease-stamped rule bundle cache reader (zero-network). Production reads the
   * gitignored bundle from the home cache; tests inject a fixed read (fresh | stale | unavailable). */
  readBundle?: (principal: BundlePrincipal, nowMs: number) => BundleCacheRead;
  /** The session ceiling cap resolver (the `MEETLESS_ACTION_INTERCEPT_MAX` kill switch). Production reads
   * the env var; tests pin the cap. Absent/unset/unrecognized => DENY (uncapped), preserving current
   * behavior. Capping to WARN turns every would-be block into a non-blocking advisory. */
  resolveMaxEnforcement?: () => EligibleEnforcement;
}

function readStdinReal(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (c: Buffer) => chunks.push(c));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
}

const defaultDeps: PretoolObserveDeps = {
  readStdin: readStdinReal,
  writeOut: (s) => process.stdout.write(s),
};

/**
 * Compute the PreToolUse decision for one raw stdin payload from the principal-bound rule bundle (§6).
 * Resolves the bundle principal and reads its lease-bound cache (zero-network), then runs
 * `decideBundleEnforcement` over the bundle entries. DENY emits the deny tile and returns the hard
 * block; ASK returns the interactive confirmation body (§6.4); UNAVAILABLE (no usable bundle: the
 * runtime holds no rules) and PASS both fall through to the SOFT conflict-warning layer. Fails OPEN to
 * the pass-through on ANY error so the hook can never block a tool on infrastructure.
 */
async function computePretoolDecision(raw: string, deps: PretoolObserveDeps): Promise<PretoolObserveOutput> {
  try {
    const parsed = parsePreToolUseInput(raw);
    if (!parsed) return computeConflictWarning(raw, deps);
    const scope = (deps.resolveScope ?? defaultResolveScope)();
    const clock = (deps.clock ?? defaultClock)();
    const principal = (deps.resolvePrincipal ?? defaultResolvePrincipal)();
    // No resolvable principal means the runtime holds no enforceable bundle. The safe direction is the
    // advisory pass-through, never a block.
    if (principal === null) return computeConflictWarning(raw, deps);
    const read = (deps.readBundle ?? defaultReadBundle)(principal, clock.now);
    const call: ToolCall = { toolName: parsed.tool_name, toolInput: parsed.tool_input };
    const maxEnforcement = (deps.resolveMaxEnforcement ?? defaultResolveMaxEnforcement)();
    const decision = await decideBundleEnforcement({
      call,
      read,
      runtimeProjectRoot: scope.runtimeProjectRoot,
      classifyRuntime: deps.classifyRuntime,
      maxEnforcement,
    });
    if (decision.kind === "DENY") {
      // Reuse the one analytics append the deny tile reads (§5.1). The bundle decision is not an
      // EnforceOutcome, so synthesize the minimal DENIED telemetry source the emitter reads (a fresh
      // incident id + the deciding rule version + the runtime-relative blocked path). Awaited and
      // fail-soft.
      await emitDenyIncident(
        raw,
        {
          kind: "DENIED",
          attemptId: ulid(clock.now),
          ruleVersionId: decision.ruleVersionId,
          ruleNodeId: decision.ruleNodeId,
          ruleText: decision.ruleText,
          blockedPath: decision.targetPath,
        },
        clock.now,
        deps,
      );
      // Append the capture-time adjudication CTA so the operator can confirm/dismiss this block the
      // moment they see it, without hunting for the console review queue.
      return renderPreToolUseResponse({
        permissionDecision: "deny",
        reason: appendEnforcementHint(decision.reason),
      });
    }
    if (decision.kind === "ASK") {
      return renderPreToolUseAsk(decision.reason);
    }
    if (decision.kind === "WARN") {
      // The non-blocking middle rung (INV-8). Surface the governed-rule advisory and, when the session
      // also has an open cross-session conflict, concatenate both (they both ride additionalContext, so
      // the model reads them together on its next request). Never a permissionDecision: never a block.
      const warnParts = buildRuleWarnParts(decision.reason);
      const conflictParts = computeConflictWarningParts(raw, deps);
      if (conflictParts === null) return renderAdvisory(warnParts);
      return renderAdvisory({
        systemMessage: `${warnParts.systemMessage} ${conflictParts.systemMessage}`,
        additionalContext: `${warnParts.additionalContext}\n\n${conflictParts.additionalContext}`,
      });
    }
    // UNAVAILABLE | PASS: nothing to enforce. Layer the SOFT cross-session conflict warning.
    return computeConflictWarning(raw, deps);
  } catch {
    // No failure on the bundle path may escalate into a blocking hook decision.
    return renderPreToolUseResponse(PRETOOL_PASS_THROUGH);
  }
}

/**
 * The SOFT cross-session conflict warning layer. Runs only after the notes path
 * passes through (a notes deny already returned). Parses the session id from the raw
 * stdin, reads the session's zero-network open-conflict snapshot, and warns when one
 * is open. Fails OPEN to the pass-through on a missing session id, an empty or stale
 * snapshot, or ANY error: the warning is advisory, so silence is always the safe
 * direction. Synchronous (the snapshot read is a local file read, no network).
 *
 * The matcher pins this hook to Write|Edit, so the warning fires immediately before a
 * file mutation, the highest-value moment to interrupt work built on a contested
 * assumption. The turn-level open-time steer (§11.1) is the complementary channel that
 * reaches the agent regardless of which tool runs; this decision function is itself
 * tool-agnostic, so broadening the matcher later needs no change here.
 */
function computeConflictWarning(raw: string, deps: PretoolObserveDeps): PretoolObserveOutput {
  const parts = computeConflictWarningParts(raw, deps);
  if (parts === null) return renderPreToolUseResponse(PRETOOL_PASS_THROUGH);
  return renderAdvisory(parts);
}

/**
 * The parts of the SOFT conflict warning, or null when there is nothing to warn about. Split out from
 * `computeConflictWarning` so the WARN branch can concatenate the conflict advisory onto a governed-rule
 * warning (both ride additionalContext). Fails to null (no warning) on a missing session id, an empty or
 * stale snapshot, or ANY error: the warning is advisory, so silence is always the safe direction.
 */
function computeConflictWarningParts(raw: string, deps: PretoolObserveDeps): AdvisoryParts | null {
  try {
    const sessionId = parsePreToolUseInput(raw)?.session_id;
    if (!sessionId) return null;
    const readConflicts = deps.readConflicts ?? ((sid: string) => readActiveConflicts(sid));
    const conflicts = readConflicts(sessionId);
    if (conflicts.length === 0) return null;
    const mode = (deps.resolveGateMode ?? resolveConflictGateMode)();
    return buildConflictWarningParts(conflicts, mode);
  } catch {
    // The conflict warning is advisory; any fault degrades to no warning, never a block.
    return null;
  }
}

/** The minimal deny-telemetry source the incident emitter reads: the incident id, the deciding rule
 * version, and the runtime-relative blocked path. The bundle DENY narrows to this so it reuses the exact
 * same deny-tile append the historical `EnforceOutcome` DENIED variant fed, without fabricating any
 * per-rule hash fields. `blockedPath` is the runtime-relative target (never absolute, micro-decision A)
 * so the review queue can show WHAT was blocked; null when the target was not a runtime-relative file. */
type DenyIncidentSource = {
  kind: "DENIED";
  attemptId: string;
  ruleVersionId: string;
  // The deciding rule NODE id (stable across version cutovers) and its own STATEMENT, snapshotted at
  // block time so the review queue records WHICH rule fired as immutable evidence, not a version id that
  // rots. Both are runtime-relative-scope evidence, dropped from PostHog by the fail-closed allowlist.
  ruleNodeId: string;
  ruleText: string;
  blockedPath: string | null;
};

/** One-line CTA appended to every fired deny so the operator can adjudicate the block at the moment they
 * see it (the capture-time verdict path). The interactive PreToolUse hook cannot prompt y/n (it returns
 * JSON, no TTY), so the verdict is deferred to `mla enforcement`, which reuses control's adjudicate path. */
const ENFORCEMENT_ADJUDICATE_HINT =
  "Run `mla enforcement` to confirm or dismiss this block.";

function appendEnforcementHint(reason: string): string {
  return `${reason}\n\n${ENFORCEMENT_ADJUDICATE_HINT}`;
}

/**
 * Emit the enforcement-incident analytics event for one fired deny (the deny tile, §5.1).
 * Classifies the tool + blocked-path surface into PII-safe enums (the path never leaves the
 * device), resolves the workspace fail-open, and hands the built input/coords to the injected
 * emitter (production lazy-imports the real append-only emit). The whole thing is fail-soft: a
 * deny must never be turned into a thrown, blocking hook by a telemetry fault. The emitter is
 * awaited so its synchronous local append lands before this short-lived hook process exits.
 */
async function emitDenyIncident(
  raw: string,
  outcome: EnforceOutcome | R0DurableOutcome | DenyIncidentSource,
  nowMs: number,
  deps: PretoolObserveDeps,
): Promise<void> {
  try {
    // The deny response is only ever returned alongside a DENIED outcome (the enforce path);
    // guard defensively so a future shape change degrades to no-telemetry, never a wrong event.
    if (outcome.kind !== "DENIED") return;
    const parsed = parsePreToolUseInput(raw);
    const filePath =
      typeof parsed?.tool_input?.file_path === "string" ? parsed.tool_input.file_path : null;
    let workspaceId: string | null = null;
    try {
      workspaceId = resolveWorkspaceIdWithEnv() || null;
    } catch {
      workspaceId = null;
    }
    // Only the bundle DENY (DenyIncidentSource) carries the runtime-relative blocked path and the
    // snapshotted rule evidence (node id + text); the legacy EnforceOutcome / R0DurableOutcome variants do
    // not, so read all three presence-guarded and default to null. blockedPath is the ALREADY
    // runtime-relative path (micro-decision A) -- never the raw absolute file_path, which is used only to
    // classify the PII-safe surface enum and never persisted.
    const blockedPath = "blockedPath" in outcome ? outcome.blockedPath : null;
    const ruleNodeId = "ruleNodeId" in outcome ? outcome.ruleNodeId : null;
    const ruleText = "ruleText" in outcome ? outcome.ruleText : null;
    const input: EnforcementIncidentInput = {
      incidentId: outcome.attemptId,
      decision: "deny",
      tool: normalizeEnforcedTool(parsed?.tool_name),
      touchedSurface: classifyTouchedSurface(filePath),
      ruleVersionId: outcome.ruleVersionId,
      ruleNodeId,
      ruleText,
      blockedPath,
    };
    const coords: EnforcementIncidentCoords = {
      workspaceId,
      sessionId: parsed?.session_id ?? null,
      nowMs,
    };
    await (deps.emitIncident ?? defaultEmitIncident)(input, coords);
  } catch {
    // Fail-soft: deny telemetry must never escalate into a blocking hook.
  }
}

/** Production deny emitter: lazy-imports the recorder-touching emit so the non-deny hot path
 * never loads it, then performs the synchronous local append. Awaited by the caller. */
async function defaultEmitIncident(
  input: EnforcementIncidentInput,
  coords: EnforcementIncidentCoords,
): Promise<void> {
  const { emitEnforcementIncident } = await import("../lib/analytics/enforcement-incident");
  emitEnforcementIncident(input, coords);
  // The emit only appended locally + buffered for a forward that this exiting hook will
  // never run (recorder.ts: no cross-run replay, and the deny path exits before flush).
  // Hand delivery to a detached child so the incident actually reaches control's review
  // queue (INV-ENFORCEMENT-DELIVERY-1). Best-effort; never blocks or throws.
  const { spawnEnforcementForward } = await import("../lib/analytics/spawn-enforcement-forward");
  spawnEnforcementForward(coords.sessionId);
}

function defaultResolveScope(): { runtimeScopeId: string; runtimeProjectRoot: string } {
  const root = resolveActiveRuntimeScopeId();
  return { runtimeScopeId: root, runtimeProjectRoot: root };
}

function defaultClock(): { now: number; createdAt: string } {
  const now = Date.now();
  return { now, createdAt: new Date(now).toISOString() };
}

/**
 * Pure. Parse the `MEETLESS_ACTION_INTERCEPT_MAX` kill-switch value into the session ceiling cap. Only
 * `warn` | `ask` | `deny` (case-insensitive) are honored; anything else (unset, empty, or unrecognized)
 * yields `DENY` (uncapped) so the default preserves the current, notes-location-DENY-fires behavior. A
 * WARN cap turns every would-be block into a non-blocking advisory; an ASK cap forbids only DENY.
 */
export function parseMaxEnforcement(raw: string | undefined): EligibleEnforcement {
  switch ((raw ?? "").trim().toLowerCase()) {
    case "warn":
      return "WARN";
    case "ask":
      return "ASK";
    case "deny":
      return "DENY";
    default:
      return "DENY";
  }
}

function defaultResolveMaxEnforcement(): EligibleEnforcement {
  return parseMaxEnforcement(process.env.MEETLESS_ACTION_INTERCEPT_MAX);
}

/** Principal resolver: bind the bundle read to the active workspace + project + login session
 * (§6.1). Returns null on a missing workspace or ANY error, which the bundle path treats as "no
 * enforceable bundle" and degrades to the advisory pass-through, never a block. */
function defaultResolvePrincipal(): BundlePrincipal | null {
  try {
    const workspaceId = resolveWorkspaceIdWithEnv();
    if (!workspaceId) return null;
    return resolveBundlePrincipal(workspaceId);
  } catch {
    return null;
  }
}

/** The zero-network, principal-bound, lease-stamped bundle cache read (§6.3). The read itself never
 * throws (it returns an `unavailable` status on a missing / corrupt / wrong-principal bundle), so the
 * bundle path needs no extra guard here. */
export function defaultReadBundle(principal: BundlePrincipal, nowMs: number): BundleCacheRead {
  // The bundle cache lives under $MEETLESS_HOME (`HOME`, e.g. ~/.meetless), the same base the
  // steer-sync writer and the scanner read. `readRuleBundleCache` joins `home` + "rules" directly, so
  // `home` must already include the `.meetless` segment. Passing the raw os homedir() here would read
  // ~/rules/... (a directory that never exists) and silently degrade every DENY to a pass-through.
  return readRuleBundleCache(principal, { home: HOME, nowMs });
}

// IO shell. Reads stdin best-effort (a read failure still yields the pass-through body so the hook never
// blocks a tool), computes the decision, writes stdout, returns the exit code (always 0). Takes no argv.
export async function runInternalPretoolObserve(
  _argv: string[],
  deps: PretoolObserveDeps = defaultDeps,
): Promise<number> {
  let raw = "";
  try {
    raw = await deps.readStdin();
  } catch {
    // A stdin read error must never escalate into a blocking hook decision.
    raw = "";
  }
  const out = await computePretoolDecision(raw, deps);
  deps.writeOut(out.stdout);
  return out.exitCode;
}
