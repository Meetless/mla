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
import { projectEligibleEnforcement } from "./deny-admission";
import type { EvaluationTarget } from "./evaluation-input-hash";
import { selectRule, type ToolCall } from "./evaluator";
import { classifyRuntimeTarget } from "./notes-path";
import type { RulePayloadV1 } from "./types";
import { versionBackedVerdict } from "./version-evaluation";

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

/** Per-entry resolution: DENY (fresh block), ASK (stale-degraded or native ask), or null (not selected). */
type EntryDecision =
  | { kind: "DENY"; reason: string; targetPath: string | null; ruleText: string }
  | { kind: "ASK"; reason: string; degraded: boolean }
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

  if (selectRule(call, app) === "NOT_APPLICABLE") return null;

  const target = await classify(call.toolInput[app.matcher.field], runtimeProjectRoot);
  const verdict = versionBackedVerdict(payload, target);
  const eligible = projectEligibleEnforcement(verdict.result, payload.enforcementCeiling);
  if (eligible === "OBSERVE") return null;
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
  const entries = [...read.bundle.rules].sort((a, b) => (a.ruleNodeId < b.ruleNodeId ? -1 : a.ruleNodeId > b.ruleNodeId ? 1 : 0));

  let ask: { reason: string; ruleNodeId: string; ruleVersionId: string; degraded: boolean } | null = null;
  for (const entry of entries) {
    let decided: EntryDecision;
    try {
      decided = await evaluateEntry(entry, input.call, input.runtimeProjectRoot, classify, stale);
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
    if (ask === null) {
      ask = { reason: decided.reason, ruleNodeId: entry.ruleNodeId, ruleVersionId: entry.ruleVersionId, degraded: decided.degraded };
    }
  }
  if (ask !== null) {
    return { kind: "ASK", reason: ask.reason, ruleNodeId: ask.ruleNodeId, ruleVersionId: ask.ruleVersionId, degraded: ask.degraded };
  }
  return { kind: "PASS" };
}
