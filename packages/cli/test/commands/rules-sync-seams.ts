import type { WorkspaceCliConfig } from "../../src/lib/config";

/**
 * Auto-publish is part of the `attest` / `revoke` contract now: after any state-changing mutation the
 * command best-effort POSTs the scope's LIVE rules to control so the console Rules surface stays in sync.
 * That makes the network post external IO the unit suite must inject, exactly like a Slack/Jira wrapper.
 *
 * These seams keep the older attest/revoke specs hermetic: a bound workspace config and a publish seam that
 * records nothing and answers benignly, so the command never touches the real network. They do NOT assert
 * anything about the sync; rules-auto-publish.spec owns that behavior end to end.
 */
export function hermeticSyncSeams(): {
  loadConfig: () => WorkspaceCliConfig;
  publish: (
    cfg: WorkspaceCliConfig,
    body: { rules: unknown[] },
  ) => Promise<{ published: number; retired: number; items: never[] }>;
} {
  return {
    loadConfig: () => ({ workspaceId: "ws_test" }) as unknown as WorkspaceCliConfig,
    publish: async (_cfg, body) => ({ published: body.rules.length, retired: 0, items: [] }),
  };
}
