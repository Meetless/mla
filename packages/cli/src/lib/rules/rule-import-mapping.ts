/**
 * Pure mapping from the two LEGACY local rule stores into the unified backend importer's
 * contract (notes/20260627-rules-store-unification-backend-sot-proposal.md §3, §7 step 2).
 *
 * The CLI owns two pre-unification stores (§3):
 *
 *   1. `.meetless/rules.md` MANAGED rules: human-accepted durable conventions, checked into
 *      the repo and shared via git, injected as confirmedRulesXml. They are NOT enforced at
 *      action time (no CE0 evaluator backs them). `managedRulesToImportRules` converts each to
 *      a single ambient / OBSERVE / unsupported-evaluator RulePayloadV1 that is structurally
 *      incapable of asking or denying (triple-safe, see managedRuleToRulePayload), so importing
 *      them changes their authority store but never their (zero) enforcement behavior.
 *
 *   2. CE0 SQLite `local_rule_version`: the per-operator ENFORCEMENT authority written by
 *      `mla rules attest` / `revoke`. `ce0VersionsToImportRules` brings the FULL version history
 *      (not just LIVE) so a revoked / superseded legacy versionId still resolves after migration
 *      (acceptance 18). Each version's canonicalPayloadHash and sourceVersionId are carried
 *      VERBATIM; the backend trusts the supplied hash and PreToolUse recomputes it with this same
 *      ruleVersionHash, so end-to-end integrity holds (acceptance 4).
 *
 * This module is PURE: no I/O, no clock, no network. Timestamps (managed-rule file mtime) are
 * injected by the command so the mapping is deterministic and unit-testable.
 *
 * FORK ASSUMPTIONS (flagged for An's review; the CLI cannot do better today):
 *
 *   - authorityScope. Managed rules are committed-to-repo / shared-via-git, so they map to
 *     TEAM (ownerUserId = null). CE0 versions are a single operator's local enforcement store,
 *     so they map to PERSONAL owned by the attesting human (the oldest version's attestor is the
 *     node originator). This matches §4.1 ownership semantics.
 *
 *   - projectId is FORCED to null for EVERY imported rule. The CLI has no project-activation
 *     concept; its only scoping primitive is runtimeScopeId, a git-checkout fingerprint that
 *     §4.1 explicitly forbids using as a projectId. null is therefore the only buildable value.
 *     For a CE0 rule this BROADENS a per-checkout DENY into an all-projects personal DENY for
 *     that owner (an over-enforcement change); for a managed rule it is benign because the
 *     converted payload never enforces. If An wants per-checkout applicability preserved, the
 *     CLI needs a real project-activation concept first.
 */
import type { ManagedRule } from "../scanner/managed-rules";
import { ruleVersionHash } from "./rule-version-hash";
import type { RulePayloadV1, TurnTrigger } from "./types";
import type { LocalRuleVersionRecord } from "./local-rule-version-repo";
import type { ImportRuleInput, ImportRuleVersionInput } from "./control-rule-client";

/** The deterministic sourceVersionId for a managed rule's single converted version. */
export function managedRuleSourceVersionId(managedRuleId: string): string {
  return `mr-v1-${managedRuleId}`;
}

/**
 * Convert one managed rule to the TRIPLE-SAFE RulePayloadV1 that can never ask or deny at action
 * time. Three independent guarantees, any one of which alone suffices:
 *   - applicability is AMBIENT (not action-scoped), so the PreToolUse matcher never selects it.
 *   - the compliance evaluator is unrecognized ("none"), so evaluation resolves UNSUPPORTED ->
 *     UNKNOWN, and UNKNOWN never asks or denies.
 *   - enforcementCeiling is OBSERVE, the lowest authority, which caps any verdict to observe-only.
 * Every field is a fixed v1-pilot constant except `text` (the convention) and `strength` (carried
 * from the managed rule), so two operators importing the same managed rule mint a byte-identical
 * payload and the same hash.
 *
 * TURN VARIANT (targeted-rule-injection §5.3). When `trigger` is supplied the applicability becomes
 * `{ mode: "turn", trigger }` instead of ambient; every other field (the triple-safe none/OBSERVE/
 * runtimeInject shape) is IDENTICAL, so a turn rule is exactly as incapable of asking or denying as
 * an ambient one. Only the DELIVERY filter changes: a turn rule is injected on matching turns rather
 * than every turn. When `trigger` is omitted the payload is byte-for-byte the historical ambient one
 * (the managed-rule import and every legacy caller keep their exact output).
 *
 * WRITE-BEFORE-READ SEQUENCING HAZARD (targeted-rule-injection §3.6, §7). A `{ mode: "turn" }` payload
 * is SAFE only once EVERY reader in the deployment understands the turn branch: the P2 read boundary
 * (`injectionTupleOK`) + the `buildStructuredRules` partition, and the P3 `assemble.ts` `matchesTrigger`.
 * If a turn payload reaches a pre-Layer-B reader it is injectable (runtimeInject) but trigger-less and
 * glob-less to that reader, so `buildStructuredRules` classifies it as floor = ambient EVERY turn (the
 * exact every-turn tax the feature removes), and once it is a MUST the marker reservation can trip the
 * base invariant and drop the whole turn to the bash fallback. That is why P0-P3 ship as ONE release,
 * the `mla rules add/edit --turn-when-*` options stay hidden from help until the full read+assemble
 * path is in the build, and no production turn rule is written to the store until the release is
 * deployed to every environment that reads the store (P4 performs the single live migration).
 */
export function managedRuleToRulePayload(
  managed: ManagedRule,
  runtimeScopeId: string,
  trigger?: TurnTrigger,
): RulePayloadV1 {
  return {
    text: managed.statement,
    applicability: trigger ? { mode: "turn", trigger } : { mode: "ambient" },
    compliance: {
      evaluatorContractVersion: "none",
      matcherSchemaVersion: "none",
      pathCanonicalizerVersion: "none",
      config: { forbiddenRootRelativePath: "" },
    },
    effect: "REQUIRE",
    strength: managed.strength,
    deliveryChannels: ["runtimeInject"],
    enforcementCeiling: "OBSERVE",
    infrastructureFailurePolicy: "PASS_WITH_ALERT",
    runtimeScopeId,
    payloadSchemaVersion: "rule-payload-v1",
    canonicalSerializationVersion: "v1",
  };
}

export interface ManagedImportOptions {
  /** The active runtime scope the converted payloads bind to (and hash within). */
  runtimeScopeId: string;
  /** The historical attestation timestamp (ISO 8601), e.g. the rules file mtime. */
  attestedAt: string;
}

/**
 * Map `.meetless/rules.md` managed rules to importer rules. Each becomes a one-version ACTIVE
 * TEAM rule (ownerUserId null, projectId null). The single version carries attestedByUserId =
 * null (a managed rule records no per-version attesting human) and the injected attestedAt. The
 * hash is computed from the converted payload with ruleVersionHash so the backend's verbatim
 * hash matches what PreToolUse would recompute. Deterministic and idempotent: same rule ->
 * same sourceRuleId, sourceVersionId, payload, and hash.
 */
export function managedRulesToImportRules(
  rules: readonly ManagedRule[],
  opts: ManagedImportOptions,
): ImportRuleInput[] {
  return rules.map((managed) => {
    const payload = managedRuleToRulePayload(managed, opts.runtimeScopeId);
    const sourceVersionId = managedRuleSourceVersionId(managed.id);
    return {
      sourceRuleId: managed.id,
      authorityScope: "TEAM",
      ownerUserId: null,
      projectId: null,
      lifecycleStatus: "ACTIVE",
      currentSourceVersionId: sourceVersionId,
      versions: [
        {
          sourceVersionId,
          canonicalPayloadHash: ruleVersionHash(payload),
          payload: payload as unknown as Record<string, unknown>,
          attestedByUserId: null,
          attestedAt: opts.attestedAt,
        },
      ],
    };
  });
}

/** Stable ascending compare of two version rows by (attestedAt, versionId). */
function byAttestedThenId(a: LocalRuleVersionRecord, b: LocalRuleVersionRecord): number {
  if (a.attestedAt !== b.attestedAt) return a.attestedAt < b.attestedAt ? -1 : 1;
  return a.versionId < b.versionId ? -1 : a.versionId > b.versionId ? 1 : 0;
}

/**
 * Map CE0 `local_rule_version` rows to importer rules. Rows are grouped by ruleId (first-seen
 * order preserved for a stable batch) and each group is sorted oldest-first by (attestedAt,
 * versionId) so the backend rebuilds the supersedes chain in the right order. Per rule:
 *
 *   - authorityScope PERSONAL; ownerUserId = the oldest version's attestor (the originator).
 *   - projectId null (fork assumption above).
 *   - lifecycleStatus ACTIVE with currentSourceVersionId = the single LIVE version when one
 *     exists; otherwise REVOKED with a null current pointer (the versions are still imported for
 *     historical resolution). The one-LIVE-per-(scope, rule) schema invariant means at most one
 *     LIVE row per group.
 *
 * Each version carries its versionId, canonicalPayloadHash, parsed payload, attestor, and
 * timestamp VERBATIM. The payload is parsed from the opaque stored JSON string; a row whose
 * rule_payload is not valid JSON throws (the importer must not silently drop a legacy rule).
 */
export function ce0VersionsToImportRules(
  rows: readonly LocalRuleVersionRecord[],
): ImportRuleInput[] {
  const groups = new Map<string, LocalRuleVersionRecord[]>();
  for (const row of rows) {
    const existing = groups.get(row.ruleId);
    if (existing) {
      existing.push(row);
    } else {
      groups.set(row.ruleId, [row]);
    }
  }

  const out: ImportRuleInput[] = [];
  for (const [ruleId, groupRows] of groups) {
    const ordered = [...groupRows].sort(byAttestedThenId);
    const live = ordered.find((r) => r.lifecycleStatus === "LIVE") ?? null;
    const versions: ImportRuleVersionInput[] = ordered.map((row) => ({
      sourceVersionId: row.versionId,
      canonicalPayloadHash: row.canonicalPayloadHash,
      payload: parsePayload(row),
      attestedByUserId: row.attestedBy,
      attestedAt: row.attestedAt,
    }));
    out.push({
      sourceRuleId: ruleId,
      authorityScope: "PERSONAL",
      ownerUserId: ordered[0].attestedBy,
      projectId: null,
      lifecycleStatus: live ? "ACTIVE" : "REVOKED",
      currentSourceVersionId: live ? live.versionId : null,
      versions,
    });
  }
  return out;
}

function parsePayload(row: LocalRuleVersionRecord): Record<string, unknown> {
  try {
    return JSON.parse(row.rulePayload) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `CE0 rule ${row.ruleId} version ${row.versionId} has an unparseable rule_payload: ${
        (err as Error).message
      }`,
    );
  }
}
