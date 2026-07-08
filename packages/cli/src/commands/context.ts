// src/commands/context.ts
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readScanCache, readVerdicts, writeVerdicts } from "../lib/scanner/cache";
import { resolveWorkspaceIdWithEnv } from "../lib/workspace";
import { rescanAndCache, resolveScanRoot } from "./scan-context";

export interface VerdictArgs {
  home: string;
  workspaceId: string;
  action: "accept" | "dismiss";
  id: string;
}

// Pure verdict bookkeeping (no rescan); the command wrapper triggers the rescan.
export function applyContextVerdict(args: VerdictArgs): void {
  const v = readVerdicts(args.home, args.workspaceId);
  const add = (list: string[], id: string) => (list.includes(id) ? list : [...list, id]);
  const drop = (list: string[], id: string) => list.filter((x) => x !== id);
  if (args.action === "accept") {
    v.accepted = add(v.accepted, args.id);
    v.dismissed = drop(v.dismissed, args.id);
  } else {
    v.dismissed = add(v.dismissed, args.id);
    v.accepted = drop(v.accepted, args.id);
  }
  writeVerdicts(args.home, args.workspaceId, v);
}

// Read-only view of the advisory agent-memory rules captured in the scan cache.
// These are machine_inferred (untracked, per-machine, agent-distilled), so they are
// NEVER auto-injected as must-follow; this list is a human review surface only.
// `?? []` guards a pre-M1 on-disk cache that predates the advisoryDirectives field.
export function advisoryLines(home: string, workspaceId: string): string[] {
  const cache = readScanCache(home, workspaceId);
  const advisory = cache?.advisoryDirectives ?? [];
  return advisory.map((d) => `${d.id}  [${d.strength}]  ${d.text}  (${d.source})`);
}

export interface ReviewItem { id: string; detail: string; source: string; }

export function latestReviewCardItems(home: string, workspaceId: string): ReviewItem[] {
  const path = join(home, ".meetless", "workspaces", workspaceId, "review-cards.jsonl");
  let lines: string[];
  try {
    lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const row = JSON.parse(lines[i]);
      if (row.event === "review_card" && Array.isArray(row.items)) return row.items;
    } catch {
      // skip malformed line
    }
  }
  return [];
}

export async function runContext(argv: string[]): Promise<number> {
  const [sub, id] = argv;
  const workspaceId = resolveWorkspaceIdWithEnv();
  if (!workspaceId) {
    console.error("context: run inside an activated workspace (MEETLESS_WORKSPACE_ID unset and no .meetless.json marker found).");
    return 2;
  }
  const home = homedir();
  if (sub === "list") {
    const cache = readScanCache(home, workspaceId);
    if (cache && cache.staleSignals.length) {
      for (const s of cache.staleSignals) console.log(`${s.id}  ${s.detail}`);
      return 0;
    }
    if (!cache) {
      // No live scan cache (workspace not scanned yet, or cache cleared). Fall back to
      // the last session's review card as a degraded, clearly-labelled view.
      const card = latestReviewCardItems(home, workspaceId);
      if (card.length) {
        console.log("No current scan cache; showing the last session's review card. Run `mla activate` to refresh.");
        for (const item of card) console.log(`${item.id}  ${item.detail}`);
        return 0;
      }
    }
    console.log("No pending review items.");
    return 0;
  }
  if (sub === "advisory") {
    const lines = advisoryLines(home, workspaceId);
    if (!lines.length) {
      console.log("No advisory agent-memory rules.");
      return 0;
    }
    // Advisory rules are machine_inferred and never injected; this is review-only.
    // accept/dismiss is deliberately NOT wired here: promoting a machine_inferred rule
    // to attested is a state transition that belongs to a human attestation flow.
    console.log("Advisory rules from agent memory (machine_inferred; NOT injected; review only):");
    for (const l of lines) console.log(`  ${l}`);
    return 0;
  }
  if ((sub === "accept" || sub === "dismiss") && id) {
    applyContextVerdict({ home, workspaceId, action: sub, id });
    // Anchor the refresh to the marker dir, not cwd: a dismiss/accept from a
    // package subdir must rescan the WHOLE workspace, or the cache loses every
    // rule outside the subdir and the just-dismissed signal resurfaces under a
    // new (path-relative) id. See resolveScanRoot.
    void rescanAndCache({ cwd: resolveScanRoot(process.cwd()), workspaceId, home });
    console.log(`${sub === "accept" ? "Accepted" : "Dismissed"} ${id}. Next session's context updated.`);
    return 0;
  }
  console.error("usage: mla context <accept|dismiss> <id> | mla context list | mla context advisory");
  return 2;
}
