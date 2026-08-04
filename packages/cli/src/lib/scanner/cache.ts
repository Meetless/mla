import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { resolveMeetlessHome } from "../config";
import { assertSafeWorkspaceId } from "../path-component";
import { ScanResult, Verdicts } from "./types";
import { renderStaleContextXml } from "./render";

// This machine's Meetless state root, i.e. the `.meetless` dir that holds every per-workspace
// artifact below.
//
// An EXPLICIT `home` always wins and keeps this module's historical convention: `home` is the OS
// home and we append the `.meetless` segment ourselves (unlike config.HOME, where `home` IS the
// `.meetless` dir). Tests and injected deps rely on that to get an isolated root per case.
//
// With no home passed, MEETLESS_HOME decides. It always should have: that variable is the documented
// "relocate this machine's Meetless state" knob, and config.HOME (bundle cache, telemetry, logs)
// already honored it while every path here ignored it, so an operator who set it got a split brain,
// bundle in the new root and scan cache in the old one.
//
// A correction, because the note that used to sit here had it exactly backwards and that error is
// what let the $HOME bug live: it claimed "on macOS os.homedir() reads getpwuid and IGNORES $HOME".
// The opposite is true, on Darwin as on Linux. `env HOME=/tmp/x node -p 'os.homedir()'` prints
// /tmp/x, and `HOME='~'` prints a literal `~`. os.homedir() returns $HOME VERBATIM and consults
// getpwuid only when $HOME is UNSET; it is os.userInfo() that ignores $HOME. Believing the inverse
// made a poisoned $HOME look impossible, so nothing validated it, and a launcher that exported
// HOME='' had this join() collapse to a relative ".meetless" under process.cwd(). Resolution now
// goes through config.resolveMeetlessHome, which validates and recovers.
//
// With the variable unset (every production install) this resolves exactly as before.
//
// EXPORTED because the state root is now also an IDENTITY, not just a path prefix: the floor
// projection stamps the root that wrote it so a run under one state root cannot silently
// replace a projection owned by another (floor-projection-writer.ts).
export function resolveStateRoot(home?: string): string {
  if (home !== undefined) return join(home, ".meetless");
  return resolveMeetlessHome();
}
// The single choke point through which EVERY per-workspace artifact path below is built, which
// is why the id is validated here and not at the eight callers. `join` normalizes, so an id like
// `../../x` does not name a badly-named directory, it lands OUTSIDE the state root entirely; and
// a shell-quoted id (observed on disk 2026-07-15) silently forks one workspace's state into two
// directories. See path-component.ts for the full incident.
function wsDir(home: string | undefined, workspaceId: string): string {
  return join(resolveStateRoot(home), "workspaces", assertSafeWorkspaceId(workspaceId));
}
export function scanCachePath(workspaceId: string, home?: string): string {
  return join(wsDir(home, workspaceId), "scan-cache.json");
}

// PER-ROOT scan cache slots.
//
// One workspace id can be bound by SEVERAL `.meetless.json` markers: this dogfood workspace is
// bound by three (the umbrella dir, `meetless/`, `intel/`). Every one of them scans into the SAME
// workspace-keyed `scan-cache.json` above, so the file is last-writer-wins across roots, and the
// reader-side guard (`readScanCacheForRoot`) then correctly refuses a cache stamped with another
// root. Correct, and the net effect was that two of three roots delivered ZERO rules at any moment
// and `mla scan` from any one of them inverted which two were dark (2026-07-28 and again
// 2026-08-02, 8h11m exposure the second time).
//
// The fix is a slot per root, keyed by a hash of the resolved (realpath'd) scan root. The
// workspace-keyed file above is still written unchanged, because it is workspace-GLOBAL content
// that three shell readers in the hot-path hook consume directly with jq (`.floorRulesXml`,
// `.floorMeta.*`) and because it remains the compatibility path for a cache written by an older
// build. Repo-specific reads prefer the per-root slot.
export function scanCacheRootKey(scanRootPath: string): string {
  return createHash("sha256").update(scanRootPath).digest("hex").slice(0, 12);
}
export function scanCacheRootsDir(workspaceId: string, home?: string): string {
  return join(wsDir(home, workspaceId), "roots");
}
export function scanCachePathForRoot(workspaceId: string, scanRootPath: string, home?: string): string {
  return join(scanCacheRootsDir(workspaceId, home), `scan-cache-${scanCacheRootKey(scanRootPath)}.json`);
}
export function verdictsPath(workspaceId: string, home?: string): string {
  return join(wsDir(home, workspaceId), "scanner-verdicts.json");
}
// The floor-projection materialization receipt (matrix doc Phase 2). A local artifact,
// written next to scan-cache.json, that records the outcome of the last projection write
// (written | unchanged | blocked) for the async flush to upload. No network on this path.
export function projectionReceiptPath(workspaceId: string, home?: string): string {
  return join(wsDir(home, workspaceId), "projection-receipt.json");
}
// The review-card journal the Stop hook appends to at the end of a session. Written shell-side
// (hooks-template/stop.sh, straight to $HOME); this is the reader's half of the same path.
export function reviewCardsPath(workspaceId: string, home?: string): string {
  return join(wsDir(home, workspaceId), "review-cards.jsonl");
}
// The assembler's out-of-band audit (targeted-rule-injection §4.4). The assemble-context
// subcommand budgets the model-facing envelope, then records WHAT it delivered vs dropped
// (and any overflow) here rather than in the byte-limited prompt. Diagnostic only: a failed
// write never breaks delivery.
export function assembleAuditPath(workspaceId: string, home?: string): string {
  return join(wsDir(home, workspaceId), "assemble-audit.json");
}
// The hook's per-turn delivery receipt. The ONLY artifact written by the bash side
// (hooks-template/user-prompt-submit.sh §emit_delivery_receipt), and the only one that covers the
// paths where the assembler never runs: the bash fallback, the fail-closed block, and the
// inject-nothing arm. TypeScript reads it and never writes it.
export function deliveryReceiptPath(workspaceId: string, home?: string): string {
  return join(wsDir(home, workspaceId), "hook-receipt.json");
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2), "utf8");
}
function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

// How many per-root slots to keep. Real installs have one to three roots; the extra headroom is
// for the throwaway directories that create these in the first place (three `mla activate` calls
// from `live-handoff-test-000{1,2,3}` on 2026-08-02). Beyond the cap the oldest by mtime are
// dropped: a pruned root falls back to the workspace-global slot, whose stamp check then refuses
// it, which is a floor-only turn rather than a wrong-rules turn. Bounded, not clever.
const MAX_ROOT_SLOTS = 8;

// A slot whose root directory is GONE is unreachable, not merely old: `readScanCacheAtRoot` keys on
// the live cwd's realpath, so nothing can ever address it again. Those are dropped before the cap
// applies, because mtime order is exactly backwards for this hazard: the throwaway roots are the
// NEWEST slots, so a pure-mtime cap evicts the real checkouts and keeps the temp dirs.
function pruneRootSlots(workspaceId: string, home: string | undefined, keep: string): void {
  try {
    const dir = scanCacheRootsDir(workspaceId, home);
    const survivors: { path: string; mtime: number }[] = [];
    for (const f of readdirSync(dir)) {
      if (!f.startsWith("scan-cache-") || !f.endsWith(".json")) continue;
      const path = join(dir, f);
      if (path === keep) continue;
      const root = readJson<ScanResult>(path)?.scanRootPath;
      // Only a slot that NAMES a root we can prove is gone gets dropped here. An unparseable or
      // unstamped slot is left to the cap: it may be a partial write from a live root, and
      // "cannot tell" must not read as "vanished".
      if (root && !existsSync(root)) {
        try {
          unlinkSync(path);
        } catch {
          /* best effort */
        }
        continue;
      }
      let mtime = 0;
      try {
        mtime = statSync(path).mtimeMs;
      } catch {
        /* unreadable: sorts oldest, gets pruned first */
      }
      survivors.push({ path, mtime });
    }
    survivors.sort((a, b) => b.mtime - a.mtime);
    for (const stale of survivors.slice(MAX_ROOT_SLOTS - 1)) {
      try {
        unlinkSync(stale.path);
      } catch {
        /* best effort */
      }
    }
  } catch {
    // No roots dir yet, or an unreadable one: nothing to prune.
  }
}

// What the workspace-global slot should hold after `incoming` is scanned.
//
// That slot is ONE file shared by every root bound to this workspace id, and its fields split in
// two (see ScanResult.scanRootPath): floor content is workspace-global and identical from any
// root, while commitSha / inventory / directives / scopedRules / staleSignals describe exactly ONE
// checkout. Writing the whole record from any root is what let a scan inside a throwaway directory
// serve that directory's inventory as a real checkout's governing rules, twice (2026-07-28,
// 2026-08-02). Per-root slots fixed the READ side for roots that already own a slot; this fixes
// the write side for every root that does not, and for the three shell readers of this file.
//
// So the slot gets an OWNER: the first root to stamp it. A different root refreshes the floor and
// leaves the owner's repo-specific fields alone. Ownership transfers when the owner's directory no
// longer exists, which is precisely the throwaway-dir case and the self-heal the 2026-07-28
// write-up said was missing ("that directory is then deleted, so the cache can never match again
// and nothing self-heals").
//
// Single-root installs, the vast majority, always take the `incoming` path and are byte-identical
// to before this landed.
// Does this scan actually carry a floor? Missing, empty and whitespace-only are the same absence
// wearing different clothes: `floorRulesXml` is optional in the type, a bundle read that returns
// nothing renders "", and a renderer given zero rules can emit an empty wrapper's worth of
// whitespace. Guarding only `=== ""` would leave the other two roads open.
function hasFloor(scan: ScanResult): boolean {
  return (scan.floorRulesXml ?? "").trim().length > 0;
}

function globalSlotContent(
  home: string | undefined,
  workspaceId: string,
  incoming: ScanResult,
): ScanResult {
  const incumbent = readScanCache(home, workspaceId);
  // Nothing there, an unstamped pre-per-root cache (whose owner is unknowable), or an unstamped
  // incoming scan: claim the slot outright.
  if (!incumbent?.scanRootPath || !incoming.scanRootPath) return incoming;
  if (incumbent.scanRootPath === incoming.scanRootPath) return incoming;
  if (!existsSync(incumbent.scanRootPath)) return incoming;
  // A different, still-present root owns this slot. Refresh only what is workspace-global.
  //
  // schemaVersion deliberately stays the INCUMBENT's: it gates how the assembler reads the record
  // it is attached to, and every repo-specific field here is still the incumbent's. Raising it to
  // match a newer `incoming` would claim structured arrays this record does not carry, turning a
  // visible degradation into a silent floor-only delivery.
  //
  // ...and a stranger only gets to refresh the floor when it HAS one. The floor is workspace-global
  // and principal-keyed, so every root that can read the bundle computes the same one; but a root
  // that cannot read it (offline, no cached bundle for that principal, a throwaway dir that
  // resolves no principal at all) still scans successfully and still carries an EMPTY floor. Taking
  // that unconditionally writes the absence over the owner's real floor, and three shell readers in
  // the hot-path hook read this slot directly, so the owning checkout loses its MUSTs on every
  // prompt: the 2026-08-02 floor outage reached by a different road. A refresh must carry something.
  // Absence never overwrites presence.
  //
  // The three fields move together on purpose. They come from ONE bundle read, and floorMeta is the
  // provenance stamp (bundleId/bundleHash/freshness) that the delivery receipt attests ABOUT
  // floorRulesXml. Taking the XML from the stranger and the stamp from the incumbent would mint a
  // record whose receipt vouches for a body it never saw.
  if (!hasFloor(incoming)) return incumbent;
  return {
    ...incumbent,
    floorRulesXml: incoming.floorRulesXml,
    floorRules: incoming.floorRules,
    floorMeta: incoming.floorMeta,
  };
}

export function writeScanCache(home: string | undefined, workspaceId: string, result: ScanResult): void {
  // The workspace-global slot. Three shell readers in the hot-path hook consume it directly, so it
  // is always written; what it is allowed to overwrite is decided by globalSlotContent.
  writeJson(scanCachePath(workspaceId, home), globalSlotContent(home, workspaceId, result));
  // The per-root slot. Only written when the scan stamped its root; a result without one is a
  // pre-stamp cache and has nothing to key by.
  if (!result.scanRootPath) return;
  try {
    const path = scanCachePathForRoot(workspaceId, result.scanRootPath, home);
    writeJson(path, result);
    pruneRootSlots(workspaceId, home, path);
  } catch {
    // Best effort: the workspace-global slot above is already written, so a failure here degrades
    // to exactly the pre-fix behavior rather than losing the scan.
  }
}
export function readScanCache(home: string | undefined, workspaceId: string): ScanResult | null {
  return readJson<ScanResult>(scanCachePath(workspaceId, home));
}
// Read the slot belonging to ONE resolved scan root. Null when this root has never been scanned
// by a build that writes per-root slots; the caller falls back to the workspace-global slot and
// its stamp check.
export function readScanCacheAtRoot(
  home: string | undefined,
  workspaceId: string,
  scanRootPath: string,
): ScanResult | null {
  return readJson<ScanResult>(scanCachePathForRoot(workspaceId, scanRootPath, home));
}

// The persisted shape of a projection receipt. `projection` is the load-bearing field
// (matrix doc Phase 2); the rest is diagnostic provenance. Best-effort: a failed write
// never breaks the scan that produced it.
export interface PersistedProjectionReceipt {
  schemaVersion: 1;
  at: string; // ISO timestamp of the materialization attempt
  workspaceId: string;
  // "removed" = an owned projection was torn down because the floor was legitimately revoked
  // (fresh bundle, zero floor rules); distinct from "unchanged" (nothing to do) so a revocation
  // is observable and never masquerades as a no-op.
  projection: "written" | "unchanged" | "blocked" | "removed";
  reason?: string;
  bundleId: string;
}
export function writeProjectionReceipt(
  home: string | undefined,
  workspaceId: string,
  receipt: PersistedProjectionReceipt,
): void {
  try {
    writeJson(projectionReceiptPath(workspaceId, home), receipt);
  } catch {
    // A receipt is observability, never a gate: a failure here must not break the scan.
  }
}
export function readProjectionReceipt(
  home: string | undefined,
  workspaceId: string,
): PersistedProjectionReceipt | null {
  return readJson<PersistedProjectionReceipt>(projectionReceiptPath(workspaceId, home));
}

// The persisted assembler audit (§4.4, §7). `state` names which cache-degradation row fired
// (or "normal"); `delivered`/`omitted` name rules by their durable identity; `overflow` is
// true iff the mandatory-scoped fail-loud marker replaced the scoped block.
//
// `versionId` on a delivered/omitted row is the durable RuleVersion identity of that rule
// (§7.4), enriched at the persistence boundary from the scan-cache floor/scoped arrays (the
// pure assembler keeps its result minimal so its tests do not churn on identity plumbing).
// `represents` on a delivered row lists the RuleVersions this injected rule canonically stands
// in for after dedup (§7.3 REPRESENTED_BY_RULE_VERSION): an absorbed MUST is honestly reported
// as delivered-by-equivalent, never as lost. Both are optional (absent when unknown / nothing
// absorbed) so a row written by an older build still parses.
export interface PersistedAssembleAudit {
  schemaVersion: 1;
  at: string;
  workspaceId: string;
  state: "normal" | "overflow" | "old-schema" | "incomplete" | "base-invariant";
  bytes: number;
  safeTotal: number;
  overflow: boolean;
  explicitPaths: string[];
  delivered: Array<{ ruleId: string; tier: string; versionId?: string; represents?: string[] }>;
  omitted: Array<{ ruleId: string; reason: string; versionId?: string }>;
  // The prompt-time reconciliation rehash partition (ADR §3.3 item 9). Present ONLY when the
  // scan cache carried reconciliation findings; Phase 2B populates them, so every Phase 2A cache
  // carries none and this key is omitted from every 2A audit. `kept` = findings whose cited file's
  // current content-normalization-v1 digest still equals the evaluated digest (eligible to inject,
  // pending the blocked Phase-3 renderer). `needsReevaluation` = findings dropped from THIS prompt
  // because the file drifted (`digest_drift`), could not be read (`unreadable`), or failed
  // normalization (`normalization_error`); never auto-resolved (item #6), only held back. This
  // audit is the sole Phase 2A consumer of the rehash, so it is where the partition is observed.
  reconciliation?: {
    kept: Array<{ path: string; reason: string }>;
    needsReevaluation: Array<{ path: string; reason: string }>;
  };
}
export function writeAssembleAudit(
  home: string | undefined,
  workspaceId: string,
  audit: PersistedAssembleAudit,
): void {
  try {
    writeJson(assembleAuditPath(workspaceId, home), audit);
  } catch {
    // The audit is observability, never a gate: a failure here must not break delivery.
  }
}

// The per-turn DELIVERY receipt, written by the BASH hook (user-prompt-submit.sh
// §emit_delivery_receipt) and read here. It is the only artifact that records what the hook
// actually put in front of the model on the last turn: which emission path won, how many floor and
// scoped rule bullets rode along, how many bytes, and which degradation marker (if any) was
// present. Latest-state, overwritten every turn.
//
// It is deliberately derived from the emitted STRING rather than from the assemble audit above:
// the audit records what the ASSEMBLER decided, and on the bash fallback path the assembler does
// not run at all. Between 2026-08-02T07:38Z and 15:49Z the assembler emitted a non-empty head
// carrying ZERO floor rules on two turns while every other signal read healthy; `floorRules` is
// the field that would have said so.
//
// TypeScript never writes this file. The reader tolerates a missing or malformed one (no turn has
// run yet under this workspace, or an older hook build) by returning null.
export interface PersistedDeliveryReceipt {
  at: string;
  // Which arm of the hook's emission fork ran. "assembler" = the byte-asserted head from
  // `mla _internal assemble-context`; "fallback" = bash's LAYER1 + pre-rendered floor XML;
  // "blocked" = the fail-closed rc==3 path that exits 2 and shows the model nothing;
  // "none" = an inject-nothing turn (the pull_only control arm).
  path: "assembler" | "fallback" | "blocked" | "none";
  // Whether a floor-rules block reached the model at all. Kept as the original field name so a
  // receipt written before and after the rewrite compares cleanly.
  delivery: "emitted" | "missing";
  floorRules: number;
  scopedRules: number;
  bytes: number;
  cwd: string;
  freshness: string;
  bundleId: string;
  // The §6 degradation marker present in the emitted head, in severity order:
  // "delivery-incomplete" (no cache for THIS root) beats "scoped-unavailable" (matching failed).
  degraded?: "delivery-incomplete" | "scoped-unavailable";
  // Why the floor is missing, when it is. Absent on a delivering turn.
  reason?: string;
  bundleHash?: string;
}
export function readDeliveryReceipt(
  home: string | undefined,
  workspaceId: string,
): PersistedDeliveryReceipt | null {
  return readJson<PersistedDeliveryReceipt>(deliveryReceiptPath(workspaceId, home));
}

const EMPTY_VERDICTS: Verdicts = { schemaVersion: 1, accepted: [], dismissed: [] };
export function readVerdicts(home: string | undefined, workspaceId: string): Verdicts {
  return readJson<Verdicts>(verdictsPath(workspaceId, home)) ?? { ...EMPTY_VERDICTS };
}
export function writeVerdicts(home: string | undefined, workspaceId: string, v: Verdicts): void {
  writeJson(verdictsPath(workspaceId, home), v);
}

// Dismissed signals are removed; the stale block + inventory are re-derived so the
// cache the hot path reads always reflects the latest verdicts.
export function applyVerdicts(result: ScanResult, verdicts: Verdicts): ScanResult {
  const dismissed = new Set(verdicts.dismissed);
  const staleSignals = result.staleSignals.filter((s) => !dismissed.has(s.id));
  return {
    ...result,
    staleSignals,
    staleContextXml: renderStaleContextXml(staleSignals),
    inventory: { ...result.inventory, staleSignals: staleSignals.length },
  };
}
