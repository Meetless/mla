import { loadWorkspaceConfig, WorkspaceCliConfig } from "../lib/config";
import { get, post } from "../lib/http";
import {
  ActiveConflict,
  writeActiveConflictCache,
} from "../lib/active-conflict-cache";
import {
  CachedSteer,
  writeSteerCache,
  readInjectedIds,
} from "../lib/steer-cache";
import { homedir } from "node:os";
import { getBundle, type RuleBundle } from "../lib/rules/control-rule-client";
import { writeRuleBundleCache } from "../lib/rules/bundle-cache";
import { recordBundlePrincipal } from "../lib/rules/bundle-principal";
import { readScanCache } from "../lib/scanner/cache";
import { rescanAndCache, resolveScanRoot } from "./scan-context";

// `mla _internal steer-sync --session <sid>` (Plan 1, conflict-resolution loop).
//
// Invoked by flush.sh every turn. Three jobs, all best-effort (P6 advise-never-
// block: a failure prints a zero summary and exits 0 so the flush drain is never
// affected):
//   1. PULL the not-yet-injected steers for this session from control (atomic
//      flip PENDING -> PULLED server-side) and write them to the zero-network
//      cache the UserPromptSubmit hook reads.
//   2. MARK-INJECTED every steer the hook already surfaced (read from the hook's
//      inject-state file), flipping PULLED -> INJECTED so it drops out of the next
//      pull. "markInjected" (the agent surfaced it), NOT "ack" (the reserved
//      Plan-2 human acknowledgement state).
//   3. SNAPSHOT the session's currently-open cross-session conflicts from control
//      and overwrite the zero-network active-conflict cache the PreToolUse hook
//      reads for its soft warning (G8 / D1 §11.3, CRITICAL-5). This is the SAME
//      turn-boundary pass that pulls steers; the snapshot is the complete current
//      set, so a resolved conflict disappears on the next sync. A fetch FAILURE
//      leaves the prior snapshot untouched (the hook's TTL staleness guard fails it
//      open); only a successful fetch, even an empty one, overwrites.
//   4. SYNC the principal-bound rule bundle (rules-store unification §6.1 / P1F).
//      It fetches the bundle (server resolves the principal from the session) and
//      writes it to the zero-network rule-bundle cache the scanner (rule injection)
//      and the PreToolUse hook (DENY enforcement) both read. Same best-effort
//      posture as job 3: a fetch FAILURE leaves the prior cached bundle in place,
//      and the reader's own lease guard degrades a stale DENY to ASK rather than
//      enforcing on a possibly-revoked rule. This is the WRITER half that keeps the
//      backend Rule store and the two local readers in sync each turn.
//
// Hermetic test seam: MEETLESS_STEER_SYNC_STUB_PULL, when set, is parsed as a
// CachedSteer[] JSON and used as the pull result with NO HTTP and NO config load,
// and the mark-injected network call is skipped. MEETLESS_CONFLICT_SYNC_STUB, in
// the same stub mode, is parsed as an ActiveConflict[] JSON snapshot.
// MEETLESS_RULE_BUNDLE_SYNC_STUB, likewise, is parsed as a RuleBundle JSON (the
// job-4 fetch result). This keeps a command test offline.

export interface SteerTransport {
  pull: (sessionId: string) => Promise<CachedSteer[]>;
  markInjected: (id: string) => Promise<void>;
  fetchActiveConflicts: (sessionId: string) => Promise<ActiveConflict[]>;
  /** §6.1 principal bundle for the authenticated session; null when none is served. */
  fetchRuleBundle: () => Promise<RuleBundle | null>;
}

interface PullResponse {
  steers?: CachedSteer[];
}

interface ActiveConflictResponse {
  conflicts?: ActiveConflict[];
}

function realTransport(cfg: WorkspaceCliConfig): SteerTransport {
  return {
    pull: async (sessionId) => {
      const res = await post<PullResponse>(
        cfg,
        `/internal/v1/session-steers/by-session/${encodeURIComponent(sessionId)}/pull`,
        { workspaceId: cfg.workspaceId },
        8000,
      );
      return res.steers ?? [];
    },
    markInjected: async (id) => {
      await post<unknown>(
        cfg,
        `/internal/v1/session-steers/${encodeURIComponent(id)}/injected`,
        { workspaceId: cfg.workspaceId },
        8000,
      );
    },
    fetchActiveConflicts: async (sessionId) => {
      const res = await get<ActiveConflictResponse>(
        cfg,
        `/internal/v1/session-conflicts/by-session/${encodeURIComponent(sessionId)}/active` +
          `?workspaceId=${encodeURIComponent(cfg.workspaceId)}`,
        8000,
      );
      return res.conflicts ?? [];
    },
    // §6.1: the server resolves the principal from the session token and binds the
    // bundle to it. The CLI has no project-activation concept (rule-import-mapping.ts),
    // so projectId is null: the bundle is workspace + principal bound.
    fetchRuleBundle: async () => getBundle(cfg, { projectId: null }),
  };
}

function stubTransport(stubJson: string): SteerTransport {
  return {
    pull: async () => {
      const parsed = JSON.parse(stubJson) as CachedSteer[];
      return Array.isArray(parsed) ? parsed : [];
    },
    markInjected: async () => {
      /* stub: no network */
    },
    fetchActiveConflicts: async () => {
      const raw = process.env.MEETLESS_CONFLICT_SYNC_STUB;
      if (!raw || raw.length === 0) return [];
      const parsed = JSON.parse(raw) as ActiveConflict[];
      return Array.isArray(parsed) ? parsed : [];
    },
    fetchRuleBundle: async () => {
      const raw = process.env.MEETLESS_RULE_BUNDLE_SYNC_STUB;
      if (!raw || raw.length === 0) return null;
      return JSON.parse(raw) as RuleBundle;
    },
  };
}

export function parseArgs(argv: string[]): { sessionId: string } {
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
        `Unknown flag: ${a}. \`mla _internal steer-sync\` takes only --session <sid>.`,
      );
    }
    throw new Error(
      `Unexpected positional argument: ${a}. \`mla _internal steer-sync\` takes only --session <sid>.`,
    );
  }
  if (!sessionId) {
    throw new Error("`mla _internal steer-sync` requires --session <sid>.");
  }
  return { sessionId };
}

export async function runInternalSteerSync(argv: string[]): Promise<number> {
  let sessionId: string;
  try {
    ({ sessionId } = parseArgs(argv));
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }

  try {
    const stub = process.env.MEETLESS_STEER_SYNC_STUB_PULL;
    const transport =
      stub && stub.length > 0 ? stubTransport(stub) : realTransport(loadWorkspaceConfig());

    // 1) Pull and cache the authoritative deliverable set (overwrite: the server
    //    returns the full not-yet-injected set, so the cache is never a stale delta).
    const steers = await transport.pull(sessionId);
    writeSteerCache(sessionId, steers);

    // 2) Mark-injected what the hook already surfaced. The hook dedups injection
    //    via its own inject-state, so a one-turn overlap (a just-injected steer
    //    still in the freshly written cache) never re-injects; the next pull drops
    //    it once it is flipped to INJECTED.
    let injected = 0;
    if (!stub) {
      for (const id of readInjectedIds(sessionId)) {
        try {
          await transport.markInjected(id);
          injected++;
        } catch {
          /* best-effort: a failed mark-injected retries next flush */
        }
      }
    }

    // 3) Snapshot the session's open cross-session conflicts for the PreToolUse soft
    //    warning. Isolated from the steer pull: a conflict-fetch failure must not
    //    zero the pull or the flush. On a SUCCESSFUL fetch (even an empty set) we
    //    overwrite the snapshot so a resolved conflict clears the warning at once;
    //    on a FAILURE we leave the prior snapshot in place and let the hook's TTL
    //    staleness guard fail it open. -1 means "fetch did not complete this turn".
    let conflicts = -1;
    try {
      const active = await transport.fetchActiveConflicts(sessionId);
      writeActiveConflictCache(sessionId, active);
      conflicts = active.length;
    } catch {
      /* best-effort: leave the prior snapshot; TTL fails it open if the sync stays down */
    }

    // 4) Sync the principal-bound rule bundle. Writes the freshly fetched bundle to the
    //    cache the scanner + PreToolUse read; writeRuleBundleCache refuses to regress
    //    bundleRevision, so a late stale fetch never displaces a newer bundle. A fetch
    //    FAILURE leaves the prior cached bundle untouched (the reader's lease guard
    //    degrades a stale DENY to ASK). -1 means "not synced this turn".
    let bundleRevision = -1;
    let rescanned = false;
    try {
      const bundle = await transport.fetchRuleBundle();
      if (bundle) {
        const write = writeRuleBundleCache(bundle);
        bundleRevision = write.storedRevision ?? -1;
        // Learn the principal control stamped for THIS workspace so the offline readers
        // (scanner injection + PreToolUse enforcement) key the bundle-cache read by the
        // SAME id. For a marker bound to a NON-home workspace this differs from the home
        // auth.user.id, and the client cannot re-derive it; recording it here is what lets
        // a teammate's shared TEAM rules actually fold on a foreign workspace.
        recordBundlePrincipal(bundle.workspaceId, bundle.principalUserId);
        // Bridge bundle -> scan cache. The scan cache (confirmedRulesXml) is what the
        // UserPromptSubmit hook injects; nothing else regenerates it on the live per-turn
        // path, so without this bridge a rule change never reaches a running/new session
        // until a manual `mla scan`. Two triggers, both cheap and self-limiting:
        //
        //   (a) BUMP: the freshly written bundle carries a higher revision than the prior
        //       cached one (a rule was added/attested/revoked). writeRuleBundleCache
        //       overwrites even on an equal revision (lease refresh), so a bump is the
        //       precise "governance changed" signal.
        //   (b) BEHIND: the scan cache's own recorded bundle revision (floorMeta.bundleId)
        //       lags the stored bundle, or there is no scan cache at all. This self-heals
        //       the reported "mla status shows 0 rules injected" case: a session whose
        //       bundle never bumps this turn but whose scan cache is stale/missing (fresh
        //       checkout, cleared cache, or an interrupted earlier rescan) would otherwise
        //       stay empty forever, since (a) only ever fires on the turn of the bump.
        //
        // Once a rescan runs it stamps the scan cache with the current revision, so the
        // BEHIND trigger goes quiet on the next sync: in steady state (scan cache == bundle)
        // neither fires and an unchanged bundle costs nothing.
        const stored = write.storedRevision;
        if (stored !== null) {
          const bumped =
            write.outcome === "written" &&
            (write.priorRevision === null || stored > write.priorRevision);
          const scanRevision = scanCacheBundleRevision(undefined, bundle.workspaceId);
          const scanBehind = scanRevision === null || scanRevision < stored;
          if (bumped || scanBehind) {
            try {
              rescanAndCache({ cwd: resolveScanRoot(process.cwd()), workspaceId: bundle.workspaceId });
              rescanned = true;
            } catch {
              /* best-effort: a failed rescan just leaves the prior scan cache; next sync retries */
            }
          }
        }
      }
    } catch {
      /* best-effort: leave the prior cached bundle; the reader's lease guard fails it to ASK */
    }

    console.log(JSON.stringify({ pulled: steers.length, injected, conflicts, bundleRevision, rescanned }));
    return 0;
  } catch {
    // Best-effort: never break the flush this hop rides on.
    console.log(JSON.stringify({ pulled: 0, injected: 0, conflicts: -1, bundleRevision: -1, rescanned: false }));
    return 0;
  }
}

// The bundle revision the scan cache was last built from, parsed from its floorMeta.bundleId
// ("rev-<n>" | "unavailable"), or null when there is no scan cache, no floorMeta, or the id is
// not a numbered revision. Feeds the BEHIND rescan trigger: null (missing/unusable) is treated
// as "infinitely behind" so a first-ever or cleared scan cache always rescans. Throw-free by
// construction (readScanCache swallows read/parse errors and returns null).
function scanCacheBundleRevision(home: string | undefined, workspaceId: string): number | null {
  const bundleId = readScanCache(home, workspaceId)?.floorMeta?.bundleId;
  if (!bundleId) return null;
  const m = /^rev-(\d+)$/.exec(bundleId);
  return m ? Number(m[1]) : null;
}
