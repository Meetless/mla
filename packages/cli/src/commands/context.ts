// src/commands/context.ts
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readVerdicts, reviewCardsPath, writeVerdicts } from "../lib/scanner/cache";
import {
  liveReconciliationFindings,
  makeArtifactByteReader,
  type ReconciliationCacheView,
} from "../lib/scanner/reconciliation-live";
import { resolveWorkspaceIdWithEnv } from "../lib/workspace";
import {
  readScanCacheForRoot,
  rescanAndCache,
  resolveScanRoot,
  resolveScanRootIdentity,
} from "./scan-context";

export interface VerdictArgs {
  // undefined = the cache module resolves the state root (it honors MEETLESS_HOME).
  home: string | undefined;
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
export function advisoryLines(home: string | undefined, workspaceId: string): string[] {
  // Guarded read: advisory rules are distilled from THIS checkout's tree, so a cache stomped by
  // a sibling checkout of the same workspace must not surface as this repo's advisory set.
  const cache = readScanCacheForRoot(home, workspaceId);
  const advisory = cache?.advisoryDirectives ?? [];
  return advisory.map((d) => `${d.id}  [${d.strength}]  ${d.text}  (${d.source})`);
}

// The full set of live reconciliation findings for THIS checkout (ADR §3.5 T11).
//
// This is the "full set" the injected block's `<omitted>` notice points at, and the wider view the
// deliberately narrow `mla ask` documentation-impact section leaves room for. It runs the SAME two
// gates the injection surface runs (shared, in reconciliation-live.ts), so what this prints and what
// an agent is told are the same list by construction. A finding the hook has gone quiet about must
// not still be listed here as live.
//
// Only the GOVERNED band is printed. `currentSummary` is attacker-or-accident-controlled file bytes:
// the injected block can carry it because it labels the band, plain stdout cannot.
export function reconciliationLines(
  cache: ReconciliationCacheView | null,
  repoRoot: string,
  nowIso: string,
): string[] {
  const kept = liveReconciliationFindings(cache, makeArtifactByteReader(repoRoot), nowIso).kept;
  const lines: string[] = [];
  for (const { finding } of kept) {
    const statement = finding.acceptedStatement?.trim();
    // No governed band, nothing to assert. Same rule the injection renderer applies.
    if (!statement) continue;
    const cite = finding.sourceCaseId ? `  [CC:${finding.sourceCaseId}]` : "";
    lines.push(`${finding.path}${cite}`);
    lines.push(`    accepted: ${statement}`);
  }
  return lines;
}

export interface ReviewItem { id: string; detail: string; source: string; }

export function latestReviewCardItems(
  home: string | undefined,
  workspaceId: string,
  currentScanRootPath?: string,
): ReviewItem[] {
  const path = reviewCardsPath(workspaceId, home);
  let lines: string[];
  try {
    lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const row = JSON.parse(lines[i]);
      if (row.event !== "review_card" || !Array.isArray(row.items)) continue;
      // The review-cards journal is shared by every checkout of this workspace. The Stop hook
      // stamps each card with the scan root it read from (scan_root, propagated from the cache;
      // see write_stop_review_card). Skip a card written from a DIFFERENT checkout so this repo's
      // "last session" fallback never shows a sibling repo's items. A card with no stamp is legacy:
      // trust it (only a PRESENT, mismatching stamp is rejected).
      if (currentScanRootPath && row.scan_root && row.scan_root !== currentScanRootPath) continue;
      return row.items;
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
  const home = undefined; // let the cache module resolve the state root (it honors MEETLESS_HOME)
  if (sub === "list") {
    // Guarded read: a cache stomped by a sibling checkout must read as "no scan for THIS repo"
    // so we fall through to this checkout's own review card, not the sibling's stale signals.
    const cache = readScanCacheForRoot(home, workspaceId);
    // Decision reconciliation first: a file that contradicts an ACCEPTED decision outranks a stale
    // signal, because an agent is being told the governed version on every turn while the file says
    // the opposite. Printed alongside the stale signals, never instead of them.
    const recon = reconciliationLines(cache, resolveScanRoot(process.cwd()), new Date().toISOString());
    if (recon.length) {
      console.log("Decision reconciliation: instruction files that contradict an accepted decision.");
      for (const l of recon) console.log(`  ${l}`);
    }
    if (cache && cache.staleSignals.length) {
      if (recon.length) console.log("");
      for (const s of cache.staleSignals) console.log(`${s.id}  ${s.detail}`);
      return 0;
    }
    if (recon.length) return 0;
    if (!cache) {
      // No live scan cache (workspace not scanned yet, or cache cleared). Fall back to
      // the last session's review card as a degraded, clearly-labelled view, filtered to
      // THIS checkout so a sibling repo's card is never shown as ours.
      const card = latestReviewCardItems(home, workspaceId, resolveScanRootIdentity());
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
