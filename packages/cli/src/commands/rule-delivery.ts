// src/commands/rule-delivery.ts
//
// The ONE place a change to the rule authority is carried down to the local caches an agent
// actually reads. Every rule verb that mutates the backend goes through here.
//
// WHY THIS EXISTS (the three-hop delivery chain). The backend RuleNode store is the authority
// (notes/20260627-rules-store-unification-backend-sot-proposal.md; `.meetless/rules.md` is a read
// projection, never an authority). But NOTHING on the agent hot path fetches the authority:
//
//   authority (backend)  ->  rule-bundle cache  ->  scan cache  ->  the prompt hook
//                    (1) fetch            (2) scan          (3) read
//
// `scan` reads the rule-bundle CACHE, and the UserPromptSubmit hook reads the scan cache that
// `scan` writes. No hook ever fetches a bundle. So a verb that mints/revokes on the authority and
// stops there has changed nothing any agent can see: hop 1 is done, hops 2 and 3 are stale. That
// was the 0.2.17 "accept never reached the agent" bug, and it was never a property of `accept`: it
// is a property of the SEAM. `rules add`, `revoke`, `attest`, `promote`, `demote` and `edit` all
// had it too (a rule a human explicitly added stayed invisible to every reader; `revoke`, the kill
// switch, did not disarm anything locally).
//
// `_internal steer-sync` does bridge authority -> caches, but only at a Claude Code turn boundary.
// That leaves the change one turn late inside a session, and NEVER delivered for anyone driving the
// CLI outside one: a plain shell, CI, a scripted demo. Depending on a later hook to make your own
// printed claim true is not delivery. So the verb that changes governance delivers it.
//
// Delivery is BEST EFFORT and never fails the mutation: the authority write already succeeded and
// is durable, so a network blip on the refresh must not report failure for a rule that is live. The
// caller gets the outcome back and prints only what is true.
import { type RuleClientHttp } from "../lib/rules/control-rule-client";
import { refreshBundleCache, type DeliveryOutcome } from "../lib/rules/bundle-refresh";
import { type WorkspaceCliConfig } from "../lib/config";
import { rescanAndCache, resolveScanRoot } from "./scan-context";

export type { DeliveryOutcome };

/**
 * Carry the current authority state down to BOTH local caches an agent reads: fetch the
 * principal-bound bundle into the rule-bundle cache (hop 1 -> 2), then rescan so the scan cache the
 * prompt hook reads is rebuilt from it (hop 2 -> 3).
 *
 * The scan targets the repository the rules are bound to, which is NOT always the cwd: `enrich
 * accept` is explicitly allowed to accept a run from elsewhere, and must still deliver into the
 * repo the candidates were mined from.
 *
 * Throws on a fetch/refresh failure; callers that must not fail on delivery use deliverRuleChange.
 */
export async function refreshRuleDelivery(
  cfg: WorkspaceCliConfig,
  repositoryRoot: string,
  http?: RuleClientHttp,
): Promise<void> {
  const bundle = await refreshBundleCache(cfg, http);
  rescanAndCache({ cwd: resolveScanRoot(repositoryRoot), workspaceId: bundle.workspaceId });
}

/**
 * The rule verbs' delivery call: refresh, and report whether it landed. Never throws, because the
 * authority mutation it follows has already committed. A caller that gets `delivered: false` must
 * say so rather than print an injection claim it cannot back.
 */
export async function deliverRuleChange(
  cfg: WorkspaceCliConfig,
  repositoryRoot: string,
  http?: RuleClientHttp,
): Promise<DeliveryOutcome> {
  try {
    await refreshRuleDelivery(cfg, repositoryRoot, http);
    return { delivered: true };
  } catch (e) {
    return { delivered: false, error: (e as Error).message };
  }
}

/**
 * The line a verb prints after mutating the authority. Worded for BOTH directions (a revoke
 * delivers a removal, not an injection), and claims delivery only when it actually happened.
 */
export function deliveryLine(outcome: DeliveryOutcome): string {
  return outcome.delivered
    ? "Delivered: your local rule cache now matches the authority; it applies from your very next turn."
    : `NOT delivered: the change is live on the authority, but this machine's rule cache refresh ` +
        `failed (${outcome.error}). Your agent still sees the OLD rules. Run \`mla scan\` to deliver it.`;
}
