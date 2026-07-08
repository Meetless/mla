// The §6.1 local rule-bundle cache: the zero-network hand-off between the CLI's
// bundle sync (`getBundle`, control-rule-client.ts) and the two offline readers
// (the scanner's rule injection and the PreToolUse enforcement hook). The backend
// builds the principal-bound bundle; this module writes it to a gitignored file
// under $MEETLESS_HOME (outside any repo by construction) with a temp-file + atomic
// rename, and reads it back with the safety guards the bundle's own contract spells
// out (apps/control/src/rules/rule-bundle.ts). P1F of the rules-store unification.
//
// The cache deliberately INVERTS the active-conflict-cache fail-open posture: that
// snapshot drives a SOFT warning, so the safe direction on staleness is "say
// nothing". This bundle drives DENY enforcement, so its safe directions are:
//   - missing / corrupt / wrong-principal file  -> "unavailable" (the reader surfaces
//     "rule protection unavailable", acceptance 15), never serve another principal's
//     rules (acceptance 11).
//   - past the DENY lease (validUntil)           -> "stale": the bundle is still
//     returned, but the consumer degrades its DENY rules to ASK (acceptance 17),
//     never enforce a possibly-revoked rule.
//
// Three guards mirror the three safety properties stamped server-side:
//   - Principal-bound: a read whose embedded principalUserId / workspaceId / projectId
//     does not match the live session is rejected as unavailable (acceptance 11). The
//     file is also PATH-keyed by principal+project so two principals on one checkout
//     keep independent last-good snapshots and never collide.
//   - Freshness-ordered: a write whose bundleRevision is OLDER than the stored one is
//     refused, so a late-arriving stale fetch can never displace a newer bundle
//     (acceptance 13).
//   - Integrity-checked: each entry's payload is re-hashed; see verifyEntryIntegrity
//     for why a mismatch DROPS that one entry rather than nuking the whole bundle.

import * as fs from "fs";
import * as path from "path";

import { HOME } from "../config";
import type { RuleBundle, RuleBundleEntry } from "./control-rule-client";
import { ruleVersionHash } from "./rule-version-hash";

/** The bundle schema this client understands (control's RULE_BUNDLE_SCHEMA_VERSION). */
export const RULE_BUNDLE_SCHEMA_VERSION = 1 as const;

/**
 * The cache FILE envelope version, independent of the bundle's own schemaVersion so the
 * on-disk wrapper can evolve (extra diagnostics, compression, ...) without touching the
 * server contract. Bumped only when the envelope shape changes.
 */
export const RULE_BUNDLE_CACHE_SCHEMA_VERSION = 1 as const;

/** The live session's identity + activated project, used to bind reads to one principal. */
export interface BundlePrincipal {
  workspaceId: string;
  /** The activated projectId, or null for a cross-project session. */
  projectId: string | null;
  /** The authenticated user, or null for a shared-key (headless) session. */
  principalUserId: string | null;
}

/** The on-disk wrapper around the verbatim server bundle. */
interface RuleBundleCacheEnvelope {
  cacheSchemaVersion: number;
  bundle: RuleBundle;
}

export type BundleCacheReadStatus = "fresh" | "stale" | "unavailable";

export interface BundleCacheRead {
  /** fresh: within lease. stale: past validUntil (consumer degrades DENY->ASK). unavailable: no usable bundle. */
  status: BundleCacheReadStatus;
  /** The bundle for fresh|stale (with any integrity-failed entries already dropped); null when unavailable. */
  bundle: RuleBundle | null;
  /** now - generatedAt, for "offline list shows bundle revision + age" (acceptance 16); null when unavailable. */
  ageMs: number | null;
  /** How many entries were dropped because their payload failed re-hashing (0 on a clean bundle). */
  droppedForIntegrity: number;
  /** Short machine-ish reason for stale/unavailable, for diagnostics and the "rule protection unavailable" copy. */
  reason: string | null;
}

export type BundleCacheWriteOutcome = "written" | "kept-newer" | "skipped-error";

export interface BundleCacheWrite {
  outcome: BundleCacheWriteOutcome;
  /** The bundleRevision now on disk after the op (the incoming one if written, the existing one if kept-newer). */
  storedRevision: number | null;
  /**
   * The bundleRevision that was on disk BEFORE this op (null if there was no prior cache).
   * Lets a caller tell a genuine revision bump apart from an equal-revision lease refresh, so
   * downstream work (e.g. regenerating the scan cache) fires only when the rule set changed.
   */
  priorRevision: number | null;
}

/** The principal segment for a null (shared-key) principal: a fixed sentinel, never a real id. */
const SHARED_PRINCIPAL_SEGMENT = "_shared";
/** The project segment for a null (cross-project) activation. */
const NO_PROJECT_SEGMENT = "_none";

function fileSegment(value: string): string {
  // Path-safe, collision-resistant: ids are cuid-ish already, but a hostile or legacy id
  // could contain a separator. Replace anything outside [A-Za-z0-9_-] so the filename stays
  // one flat token and two distinct ids can never map to the same file.
  return value.replace(/[^A-Za-z0-9_-]/g, "_");
}

/**
 * The gitignored cache file for one (workspace, principal, project) triple. Keyed by all
 * three so switching user or activated project naturally swaps to a different last-good
 * snapshot (acceptance 11) instead of clobbering. Lives under $MEETLESS_HOME/rules/, which
 * is outside any repo, so the bundle (which may carry another user's PERSONAL rules in a
 * TEAM context) is never committed.
 */
export function ruleBundleCachePath(p: BundlePrincipal, home: string = HOME): string {
  const principal = p.principalUserId ? fileSegment(p.principalUserId) : SHARED_PRINCIPAL_SEGMENT;
  const project = p.projectId ? fileSegment(p.projectId) : NO_PROJECT_SEGMENT;
  const ws = fileSegment(p.workspaceId);
  return path.join(home, "rules", `bundle-${ws}-${principal}-${project}.json`);
}

/**
 * Re-hash one entry's payload and compare to the carried canonicalPayloadHash.
 *
 * A mismatch (or a payload the v1 hasher rejects outright) makes the reader DROP that one
 * entry, not the whole bundle. The reason is a hard safety trade-off: legacy versions
 * imported by the one-time G2 migration carry a canonicalPayloadHash from the OLD CE0
 * canonicalization, which is not guaranteed to recompute under the v1 ruleVersionHash. A
 * hard whole-bundle gate would therefore BRICK every imported rule (including the live
 * notes-location DENY pilot) the instant it is imported. Dropping the single failing entry
 * caps the blast radius to that one rule while keeping the rest enforceable; the caller
 * surfaces the dropped count so a SYSTEMATIC hash-scheme mismatch is loud, not silent.
 * (Fork assumption #6: tighten to whole-bundle-strict once the importer is confirmed to
 * normalize imported hashes to v1.)
 */
function verifyEntryIntegrity(entry: RuleBundleEntry): boolean {
  try {
    return ruleVersionHash(entry.payload as Parameters<typeof ruleVersionHash>[0]) === entry.canonicalPayloadHash;
  } catch {
    // The v1 hasher throws on a payload outside the closed RulePayloadV1 key set. Treat that
    // as an integrity failure for this entry (drop it), never a throw out of the reader.
    return false;
  }
}

function unavailable(reason: string): BundleCacheRead {
  return { status: "unavailable", bundle: null, ageMs: null, droppedForIntegrity: 0, reason };
}

function isRuleBundle(value: unknown): value is RuleBundle {
  if (!value || typeof value !== "object") return false;
  const b = value as Partial<RuleBundle>;
  return (
    typeof b.schemaVersion === "number" &&
    (b.principalUserId === null || typeof b.principalUserId === "string") &&
    typeof b.workspaceId === "string" &&
    (b.projectId === null || typeof b.projectId === "string") &&
    typeof b.bundleRevision === "number" &&
    typeof b.generatedAt === "string" &&
    typeof b.validUntil === "string" &&
    Array.isArray(b.rules)
  );
}

/**
 * Read and validate the cached bundle for the live principal. Never throws and never
 * touches the network. Returns "unavailable" for any of: missing file, parse failure,
 * wrong envelope/bundle schema, principal/scope mismatch, or an unparseable lease;
 * "stale" once past validUntil (the consumer degrades DENY to ASK); otherwise "fresh".
 * Entries that fail integrity re-hashing are dropped from the returned bundle.rules.
 */
export function readRuleBundleCache(
  expected: BundlePrincipal,
  opts: { home?: string; nowMs?: number } = {},
): BundleCacheRead {
  const home = opts.home ?? HOME;
  const nowMs = opts.nowMs ?? Date.now();
  const file = ruleBundleCachePath(expected, home);

  let envelope: RuleBundleCacheEnvelope;
  try {
    envelope = JSON.parse(fs.readFileSync(file, "utf8")) as RuleBundleCacheEnvelope;
  } catch {
    return unavailable("no cached rule bundle");
  }

  if (!envelope || typeof envelope !== "object" || envelope.cacheSchemaVersion !== RULE_BUNDLE_CACHE_SCHEMA_VERSION) {
    return unavailable("cache envelope schema mismatch");
  }
  const bundle = envelope.bundle;
  if (!isRuleBundle(bundle) || bundle.schemaVersion !== RULE_BUNDLE_SCHEMA_VERSION) {
    return unavailable("bundle schema mismatch");
  }

  // Principal binding: never serve a bundle built for a different user, workspace, or
  // activated project. The file is path-keyed by these too, so a mismatch here means a
  // hand-edited / stale-renamed file; reject it outright (acceptance 11).
  if (
    bundle.principalUserId !== expected.principalUserId ||
    bundle.workspaceId !== expected.workspaceId ||
    bundle.projectId !== expected.projectId
  ) {
    return unavailable("bundle principal/scope mismatch");
  }

  // Lease: a non-parseable validUntil is treated as expired (fail toward "stale", which
  // degrades DENY to ASK rather than enforcing on an unreadable horizon).
  const validUntilMs = Date.parse(bundle.validUntil);
  const generatedAtMs = Date.parse(bundle.generatedAt);
  const ageMs = Number.isNaN(generatedAtMs) ? null : Math.max(0, nowMs - generatedAtMs);

  // Integrity: drop any entry whose payload no longer hashes to its carried digest.
  const kept = bundle.rules.filter(verifyEntryIntegrity);
  const droppedForIntegrity = bundle.rules.length - kept.length;
  const checkedBundle: RuleBundle = droppedForIntegrity > 0 ? { ...bundle, rules: kept } : bundle;

  const expired = Number.isNaN(validUntilMs) || nowMs > validUntilMs;
  return {
    status: expired ? "stale" : "fresh",
    bundle: checkedBundle,
    ageMs,
    droppedForIntegrity,
    reason: expired ? "bundle lease expired" : null,
  };
}

/**
 * Atomically persist a freshly fetched bundle, refusing to move backward in revision.
 *
 * Freshness guard (acceptance 13): if a stored bundle already has a HIGHER bundleRevision,
 * the incoming one is a late/stale fetch and is dropped ("kept-newer"). Equal or higher
 * revisions overwrite (an equal-revision re-fetch legitimately refreshes the lease).
 *
 * Atomicity (acceptance 14): the payload is written to a per-process temp file and then
 * renamed over the destination. rename(2) is atomic within a filesystem, so a crashed or
 * failing write leaves the prior good file fully intact and never a half-written one. Any
 * error degrades to "skipped-error" with the temp file cleaned up; it never throws.
 */
export function writeRuleBundleCache(bundle: RuleBundle, opts: { home?: string } = {}): BundleCacheWrite {
  const home = opts.home ?? HOME;
  const file = ruleBundleCachePath(
    { workspaceId: bundle.workspaceId, projectId: bundle.projectId, principalUserId: bundle.principalUserId },
    home,
  );

  // Freshness guard: read the existing revision (best-effort) and refuse to regress.
  let existingRevision: number | null = null;
  try {
    const prior = JSON.parse(fs.readFileSync(file, "utf8")) as RuleBundleCacheEnvelope;
    if (prior && typeof prior === "object" && isRuleBundle(prior.bundle)) {
      existingRevision = prior.bundle.bundleRevision;
    }
  } catch {
    /* no prior bundle, or unreadable: treat as absent and write through */
  }
  if (existingRevision !== null && bundle.bundleRevision < existingRevision) {
    return { outcome: "kept-newer", storedRevision: existingRevision, priorRevision: existingRevision };
  }

  const envelope: RuleBundleCacheEnvelope = { cacheSchemaVersion: RULE_BUNDLE_CACHE_SCHEMA_VERSION, bundle };
  const tmp = `${file}.tmp-${process.pid}-${bundle.bundleRevision}`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Owner-only (0o600): the bundle is principal-bound and can carry the operator's PERSONAL
    // rules, so it must not be world/group-readable. The fresh tmp is created with the mode and
    // the atomic rename preserves it.
    fs.writeFileSync(tmp, JSON.stringify(envelope), { mode: 0o600 });
    fs.renameSync(tmp, file);
    return { outcome: "written", storedRevision: bundle.bundleRevision, priorRevision: existingRevision };
  } catch {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* best-effort temp cleanup */
    }
    return { outcome: "skipped-error", storedRevision: existingRevision, priorRevision: existingRevision };
  }
}
