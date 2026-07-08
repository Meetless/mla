// tools/meetless-agent/src/lib/auto-index.ts
// Pure selection + argv construction for the Zone 2 auto-index loop. Given the
// reduced Active Review records for a session, pick the produced docs to index
// into the owner's Personal KB and build the `mla kb add` argv for each. No I/O;
// the command layer (internal-auto-index.ts) owns the store read, the on-disk
// existence check, and the (fail-soft) add invocation.
// See notes/20260605-mla-auto-index-loop-implementation-plan.md.
import * as path from "path";
import { ActiveMemoryRecord } from "./active-memory";
import { canonicalizeSessionId } from "./observability";

export interface IndexTarget {
  absPath: string;
  workspaceId: string;
  canonicalPath: string;
  contentHash: string;
}

// One target per (repoRootHash, canonicalPath). Only produced_doc records that
// carry a repoRoot are eligible: tagged_reference docs are user-named, not
// agent-produced, and a record without a repoRoot predates Phase A and cannot be
// resolved on disk. reduceActiveMemory yields records most-recent-last, so a later
// record overwrites an earlier one for the same key -> latest content wins.
export function selectIndexTargets(records: ActiveMemoryRecord[]): IndexTarget[] {
  const latest = new Map<string, ActiveMemoryRecord>();
  for (const r of records) {
    if (r.kind !== "produced_doc") continue;
    if (!r.repoRoot || r.repoRoot.length === 0) continue;
    latest.set(`${r.repoRootHash}|${r.canonicalPath}`, r);
  }
  return Array.from(latest.values()).map((r) => ({
    absPath: path.join(r.repoRoot as string, r.canonicalPath),
    workspaceId: r.workspaceId,
    canonicalPath: r.canonicalPath,
    contentHash: r.contentHash,
  }));
}

// The Zone 2 personal-KB add contract: agent_distilled provenance (ADVISORY echo
// under the two-axis model; the server derives recorded trust from the capture
// path), workspace pinned from the record (NOT marker-resolved, since the detached
// run has cwd=$HOME), and --queue so the add returns after the revision commits
// without blocking on the async GRAPH_EXTRACT job.
//
// NO --posture: commit e7f20756 removed the --posture contract from `mla kb add`
// (every notes ingest is born reviewOutcome=PENDING; LIVE/SHADOW posture is dead).
// `mla kb add` now REJECTS --posture as an unknown flag, so emitting it here made
// every auto-index ingest fail ("Unknown flag: --posture") -- session files were
// recorded but never ingested or mined for relationships. Keep this argv in lockstep
// with kb_add.ts's VALUE_FLAGS/BOOLEAN_FLAGS.
//
// --reingest-if-active makes this an add-or-UPDATE. Without it, a doc the agent
// produced once is ACTIVE in the KB, and every later edit re-runs `kb add` over an
// ACTIVE identity, which the kb add route hard-refuses ("use mla kb reingest"). The
// loop swallows that exit-2 as a failure, so a re-edited doc silently never accrues
// a second revision. With the flag, a changed body reingests in place (new revision)
// and a frontmatter-only change patches; an unchanged doc still no-ops.
export function buildKbAddArgv(t: IndexTarget, sessionId?: string | null): string[] {
  const argv = [
    t.absPath,
    "--mode",
    "file",
    "--provenance",
    "agent_distilled",
    "--workspace",
    t.workspaceId,
    "--queue",
    "--reingest-if-active",
  ];
  // Channel B (sync ingest): carry THIS session's raw Claude UUID through to the
  // intel ingest route as `--agent-session <uuid>` (it rides the kb add HTTP body)
  // so the workspace-authoritative sink composes the Langfuse session exactly once
  // (INV-COMPOSE-ONCE). The value is canonicalized here (trim, uuid-shape, lowercase)
  // but NEVER composed; an absent or malformed session simply omits the flag and the
  // ingest still runs (intel falls back to its own grouping). No env var is read: the
  // detached auto-index process has a bare environment, so the session arrives
  // explicitly on its `--session` wire.
  const agentSession = canonicalizeSessionId(sessionId ?? null);
  if (agentSession) {
    argv.push("--agent-session", agentSession);
  }
  return argv;
}
