// tools/meetless-agent/src/commands/internal-auto-index.ts
// `mla _internal auto-index --session <sid>` (Zone 2 auto-index loop).
//
// Fired detached from the Stop hook (spawn_auto_index). It reads this session's
// produced-doc captures from the Zone 1 Active Review spool and indexes each into
// the owner's Personal KB as a SHADOW / agent_distilled doc via the idempotent
// `mla kb add` path. SHADOW never grounds anyone (INV-GROUNDING-APPROVED), so this
// auto-ingest cannot pollute retrieval; the explicit human gate moves to
// `mla kb promote` (SHADOW -> LIVE), which is unchanged.
//
// advise-never-block (P6): every failure path is swallowed; the command prints a
// JSON summary and exits 0 (except a strict argv parse error -> 2, and an
// owner-check denial -> 3). It runs off the session's hot path and must never
// disturb the session it rides on; the denial halt only stops THIS detached
// batch, never the session.
//
// Owner-denial halt (fix B3): a non-OWNER actor used to fail-soft once PER DOC
// (154 denial lines in the incident) because runKbAdd swallows KbOwnerCheckError
// into stderr + exit 2, invisible to this loop. The denial is run-fatal, not
// doc-local: the same actor is denied for every doc. So the run halts on the
// first denial with ONE message. The OWNER-only gate itself (kb_acl.ts + the
// control-side check) is locked design and is NOT touched here.
// See notes/20260605-mla-auto-index-loop-implementation-plan.md.
import * as fs from "fs";
import * as path from "path";

import { HOME, readKbConfig } from "../lib/config";
import { reduceActiveMemory } from "../lib/active-memory";
import { selectIndexTargets, buildKbAddArgv } from "../lib/auto-index";
import { verifyKbActorIsOwner, KbOwnerCheckError } from "../lib/kb_acl";
import {
  runLiveCollector,
  type LiveBindingPassResult,
} from "../lib/agent-memory-capture/live-collector";
import { runKbAdd } from "./kb_add";

function activeMemoryStorePath(): string {
  return path.join(HOME, "logs", "kb-knowledge.jsonl");
}

// Mirror the Active Review reader's window so the two zones see the same record set.
const TTL_HOURS = 48;
const MAX_RECORDS = 100;

export function parseArgs(argv: string[]): { sessionId: string | null } {
  let sessionId: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--session") {
      sessionId = argv[i + 1] ?? null;
      i++;
      continue;
    }
    if (a.startsWith("-")) {
      throw new Error(
        `Unknown flag: ${a}. \`mla _internal auto-index\` takes only [--session <sid>].`,
      );
    }
    throw new Error(
      `Unexpected positional argument: ${a}. \`mla _internal auto-index\` takes only [--session <sid>].`,
    );
  }
  return { sessionId };
}

export type AddFn = (argv: string[]) => Promise<number>;
export type VerifyOwnerFn = (workspaceId: string) => Promise<void>;
export type RunLiveFn = (opts: { nowIso: string }) => Promise<LiveBindingPassResult[]>;

export interface AutoIndexDeps {
  add?: AddFn;
  storePath?: string;
  // Owner-gate preflight. Defaults to the real kb_acl check ONLY when `add`
  // is not injected: an injected add owns its full boundary and signals a
  // denial by throwing KbOwnerCheckError (or an error carrying its name or
  // message signature) into the loop.
  verifyOwner?: VerifyOwnerFn;
  // Live agent-memory capture pass (proposal §6). Runs by default after the
  // Zone-2 loop; the collector self-gates on a consented binding + a resolvable
  // actor, so an unbound / logged-out machine is a clean no-op. Injected for
  // tests. Fully fail-soft (never affects the auto-index result or the session).
  runLive?: RunLiveFn;
}

// Roll the per-binding live results into a flat outcome tally for the worker's
// JSON summary. Counts only; never carries content. `locked` is the number of
// bindings skipped because another collector held the lock this pass.
function tallyLive(results: LiveBindingPassResult[]): {
  bindings: number;
  uploaded: number;
  deferred: number;
  blocked: number;
  withdrawn: number;
  failed: number;
  skippedBindings: number;
} {
  let bindings = 0;
  let uploaded = 0;
  let deferred = 0;
  let blocked = 0;
  let withdrawn = 0;
  let failed = 0;
  // Bindings that did no work this pass: another collector held the lock, or the
  // pipeline threw (fail-soft). Both surface as summary === null.
  let skippedBindings = 0;
  for (const r of results) {
    if (!r.locked || !r.summary) {
      skippedBindings++;
      continue;
    }
    bindings++;
    for (const rec of r.summary.records) {
      switch (rec.outcome) {
        case "uploaded":
          uploaded++;
          break;
        case "deferred":
          deferred++;
          break;
        case "blocked":
          blocked++;
          break;
        case "reclassified":
        case "deleted":
          withdrawn++;
          break;
        case "failed":
          failed++;
          break;
        default:
          break; // unchanged / skipped: no-op, not surfaced
      }
    }
  }
  return { bindings, uploaded, deferred, blocked, withdrawn, failed, skippedBindings };
}

// runKbAdd converts KbOwnerCheckError into stderr + exit 2 before it reaches
// this loop, so a thrown denial only arrives from injected add fns or future
// boundary changes. Match the class, the name (survives module-duplication
// boundaries), or the stable message prefix kb_acl.ts stamps on every denial.
function isOwnerDenial(e: unknown): boolean {
  if (e instanceof KbOwnerCheckError) return true;
  const err = e as { name?: unknown; message?: unknown } | null | undefined;
  if (err && err.name === "KbOwnerCheckError") return true;
  return Boolean(
    err && typeof err.message === "string" && err.message.includes("KB owner check failed"),
  );
}

function haltOnOwnerDenial(
  e: unknown,
  summary: { indexed: number; skipped: number; failed: number; total: number },
): number {
  const detail = e instanceof Error && e.message ? e.message : String(e);
  // One clear line for the whole run instead of one denial per doc. The
  // kb_acl message already names the actor, its role, and the OWNER
  // requirement.
  console.error(`auto-index halted: owner-check denial; remaining docs not attempted. ${detail}`);
  console.log(JSON.stringify({ ...summary, halted: "owner_check_denied" }));
  return 3;
}

export async function runInternalAutoIndex(
  argv: string[],
  deps: AutoIndexDeps = {},
): Promise<number> {
  let sessionId: string | null;
  try {
    ({ sessionId } = parseArgs(argv));
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }

  const add: AddFn = deps.add ?? runKbAdd;
  const storePath = deps.storePath ?? activeMemoryStorePath();
  const verifyOwner: VerifyOwnerFn | null =
    deps.verifyOwner ??
    (deps.add ? null : async (ws) => verifyKbActorIsOwner(readKbConfig(ws)));

  try {
    // Scope to this session BEFORE dedup: the content-keyed dedup identity omits
    // sessionId, so a post-reduce filter could drop this session's doc in favor of
    // an identical-content record from another session. sessionId === null (no flag)
    // reduces the whole spool, matching the active-review reader's window.
    const records = reduceActiveMemory(storePath, {
      nowMs: Date.now(),
      ttlHours: TTL_HOURS,
      maxRecords: MAX_RECORDS,
      ...(sessionId ? { sessionId } : {}),
    });
    const targets = selectIndexTargets(records);

    let indexed = 0;
    let skipped = 0;
    let failed = 0;
    const verifiedWorkspaces = new Set<string>();
    for (const t of targets) {
      if (!fs.existsSync(t.absPath)) {
        skipped++;
        continue;
      }
      // Owner-gate preflight, once per workspace: runKbAdd would swallow a
      // denial into exit 2 per doc; checking here lets a denial halt the
      // whole run before the spam starts. Non-denial preflight failures
      // (missing config, control unreachable) stay fail-soft and let the add
      // surface its own per-doc outcome.
      if (verifyOwner && !verifiedWorkspaces.has(t.workspaceId)) {
        try {
          await verifyOwner(t.workspaceId);
          verifiedWorkspaces.add(t.workspaceId);
        } catch (e) {
          if (isOwnerDenial(e)) {
            return haltOnOwnerDenial(e, { indexed, skipped, failed, total: targets.length });
          }
        }
      }
      try {
        // Pass this run's raw session UUID (from `--session`, kept raw for spool
        // scoping above) so the add carries `--agent-session` to the intel route.
        // buildKbAddArgv canonicalizes it; null/invalid simply omits the flag.
        const code = await add(buildKbAddArgv(t, sessionId));
        if (code === 0) indexed++;
        else failed++;
      } catch (e) {
        if (isOwnerDenial(e)) {
          // Run-fatal, not doc-local: the same denial would repeat for every
          // remaining doc.
          return haltOnOwnerDenial(e, { indexed, skipped, failed, total: targets.length });
        }
        failed++; // fail-soft: one bad add never aborts the batch.
      }
    }

    // Live agent-memory capture (proposal §6): the collector attached to this
    // existing Stop worker. Runs by default; the collector self-gates on a
    // consented binding + a resolvable actor, so an unbound / logged-out machine
    // is a clean no-op. Fully fail-soft and OUTSIDE the Zone-2 result above: any
    // error here is swallowed and never changes the indexed/skipped/failed counts
    // or the session. Runs last so it rides the same detached tail.
    const summary: {
      indexed: number;
      skipped: number;
      failed: number;
      total: number;
      liveCapture?: ReturnType<typeof tallyLive>;
    } = { indexed, skipped, failed, total: targets.length };

    try {
      const runLive = deps.runLive ?? runLiveCollector;
      const liveResults = await runLive({ nowIso: new Date().toISOString() });
      summary.liveCapture = tallyLive(liveResults);
    } catch {
      // Live capture must never disturb the auto-index worker. Swallow.
    }

    console.log(JSON.stringify(summary));
    return 0;
  } catch {
    // Any unexpected error (unreadable store, etc.) degrades to a quiet no-op.
    console.log(JSON.stringify({ indexed: 0, skipped: 0, failed: 0, total: 0 }));
    return 0;
  }
}
