// src/lib/rules/mint-managed-rule.ts
//
// The ONE way a ManagedRule becomes a live RuleNode on the backend (the authority).
//
// Two commands mint: `mla rules add` (the operator types the convention) and `mla enrich accept`
// (the operator accepts a candidate an onboarding run found). Both produce the same artifact, so
// they must produce the same WIRE shape: the managed rule converted to the triple-safe
// RulePayloadV1, hashed once, with that one hash sent as BOTH the canonical payload hash (so the
// backend stores it verbatim and the read-path re-hash agrees) and the request idempotency key
// (recorded on the version for audit/forensics).
//
// The native mint does NOT dedup on requestIdempotencyKey: minting the same payload twice mints a
// second RuleNode. Callers that can plausibly be re-run over the same input (accept) therefore
// pre-filter with `managedRuleHash` against the hashes already live in the workspace; see
// `alreadyMintedHashes`.
import type { WorkspaceCliConfig } from "../config";
import type { ManagedRule } from "../scanner/managed-rules";
import {
  listRules,
  mintRule,
  type RuleAuthorityScope,
  type RuleClientHttp,
  type RuleNodeView,
} from "./control-rule-client";
import { managedRuleToRulePayload } from "./rule-import-mapping";
import { ruleVersionHash } from "./rule-version-hash";
import type { TurnTrigger } from "./types";

export interface MintManagedRuleOptions {
  /** PERSONAL enforces for the author alone; TEAM enforces workspace-wide (higher blast radius). */
  authorityScope: RuleAuthorityScope;
  /** The author, for PERSONAL only. The backend re-derives it (ownerUserId is a hint, INV-AUTH-1). */
  ownerUserId: string | null;
  /** The active runtime scope the payload binds to (and hashes within). */
  runtimeScopeId: string;
  /** Layer B turn trigger; absent means ambient (always injected). */
  trigger?: TurnTrigger;
}

export interface MintedManagedRule {
  node: RuleNodeView;
  /** The payload hash, sent as both canonicalPayloadHash and requestIdempotencyKey. */
  canonicalPayloadHash: string;
}

/** The content-derived identity of a managed rule ON THE WIRE, without minting it. */
export function managedRuleHash(
  managed: ManagedRule,
  runtimeScopeId: string,
  trigger?: TurnTrigger,
): string {
  return ruleVersionHash(managedRuleToRulePayload(managed, runtimeScopeId, trigger));
}

/** Mint one managed rule as a RuleNode on the backend. Throws the transport error on failure. */
export async function mintManagedRule(
  cfg: WorkspaceCliConfig,
  managed: ManagedRule,
  opts: MintManagedRuleOptions,
  http?: RuleClientHttp,
): Promise<MintedManagedRule> {
  const payload = managedRuleToRulePayload(managed, opts.runtimeScopeId, opts.trigger);
  const canonicalPayloadHash = ruleVersionHash(payload);
  const node = await mintRule(
    cfg,
    {
      workspaceId: cfg.workspaceId,
      authorityScope: opts.authorityScope,
      ownerUserId: opts.ownerUserId,
      projectId: null,
      payload: payload as unknown as Record<string, unknown>,
      canonicalPayloadHash,
      requestIdempotencyKey: canonicalPayloadHash,
    },
    http,
  );
  return { node, canonicalPayloadHash };
}

/**
 * The payload hashes already live in this workspace (as the caller can see them), so a re-run of a
 * minting command can skip what it already minted instead of duplicating it. The hash covers text,
 * strength, applicability and runtime scope, so a match is the same rule, not a lookalike.
 *
 * Best-effort by design: this is a duplicate-suppression convenience, not a correctness gate, so a
 * backend that cannot list (offline, 403) yields an empty set and the mint proceeds. The real
 * failure would then surface on the mint call itself.
 */
export async function alreadyMintedHashes(
  cfg: WorkspaceCliConfig,
  http?: RuleClientHttp,
): Promise<Set<string>> {
  try {
    const nodes = await listRules(cfg, { lifecycleStatus: "ACTIVE" }, http);
    const hashes = new Set<string>();
    for (const n of nodes) {
      if (n.currentVersion?.canonicalPayloadHash) hashes.add(n.currentVersion.canonicalPayloadHash);
    }
    return hashes;
  } catch {
    return new Set<string>();
  }
}
