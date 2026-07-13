// The §6 PreToolUse enforcement decision, computed from the principal-bound rule bundle
// (P1G / G4 of the rules-store unification,
// notes/20260627-rules-store-unification-backend-sot-proposal.md). Post-cutover this is the
// ONE enforcement path: the local CE0 LocalRuleVersion store is no longer consulted at action time.
//
// The pure evaluation primitives (selectRule, classifyRuntimeTarget, versionBackedVerdict,
// projectEligibleEnforcement) are run over the bundle entries the backend stamped as the human-attested
// LIVE rule set, served lease-bound through the zero-network cache. The bundle is server-authoritative
// and lease-stamped, so this path does NOT re-run the local CE0 input-authority (P0.58) / attested-path-root
// (P0.63) admission gates: the lease IS the staleness gate, and the three bundle-cache guards (principal
// binding, freshness ordering, per-entry integrity) already ran in readRuleBundleCache.
//
// Three states are load-bearing and mirror the bundle cache's three safe directions (§6.3, §6.4):
//
//   - UNAVAILABLE: no usable bundle at all (missing / corrupt / wrong-principal / schema mismatch). The
//     runtime holds no rules, so it MUST NOT claim enforcement is active (§6.3, acceptance 15). The hook
//     wiring maps this to a pass-through: nothing to enforce, nothing to inject.
//   - DENY: a fresh bundle carries a PROHIBIT forbidden-root DENY rule the call VIOLATES. A hard block.
//   - ASK: the SAME match but the bundle is STALE (offline past its DENY lease): every expired DENY
//     degrades to a single human confirmation scoped to this one action (§6.4, acceptance 17), never an
//     enforced block on a possibly-revoked rule. A natively-ASK ceiling also resolves here regardless of
//     freshness.
//   - PASS: a usable bundle with no DENY/ASK rule selected for this call.
//
// PURE: no I/O, no store, no clock of its own. The bundle cache read, the runtime project root, and the
// path classifier are all supplied by the caller, so this decision is fully unit-testable with real
// bundle fixtures and the real hasher (no mocks).

import type { BundleCacheRead } from "./bundle-cache";
import type { RuleBundleEntry } from "./control-rule-client";
import { type EligibleEnforcement, projectEligibleEnforcement } from "./deny-admission";
import type { EvaluationTarget } from "./evaluation-input-hash";
import { selectRule, type ToolCall } from "./evaluator";
import { matchesGlob } from "./glob-match";
import { classifyRuntimeTarget } from "./notes-path";
import type { RulePayloadV1 } from "./types";
import { versionBackedVerdict } from "./version-evaluation";
import { deriveWriteTargets, isWriteCapableTool } from "./write-targets";

/** The PreToolUse decision. DENY/ASK carry the deciding rule's node + version identity so the
 * caller can stamp deny telemetry; UNAVAILABLE carries the diagnostic reason; PASS carries nothing. */
export type BundleEnforceDecision =
  | {
      kind: "DENY";
      reason: string;
      ruleNodeId: string;
      ruleVersionId: string;
      // The runtime-relative path the block was about (micro-decision A: NEVER the
      // absolute path). null when the target was not a runtime-relative file. Carried
      // so the deny incident records WHAT was blocked, the evidence the review queue
      // needs. Dropped by control's fail-closed PostHog projector (INV-POSTHOG-PII-1).
      targetPath: string | null;
      // The deciding rule's own statement (RulePayloadV1.text), snapshotted at block
      // time. The incident records WHICH rule fired as immutable evidence, so the review
      // queue never depends on a later version-id join that rots when the rule store is
      // cut over or the version is superseded. Authored rule content, not user PII; still
      // dropped from PostHog by the fail-closed allowlist (INV-POSTHOG-PII-1).
      ruleText: string;
    }
  | { kind: "ASK"; reason: string; ruleNodeId: string; ruleVersionId: string; degraded: boolean }
  // The non-blocking middle rung (INV-8). One or more VIOLATIONs whose attested ceiling is WARN, with
  // no DENY or ASK outranking them. `reason` is the already-aggregated, cap-honored advisory body the
  // hook renders as model-facing additionalContext (never a permissionDecision); `count` is how many
  // rules warned (>= the number of reasons shown, since the cap may have suppressed some) so the render
  // and any future telemetry can note suppression honestly.
  | { kind: "WARN"; reason: string; count: number }
  | { kind: "UNAVAILABLE"; reason: string }
  | { kind: "PASS" };

export interface BundleEnforceInput {
  /** The parsed tool invocation (toolName + toolInput) from the PreToolUse payload. */
  call: ToolCall;
  /** The principal-bound bundle cache read (fresh | stale | unavailable). */
  read: BundleCacheRead;
  /** The activated runtime project root (absolute); relative targets resolve from here. */
  runtimeProjectRoot: string;
  /** Runtime-scope path classifier; defaults to the real filesystem canonicalizer. Injected in tests. */
  classifyRuntime?: (rawFilePath: unknown, runtimeProjectRoot: string) => Promise<EvaluationTarget>;
  /**
   * The session's ceiling cap (the `MEETLESS_ACTION_INTERCEPT_MAX` kill switch). Every rule's eligible
   * enforcement is clamped to at most this rung, so a `WARN`-capped session can never ASK or DENY and an
   * `ASK`-capped session can never DENY. Defaults to `DENY` (uncapped). Headless callers set `WARN`
   * because `ask` is undefined/aborts without a TTY: capping to WARN turns every would-be block into a
   * non-blocking advisory instead of aborting the run.
   */
  maxEnforcement?: EligibleEnforcement;
}

/** The "no usable bundle" copy the runtime surfaces when it holds no rules (§6.3, acceptance 15). */
export const RULE_PROTECTION_UNAVAILABLE = "rule protection unavailable";

/** Describe the would-be-written target for the operator-facing reason. */
function describeTarget(target: EvaluationTarget): string {
  return target.kind === "RUNTIME_RELATIVE" ? target.path : "the requested file";
}

/** The runtime-relative path for capture (micro-decision A). null for a non-relative
 * target, so an absolute path is never captured. */
function runtimeRelativePath(target: EvaluationTarget): string | null {
  return target.kind === "RUNTIME_RELATIVE" ? target.path : null;
}

/** The hard-block reason. Same prose shape as the legacy CE0 deny so the operator sees one block voice. */
function buildBundleDenyReason(entry: RuleBundleEntry, payload: RulePayloadV1, target: EvaluationTarget): string {
  const where = describeTarget(target);
  const forbidden = payload.compliance.config.forbiddenRootRelativePath;
  return `Blocked by Meetless rule ${entry.ruleNodeId}. Writing ${where} under the forbidden "${forbidden}/" root is prohibited. ${payload.text}`;
}

/** The degrade-to-ASK reason: a DENY that cannot be enforced on a stale lease, asking for one confirmation. */
function buildDegradedAskReason(entry: RuleBundleEntry, payload: RulePayloadV1, target: EvaluationTarget): string {
  const where = describeTarget(target);
  const forbidden = payload.compliance.config.forbiddenRootRelativePath;
  return (
    `Meetless rule ${entry.ruleNodeId} would block writing ${where} under the forbidden "${forbidden}/" root, ` +
    `but its rule bundle is stale (offline past its lease), so this needs your explicit confirmation. ${payload.text}`
  );
}

/** The native-ASK reason: a ceiling the human attested as ASK, surfacing one confirmation prompt. */
function buildAskReason(entry: RuleBundleEntry, payload: RulePayloadV1, target: EvaluationTarget): string {
  const where = describeTarget(target);
  const forbidden = payload.compliance.config.forbiddenRootRelativePath;
  return `Meetless rule ${entry.ruleNodeId} asks you to confirm writing ${where} under the "${forbidden}/" root. ${payload.text}`;
}

/** The non-blocking WARN reason: a VIOLATION whose attested ceiling is WARN. Advises but never gates,
 * so the copy names the concern and leaves the correction to the agent (INV-8: no false-positive block). */
function buildWarnReason(entry: RuleBundleEntry, payload: RulePayloadV1, target: EvaluationTarget): string {
  const where = describeTarget(target);
  const forbidden = payload.compliance.config.forbiddenRootRelativePath;
  return `Meetless rule ${entry.ruleNodeId}: writing ${where} under the "${forbidden}/" root is discouraged. ${payload.text}`;
}

// The authority ladder as an ordinal so eligibility can be clamped to the session ceiling cap. The
// order is load-bearing (OBSERVE < WARN < ASK < DENY, deny-admission.ts): clamping to a lower rung is
// exactly "never escalate past this authority", the semantics the MEETLESS_ACTION_INTERCEPT_MAX kill
// switch promises.
const ENFORCEMENT_RANK: Record<EligibleEnforcement, number> = { OBSERVE: 0, WARN: 1, ASK: 2, DENY: 3 };

/** Clamp an eligible enforcement to at most `max`. A DENY under a WARN cap becomes WARN; an ASK under a
 * WARN cap becomes WARN; nothing is ever escalated. `max` defaults to DENY (uncapped) at the call site. */
function clampEnforcement(eligible: EligibleEnforcement, max: EligibleEnforcement): EligibleEnforcement {
  return ENFORCEMENT_RANK[eligible] <= ENFORCEMENT_RANK[max] ? eligible : max;
}

/** No-spam cap on how many distinct WARN reasons are surfaced in one aggregated advisory. Beyond this,
 * the surplus is summarized ("(and N more ...)") rather than dumped, so a bundle with many WARN rules
 * cannot flood a single tool call. */
export const WARN_AGGREGATE_CAP = 3;

/** Aggregate the collected WARN reasons into one advisory body, honoring the no-spam cap. */
function aggregateWarnReasons(reasons: string[]): string {
  if (reasons.length <= WARN_AGGREGATE_CAP) return reasons.join("\n\n");
  const shown = reasons.slice(0, WARN_AGGREGATE_CAP);
  const suppressed = reasons.length - WARN_AGGREGATE_CAP;
  return `${shown.join("\n\n")}\n\n(and ${suppressed} more governed-rule warning(s) on this action)`;
}

/** Per-entry resolution: DENY (fresh block), ASK (stale-degraded or native ask), WARN (non-blocking
 * advisory), or null (not selected). */
type EntryDecision =
  | { kind: "DENY"; reason: string; targetPath: string | null; ruleText: string }
  | { kind: "ASK"; reason: string; degraded: boolean }
  | { kind: "WARN"; reason: string }
  | null;

/**
 * Evaluate ONE bundle entry against the call. Returns null unless the entry is an enforceable PROHIBIT
 * forbidden-root action rule that (a) is delivered to the preToolUse surface, (b) selects this call, and
 * (c) projects (through the rule's evaluation result and attested ceiling) to a DENY or ASK. The PROHIBIT
 * forbidden-root family is conflict-free by construction (§2.0), so collapsing across entries is sound.
 */
async function evaluateEntry(
  entry: RuleBundleEntry,
  call: ToolCall,
  runtimeProjectRoot: string,
  classify: (rawFilePath: unknown, runtimeProjectRoot: string) => Promise<EvaluationTarget>,
  stale: boolean,
  maxEnforcement: EligibleEnforcement,
): Promise<EntryDecision> {
  // A surviving bundle entry already passed re-hashing, so its payload is a structurally valid
  // RulePayloadV1; narrow defensively anyway so a malformed entry degrades to "not selected", never throws.
  const payload = entry.payload as RulePayloadV1;
  const app = payload.applicability;
  if (payload.effect !== "PROHIBIT" || app.mode !== "action") return null;
  const forbidden = payload.compliance?.config?.forbiddenRootRelativePath;
  if (typeof forbidden !== "string" || forbidden.length === 0) return null;
  // The preToolUse surface enforces only rules delivered to it. A rule routed solely to nativeRule /
  // runtimeInject must never produce an action-time block; the safe direction is PASS (do not enforce).
  if (!Array.isArray(payload.deliveryChannels) || !payload.deliveryChannels.includes("preToolUse")) return null;

  // A forbidden-root rule is a statement about a PATH ("never create or edit any file
  // under <root>/"), so it must hold against EVERY tool that can write that path — not
  // only the two the attestation named. Gating on `applicability.tools` turned the rule
  // into "…using Write or Edit", and on 2026-07-11 our own benchmark watched an agent
  // step around it in one move: Write -> DENIED, then `Bash: cat > notes/design.md` ->
  // succeeded, because the hook never fired. Enforcement that only stops the compliant
  // is not enforcement.
  //
  // `selectRule` is still the authority for the ATTESTED tools (unchanged semantics for
  // Write/Edit). Beyond them we admit any write-capable tool and derive its real write
  // targets. Read-only tools derive nothing and fall out here.
  const attested = selectRule(call, app) === "APPLIES";
  if (!attested && !isWriteCapableTool(call.toolName)) return null;

  const rawTargets = deriveWriteTargets(call);
  if (rawTargets.length === 0) return null;
  // Honour an attested glob per candidate path, so a narrowed rule stays narrow.
  const candidates =
    app.matcher.glob === undefined
      ? rawTargets
      : rawTargets.filter((p) => matchesGlob(p, app.matcher.glob as string));
  if (candidates.length === 0) return null;

  // A single call can write several paths (`tee a b`, `cp x y z dir/`). One violating
  // path is enough: take the first, so the reason names a concrete file.
  let target: EvaluationTarget | null = null;
  let verdict: ReturnType<typeof versionBackedVerdict> | null = null;
  for (const raw of candidates) {
    const t = await classify(raw, runtimeProjectRoot);
    const v = versionBackedVerdict(payload, t);
    if (v.result === "VIOLATION") {
      target = t;
      verdict = v;
      break;
    }
    // Remember the first evaluated target so a non-violating call still reports coherently.
    if (target === null) {
      target = t;
      verdict = v;
    }
  }
  if (target === null || verdict === null) return null;
  // Clamp the attested ceiling to the session cap BEFORE branching, so a WARN-capped session never
  // reaches the DENY/ASK arms (a would-be block becomes the non-blocking advisory instead) and an
  // ASK-capped session never reaches DENY. The clamp only ever lowers, never escalates.
  const eligible = clampEnforcement(projectEligibleEnforcement(verdict.result, payload.enforcementCeiling), maxEnforcement);
  if (eligible === "OBSERVE") return null;
  if (eligible === "WARN") {
    // Non-blocking (INV-8): a WARN never degrades and never blocks, so bundle freshness is irrelevant.
    return { kind: "WARN", reason: buildWarnReason(entry, payload, target) };
  }
  if (eligible === "DENY") {
    return stale
      ? { kind: "ASK", reason: buildDegradedAskReason(entry, payload, target), degraded: true }
      : {
          kind: "DENY",
          reason: buildBundleDenyReason(entry, payload, target),
          targetPath: runtimeRelativePath(target),
          ruleText: payload.text,
        };
  }
  // eligible === "ASK": a natively-attested ASK ceiling, surfaced regardless of bundle freshness.
  return { kind: "ASK", reason: buildAskReason(entry, payload, target), degraded: false };
}

/**
 * Decide the PreToolUse outcome for one call against the cached bundle.
 *
 * UNAVAILABLE when there is no usable bundle (the runtime holds no rules and must not claim enforcement,
 * §6.3). Otherwise the entries are faced in ruleNodeId order (deterministic single block, mirroring the
 * legacy single-deny dispatch): the first VIOLATION on a fresh bundle is the hard DENY and short-circuits; on a
 * stale bundle every such DENY degrades to ASK, so the lowest-id match becomes the single confirmation
 * (§6.4). When no DENY/ASK rule selects this call, the action PASSes. A malformed single entry degrades
 * to "not selected" (skip), never a throw, so one bad entry can never brick the rest of the bundle.
 */
export async function decideBundleEnforcement(input: BundleEnforceInput): Promise<BundleEnforceDecision> {
  const { read } = input;
  if (read.status === "unavailable" || read.bundle === null) {
    return { kind: "UNAVAILABLE", reason: read.reason ?? RULE_PROTECTION_UNAVAILABLE };
  }

  const stale = read.status === "stale";
  const classify = input.classifyRuntime ?? classifyRuntimeTarget;
  // The session ceiling cap (MEETLESS_ACTION_INTERCEPT_MAX). Absent => DENY (uncapped): the pure kernel
  // stays uncapped by default; the IO shell reads the env var and passes WARN for headless callers.
  const maxEnforcement = input.maxEnforcement ?? "DENY";
  const entries = [...read.bundle.rules].sort((a, b) => (a.ruleNodeId < b.ruleNodeId ? -1 : a.ruleNodeId > b.ruleNodeId ? 1 : 0));

  let ask: { reason: string; ruleNodeId: string; ruleVersionId: string; degraded: boolean } | null = null;
  const warns: string[] = [];
  for (const entry of entries) {
    let decided: EntryDecision;
    try {
      decided = await evaluateEntry(entry, input.call, input.runtimeProjectRoot, classify, stale, maxEnforcement);
    } catch {
      // One unparseable / faulty entry must never block the hook nor mask the rest of the bundle.
      continue;
    }
    if (decided === null) continue;
    if (decided.kind === "DENY") {
      return {
        kind: "DENY",
        reason: decided.reason,
        ruleNodeId: entry.ruleNodeId,
        ruleVersionId: entry.ruleVersionId,
        targetPath: decided.targetPath,
        ruleText: decided.ruleText,
      };
    }
    if (decided.kind === "WARN") {
      // WARN outranks nothing: collect ALL of them (in ruleNodeId order) so they aggregate into one
      // advisory. DENY/ASK, if any also selected, still win below.
      warns.push(decided.reason);
      continue;
    }
    if (ask === null) {
      ask = { reason: decided.reason, ruleNodeId: entry.ruleNodeId, ruleVersionId: entry.ruleVersionId, degraded: decided.degraded };
    }
  }
  if (ask !== null) {
    return { kind: "ASK", reason: ask.reason, ruleNodeId: ask.ruleNodeId, ruleVersionId: ask.ruleVersionId, degraded: ask.degraded };
  }
  if (warns.length > 0) {
    return { kind: "WARN", reason: aggregateWarnReasons(warns), count: warns.length };
  }
  return { kind: "PASS" };
}
