// src/commands/status.ts
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readScanCache } from "../lib/scanner/cache";
import { readScanCacheForRoot } from "./scan-context";
import { resolveWorkspaceIdWithEnv } from "../lib/workspace";
import { CliConfig, HOOKS_DIR, readConfig } from "../lib/config";
import { get } from "../lib/http";
import {
  isWorkspaceAccessDenied,
  workspaceAccessDeniedMessage,
} from "../lib/workspace-access";

const NOT_ACTIVATED = "Meetless is not activated for this repo. Run `mla activate`.";

export interface StatusView {
  // undefined = the cache module resolves the state root (it honors MEETLESS_HOME).
  home: string | undefined;
  workspaceId: string;
  hooksInstalled: boolean;
  // Optional pre-read scan cache. When omitted, renderStatus reads it from disk
  // (the behaviour specs rely on). runStatus reads it once to decide whether to
  // probe membership, then passes it here so the file is not read twice.
  cache?: ReturnType<typeof readScanCache>;
}

export function renderStatus(view: StatusView): string {
  const cache =
    view.cache !== undefined ? view.cache : readScanCache(view.home, view.workspaceId);
  if (!cache) {
    return NOT_ACTIVATED;
  }
  const rules = cache.directives.length;
  const pending = cache.staleSignals.length;
  // `?? 0` guards a pre-M1 on-disk cache that predates the agentMemoryRules field.
  const advisory = cache.inventory.agentMemoryRules ?? 0;
  const hooks = view.hooksInstalled ? "hooks installed" : "hooks NOT installed (run `mla wire`)";
  const lines = [
    `Meetless is active for workspace ${view.workspaceId} (${hooks}).`,
    `  ${plural(rules, "confirmed rule")} injected on every prompt.`,
    `  ${plural(pending, "pending review item")} (mla context list).`,
    `  inventory: ${cache.inventory.instructionFiles} instruction files, ` +
      `${cache.inventory.decisionDocs} docs, ${cache.inventory.legacyNotes} notes.`,
  ];
  // Advisory agent-memory rules are machine_inferred and NOT injected (never must-follow);
  // surface them only when present, so a fresh repo with none stays quiet (no spam).
  if (advisory > 0) {
    lines.push(`  ${plural(advisory, "advisory rule")} from agent memory (pending review; not injected).`);
  }
  return lines.join("\n");
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

// Thin wrapper kept for local readability; delegates to the shared resolver
// in src/lib/workspace.ts (env override first, then .meetless.json marker walk).
function resolveWorkspaceId(): string | undefined {
  return resolveWorkspaceIdWithEnv();
}

function detectHooksInstalled(): boolean {
  try {
    return existsSync(join(HOOKS_DIR, "user-prompt-submit.sh"));
  } catch {
    return false;
  }
}

// Status-framed message for a bound-but-not-a-member repo (BUG-6 Issue 1). Leads
// with the SAME canonical membership line the rest of the CLI emits (BUG-5), then
// adds the piece status uniquely knows: this repo IS bound, so `mla activate`
// cannot fix it. This is what separates "activated but not a member of X" from
// the "not activated" copy the operator would otherwise see and loop on.
export function notMemberStatusMessage(e: unknown, workspaceId: string): string {
  return (
    `${workspaceAccessDeniedMessage(e, workspaceId)}\n` +
    `This repo is bound to that workspace (.meetless.json), so \`mla activate\` ` +
    `will keep failing until you are added.`
  );
}

// Best-effort membership probe against control for the no-cache branch. Returns
// the status-framed non-member message when control DEFINITIVELY denies access
// to the bound workspace (403 WORKSPACE_ACCESS_DENIED), else null: a member, or
// the probe simply could not run (no user-token session, control unreachable,
// stale token, any non-membership error). status must never fail or hang on the
// common local case, so anything inconclusive falls back to the activate hint.
//
// Only user-token sessions are probed: shared-key / none carry no per-user
// membership to check, and CI paths should not pay a network round-trip here.
async function probeMembershipDenied(workspaceId: string): Promise<string | null> {
  let cfg: CliConfig;
  try {
    cfg = readConfig();
  } catch {
    // readConfig throws by design when MEETLESS_CONTROL_TOKEN shadows a
    // user-token login; status must not crash on it.
    return null;
  }
  if (cfg.auth.mode !== "user-token") return null;

  const actorUserId = (cfg.actorUserId || "").trim();
  const path = actorUserId
    ? `/internal/v1/whoami?workspaceId=${encodeURIComponent(workspaceId)}&actorUserId=${encodeURIComponent(actorUserId)}`
    : `/internal/v1/whoami?workspaceId=${encodeURIComponent(workspaceId)}`;
  try {
    await get(cfg, path, 6000);
    return null; // 200 -> the session IS a member of this workspace.
  } catch (e) {
    if (isWorkspaceAccessDenied(e)) {
      return notMemberStatusMessage(e, workspaceId);
    }
    // 401 / network / control down / workspace-not-found: inconclusive, don't
    // block status. Fall through to the local activate hint.
    return null;
  }
}

export async function runStatus(_argv: string[]): Promise<number> {
  const workspaceId = resolveWorkspaceId();
  if (!workspaceId) {
    console.log(NOT_ACTIVATED);
    return 0;
  }
  const home = undefined; // let the cache module resolve the state root (it honors MEETLESS_HOME)
  // Guarded read: a scan cache stomped by ANOTHER checkout of this same workspace must read as
  // "no scan for THIS repo" (its commitSha/inventory/stale signals belong to the other checkout),
  // so the operator is steered to re-activate here rather than shown a sibling repo's status.
  const cache = readScanCacheForRoot(home, workspaceId);
  if (!cache) {
    // No local scan for this bound workspace. Before advising `mla activate`,
    // make sure the workspace is actually usable: a marker can name a workspace
    // the operator is not a member of (activate 403'd, or access was later
    // revoked), and "run mla activate" would just loop on the same denial.
    const denied = await probeMembershipDenied(workspaceId);
    if (denied) {
      console.error(denied);
      return 1;
    }
    console.log(NOT_ACTIVATED);
    return 0;
  }
  const hooksInstalled = detectHooksInstalled();
  console.log(renderStatus({ home, workspaceId, hooksInstalled, cache }));
  return 0;
}
