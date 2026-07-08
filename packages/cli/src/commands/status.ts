// src/commands/status.ts
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readScanCache } from "../lib/scanner/cache";
import { resolveWorkspaceIdWithEnv } from "../lib/workspace";
import { HOOKS_DIR } from "../lib/config";

export interface StatusView {
  home: string;
  workspaceId: string;
  hooksInstalled: boolean;
}

export function renderStatus(view: StatusView): string {
  const cache = readScanCache(view.home, view.workspaceId);
  if (!cache) {
    return `Meetless is not activated for this repo. Run \`mla activate\`.`;
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

export async function runStatus(_argv: string[]): Promise<number> {
  const workspaceId = resolveWorkspaceId();
  if (!workspaceId) {
    console.log("Meetless is not activated for this repo. Run `mla activate`.");
    return 0;
  }
  const hooksInstalled = detectHooksInstalled();
  console.log(renderStatus({ home: homedir(), workspaceId, hooksInstalled }));
  return 0;
}
